function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sleepRandom(minMs, maxMs) {
  const delay = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  return sleep(delay);
}

function queryByAriaLabel(prefix) {
  return document.querySelector(`[aria-label^="${prefix}"]`);
}

function waitForElement(selector, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
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
}

window.GetEmployedDom = {
  sleep,
  sleepRandom,
  queryByAriaLabel,
  waitForElement,
};
