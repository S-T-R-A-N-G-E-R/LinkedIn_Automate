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
const recruiterSearchInput = document.getElementById("recruiter-search");
const recruiterSearchBtn = document.getElementById("recruiter-search-btn");
const recruiterResults = document.getElementById("recruiter-results");

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
      "hrAvailable",
      "recruiterName",
      "recruiterLinkedIn",
      "recruiterRole",
      "connectionDegree",
      "connectionStatus",
      "messageGenerated",
      "messageTimestamp",
    ];

    const rows = records.map((record) => [
      record.timestamp ? new Date(record.timestamp).toISOString() : "",
      record.company || "",
      record.jobTitle || "",
      record.applyType || "",
      record.status || "",
      record.experienceRequired ?? "",
      record.hrDetails?.available ? "Yes" : "No",
      record.hrDetails?.name || "",
      record.hrDetails?.linkedinId || "",
      record.hrDetails?.role || "",
      record.hrDetails?.connectionDegree || "",
      record.hrDetails?.connectionStatus || "",
      record.messageGenerated ? "Yes" : "No",
      record.messageTimestamp
        ? new Date(record.messageTimestamp).toISOString()
        : "",
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

/* ── Recruiter Search & Message Generator ───────────────────────── */

function searchRecruiters(query) {
  const q = query.trim().toLowerCase();
  console.log("[Recruiter Search] query:", q);
  if (!q) {
    recruiterResults.classList.add("hidden");
    return;
  }

  chrome.storage.local.get({ applicationRecords: [] }, (data) => {
    const records = data.applicationRecords || [];
    console.log("[Recruiter Search] Total records:", records.length);
    console.log(
      "[Recruiter Search] Records with hrDetails:",
      records.filter((r) => r.hrDetails?.available && r.hrDetails?.name).length,
    );

    // Find all records where recruiter name matches the query
    const matches = records.filter((r) => {
      if (!r.hrDetails?.available || !r.hrDetails?.name) return false;
      return r.hrDetails.name.toLowerCase().includes(q);
    });

    console.log("[Recruiter Search] Matches found:", matches.length);
    if (matches.length > 0) {
      console.log(
        "[Recruiter Search] First match:",
        matches[0].hrDetails?.name,
        matches[0].company,
        matches[0].status,
      );
    }
    renderRecruiterResults(matches);
  });
}

function badgeClass(status) {
  const s = (status || "").toLowerCase();
  if (s === "applied") return "badge--applied";
  if (s.includes("save")) return "badge--saved";
  if (s.includes("inprocess") || s.includes("in process"))
    return "badge--inprocess";
  return "badge--other";
}

function renderRecruiterResults(matches) {
  recruiterResults.innerHTML = "";

  if (!matches.length) {
    recruiterResults.innerHTML =
      '<p class="no-results">No matching recruiters found in your records.</p>';
    recruiterResults.classList.remove("hidden");
    return;
  }

  // Group by recruiter name + linkedinId for dedup display
  const grouped = {};
  for (const rec of matches) {
    const key = rec.hrDetails.linkedinId || rec.hrDetails.name;
    if (!grouped[key]) {
      grouped[key] = {
        name: rec.hrDetails.name,
        linkedinId: rec.hrDetails.linkedinId,
        linkedinUrl: rec.hrDetails.linkedinUrl,
        role: rec.hrDetails.role,
        connectionDegree: rec.hrDetails.connectionDegree,
        connectionStatus: rec.hrDetails.connectionStatus,
        jobs: [],
      };
    }
    grouped[key].jobs.push({
      company: rec.company,
      jobTitle: rec.jobTitle,
      status: rec.status,
      applyType: rec.applyType,
      experienceRequired: rec.experienceRequired,
      jobDescription: rec.jobDescription || "",
      timestamp: rec.timestamp,
      messageGenerated: rec.messageGenerated || false,
      generatedMessage: rec.generatedMessage || "",
    });
  }

  for (const [key, recruiter] of Object.entries(grouped)) {
    const card = document.createElement("div");
    card.className = "recruiter-card";

    // Sort jobs by timestamp (newest first)
    recruiter.jobs.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

    const jobRows = recruiter.jobs
      .map((j) => {
        const date = j.timestamp
          ? new Date(j.timestamp).toLocaleDateString()
          : "—";
        const badge = `<span class="recruiter-card__badge ${badgeClass(j.status)}">${j.status}</span>`;
        return `<span>${j.jobTitle} @ ${j.company} · ${j.applyType} · Exp: ${j.experienceRequired ?? "?"}yr · ${date} ${badge}</span>`;
      })
      .join("");

    const connStatus = recruiter.connectionStatus
      ? `Connection: ${recruiter.connectionStatus}`
      : "Connection: —";

    card.innerHTML = `
      <div class="recruiter-card__name">${escHtml(recruiter.name)}</div>
      <div class="recruiter-card__meta">
        <span>${escHtml(recruiter.role || "—")}</span>
        <span>${escHtml(recruiter.connectionDegree || "?")} degree · ${connStatus}</span>
        ${jobRows}
      </div>
      <div class="recruiter-card__actions">
        <button class="btn-generate" data-recruiter-key="${escAttr(key)}">Generate Message</button>
        ${recruiter.linkedinUrl ? `<button class="btn-open-profile" data-url="${escAttr(recruiter.linkedinUrl)}">Open Profile</button>` : ""}
      </div>
      <div class="recruiter-card__message hidden" data-msg-key="${escAttr(key)}"></div>
      <div class="recruiter-card__status" data-status-key="${escAttr(key)}"></div>
    `;

    // Show previously generated message if any
    const lastJob = recruiter.jobs.find((j) => j.generatedMessage);
    if (lastJob?.generatedMessage) {
      const msgDiv = card.querySelector(`[data-msg-key]`);
      msgDiv.textContent = lastJob.generatedMessage;
      msgDiv.classList.remove("hidden");
      // Add copy button
      const actionsDiv = card.querySelector(".recruiter-card__actions");
      const copyBtn = document.createElement("button");
      copyBtn.className = "btn-copy";
      copyBtn.textContent = "Copy Message";
      copyBtn.addEventListener("click", () => {
        navigator.clipboard.writeText(lastJob.generatedMessage);
        copyBtn.textContent = "Copied!";
        setTimeout(() => (copyBtn.textContent = "Copy Message"), 2000);
      });
      actionsDiv.appendChild(copyBtn);
    }

    // Generate message button
    card.querySelector(".btn-generate").addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      btn.textContent = "Generating...";

      const statusDiv = card.querySelector(`[data-status-key]`);
      const msgDiv = card.querySelector(`[data-msg-key]`);
      statusDiv.textContent = "Calling Ollama...";

      // Pick the most relevant job for the message
      // Prefer: Applied > InProcess > Saved
      const sortedJobs = [...recruiter.jobs].sort((a, b) => {
        const priority = { Applied: 3, InProcess: 2, Saved: 1 };
        const pa = priority[a.status] || 0;
        const pb = priority[b.status] || 0;
        return pb - pa;
      });
      const bestJob = sortedJobs[0];

      // Determine message type: eligible/applied => specific, else generic
      const state = await new Promise((resolve) =>
        chrome.storage.local.get(DEFAULT_STATE, resolve),
      );
      const maxYears = state.eligibilityMaxYears || 0;
      const wasEligible =
        maxYears === 0 || (bestJob.experienceRequired || 0) <= maxYears;
      const wasApplied =
        bestJob.status === "Applied" || bestJob.status === "InProcess";

      console.log("[Recruiter Msg] Sending GENERATE_RECRUITER_MESSAGE:", {
        recruiterName: recruiter.name,
        jobTitle: bestJob.jobTitle,
        company: bestJob.company,
        applicationStatus: bestJob.status,
        wasEligibleAndApplied: wasEligible && wasApplied,
        experienceRequired: bestJob.experienceRequired,
      });

      chrome.runtime.sendMessage(
        {
          action: "GENERATE_RECRUITER_MESSAGE",
          recruiterName: recruiter.name,
          jobTitle: bestJob.jobTitle,
          company: bestJob.company,
          jobDescription: bestJob.jobDescription,
          applicationStatus: bestJob.status,
          wasEligibleAndApplied: wasEligible && wasApplied,
          experienceRequired: bestJob.experienceRequired,
        },
        (response) => {
          console.log("[Recruiter Msg] Response:", response);
          btn.disabled = false;
          btn.textContent = "Generate Message";

          if (!response?.ok) {
            console.error("[Recruiter Msg] Error:", response?.error);
            statusDiv.textContent = `Error: ${response?.error || "Failed"}`;
            return;
          }

          const msg = response.message;
          msgDiv.textContent = msg;
          msgDiv.classList.remove("hidden");
          statusDiv.textContent =
            "Message generated! Copy and send on LinkedIn.";

          // Add/update copy button
          let copyBtn = card.querySelector(".btn-copy");
          if (!copyBtn) {
            copyBtn = document.createElement("button");
            copyBtn.className = "btn-copy";
            card.querySelector(".recruiter-card__actions").appendChild(copyBtn);
          }
          copyBtn.textContent = "Copy Message";
          copyBtn.onclick = () => {
            navigator.clipboard.writeText(msg);
            copyBtn.textContent = "Copied!";
            setTimeout(() => (copyBtn.textContent = "Copy Message"), 2000);
          };

          // Save generated message to records
          chrome.runtime.sendMessage({
            action: "UPDATE_RECORD_MESSAGE",
            linkedinId: recruiter.linkedinId,
            generatedMessage: msg,
          });
        },
      );
    });

    // Open profile button
    const openBtn = card.querySelector(".btn-open-profile");
    if (openBtn) {
      openBtn.addEventListener("click", () => {
        chrome.tabs.create({ url: openBtn.dataset.url, active: true });
      });
    }

    recruiterResults.appendChild(card);
  }

  recruiterResults.classList.remove("hidden");
}

function escHtml(str) {
  const d = document.createElement("div");
  d.textContent = str || "";
  return d.innerHTML;
}

function escAttr(str) {
  return (str || "").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// Event listeners
console.log("[Recruiter Search] Event listeners attached");
recruiterSearchBtn.addEventListener("click", () => {
  console.log("[Recruiter Search] Search button clicked");
  searchRecruiters(recruiterSearchInput.value);
});

recruiterSearchInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    searchRecruiters(recruiterSearchInput.value);
  }
});
