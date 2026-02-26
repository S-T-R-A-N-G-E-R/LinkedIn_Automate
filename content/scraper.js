(() => {
  const log = (...args) => console.log("[GetEmployed][scraper]", ...args);
  const DEFAULT_MAX_JOBS = 25;
  let isRunning = false;
  let stopRequested = false;

  /* ── Helpers ───────────────────────────────────────────────────────── */

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const sleepRandom = (minMs, maxMs) =>
    sleep(Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs);

  const getState = () =>
    new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: "GET_STATE" }, (response) => {
        resolve(response?.state || {});
      });
    });

  const appendRecord = (record) =>
    new Promise((resolve) => {
      chrome.storage.local.get({ applicationRecords: [] }, (data) => {
        const records = data.applicationRecords || [];
        chrome.storage.local.set(
          { applicationRecords: [...records, record] },
          () => resolve(),
        );
      });
    });

  const waitForElement = (selector, timeoutMs = 10000) =>
    new Promise((resolve, reject) => {
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
        reject(new Error(`Timeout waiting for ${selector}`));
      }, timeoutMs);
    });

  const waitForElementSafe = async (selector, timeoutMs = 8000) => {
    try {
      return await waitForElement(selector, timeoutMs);
    } catch {
      return null;
    }
  };

  const sendMessage = (msg) =>
    new Promise((resolve) => {
      chrome.runtime.sendMessage(msg, (response) => resolve(response));
    });

  /* ── DOM finders ───────────────────────────────────────────────────── */

  const findShowAllButton = () =>
    document.querySelector('a[aria-label^="Show all jobs"]');

  const findJobCards = () =>
    Array.from(document.querySelectorAll("li[data-occludable-job-id]"));

  const findJobListContainer = () => {
    const selectors = [
      ".scaffold-layout__list",
      ".scaffold-layout__list-container",
      "div.scaffold-layout__list > ul",
      "ul.reusable-search__list",
      ".jobs-search-results__list-item",
      "aside ul[role='list']",
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) {
        log("Found job list container with selector:", sel);
        return el;
      }
    }

    const jobCard = document.querySelector("li[data-occludable-job-id]");
    if (jobCard) {
      let parent = jobCard.parentElement;
      while (parent) {
        const style = window.getComputedStyle(parent);
        if (style.overflowY === "auto" || style.overflowY === "scroll") {
          log("Found scrollable parent container");
          return parent;
        }
        parent = parent.parentElement;
      }
    }
    return null;
  };

  const scrollJobListIncremental = async () => {
    const container = findJobListContainer();
    if (!container) {
      log("Could not find job list container to scroll");
      return false;
    }
    const before = container.scrollTop;
    const step = container.clientHeight || 400;
    container.scrollTop += step;
    await sleep(800);
    const moved = container.scrollTop !== before;
    if (moved) {
      log("Scrolled job list by", step, "px");
    } else {
      log("Scroll did not move (may be at bottom)");
    }
    return moved;
  };

  const scrollToJobCard = (jobCard) => {
    if (jobCard) {
      jobCard.scrollIntoView({ behavior: "auto", block: "nearest" });
    }
  };

  const findNextPageButton = () => {
    const selectors = [
      'button[aria-label="View next page"]',
      'button[aria-label*="next"]',
      ".artdeco-pagination__button--next",
      "button.jobs-search-pagination__button--next",
    ];
    for (const sel of selectors) {
      const btn = document.querySelector(sel);
      if (
        btn &&
        !btn.disabled &&
        btn.getAttribute("aria-disabled") !== "true"
      ) {
        return btn;
      }
    }
    return null;
  };

  const findJobTitle = () =>
    document.querySelector("h1.t-24, h1.jobs-unified-top-card__job-title, h1");

  const findCompanyName = () => {
    const selectors = [
      ".job-details-jobs-unified-top-card__company-name a",
      "div.job-details-jobs-unified-top-card__company-name a",
      "a.job-details-jobs-unified-top-card__company-name",
      "span.job-details-jobs-unified-top-card__company-name",
      "a.jobs-unified-top-card__company-name",
      "span.jobs-unified-top-card__company-name",
      "a[data-test-job-company-name]",
      ".job-details-jobs-unified-top-card__primary-description-without-tagline a",
      ".jobs-unified-top-card__subtitle-primary-grouping a",
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && el.innerText.trim()) {
        return el;
      }
    }
    return null;
  };

  const findJobDetails = () =>
    document.querySelector("#job-details, .jobs-box__html-content");

  const extractJobText = () => {
    const details = findJobDetails();
    return details ? details.innerText.trim() : "";
  };

  const extractJobMeta = () => {
    const titleEl = findJobTitle();
    const companyEl = findCompanyName();
    const title = titleEl?.innerText?.trim() || "";
    const company = companyEl?.innerText?.trim() || "";
    log("Extracted meta", { title, company });
    return { title, company };
  };

  /* ── Hiring team extraction ──────────────────────────────────────── */

  const extractHiringTeam = () => {
    let section = null;

    // Helper: check if a candidate section actually contains "hiring team"
    // content. LinkedIn reuses .job-details-people-who-can-help for
    // "People in your network", "School alumni", etc. — we must filter.
    const isHiringTeamSection = (el) => {
      if (!el) return false;
      const headings = el.querySelectorAll("h2, h3, h4");
      for (const h of headings) {
        const txt = h.textContent.trim().toLowerCase();
        if (txt.includes("hiring team")) return true;
      }
      return false;
    };

    // Strategy 1: Find ALL sections with the shared class, then pick the
    // one that actually has a "hiring team" heading.
    const candidates = document.querySelectorAll(
      ".job-details-people-who-can-help__section--two-pane, " +
        ".job-details-people-who-can-help, " +
        "[class*='hiring-team']",
    );
    for (const el of candidates) {
      if (isHiringTeamSection(el)) {
        section = el;
        break;
      }
    }

    // Strategy 2: Find heading text and walk UP to a container that holds
    // the recruiter link.
    if (!section) {
      const headings = document.querySelectorAll("h2, h3");
      for (const h of headings) {
        const txt = h.textContent.trim().toLowerCase();
        if (
          txt.includes("meet the hiring team") ||
          txt.includes("hiring team")
        ) {
          // Preferred: artdeco-card wraps the whole section
          section =
            h.closest("[class*='artdeco-card']") || h.closest("section");
          // If those fail, walk up until we find a parent that contains an /in/ link
          if (!section) {
            let parent = h.parentElement;
            for (let i = 0; i < 6 && parent; i++) {
              if (parent.querySelector('a[href*="/in/"]')) {
                section = parent;
                break;
              }
              parent = parent.parentElement;
            }
          }
          // Last resort: use grandparent of heading
          if (!section) {
            section = h.parentElement?.parentElement || h.parentElement;
          }
          break;
        }
      }
    }

    if (!section) {
      log("No hiring team section found");
      return null;
    }

    log("Hiring team section found, HTML length:", section.innerHTML.length);

    // ── Extract recruiter profile link (very permissive) ──
    let linkEl = section.querySelector(
      'a[href*="/in/"][data-test-app-aware-link]',
    );
    if (!linkEl) {
      linkEl = section.querySelector('a[href*="/in/"]');
    }
    const linkedinUrl = linkEl?.href || "";
    const linkedinId = linkedinUrl
      ? linkedinUrl.match(/\/in\/([^/?]+)/)?.[1] || ""
      : "";

    // ── Extract recruiter name — 6 cascading strategies ──
    let name = "";

    // 1. Standard LinkedIn class selectors
    const nameEl = section.querySelector(
      ".jobs-poster__name strong, " +
        "span.jobs-poster__name strong, " +
        ".hirer-card__hirer-information strong, " +
        "span.text-body-medium-bold strong",
    );
    if (nameEl) {
      name = nameEl.innerText?.trim() || "";
    }

    // 2. Any <strong> in the section that looks like a person's name
    if (!name) {
      const strongEls = section.querySelectorAll("strong");
      for (const el of strongEls) {
        const text = el.innerText?.trim() || "";
        if (
          text &&
          text.length > 1 &&
          text.length < 60 &&
          !text.includes("\n")
        ) {
          name = text;
          break;
        }
      }
    }

    // 3. aria-label on the recruiter link ("View Jane Doe's verified profile")
    if (!name && linkEl) {
      const ariaLabel = linkEl.getAttribute("aria-label") || "";
      const ariaMatch = ariaLabel.match(/View\s+(.+?)(?:[\u2019']s|'s)/i);
      if (ariaMatch) name = ariaMatch[1].trim();
    }

    // 4. img alt attribute inside the link
    if (!name && linkEl) {
      const img = linkEl.querySelector("img[alt]");
      if (img && img.alt.trim() && img.alt.trim().length < 60) {
        name = img.alt.trim();
      }
    }

    // 5. Any img alt in the section that looks like a person name
    if (!name) {
      const imgs = section.querySelectorAll("img[alt]");
      for (const img of imgs) {
        const alt = img.alt?.trim() || "";
        if (
          alt &&
          alt.length > 1 &&
          alt.length < 60 &&
          !alt.toLowerCase().includes("logo") &&
          !alt.toLowerCase().includes("company")
        ) {
          name = alt;
          break;
        }
      }
    }

    // 6. Visible text inside the link element itself (first line)
    if (!name && linkEl) {
      const linkText = linkEl.innerText?.trim()?.split("\n")[0]?.trim() || "";
      if (linkText && linkText.length > 1 && linkText.length < 60) {
        name = linkText;
      }
    }

    // ── Extract connection degree ──
    const degreeEl = section.querySelector(
      ".hirer-card__connection-degree, span[class*='connection-degree']",
    );
    const connectionDegree = degreeEl?.innerText?.trim() || "";

    // ── Extract recruiter title/role ──
    const roleEl = section.querySelector(
      ".hirer-card__hirer-information .linked-area .text-body-small, " +
        ".hirer-card__hirer-information .t-black:not(.jobs-poster__name)",
    );
    const role = roleEl?.innerText?.trim() || "";

    if (!name && !linkedinUrl) {
      log("Hiring team section found but no recruiter data could be extracted");
      log("Section text preview:", section.innerText?.slice(0, 200));
      return null;
    }

    log("Extracted hiring team:", {
      name,
      linkedinId,
      linkedinUrl,
      connectionDegree,
      role,
    });
    return {
      available: true,
      name,
      linkedinUrl,
      linkedinId,
      connectionDegree,
      role,
    };
  };

  /* ── Apply type detection ──────────────────────────────────────── */

  const detectApplyType = () => {
    // Look for the actual apply button by id
    const applyBtn = document.querySelector("#jobs-apply-button-id");
    if (applyBtn) {
      const ariaLabel = applyBtn.getAttribute("aria-label") || "";
      const btnText = applyBtn.innerText?.trim() || "";

      if (ariaLabel.includes("Easy Apply") || btnText.includes("Easy Apply")) {
        return "EasyApply";
      }
      if (
        ariaLabel.includes("Apply to") ||
        ariaLabel.includes("on company website") ||
        btnText.trim() === "Apply"
      ) {
        return "ExternalApply";
      }
    }

    // Fallback: search for any Easy Apply text
    const allBtns = document.querySelectorAll("button");
    for (const btn of allBtns) {
      if (btn.innerText?.includes("Easy Apply")) return "EasyApply";
    }

    return "Unknown";
  };

  /* ── Save job ──────────────────────────────────────────────────── */

  const clickSaveButton = async () => {
    // Find the job-specific Save button. LinkedIn uses a toggle:
    // unsaved → "Save" / saved → "Saved" (with aria-label "Unsave job").
    // We MUST avoid clicking an already-saved button (that would unsave it).
    const saveBtn = document.querySelector(
      "button.jobs-save-button, " +
        'button[data-control-name="save_job"], ' +
        'button[aria-label*="Save"][aria-label*="job" i], ' +
        'button[aria-label*="Unsave"][aria-label*="job" i], ' +
        'button[aria-label*="Save"]',
    );

    if (!saveBtn) {
      log("Save button not found");
      return false;
    }

    const label = (saveBtn.getAttribute("aria-label") || "").toLowerCase();
    const text = (saveBtn.innerText || "").trim().toLowerCase();
    const ariaPressed = saveBtn.getAttribute("aria-pressed") === "true";

    log("Save button state:", { label, text, ariaPressed });

    // Already saved — do nothing.
    if (
      label.includes("unsave") ||
      text === "saved" ||
      text.includes("unsave") ||
      ariaPressed
    ) {
      log("Job is already saved — skipping to avoid toggling off");
      return true;
    }

    saveBtn.click();
    log("Clicked Save button");
    await sleep(800);
    return true;
  };

  /* ── Easy Apply flow ───────────────────────────────────────────── */

  const runEasyApply = async () => {
    const applyBtn = document.querySelector("#jobs-apply-button-id");
    if (!applyBtn) {
      log("Easy Apply button not found");
      return { success: false, status: "NoButton" };
    }

    applyBtn.click();
    log("Clicked Easy Apply button");
    await sleepRandom(1500, 2500);

    // Wait for the Easy Apply modal/form to appear
    const form = await waitForElementSafe(
      ".jobs-easy-apply-content, .jobs-easy-apply-modal, " +
        "div[data-test-modal] form, div.artdeco-modal form",
      8000,
    );

    if (!form) {
      log("Easy Apply form did not appear");
      return { success: false, status: "NoForm" };
    }

    // Step through the multi-page form
    const MAX_STEPS = 10;
    for (let step = 0; step < MAX_STEPS; step++) {
      await sleep(800);

      // Check for Submit button (final step)
      const submitBtn = document.querySelector(
        'button[aria-label="Submit application"], ' +
          "button[data-live-test-easy-apply-submit-button]",
      );
      if (submitBtn) {
        submitBtn.click();
        log("Clicked Submit Application");
        await sleepRandom(1500, 2500);

        // Handle "Application sent" dialog → click Done
        await waitForElementSafe(".artdeco-modal__actionbar", 5000);
        const doneBtns = document.querySelectorAll(
          ".artdeco-modal__actionbar button",
        );
        for (const btn of doneBtns) {
          if (btn.innerText.trim() === "Done") {
            btn.click();
            log("Clicked Done on post-apply dialog");
            await sleep(800);
            break;
          }
        }

        return { success: true, status: "Applied" };
      }

      // Check for Review button (second-to-last step)
      const reviewBtn = document.querySelector(
        'button[aria-label="Review your application"], ' +
          "button[data-live-test-easy-apply-review-button]",
      );
      if (reviewBtn) {
        const hasBlockers = detectEmptyRequiredFields();
        if (hasBlockers) {
          log("Blockers detected at review step — saving");
          return await dismissAndSaveApplication();
        }
        reviewBtn.click();
        log("Clicked Review");
        await sleepRandom(1000, 2000);
        continue;
      }

      // Check for Next button
      const nextBtn = document.querySelector(
        'button[aria-label="Continue to next step"], ' +
          "button[data-easy-apply-next-button], " +
          "button[data-live-test-easy-apply-next-button]",
      );

      if (nextBtn) {
        const hasBlockers = detectEmptyRequiredFields();
        if (hasBlockers) {
          log("Blockers detected — saving application");
          return await dismissAndSaveApplication();
        }
        nextBtn.click();
        log("Clicked Next (step", step + 1, ")");
        await sleepRandom(1200, 2200);
        continue;
      }

      // No actionable button found
      log("No Next/Review/Submit button found at step", step);
      break;
    }

    // If we got here without submitting — dismiss and save
    log("Easy Apply loop ended without submit — saving");
    return await dismissAndSaveApplication();
  };

  const detectEmptyRequiredFields = () => {
    const requiredInputs = document.querySelectorAll(
      ".artdeco-modal input[required], .artdeco-modal select[required], " +
        "form input[required], form select[required]",
    );

    for (const input of requiredInputs) {
      const value = input.value?.trim() || "";
      if (!value || value === "Select an option") {
        // Confirm it's within the visible easy-apply form
        const modal = input.closest(".artdeco-modal, .jobs-easy-apply-content");
        if (modal) {
          const label =
            input
              .closest("[data-test-form-element]")
              ?.querySelector("label")
              ?.innerText?.trim() ||
            input.getAttribute("aria-label") ||
            "";
          log("Empty required field:", label || input.id);
          return true;
        }
      }
    }
    return false;
  };

  const dismissAndSaveApplication = async () => {
    // Click Dismiss (X) button on the form modal
    const dismissBtn = document.querySelector(
      ".artdeco-modal__dismiss[data-test-modal-close-btn], " +
        'button[aria-label="Dismiss"]',
    );
    if (dismissBtn) {
      dismissBtn.click();
      log("Clicked Dismiss");
      await sleepRandom(800, 1200);
    }

    // Handle "Save this application?" dialog — click Save
    const saveDialogBtn = await waitForElementSafe(
      'button[data-control-name="save_application_btn"], ' +
        ".artdeco-modal__confirm-dialog-btn[data-test-dialog-primary-btn]",
      4000,
    );
    if (saveDialogBtn) {
      saveDialogBtn.click();
      log("Clicked Save in discard/save dialog");
      await sleep(800);
    }

    return { success: false, status: "InProcess" };
  };

  /* ── Recruiter connection flow ─────────────────────────────────── */

  const connectWithRecruiter = async (
    hrDetails,
    jobMeta,
    jobDescription,
    yearsRequired,
  ) => {
    if (!hrDetails?.linkedinUrl) {
      log("No recruiter URL to connect with");
      return "NoRecruiter";
    }

    // Delegate to background.js which opens a NEW tab for the profile page.
    // This keeps scraper.js alive in the current tab.
    log(
      "Requesting recruiter connection via background:",
      hrDetails.linkedinUrl,
    );
    const result = await sendMessage({
      action: "CONNECT_WITH_RECRUITER",
      hrDetails,
      jobMeta: { title: jobMeta.title, company: jobMeta.company },
      jobDescription: (jobDescription || "").slice(0, 500),
      yearsRequired: yearsRequired || 0,
    });

    const status = result?.connectionStatus || "ConnectFailed";
    log("Recruiter connection result:", status);
    return status;
  };

  /* ── Notification ──────────────────────────────────────────────── */

  const showNotification = (message, duration = 4000) => {
    const existing = document.getElementById("getemployed-notification");
    if (existing) existing.remove();

    const notification = document.createElement("div");
    notification.id = "getemployed-notification";
    notification.style.cssText = `
      position: fixed;
      top: 20px;
      right: 20px;
      background: #2a6f5a;
      color: white;
      padding: 16px 24px;
      border-radius: 8px;
      font-size: 14px;
      font-weight: 500;
      z-index: 10000;
      box-shadow: 0 4px 12px rgba(0,0,0,0.2);
      font-family: "Segoe UI", Tahoma, Geneva, sans-serif;
      border-left: 4px solid #1d5c46;
    `;
    notification.textContent = message;
    document.body.appendChild(notification);
    setTimeout(() => {
      if (notification.parentElement) notification.remove();
    }, duration);
  };

  /* ── Main job processing ───────────────────────────────────────── */

  async function ensureJobListPage() {
    const showAll = findShowAllButton();
    if (showAll) {
      showAll.click();
      await sleepRandom(2000, 3500);
    }
    await waitForElement("li[data-occludable-job-id]");
  }

  async function processJobCard(jobCard, index) {
    scrollToJobCard(jobCard);
    await sleep(500);

    const link = jobCard.querySelector('a[href*="/jobs/view/"]');
    if (link) {
      link.click();
    } else {
      jobCard.click();
    }

    await sleepRandom(1500, 3200);
    await waitForElementSafe("#job-details, .jobs-box__html-content", 10000);

    // ── Stop check: after page load ──
    if (stopRequested) {
      log("Stop requested — aborting card early (after load)");
      return;
    }

    const jobDescription = extractJobText();
    if (!jobDescription) {
      log("No job description found for card", index + 1);
      return;
    }

    const meta = extractJobMeta();

    // ── Stop check: after meta extraction ──
    if (stopRequested) {
      log("Stop requested — aborting card after meta extract");
      return;
    }

    const state = await getState();
    const eligibilityMaxYears = Number(state.eligibilityMaxYears || 0);

    // Extract experience via Ollama (can take several seconds)
    const response = await sendMessage({
      action: "OLLAMA_EXTRACT_EXPERIENCE",
      jobDescription,
    });

    // ── Stop check: after Ollama call ──
    if (stopRequested) {
      log("Stop requested — aborting card after Ollama call");
      return;
    }

    const years = response?.ok
      ? (response.parsed?.required_experience_years ?? 0)
      : 0;

    // Extract hiring team info
    const hrDetails = extractHiringTeam() || { available: false };

    // Detect apply type
    const applyType = detectApplyType();

    // Determine eligibility (0 means no threshold set — always eligible)
    const isEligible =
      eligibilityMaxYears === 0 || years <= eligibilityMaxYears;

    log("Job analysis:", {
      title: meta.title,
      years,
      applyType,
      hrAvailable: !!hrDetails?.available,
      eligible: isEligible,
    });

    let status = "Extracted";
    let connectionStatus = "";

    // ── Stop check: before apply/save actions ──
    if (stopRequested) {
      log("Stop requested — saving partial record before apply");
      status = "Stopped";
    } else if (isEligible) {
      if (applyType === "EasyApply") {
        const result = await runEasyApply();
        status = result.status || (result.success ? "Applied" : "InProcess");
        log("Easy Apply result:", status);
      } else if (applyType === "ExternalApply") {
        await clickSaveButton();
        status = "Saved";
        log("External apply — saved for later");
      } else {
        await clickSaveButton();
        status = "Saved";
      }
    } else {
      // Not eligible — save but don't apply
      await clickSaveButton();
      status = "Saved-NotEligible";
      log(
        "Not eligible (needs",
        years,
        "yrs, max",
        eligibilityMaxYears,
        ") — saved",
      );
    }

    // ── Stop check: before recruiter connection (longest operation) ──
    if (!stopRequested && hrDetails?.available && hrDetails.linkedinUrl) {
      // Skip 1st-degree connections — already connected, no need to send invite
      const degree = (hrDetails.connectionDegree || "").trim();
      if (degree === "1st") {
        log(
          "Recruiter is 1st-degree (already connected) — skipping connection request",
        );
        connectionStatus = "AlreadyConnected";
      } else {
        connectionStatus = await connectWithRecruiter(
          hrDetails,
          meta,
          jobDescription,
          years,
        );
      }
    } else if (stopRequested && hrDetails?.available) {
      log("Stop requested — skipping recruiter connection");
    }

    // Save record (always, even when stopped)
    await appendRecord({
      timestamp: Date.now(),
      company: meta.company,
      jobTitle: meta.title,
      applyType,
      status,
      experienceRequired: years,
      jobDescription: jobDescription.slice(0, 500),
      hrDetails: hrDetails?.available
        ? {
            available: true,
            name: hrDetails.name,
            linkedinId: hrDetails.linkedinId,
            linkedinUrl: hrDetails.linkedinUrl,
            connectionDegree: hrDetails.connectionDegree,
            role: hrDetails.role,
            connectionStatus: connectionStatus || "",
          }
        : { available: false },
    });

    log("Processed:", {
      title: meta.title,
      status,
      years,
      applyType,
      connectionStatus,
    });
  }

  /* ── Main scrape loop ──────────────────────────────────────────── */

  async function runScrape() {
    if (isRunning) {
      log("Scrape already running");
      return;
    }

    isRunning = true;
    stopRequested = false;
    const processedJobIds = new Set();
    let processedCount = 0;
    let currentPage = 1;
    let consecutiveNoNewJobs = 0;

    try {
      await ensureJobListPage();
      const state = await getState();
      const maxJobs =
        Number(state.maxJobs || DEFAULT_MAX_JOBS) || DEFAULT_MAX_JOBS;
      log(`Starting scrape run — maxJobs=${maxJobs}`);

      while (processedCount < maxJobs && !stopRequested) {
        // Re-query the DOM every iteration (LinkedIn virtualises the list)
        const cards = findJobCards();
        if (cards.length === 0) {
          log("No job cards found");
          break;
        }

        const unprocessedCards = cards.filter((card) => {
          const jobId = card.getAttribute("data-occludable-job-id");
          return jobId && !processedJobIds.has(jobId);
        });

        log(
          `Found ${cards.length} total cards, ${unprocessedCards.length} unprocessed (processed so far: ${processedCount})`,
        );

        if (unprocessedCards.length === 0) {
          consecutiveNoNewJobs++;

          if (consecutiveNoNewJobs >= 5) {
            // Try next page
            const nextBtn = findNextPageButton();
            if (nextBtn) {
              log(
                `No new jobs after scrolling. Going to page ${currentPage + 1}`,
              );
              nextBtn.click();
              await sleepRandom(2000, 4000);
              await waitForElementSafe("li[data-occludable-job-id]", 10000);
              currentPage++;
              consecutiveNoNewJobs = 0;
              continue;
            } else {
              log("No more pages / jobs to process");
              break;
            }
          }

          log("Scrolling to reveal more jobs...");
          await scrollJobListIncremental();
          await sleepRandom(1000, 2000);
          continue;
        }

        consecutiveNoNewJobs = 0;

        // Process ONE card, then loop back to re-query the DOM
        // (other card references may be stale due to virtualisation)
        const card = unprocessedCards[0];
        const jobId = card.getAttribute("data-occludable-job-id");
        processedJobIds.add(jobId);

        if (stopRequested) {
          log("Stop requested — breaking before processing");
          break;
        }

        try {
          await processJobCard(card, processedCount);
        } catch (err) {
          log("Error processing job card:", err.message);
        }
        processedCount++;

        if (processedCount >= maxJobs) {
          log(`Max jobs limit (${maxJobs}) reached!`);
          showNotification(
            `✅ Processed ${processedCount} jobs (limit reached)`,
            5000,
          );
          break;
        }

        // Scroll the processed card into view so next card gets revealed
        await scrollJobListIncremental();
        await sleepRandom(1200, 2600);
      }

      if (stopRequested) {
        log("Scrape stopped by user");
        showNotification("⏸️ Scraping stopped by user", 3000);
      } else if (processedCount > 0 && processedCount < maxJobs) {
        log(
          `Scrape completed. Processed ${processedCount} jobs (reached end of listings).`,
        );
        showNotification(
          `✅ Scrape complete — ${processedCount} jobs processed`,
          4000,
        );
      }
    } catch (error) {
      log("Scrape failed:", error.message);
    } finally {
      stopRequested = true; // Prevent URL watcher from auto-restarting
      isRunning = false;
      // Reset the running flag in storage so UI stays consistent
      sendMessage({ action: "SET_STATE", patch: { isAgentRunning: false } });
    }
  }

  /* ── Bootstrap ─────────────────────────────────────────────────── */

  log("Loaded on", window.location.href);
  chrome.runtime.sendMessage({
    action: "SCRAPER_READY",
    url: window.location.href,
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.action === "START_SCRAPE") {
      stopRequested = false;
      runScrape();
    }
    if (message.action === "STOP_SCRAPE") {
      log("Received STOP_SCRAPE — flagging stop");
      stopRequested = true;
    }
    if (message.action === "RELAY_LOG") {
      // Debug logs relayed from background.js about the recruiter dialog
      log("[bg-relay]", ...(message.args || []));
    }
  });

  // Watch for URL changes (SPA navigation)
  let lastUrl = window.location.href;
  const checkUrlChange = () => {
    const currentUrl = window.location.href;
    if (currentUrl !== lastUrl) {
      log("URL changed from", lastUrl, "to", currentUrl);
      lastUrl = currentUrl;

      if (currentUrl.includes("/jobs/")) {
        getState().then((state) => {
          if (state.isAgentRunning && !isRunning && !stopRequested) {
            log("Auto-starting scraper on jobs page");
            runScrape();
          }
        });
      }
    }
  };

  setInterval(checkUrlChange, 1000);

  getState().then((state) => {
    if (state.isAgentRunning) {
      runScrape();
    }
  });
})();
