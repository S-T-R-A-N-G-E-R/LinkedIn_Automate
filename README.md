# GetEmployed: AI-Powered LinkedIn Job Application Agent

**Project:** GetEmployed

**Version:** 1.0.0 (Local Storage & Local LLM Edition)

**Target Architecture:** Google Chrome Extension (Manifest V3) + Local Ollama Server

GetEmployed is a browser-based AI agent designed to automate the LinkedIn job search, networking, and application pipeline. Operating natively within the browser, it navigates the DOM, extracts job descriptions, and leverages a local LLM to evaluate eligibility (e.g., matching ML/MLOps experience requirements) before automating outreach and application submissions.

## 🏗 System Architecture & Environment

### Prerequisites

- **Browser:** Google Chrome (latest).
- **Local LLM:** Ollama installed and running locally. Given the local inference relies on Apple Silicon (M2), models like `llama3:8b` or `mistral` are recommended for the optimal balance of speed and reasoning.
- **CORS Configuration:** Ollama must be configured to accept cross-origin requests from the Chrome Extension.
- Launch Ollama with the environment variable: `OLLAMA_ORIGINS="chrome-extension://*"`

### File Structure

```text
get-employed-extension/
├── manifest.json          # V3 manifest with permissions & host matching
├── background.js          # The State Machine: Manages tabs, coordinates content scripts, handles Ollama API calls
├── content/
│   ├── scraper.js         # Injected into linkedin.com/jobs/* (Extracts JD, navigates lists)
│   ├── profile.js         # Injected into linkedin.com/in/* (Handles connection requests)
│   └── apply.js           # Injected during Easy Apply modals (Handles form logic, blocker detection)
├── popup/
│   ├── popup.html         # Extension UI (Premium toggle, Model select, Dashboard)
│   ├── popup.css          # UI styling
│   └── popup.js           # UI logic, storage retrieval, CSV export, Recruiter message generator
├── utils/
│   ├── domHelpers.js      # Reusable functions for robust element selection and jitter/delays
│   └── storage.js         # Wrapper for chrome.storage.local operations
└── icons/                 # 16x16, 48x48, 128x128 extension icons

```

---

## ⚙️ Core Modules & Technical Specifications

### Module 1: Manifest & Permissions (`manifest.json`)

The extension requires specific permissions to operate seamlessly across LinkedIn tabs and communicate with the local server.

- **Permissions:** `storage`, `tabs`, `scripting`.
- **Host Permissions:** `*://*.linkedin.com/*`, `http://localhost:11434/*`.
- **Background:** Service worker configuration for `background.js`.

### Module 2: State Management (`background.js`)

LinkedIn is a single-page application (SPA), but opening recruiter profiles creates new tabs. The background script must act as a State Machine to ensure the agent doesn't lose its place.

- **Variables to Track:** `isAgentRunning`, `currentJobIndex`, `currentPaginationPage`, `premiumEnabled`, `selectedModel`.
- **Message Passing:** Uses `chrome.runtime.onMessage` to listen for triggers from `scraper.js` (e.g., "JD_EXTRACTED") and responds with instructions (e.g., "PROCEED_TO_APPLY" or "SKIP").

### Module 3: Local LLM Integration (Ollama API)

When `scraper.js` extracts a job description, it sends it to `background.js`, which fires a `fetch` request to the local Ollama server.

**Endpoint:** `POST http://localhost:11434/api/generate`
**Payload Strategy:**
Force the LLM to output strictly formatted JSON to prevent parsing errors.

```json
{
  "model": "llama3",
  "prompt": "Extract the required years of experience from the following job description. Return ONLY a JSON object in this exact format: {\"required_experience_years\": <number>}. If a range is given, provide the minimum. If not mentioned, output 0. \n\nJob Description:\n[INSERT_SCRAPED_JD_HERE]",
  "stream": false,
  "format": "json"
}
```

### Module 4: Job Scraping & DOM Navigation (`scraper.js`)

LinkedIn's DOM is highly volatile. CSS classes like `_1b6ec212` change constantly.

- **Selection Strategy:** Use XPath or `document.querySelector` targeting `aria-label`, `data-test-*`, or specific hierarchical structures.
- _Example (Find 'Show All'):_ `document.querySelector('a[aria-label^="Show all jobs"]')`
- _Example (Find Job Cards):_ `document.querySelectorAll('li[data-occludable-job-id]')`

