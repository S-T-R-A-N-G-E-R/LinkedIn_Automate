(() => {
  const log = (...args) => console.log("[GetEmployed][profile]", ...args);

  log("Loaded on", window.location.href);
  chrome.runtime.sendMessage({
    action: "PROFILE_READY",
    url: window.location.href,
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message.action === "START_PROFILE_FLOW") {
      log("Start profile flow placeholder");
    }
  });
})();
