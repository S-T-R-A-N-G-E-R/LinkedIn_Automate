const DEFAULT_STATE = {
  isAgentRunning: false,
  premiumEnabled: false,
  selectedModel: "",
  eligibilityMaxYears: 0,
  maxJobs: 25,
};

const toggleButton = document.getElementById("toggle-agent");
const agentStatus = document.getElementById("agent-status");
const premiumToggle = document.getElementById("premium-toggle");
const modelSelect = document.getElementById("model-select");
const eligibilityInput = document.getElementById("eligibility-max");
const maxJobsInput = document.getElementById("max-jobs");
const exportButton = document.getElementById("export-csv");
const clearDataButton = document.getElementById("clear-data");
const exportStatus = document.getElementById("export-status");
const clearStatus = document.getElementById("clear-status");
const testButton = document.getElementById("test-extract");
const jdInput = document.getElementById("jd-input");
const testOutput = document.getElementById("test-output");

function updateUI(state) {
  toggleButton.textContent = state.isAgentRunning
    ? "Stop Agent"
    : "Start Agent";
  agentStatus.textContent = state.isAgentRunning ? "Running" : "Stopped";
  premiumToggle.checked = Boolean(state.premiumEnabled);
  eligibilityInput.value = state.eligibilityMaxYears || 0;
  maxJobsInput.value = state.maxJobs || 25;
}

function setState(patch) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ action: "SET_STATE", patch }, (response) =>
      resolve(response),
    );
  });
}

function loadState() {
  chrome.storage.local.get(DEFAULT_STATE, (state) => {
    console.log("Loaded state from storage:", state);
    updateUI(state);
    if (state.selectedModel) {
      modelSelect.value = state.selectedModel;
    }
  });
}

function populateModels() {
  chrome.runtime.sendMessage({ action: "OLLAMA_TAGS" }, (response) => {
    if (!response || !response.ok) {
      modelSelect.innerHTML = '<option value="">Ollama unavailable</option>';
      return;
    }

    const models = response.data.models || [];
    if (!models.length) {
      modelSelect.innerHTML = '<option value="">No models found</option>';
      return;
    }

    modelSelect.innerHTML = models
      .map((model) => `<option value="${model.name}">${model.name}</option>`)
      .join("");

    chrome.storage.local.get(DEFAULT_STATE, (state) => {
      if (state.selectedModel) {
        modelSelect.value = state.selectedModel;
      }
    });
  });
}

function exportCsv() {
  chrome.storage.local.get({ applicationRecords: [] }, (data) => {
    const records = data.applicationRecords || [];
    if (!records.length) {
      exportStatus.textContent = "No records to export.";
      return;
    }

    const headers = [
      "timestamp",
      "company",
      "jobTitle",
      "applyType",
      "status",
      "experienceRequired",
      "recruiterName",
      "recruiterProfile",
      "connectionStatus",
    ];

    const rows = records.map((record) => [
      record.timestamp || "",
      record.company || "",
      record.jobTitle || "",
      record.applyType || "",
      record.status || "",
      record.experienceRequired || "",
      record.hrDetails?.name || "",
      record.hrDetails?.linkedinId || "",
      record.hrDetails?.connectionStatus || "",
    ]);

    const csv = [headers, ...rows]
      .map((row) =>
        row.map((value) => `"${String(value).replace(/"/g, '""')}"`).join(","),
      )
      .join("\n");

    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    const timestamp = new Date()
      .toISOString()
      .replace(/[:.]/g, "-")
      .slice(0, -5);
    link.download = `getemployed-export-${timestamp}.csv`;
    link.click();
    URL.revokeObjectURL(url);
    exportStatus.textContent = `CSV downloaded (${records.length} records).`;
  });
}

toggleButton.addEventListener("click", async () => {
  const state = await new Promise((resolve) => {
    chrome.storage.local.get(DEFAULT_STATE, resolve);
  });
  const response = await setState({ isAgentRunning: !state.isAgentRunning });
  if (response?.ok) {
    updateUI(response.state);
  }
});

premiumToggle.addEventListener("change", async () => {
  const response = await setState({ premiumEnabled: premiumToggle.checked });
  if (response?.ok) {
    updateUI(response.state);
  }
});

modelSelect.addEventListener("change", async () => {
  const response = await setState({ selectedModel: modelSelect.value });
  console.log("Saved model:", modelSelect.value);
});

eligibilityInput.addEventListener("change", async () => {
  const value = Number(eligibilityInput.value || 0);
  console.log("Saving eligibility:", value);
  const response = await setState({ eligibilityMaxYears: value });
  console.log("Eligibility save response:", response);
  if (response?.ok) {
    updateUI(response.state);
  }
});

maxJobsInput.addEventListener("change", async () => {
  const value = Number(maxJobsInput.value || 25);
  console.log("Saving maxJobs:", value);
  const response = await setState({ maxJobs: value });
  console.log("MaxJobs save response:", response);
  if (response?.ok) {
    updateUI(response.state);
  }
});

exportButton.addEventListener("click", exportCsv);

// Two-click safety pattern (confirm() is broken in MV3 popups)
let clearPending = false;
let clearTimer = null;

clearDataButton.addEventListener("click", () => {
  if (!clearPending) {
    // First click: switch to confirmation state
    clearPending = true;
    clearDataButton.textContent = "⚠️ Click again to confirm";
    clearDataButton.style.background = "#e74c3c";
    clearStatus.textContent = "";

    // Auto-revert after 3 seconds if not confirmed
    clearTimer = setTimeout(() => {
      clearPending = false;
      clearDataButton.textContent = "Clear All Data";
      clearDataButton.style.background = "";
    }, 3000);
    return;
  }

  // Second click: actually clear via background script
  clearPending = false;
  clearTimeout(clearTimer);
  clearDataButton.textContent = "Clearing...";
  clearDataButton.disabled = true;

  chrome.runtime.sendMessage({ action: "CLEAR_RECORDS" }, (response) => {
    clearDataButton.disabled = false;
    clearDataButton.textContent = "Clear All Data";
    clearDataButton.style.background = "";

    if (chrome.runtime.lastError) {
      console.error("Clear failed:", chrome.runtime.lastError);
      clearStatus.textContent = "❌ Error clearing data";
      clearStatus.style.color = "#c73e1d";
      return;
    }

    if (response?.ok) {
      clearStatus.textContent = "✅ All data cleared!";
      clearStatus.style.color = "#2a6f5a";
      exportStatus.textContent = "";
      setTimeout(() => {
        clearStatus.textContent = "";
        clearStatus.style.color = "";
      }, 3000);
    } else {
      clearStatus.textContent = `⚠️ ${response?.remaining ?? "?"} records remain`;
      clearStatus.style.color = "#c73e1d";
    }
  });
});

testButton.addEventListener("click", () => {
  const jobDescription = jdInput.value.trim();
  if (!jobDescription) {
    testOutput.textContent = "Paste a job description first.";
    return;
  }

  testOutput.textContent = "Running extraction...";
  chrome.runtime.sendMessage(
    { action: "OLLAMA_EXTRACT_EXPERIENCE", jobDescription },
    (response) => {
      if (!response || !response.ok) {
        testOutput.textContent = response?.error || "Extraction failed.";
        return;
      }

      const years = response.parsed?.required_experience_years ?? 0;
      testOutput.textContent = `Required experience (min years): ${years}`;
    },
  );
});

loadState();
populateModels();
