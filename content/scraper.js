(() => {
  const log = (...args) => console.log("[GetEmployed][scraper]", ...args);
  const DEFAULT_MAX_JOBS = 25;
  let isRunning = false;

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

  const findShowAllButton = () =>
    document.querySelector('a[aria-label^="Show all jobs"]');

  const findJobCards = () =>
    Array.from(document.querySelectorAll("li[data-occludable-job-id]"));

  const findJobListContainer = () => {
    // LinkedIn's left panel with job listings - try multiple selectors
    const selectors = [
      ".scaffold-layout__list", // Main left list container
      ".scaffold-layout__list-container",
      "div.scaffold-layout__list > ul",
      "ul.reusable-search__list", // Reusable search module
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

    // Fallback: find the scrollable parent of job cards
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

  const scrollJobListToBottom = async () => {
    const container = findJobListContainer();
    if (!container) {
      log("Could not find job list container to scroll");
      return;
    }

    const currentScrollTop = container.scrollTop;
    container.scrollTop = container.scrollHeight;
    await sleep(700);

    if (container.scrollTop === currentScrollTop) {
      log("Warning: Container did not scroll (may already be at bottom)");
    } else {
      log("Scrolled left panel to bottom");
    }
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

  const sendExperienceExtraction = (jobDescription) =>
    new Promise((resolve) => {
      chrome.runtime.sendMessage(
        { action: "OLLAMA_EXTRACT_EXPERIENCE", jobDescription },
        (response) => resolve(response),
      );
    });

  async function ensureJobListPage() {
    const showAll = findShowAllButton();
    if (showAll) {
      showAll.click();
      await sleepRandom(2000, 3500);
    }
    await waitForElement("li[data-occludable-job-id]");
  }

  async function processJobCard(jobCard, index) {
    // Scroll to make the job card visible
    scrollToJobCard(jobCard);
    await sleep(500);

    const link = jobCard.querySelector('a[href*="/jobs/view/"]');
    if (link) {
      link.click();
    } else {
      jobCard.click();
    }

    await sleepRandom(1500, 3200);
    await waitForElement("#job-details, .jobs-box__html-content");

    const jobDescription = extractJobText();
    if (!jobDescription) {
      log("No job description found", index + 1);
      return;
    }

    const meta = extractJobMeta();
    const response = await sendExperienceExtraction(jobDescription);

    if (!response || !response.ok) {
      log("Extraction failed", response?.error || "Unknown error");
      return;
    }

    const years = response.parsed?.required_experience_years ?? 0;
    await appendRecord({
      timestamp: Date.now(),
      company: meta.company,
      jobTitle: meta.title,
      applyType: "Unknown",
      status: "Extracted",
      experienceRequired: years,
      hrDetails: { available: false },
    });

    log("Extracted", { title: meta.title, years });
  }

  const showNotification = (message, duration = 4000) => {
    // Remove existing notification
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
      if (notification.parentElement) {
        notification.remove();
      }
    }, duration);
  };

  async function runScrape() {
    if (isRunning) {
      log("Scrape already running");
      return;
    }

    isRunning = true;
    const processedJobIds = new Set();
    let processedCount = 0;
    let currentPage = 1;
    let consecutiveNoNewJobs = 0;

    try {
      await ensureJobListPage();
      const state = await getState();
      const maxJobs =
        Number(state.maxJobs || DEFAULT_MAX_JOBS) || DEFAULT_MAX_JOBS;

      while (processedCount < maxJobs) {
        // Check if agent is still running
        const latest = await getState();
        if (!latest.isAgentRunning) {
          log("Agent stopped by user");
          break;
        }

        // Get current visible job cards
        const cards = findJobCards();
        if (cards.length === 0) {
          log("No job cards found");
          break;
        }

        // Filter out already processed jobs
        const unprocessedCards = cards.filter((card) => {
          const jobId = card.getAttribute("data-occludable-job-id");
          return jobId && !processedJobIds.has(jobId);
        });

        log(
          `Found ${cards.length} total cards, ${unprocessedCards.length} unprocessed`,
        );

        if (unprocessedCards.length === 0) {
          consecutiveNoNewJobs++;

          if (consecutiveNoNewJobs >= 3) {
            // Try next page or exit
            const nextBtn = findNextPageButton();
            if (nextBtn) {
              log(
                `No new jobs on current page. Going to page ${currentPage + 1}`,
              );
              nextBtn.click();
              await sleepRandom(2000, 4000);
              await waitForElement("li[data-occludable-job-id]");
              currentPage++;
              consecutiveNoNewJobs = 0;
              continue;
            } else {
              log("No more jobs to process");
              break;
            }
          }

          // Try scrolling to load more jobs
          log("Scrolling to load more jobs...");
          await scrollJobListToBottom();
          await sleepRandom(1500, 2500);
          continue;
        }

        consecutiveNoNewJobs = 0;

        // Process unprocessed jobs
        for (const card of unprocessedCards) {
          if (processedCount >= maxJobs) {
            log(`Max jobs limit (${maxJobs}) reached!`);
            showNotification(
              `✅ Processed ${processedCount} jobs (limit reached)`,
              5000,
            );
            break;
          }

          const latest2 = await getState();
          if (!latest2.isAgentRunning) {
            log("Agent stopped by user");
            showNotification("⏸️ Scraping stopped by user", 3000);
            break;
          }

          const jobId = card.getAttribute("data-occludable-job-id");
          processedJobIds.add(jobId);

          await processJobCard(card, processedCount);
          processedCount++;
          await sleepRandom(1200, 2600);
        }
      }

      if (processedCount < maxJobs) {
        log(
          `Scrape completed. Processed ${processedCount} jobs (reached end of listings).`,
        );
        showNotification(
          `✅ Scrape complete - ${processedCount} jobs processed`,
          4000,
        );
      }
    } catch (error) {
      log("Scrape failed", error.message);
    } finally {
      isRunning = false;
    }
  }

  log("Loaded on", window.location.href);
  chrome.runtime.sendMessage({
    action: "SCRAPER_READY",
    url: window.location.href,
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message.action === "START_SCRAPE") {
      runScrape();
    }
  });

  // Watch for URL changes (for SPA navigation)
  let lastUrl = window.location.href;
  const checkUrlChange = () => {
    const currentUrl = window.location.href;
    if (currentUrl !== lastUrl) {
      log("URL changed from", lastUrl, "to", currentUrl);
      lastUrl = currentUrl;

      // Check if we're on a jobs page and agent is running
      if (currentUrl.includes("/jobs/")) {
        getState().then((state) => {
          if (state.isAgentRunning && !isRunning) {
            log("Auto-starting scraper on jobs page");
            runScrape();
          }
        });
      }
    }
  };

  // Poll for URL changes every 1 second
  setInterval(checkUrlChange, 1000);

  // Initial run check
  getState().then((state) => {
    if (state.isAgentRunning) {
      runScrape();
    }
  });
})();
