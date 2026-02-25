(() => {
  const log = (...args) => console.log("[GetEmployed][apply]", ...args);

  log("Loaded on", window.location.href);
  chrome.runtime.sendMessage({
    action: "APPLY_READY",
    url: window.location.href,
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message.action === "START_APPLY_FLOW") {
      log("Start apply flow placeholder");
    }
  });
})();
