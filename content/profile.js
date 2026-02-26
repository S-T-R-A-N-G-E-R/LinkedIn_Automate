(() => {
  // Guard against double injection (background.js may re-inject as fallback)
  if (window.__getEmployedProfileLoaded) return;
  window.__getEmployedProfileLoaded = true;

  const log = (...args) => console.log("[GetEmployed][profile]", ...args);

  /* ── Helpers ─────────────────────────────────────────────────────── */

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const sleepRandom = (minMs, maxMs) =>
    sleep(Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs);

  const sendMessage = (msg) =>
    new Promise((resolve) => {
      chrome.runtime.sendMessage(msg, (resp) => resolve(resp));
    });

  const waitForElementSafe = (selector, timeoutMs = 8000) =>
    new Promise((resolve) => {
      const existing = document.querySelector(selector);
      if (existing) {
        resolve(existing);
        return;
      }

      const observer = new MutationObserver(() => {
        const found = document.querySelector(selector);
        if (found) {
          observer.disconnect();
          resolve(found);
        }
      });

      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
      });

      setTimeout(() => {
        observer.disconnect();
        resolve(null);
      }, timeoutMs);
    });

  /* ── State ───────────────────────────────────────────────────────── */

  let premiumEnabled = false;
  let flowDetails = null; // set when START_PROFILE_FLOW arrives
  let scraperTabId = null; // set from START_PROFILE_FLOW for log relay
  let yearsRequired = 0;
  let eligibilityMaxYears = 0;

  /**
   * Relay log to BOTH the local profile tab console AND to the scraper
   * tab (via background.js) so the user can see it in the jobs tab console.
   */
  const relayLog = (...args) => {
    log(...args);
    if (scraperTabId) {
      chrome.runtime
        .sendMessage({
          action: "RELAY_PROFILE_LOG",
          scraperTabId,
          args: args.map((a) =>
            typeof a === "object" ? JSON.stringify(a) : String(a),
          ),
        })
        .catch(() => {});
    }
  };

  /* ── Connection flow ─────────────────────────────────────────────── */

  /**
   * Find the main profile header section — the top card that contains
   * the profile photo, name, and action buttons.  This EXCLUDES
   * "People also viewed" / suggestion cards at the bottom of the page.
   */
  const getProfileHeaderSection = () => {
    // Strategy 1: LinkedIn usually wraps the top card in a <section> that
    // lives inside <main> and contains an <h1> (the profile name).
    const mainEl = document.querySelector("main");
    if (mainEl) {
      const sections = mainEl.querySelectorAll("section");
      for (const sec of sections) {
        if (sec.querySelector("h1")) return sec;
      }
      // Fallback: the first section inside main
      if (sections.length) return sections[0];
    }
    // Strategy 2: known LinkedIn class
    return (
      document.querySelector(".pv-top-card") ||
      document.querySelector(".scaffold-layout__main") ||
      document.body
    );
  };

  /**
   * Normalise a name for fuzzy matching:
   *   "Thoshima Kaveramma" → "thoshima kaveramma"
   */
  const normName = (n) =>
    (n || "")
      .toLowerCase()
      .replace(/[^a-z ]/g, "")
      .trim();

  const runConnectionFlow = async () => {
    const hrDetails = flowDetails.hrDetails || {};
    const jobMeta = flowDetails.jobMeta || {};
    const jobDescription = flowDetails.jobDescription || "";
    const recruiterName = normName(hrDetails.name);

    relayLog("Running connection flow for", hrDetails.name);
    await sleepRandom(2000, 4000); // Let the page fully settle

    // Wait for the profile action bar to render (it lazy-loads)
    relayLog("Waiting for profile action buttons to load...");
    const actionBar = await waitForElementSafe(
      '[aria-label*="connect" i], [aria-label*="Connect"], ' +
        'button[aria-label="More"], button[aria-label="More actions"], ' +
        '[aria-label*="Follow"], [aria-label*="Message"], ' +
        '[aria-label*="Pending"], [aria-label*="pending"]',
      10000,
    );
    if (!actionBar) {
      relayLog("Profile action buttons never loaded");
      return "ConnectNotFound";
    }
    relayLog("Profile action bar loaded");
    await sleep(500);

    const headerSection = getProfileHeaderSection();
    relayLog(
      "Profile header section tag:",
      headerSection.tagName,
      "class:",
      (headerSection.className || "").slice(0, 80),
    );

    // ── 0. Check for Already Pending or Already Connected ───────────
    //    These buttons appear instead of "Connect" when the invitation
    //    is already sent or you're already connected.
    const allHeaderEls = headerSection.querySelectorAll(
      "a[aria-label], button[aria-label], div[aria-label], span[aria-label], " +
        'button, a, [role="button"], [tabindex="0"]',
    );

    // Debug: log ALL header elements so we can see what's on the page
    relayLog("Header elements found:", allHeaderEls.length);
    for (const el of allHeaderEls) {
      const label = (el.getAttribute("aria-label") || "").slice(0, 80);
      const text = (el.innerText || "").trim().slice(0, 60);
      const tag = el.tagName;
      const role = el.getAttribute("role") || "";
      if (label || text) {
        relayLog("  elt:", { tag, role, label, text });
      }
    }

    for (const el of allHeaderEls) {
      const label = (el.getAttribute("aria-label") || "").toLowerCase();
      const text = (el.innerText || "").trim().toLowerCase();
      if (label.includes("pending") || text === "pending") {
        relayLog(
          "Already pending — detected via header element:",
          label || text,
        );
        return "already-pending";
      }
    }

    // NOTE: We do NOT check for "Message = already connected" here because
    // LinkedIn shows Message for 2nd-degree connections while hiding Connect
    // inside the "More" dropdown.  We always try the More dropdown first.

    // ── 1. Look for a DIRECT Connect element ────────────────────────
    let connectBtn = null;

    // Also search span[aria-label], [role="button"], etc.
    const allClickables = headerSection.querySelectorAll(
      "a[aria-label], button[aria-label], div[aria-label], span[aria-label], " +
        '[role="button"][aria-label]',
    );

    // 1a. Name-matched search
    for (const el of allClickables) {
      const label = (el.getAttribute("aria-label") || "").toLowerCase();
      if (label.includes("connect") && !label.includes("disconnect")) {
        if (recruiterName && normName(label).includes(recruiterName)) {
          connectBtn = el;
          relayLog(
            "Found name-matched Connect element:",
            label,
            "tag:",
            el.tagName,
          );
          break;
        }
      }
    }

    // 1b. Header-scoped (any Connect element)
    if (!connectBtn) {
      for (const el of allClickables) {
        const label = (el.getAttribute("aria-label") || "").toLowerCase();
        const text = (el.innerText || "").trim().toLowerCase();
        if (
          (label.includes("connect") && !label.includes("disconnect")) ||
          (text === "connect" && !label.includes("disconnect"))
        ) {
          connectBtn = el;
          relayLog(
            "Found header-scoped Connect element:",
            label || text,
            "tag:",
            el.tagName,
          );
          break;
        }
      }
    }

    // 1c. Search globally in main section (not just header) — some profiles
    //     have the Connect button outside the <section> with <h1>
    if (!connectBtn) {
      const mainEl = document.querySelector("main") || document.body;
      const globalClickables = mainEl.querySelectorAll(
        "a[aria-label], button[aria-label], div[aria-label], span[aria-label], " +
          '[role="button"][aria-label]',
      );
      for (const el of globalClickables) {
        const label = (el.getAttribute("aria-label") || "").toLowerCase();
        if (label.includes("connect") && !label.includes("disconnect")) {
          if (recruiterName && normName(label).includes(recruiterName)) {
            connectBtn = el;
            relayLog(
              "Found name-matched Connect in main:",
              label,
              "tag:",
              el.tagName,
            );
            break;
          }
        }
      }
      // REMOVED: Non-name-matched fallback in main — too dangerous, clicks wrong person's Connect button
      // If name-matched search failed, we'll try the "More" dropdown next (line 269)
    }

    // ── 2. If no direct button, try the "More" dropdown ─────────────
    if (!connectBtn) {
      relayLog("No direct Connect element, trying More dropdown...");
      // #region agent log
      fetch(
        "http://127.0.0.1:7288/ingest/37e7a685-ff6e-459e-8e0d-959c9c082ee3",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Debug-Session-Id": "0364f0",
          },
          body: JSON.stringify({
            sessionId: "0364f0",
            runId: "pre-fix",
            hypothesisId: "H5-MoreDropdownPath",
            location: "profile.js:runConnectionFlow:tryingMoreDropdown",
            message: "No direct Connect found, attempting More dropdown",
            data: {
              url: window.location.href,
              recruiterName: hrDetails.name || "",
              headerElementsCount: allHeaderEls.length,
            },
            timestamp: Date.now(),
          }),
        },
      ).catch(() => {});
      // #endregion
      // Search for More button in header AND globally
      const moreBtn =
        headerSection.querySelector(
          'button[aria-label="More"], button[aria-label="More actions"]',
        ) ||
        document.querySelector(
          'main button[aria-label="More"], main button[aria-label="More actions"]',
        );
      if (moreBtn) {
        moreBtn.click();
        relayLog("Clicked More button");
        await sleepRandom(1000, 1500);

        const menuItems = document.querySelectorAll(
          '[role="menuitem"], [role="menu"] a, [role="menu"] button, ' +
            '[role="menu"] div[aria-label], [role="menu"] span[aria-label], ' +
            ".artdeco-dropdown__content a, .artdeco-dropdown__content button, " +
            ".artdeco-dropdown__content div[aria-label]",
        );
        relayLog("Found", menuItems.length, "menu items");

        // Log all menu items for debug
        for (const item of menuItems) {
          const label = (item.getAttribute("aria-label") || "").slice(0, 60);
          const text = (item.innerText || "").trim().slice(0, 40);
          relayLog("  Menu item:", { label, text, tag: item.tagName });
        }

        // First pass: name-matched
        for (const item of menuItems) {
          const label = (item.getAttribute("aria-label") || "").toLowerCase();
          if (label.includes("connect") && !label.includes("disconnect")) {
            if (recruiterName && normName(label).includes(recruiterName)) {
              connectBtn = item;
              relayLog("Found name-matched Connect in More dropdown");
              break;
            }
          }
        }

        // Second pass: any connect item (strict match — exclude
        // "Remove connection", "Manage connections", etc.)
        if (!connectBtn) {
          for (const item of menuItems) {
            const label = (item.getAttribute("aria-label") || "").toLowerCase();
            const text = (item.innerText || "").trim().toLowerCase();
            const childLabel = (
              item.querySelector("[aria-label]")?.getAttribute("aria-label") ||
              ""
            ).toLowerCase();

            // Must contain "connect" but NOT "remove", "disconnect", "unconnect"
            const combined = `${label} ${text} ${childLabel}`;
            const hasConnect =
              text === "connect" ||
              (label.includes("invite") && label.includes("connect")) ||
              (childLabel.includes("invite") && childLabel.includes("connect"));
            const hasExclude =
              combined.includes("remove") ||
              combined.includes("disconnect") ||
              combined.includes("unconnect");

            if (hasConnect && !hasExclude) {
              connectBtn = item;
              relayLog("Found Connect in More dropdown (not name-matched)");
              break;
            }
          }
        }

        // If still not found, close the dropdown
        if (!connectBtn) {
          moreBtn.click();
          await sleep(300);
        }
      } else {
        relayLog("More button not found either");
      }
    }

    if (!connectBtn) {
      relayLog(
        "Connect element not found on profile — see header elements above for debug",
      );
      return "ConnectNotFound";
    }

    // ── 3. Click the Connect element ────────────────────────────────
    relayLog(
      "Clicking Connect element:",
      connectBtn.tagName,
      connectBtn.getAttribute("aria-label"),
    );

    // For <a> elements, prevent default navigation — LinkedIn's Ember
    // router intercepts <a> clicks to do SPA transitions, which can change
    // the page before our dialog handler starts polling.  We fire a
    // synthetic MouseEvent that Ember will process for the dialog, while
    // preventing the browser's native link navigation.
    if (connectBtn.tagName === "A") {
      relayLog(
        "Connect element is <a> — using synthetic click with preventDefault",
      );
      const handler = (e) => e.preventDefault();
      connectBtn.addEventListener("click", handler, {
        once: true,
        capture: true,
      });
      connectBtn.dispatchEvent(
        new MouseEvent("click", {
          bubbles: true,
          cancelable: true,
          view: window,
        }),
      );
    } else {
      // For button/div, use dispatchEvent for better Ember compatibility
      connectBtn.dispatchEvent(
        new MouseEvent("click", {
          bubbles: true,
          cancelable: true,
          view: window,
        }),
      );
    }

    relayLog("Clicked Connect element, recording URL for change detection");
    const urlBeforeClick = location.href;
    await sleepRandom(2000, 3000);

    // Check if clicking caused a page navigation (common for 3rd-degree)
    if (location.href !== urlBeforeClick) {
      relayLog(
        "URL changed after Connect click:",
        urlBeforeClick,
        "→",
        location.href,
      );
    }

    // ── 4. Signal background.js to handle the dialog ────────────────
    relayLog(
      "Sending CONNECT_CLICKED to background.js — dialog handling delegated",
    );

    // #region agent log
    fetch("http://127.0.0.1:7288/ingest/37e7a685-ff6e-459e-8e0d-959c9c082ee3", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Debug-Session-Id": "0364f0",
      },
      body: JSON.stringify({
        sessionId: "0364f0",
        runId: "pre-fix",
        hypothesisId: "H1-NoDialogHandler",
        location: "profile.js:runConnectionFlow:CONNECT_CLICKED",
        message: "PROFILE sending CONNECT_CLICKED to background",
        data: {
          url: window.location.href,
          recruiterName: hrDetails.name || "",
        },
        timestamp: Date.now(),
      }),
    }).catch(() => {});
    // #endregion

    chrome.runtime.sendMessage({
      action: "CONNECT_CLICKED",
      recruiterName: hrDetails.name || "",
      jobDescription: jobDescription || "",
      yearsRequired: yearsRequired,
      eligibilityMaxYears: eligibilityMaxYears,
      premiumEnabled: premiumEnabled,
      jobMeta: jobMeta || {},
    });

    // Return sentinel so .then() handler knows NOT to send CONNECTION_RESULT
    return "AwaitingDialogHandler";
  };

  /* ── Message listeners ───────────────────────────────────────────── */

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.action === "START_PROFILE_FLOW") {
      flowDetails = message;
      premiumEnabled = !!message.premiumEnabled;
      scraperTabId = message.scraperTabId || null;
      yearsRequired = message.yearsRequired || 0;
      eligibilityMaxYears = message.eligibilityMaxYears || 0;
      relayLog("Received START_PROFILE_FLOW for", message.hrDetails?.name);

      runConnectionFlow()
        .then((status) => {
          relayLog("Connection flow finished:", status);
          // Only send CONNECTION_RESULT if we got a definitive result.
          // "AwaitingDialogHandler" means background.js handles the dialog
          // via chrome.scripting.executeScript — don't send CONNECTION_RESULT.
          if (status !== "AwaitingDialogHandler") {
            chrome.runtime.sendMessage({
              action: "CONNECTION_RESULT",
              status,
            });
          }
        })
        .catch((err) => {
          relayLog("Connection flow error:", err);
          chrome.runtime.sendMessage({
            action: "CONNECTION_RESULT",
            status: "ConnectFailed",
          });
        });

      sendResponse({ ok: true });
      return true;
    }

    if (message.action === "UPDATE_PREMIUM") {
      premiumEnabled = !!message.premiumEnabled;
    }
  });

  /* ── Init ────────────────────────────────────────────────────────── */

  log("Loaded on", window.location.href);
  log("Registering message listener and sending PROFILE_READY...");
  chrome.runtime.sendMessage(
    {
      action: "PROFILE_READY",
      url: window.location.href,
    },
    (response) => {
      if (chrome.runtime.lastError) {
        log("PROFILE_READY send error:", chrome.runtime.lastError.message);
      } else {
        log("PROFILE_READY acknowledged:", response);
      }
    },
  );
})();
