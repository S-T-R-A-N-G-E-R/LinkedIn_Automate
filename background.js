const OLLAMA_BASE_URL = "http://localhost:11434";

const DEFAULT_STATE = {
  isAgentRunning: false,
  premiumEnabled: false,
  selectedModel: "",
  eligibilityMaxYears: 0,
  maxJobs: 25,
};

const EXPERIENCE_PROMPT =
  "Extract the required years of experience from the following job description. " +
  'Return ONLY a JSON object in this exact format: {"required_experience_years": <number>}. ' +
  "If a range is given, provide the minimum. If not mentioned, output 0.\n\n" +
  "Job Description:\n";

function getState() {
  return new Promise((resolve) => {
    chrome.storage.local.get(DEFAULT_STATE, (state) => resolve(state));
  });
}

async function setState(patch) {
  const current = await getState();
  const next = { ...current, ...patch };
  await chrome.storage.local.set(next);
  return next;
}

async function fetchJson(path, options) {
  const response = await fetch(`${OLLAMA_BASE_URL}${path}`, options);
  if (!response.ok) {
    throw new Error(`Ollama request failed: ${response.status}`);
  }
  return response.json();
}

function parseJsonResponse(raw) {
  if (!raw) {
    throw new Error("Empty Ollama response");
  }

  if (typeof raw === "object") {
    return raw;
  }

  try {
    return JSON.parse(raw);
  } catch (error) {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) {
      throw new Error("No JSON object found in response");
    }
    return JSON.parse(match[0]);
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    switch (message.action) {
      case "GET_STATE": {
        const state = await getState();
        sendResponse({ ok: true, state });
        break;
      }
      case "SET_STATE": {
        const state = await setState(message.patch || {});
        sendResponse({ ok: true, state });
        break;
      }
      case "OLLAMA_TAGS": {
        const data = await fetchJson("/api/tags", { method: "GET" });
        sendResponse({ ok: true, data });
        break;
      }
      case "OLLAMA_GENERATE": {
        const payload = {
          model: message.model,
          prompt: message.prompt,
          stream: false,
          format: message.format || "json",
        };
        const data = await fetchJson("/api/generate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        sendResponse({ ok: true, data });
        break;
      }
      case "OLLAMA_EXTRACT_EXPERIENCE": {
        const jobDescription = message.jobDescription || "";
        if (!jobDescription.trim()) {
          sendResponse({ ok: false, error: "Missing job description" });
          break;
        }

        const state = await getState();
        const model = message.model || state.selectedModel;
        if (!model) {
          sendResponse({ ok: false, error: "No model selected" });
          break;
        }

        const payload = {
          model,
          prompt: `${EXPERIENCE_PROMPT}${jobDescription}`,
          stream: false,
          format: "json",
        };

        const data = await fetchJson("/api/generate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });

        const parsed = parseJsonResponse(data.response);
        const years = Number(parsed.required_experience_years || 0);
        sendResponse({
          ok: true,
          data,
          parsed: { required_experience_years: years },
        });
        break;
      }
      case "CLEAR_RECORDS": {
        await chrome.storage.local.set({ applicationRecords: [] });
        const verify = await chrome.storage.local.get({
          applicationRecords: [],
        });
        const remaining = (verify.applicationRecords || []).length;
        sendResponse({ ok: remaining === 0, remaining });
        break;
      }
      default: {
        sendResponse({ ok: false, error: "Unknown action" });
      }
    }
  })().catch((error) => {
    sendResponse({ ok: false, error: error.message });
  });

  return true;
});