- **Anti-Bot Execution:** Implement a `sleep(min, max)` utility function. Add a randomized delay (e.g., 2000ms - 4500ms) between selecting a job from the left pane and extracting the right pane's description.

### Module 5: The Networking Pipeline (`profile.js`)

Triggered when the "Meet the hiring team" section exists.

1. **Extract Data:** Scrape Recruiter Name and Profile URL.
2. **Tab Management:** `background.js` opens the profile URL in a new, inactive tab to prevent disrupting the main job feed.
3. **UI Navigation:** \* Look for the primary "Connect" button.

- If missing, locate the "More" overflow menu (`aria-label="More"`) -> Click -> Look for "Connect" within the dropdown (`aria-label^="Invite"`).

4. **Note Logic:**

- If `premiumEnabled` == `true`: Call Ollama via `background.js` to generate a <200 character note using the specific JD and Recruiter name. Insert into the text area. Click Send.
- If `premiumEnabled` == `false`: Find and click `button[aria-label="Send without a note"]`.

5. **Cleanup:** Close the profile tab and signal `background.js` to initiate the Apply Pipeline.

### Module 6: Easy Apply Automation (`apply.js`)

This is the most complex DOM interaction.

1. **Identify Apply Type:** Check if the button contains text "Easy Apply" or "Apply". If "Apply", click the "Save" button (`button.jobs-save-button`), log status, and exit loop.
2. **Iterate Modals:** Click "Next" iteratively.
3. **Blocker Detection (Human Intervention Required):** \* Before clicking "Next", run a query for empty compulsory fields:
   `document.querySelectorAll('input[required=""], select[required=""], [aria-required="true"]')`

- Filter this NodeList for elements where `value === ""` or `value === "Select an option"`.
- **If matches > 0:** 1. Click the Dismiss 'X' button (`button[aria-label="Dismiss"]`).

2. Wait for the confirmation dialog.
3. Click "Save" (`button[data-control-name="save_application_btn"]`).
4. Log as `In-Process` and exit to the next job.

5. **Completion:** If the "Review" button is reached, click it, then click "Submit application", click "Done", and log as `Applied`.

### Module 7: Data Storage Schema & Export (`storage.js`)

Maintain an array of objects in `chrome.storage.local`.

```javascript
// Example schema
const applicationRecord = {
  timestamp: Date.now(),
  company: "Recro",
  jobTitle: "Senior AI Engineer",
  applyType: "Easy Apply", // or "External"
  status: "Applied", // "Applied", "Saved", "In-Process"
  experienceRequired: 4,
  hrDetails: {
    available: true,
    name: "Arya Priyadarshini",
    linkedinId: "https://linkedin.com/in/arya-...",
    connectionStatus: "Sent With Note",
  },
};
```

### Module 8: Extension UI (`popup.html` / `popup.js`)

- **Controls:** "Start/Stop Agent" button, "Premium Member" Toggle, "Select Local Model" dropdown (fetching available models from `http://localhost:11434/api/tags`).
- **Database View:** A simple HTML table iterating through `chrome.storage.local` data.
- **Export:** A button that converts the JSON array to a CSV string and triggers a browser download.
- **Recruiter CRM:** A search bar to look up saved recruiters. Includes a "Generate Follow-up" button that feeds the recruiter's specific job description context back into Ollama to draft a customized LinkedIn message.

---

## 🚀 Development Roadmap

- **Phase 1: Skeleton & Ollama Hookup.** Create manifest, basic popup, and ensure `background.js` can successfully ping the local Ollama API and receive JSON.
- **Phase 2: Job Navigation & Extraction.** Build `scraper.js` to confidently click through the job list, handle pagination, and extract the `#job-details` text.
- **Phase 3: Logic Routing.** Tie Phase 1 and 2 together. Scrape -> Send to LLM -> Receive output -> Log to Chrome storage.
- **Phase 4: Easy Apply Execution.** Build `apply.js`. Focus heavily on the blocker detection logic (identifying empty required fields) and the graceful exit/save sequence.
- **Phase 5: Networking Pipeline.** Build `profile.js` to handle opening recruiter tabs, finding the nested connect buttons, and injecting the LLM notes.
- **Phase 6: UI & Polish.** Complete the popup dashboard, CSV export, and fine-tune all `sleep()` jitters to ensure the agent mimics human behavior perfectly.
