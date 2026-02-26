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

/**
 * Handle the send-invite dialog by injecting fresh code into the tab
 * via chrome.scripting.executeScript.  This bypasses any stale
 * content-script context that may have lost touch with the DOM after
 * an Ember SPA transition.
 *
 * Handles multiple scenarios:
 *   - Direct "Send without a note" dialog (2nd-degree connections)
 *   - "How do you know [Name]?" intermediate step (3rd-degree)
 *   - Non-button elements (a, div, span with role="button")
 *   - Already-pending connections
 */
async function handleSendInviteDialog(tabId, scraperTabId, context = {}) {
  const MAX_ATTEMPTS = 25;
  const POLL_MS = 1500;
  const {
    recruiterName = "",
    jobDescription = "",
    yearsRequired = 0,
    eligibilityMaxYears = 0,
    premiumEnabled = false,
    jobMeta = {},
  } = context;

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
      location: "background.js:handleSendInviteDialog:entry",
      message: "handleSendInviteDialog invoked",
      data: {
        tabId,
        scraperTabId,
        MAX_ATTEMPTS,
        POLL_MS,
        premiumEnabled,
        yearsRequired,
        eligibilityMaxYears,
      },
      timestamp: Date.now(),
    }),
  }).catch(() => {});
  // #endregion

  // Helper: relay debug to the scraper tab so the user can see it
  const relayLog = async (...args) => {
    console.log("[GetEmployed][bg]", ...args);
    if (scraperTabId) {
      try {
        await chrome.tabs.sendMessage(scraperTabId, {
          action: "RELAY_LOG",
          args: args.map((a) =>
            typeof a === "object" ? JSON.stringify(a) : String(a),
          ),
        });
      } catch (_) {
        /* scraper tab may be gone */
      }
    }
  };

  // ── Helper: Generate note using Ollama ──
  const generateNote = async () => {
    try {
      const state = await getState();
      const model = state.selectedModel;
      if (!model || !recruiterName || !jobDescription) {
        return "";
      }

      const isEligible =
        eligibilityMaxYears === 0 || yearsRequired <= eligibilityMaxYears;
      const notePrompt = isEligible
        ? `Write a short, professional LinkedIn connection note (under 200 characters) ` +
          `to ${recruiterName} at ${jobMeta.company || "their company"} regarding the ${jobMeta.title || "position"} role. ` +
          `Focus on how you're a good fit for this specific role. Mention relevant experience briefly. Be warm but concise. ` +
          `Return ONLY a JSON object: {"note": "<your message>"}.\n\n` +
          `Job Description:\n${jobDescription.slice(0, 800)}`
        : `Write a short, professional LinkedIn connection note (under 200 characters) ` +
          `to ${recruiterName}. Introduce yourself briefly and ask about available opportunities. ` +
          `Be warm but concise. Return ONLY a JSON object: {"note": "<your message>"}.\n\n` +
          `Job Description context:\n${jobDescription.slice(0, 300)}`;

      const notePayload = {
        model,
        prompt: notePrompt,
        stream: false,
        format: "json",
      };

      const noteData = await fetchJson("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(notePayload),
      });

      try {
        const parsed = parseJsonResponse(noteData.response);
        return String(parsed.note || "").slice(0, 200);
      } catch {
        return isEligible
          ? `Hi ${recruiterName}, I'm interested in the ${jobMeta.title || "position"} role at ${jobMeta.company || "your company"}. Would love to connect!`.slice(
              0,
              200,
            )
          : `Hi ${recruiterName}, I'd love to connect and learn about opportunities. Thanks!`.slice(
              0,
              200,
            );
      }
    } catch (err) {
      await relayLog("Note generation failed:", err.message);
      return "";
    }
  };

  let generatedNote = "";
  let noteMandatory = false; // Will be set after first attempt if "Send without a note" not found

  // Generate note immediately if premium enabled
  if (premiumEnabled) {
    generatedNote = await generateNote();
    await relayLog(
      "Generated note for",
      recruiterName,
      ":",
      generatedNote.slice(0, 50) + "...",
    );
  }

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    await new Promise((r) => setTimeout(r, POLL_MS));

    try {
      // ── Run in BOTH worlds to maximize chance of finding the button ──
      const runInWorld = async (world) => {
        const results = await chrome.scripting.executeScript({
          target: { tabId, allFrames: true },
          world,
          func: (injectedContext) => {
            // Inject context into window for the injected script
            window.__premiumEnabled = injectedContext.premiumEnabled || false;
            window.__noteMandatory = injectedContext.noteMandatory || false;
            window.__generatedNote = injectedContext.generatedNote || "";
            // ── Utilities ──
            const deepQueryAll = (root, selector) => {
              const found = [...root.querySelectorAll(selector)];
              root.querySelectorAll("*").forEach((el) => {
                if (el.shadowRoot) {
                  found.push(...deepQueryAll(el.shadowRoot, selector));
                }
              });
              return found;
            };

            const isVisible = (el) => {
              if (!el) return false;
              if (el.offsetWidth > 0 && el.offsetHeight > 0) return true;
              try {
                const s = getComputedStyle(el);
                return (
                  s.display !== "none" &&
                  s.visibility !== "hidden" &&
                  s.opacity !== "0"
                );
              } catch (_) {
                return false;
              }
            };

            const clickEl = (el) => {
              el.focus();
              el.dispatchEvent(
                new MouseEvent("click", {
                  bubbles: true,
                  cancelable: true,
                  view: window,
                }),
              );
            };

            // Selector covering ALL interactive element types
            const CLICKABLE =
              'button, a, [role="button"], [tabindex="0"], [data-control-name]';

            // Collect ALL clickable elements (any type)
            const allClickable = deepQueryAll(document, CLICKABLE);

            // ── Step 1: Check if "Send without a note" button exists ──
            let hasSendWithoutNote = false;
            const sendWithoutNoteTexts = [
              "send without a note",
              "send without note",
            ];
            for (const el of allClickable) {
              const txt = (el.innerText || el.textContent || "")
                .trim()
                .toLowerCase();
              const label = (el.getAttribute("aria-label") || "").toLowerCase();
              for (const s of sendWithoutNoteTexts) {
                if (
                  (txt.includes(s) || label.includes(s)) &&
                  isVisible(el) &&
                  !el.disabled
                ) {
                  hasSendWithoutNote = true;
                  break;
                }
              }
              if (hasSendWithoutNote) break;
            }

            // If premium disabled and no "send without" button found, signal note is mandatory
            if (
              !window.__premiumEnabled &&
              !hasSendWithoutNote &&
              !window.__noteMandatory
            ) {
              return {
                found: false,
                noteMandatory: true, // Signal that note is required
              };
            }

            // ── Step 1c: If premium enabled OR note mandatory (no "send without"), use note flow ──
            // Note: needsNote is true if premium enabled OR if noteMandatory flag is set (meaning "send without" was not found)
            const needsNote = window.__premiumEnabled || window.__noteMandatory;
            if (needsNote && window.__generatedNote) {
              // First, check if we need to click "Add a note" button to reveal the textarea
              const addNoteButtons = deepQueryAll(document, CLICKABLE);
              let clickedAddNote = false;
              for (const btn of addNoteButtons) {
                const label = (
                  btn.getAttribute("aria-label") || ""
                ).toLowerCase();
                const txt = (btn.innerText || btn.textContent || "")
                  .trim()
                  .toLowerCase();
                const modal = btn.closest(
                  ".artdeco-modal, [role='dialog'], .send-invite",
                );

                if (modal && isVisible(btn) && !btn.disabled) {
                  if (label.includes("add a note") || txt === "add a note") {
                    clickEl(btn);
                    clickedAddNote = true;
                    // Return intermediate to wait for textarea to appear
                    return {
                      found: false,
                      intermediate: "add-note-clicked",
                    };
                  }
                }
              }

              // Find textarea for note input
              const textareas = deepQueryAll(document, "textarea");
              let noteTextarea = null;
              for (const ta of textareas) {
                const modal = ta.closest(
                  ".artdeco-modal, [role='dialog'], .send-invite",
                );
                if (modal && isVisible(ta)) {
                  noteTextarea = ta;
                  break;
                }
              }

              if (noteTextarea) {
                // Fill the textarea with generated note
                noteTextarea.focus();
                noteTextarea.value = window.__generatedNote;
                // Trigger input event for React/Ember
                noteTextarea.dispatchEvent(
                  new Event("input", { bubbles: true }),
                );
                noteTextarea.dispatchEvent(
                  new Event("change", { bubbles: true }),
                );

                // Find and click "Send" button (not "Send without a note")
                const sendButtons = deepQueryAll(document, CLICKABLE);
                for (const btn of sendButtons) {
                  const label = (
                    btn.getAttribute("aria-label") || ""
                  ).toLowerCase();
                  const txt = (btn.innerText || btn.textContent || "")
                    .trim()
                    .toLowerCase();
                  const modal = btn.closest(
                    ".artdeco-modal, [role='dialog'], .send-invite",
                  );

                  if (modal && isVisible(btn) && !btn.disabled) {
                    // Look for "Send" but NOT "Send without a note" and NOT "Add a note"
                    if (
                      (label.includes("send") &&
                        !label.includes("without") &&
                        !label.includes("add a note")) ||
                      (txt.includes("send") &&
                        !txt.includes("without") &&
                        txt !== "add a note")
                    ) {
                      clickEl(btn);
                      return {
                        found: true,
                        method: `note-flow:send tag:${btn.tagName}`,
                      };
                    }
                  }
                }
              } else if (!clickedAddNote) {
                // Textarea not found and we didn't click "Add a note" - might need to wait
                return {
                  found: false,
                  intermediate: "note-flow:textarea-not-found",
                };
              }
            }

            // ── Step 1d: If not using note flow, try "Send without a note" ──
            if (!needsNote && hasSendWithoutNote) {
              const ariaSelectors = [
                '[aria-label="Send without a note"]',
                '[aria-label*="Send without"]',
                '[aria-label="Send invitation"]',
                '[aria-label="Send now"]',
              ];
              for (const sel of ariaSelectors) {
                const els = deepQueryAll(document, sel);
                for (const el of els) {
                  if (isVisible(el) && !el.disabled) {
                    const label = (
                      el.getAttribute("aria-label") || ""
                    ).toLowerCase();
                    const txt = (el.innerText || el.textContent || "")
                      .trim()
                      .toLowerCase();
                    // Only click "Send without" buttons, not generic "Send"
                    if (
                      label.includes("send without") ||
                      txt.includes("send without")
                    ) {
                      clickEl(el);
                      return {
                        found: true,
                        method: `aria-sel:${sel} tag:${el.tagName}`,
                      };
                    }
                  }
                }
              }
            }

            // ── Step 2: Handle "How do you know [Name]?" (3rd-degree) ──
            const bodyText = (document.body?.innerText || "").toLowerCase();
            const hasHowDoYouKnow =
              bodyText.includes("how do you know") ||
              bodyText.includes("choose one of the following");

            if (hasHowDoYouKnow) {
              // Try radio buttons first
              const radios = deepQueryAll(
                document,
                'input[type="radio"], [role="radio"]',
              );
              if (radios.length > 0) {
                // Click "Other" if labelled, otherwise last radio
                let picked = null;
                for (const r of radios) {
                  const parent = r.closest("label") || r.parentElement;
                  const pText = (parent?.innerText || "").toLowerCase();
                  if (pText.includes("other")) {
                    picked = r;
                    break;
                  }
                }
                if (!picked) picked = radios[radios.length - 1];
                clickEl(picked);
                return {
                  found: false,
                  intermediate: "how-do-you-know:radio",
                };
              }

              // Try clickable options (LinkedIn may use divs/buttons)
              for (const el of allClickable) {
                const txt = (el.innerText || el.textContent || "")
                  .trim()
                  .toLowerCase();
                if (txt === "other" || txt.includes("don't know")) {
                  if (isVisible(el)) {
                    clickEl(el);
                    return {
                      found: false,
                      intermediate: `how-do-you-know:btn("${txt}")`,
                    };
                  }
                }
              }

              // As last resort, look for any "Connect" submit button inside
              // a modal/overlay (this is the confirmation after selection)
              const modals = deepQueryAll(
                document,
                '.artdeco-modal, [role="dialog"], dialog, .artdeco-modal-overlay',
              );
              for (const m of modals) {
                const btns = m.querySelectorAll(CLICKABLE);
                for (const btn of btns) {
                  const txt = (btn.innerText || "").trim().toLowerCase();
                  if (txt === "connect" || txt === "done" || txt === "send") {
                    if (isVisible(btn) && !btn.disabled) {
                      clickEl(btn);
                      return {
                        found: false,
                        intermediate: `modal-submit:"${txt}"`,
                      };
                    }
                  }
                }
              }

              return {
                found: false,
                intermediate: "how-do-you-know:no-option-found",
                debug: {
                  url: location.href,
                  radios: radios.length,
                  bodySnippet: bodyText.slice(0, 300),
                },
              };
            }

            // ── Step 3: Handle plain modals with a "Connect" submit ──
            const modals = deepQueryAll(
              document,
              '.artdeco-modal, [role="dialog"], dialog, .artdeco-modal-overlay, .send-invite',
            );
            for (const m of modals) {
              const btns = m.querySelectorAll(CLICKABLE);
              for (const btn of btns) {
                const txt = (btn.innerText || "").trim().toLowerCase();
                const label = (
                  btn.getAttribute("aria-label") || ""
                ).toLowerCase();
                // Only click send/connect type buttons, never dismiss/close
                if (
                  txt === "send" ||
                  txt === "send invitation" ||
                  txt === "connect" ||
                  label.includes("send")
                ) {
                  if (isVisible(btn) && !btn.disabled) {
                    clickEl(btn);
                    return {
                      found: true,
                      method: `modal-send:"${txt}" tag:${btn.tagName}`,
                    };
                  }
                }
              }
            }

            // ── Debug output ──
            const snapshot = [];
            for (const el of allClickable) {
              const txt = (el.innerText || el.textContent || "")
                .trim()
                .slice(0, 80);
              const label = (el.getAttribute("aria-label") || "").slice(0, 80);
              const role = el.getAttribute("role") || "";
              if (txt || label) {
                snapshot.push({
                  tag: el.tagName,
                  r: role,
                  t: txt.slice(0, 60),
                  a: label.slice(0, 60),
                  v: isVisible(el),
                  d: !!el.disabled,
                });
              }
            }

            return {
              found: false,
              debug: {
                url: location.href,
                title: (document.title || "").slice(0, 80),
                modals: modals.length,
                totalClickable: allClickable.length,
                iframes: document.querySelectorAll("iframe").length,
                bodySnippet: bodyText.slice(0, 300),
                snapshot: snapshot.slice(0, 30),
              },
            };
          },
          args: [
            {
              premiumEnabled: premiumEnabled,
              noteMandatory: noteMandatory, // Set after first attempt if "send without" not found
              generatedNote: generatedNote,
            },
          ],
        });

        // executeScript with allFrames returns one result per frame
        for (const r of results || []) {
          if (r?.result?.found) return r.result;
        }
        // Check for noteMandatory signal (must check before intermediate)
        for (const r of results || []) {
          if (r?.result?.noteMandatory === true) return r.result;
        }
        // Check for intermediate step results
        for (const r of results || []) {
          if (r?.result?.intermediate) return r.result;
        }
        // Return first non-null debug result
        for (const r of results || []) {
          if (r?.result) return r.result;
        }
        return null;
      };

      // Try ISOLATED world first (faster), then MAIN world
      let result = await runInWorld("ISOLATED");
      if (result?.found) {
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
              hypothesisId: "H3-WrongButton",
              location: "background.js:handleSendInviteDialog:isolatedSuccess",
              message:
                "Dialog handler found clickable element in ISOLATED world",
              data: { tabId, scraperTabId, method: result.method || "" },
              timestamp: Date.now(),
            }),
          },
        ).catch(() => {});
        // #endregion
        await relayLog(
          `Dialog attempt ${attempt}: SUCCESS via ISOLATED —`,
          result.method,
        );
        return "ConnectionSent";
      }
      if (result?.intermediate) {
        await relayLog(
          `Dialog attempt ${attempt}: Intermediate step via ISOLATED —`,
          result.intermediate,
          result.debug || "",
        );
        // Extra wait for the UI to transition after intermediate action
        await new Promise((r) => setTimeout(r, 1000));
        continue; // Re-poll — the "Send without a note" button should appear next
      }

      // Check if note is mandatory (no "Send without a note" button found)
      if (result?.noteMandatory && !premiumEnabled && !noteMandatory) {
        await relayLog(
          "'Send without a note' not found - note is mandatory, generating note...",
        );
        noteMandatory = true;
        if (!generatedNote) {
          generatedNote = await generateNote();
          await relayLog("Generated note:", generatedNote.slice(0, 50) + "...");
        }
        // Continue to next attempt with note flow
        continue;
      }

      result = await runInWorld("MAIN");
      if (result?.found) {
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
              hypothesisId: "H3-WrongButton",
              location: "background.js:handleSendInviteDialog:mainSuccess",
              message: "Dialog handler found clickable element in MAIN world",
              data: { tabId, scraperTabId, method: result.method || "" },
              timestamp: Date.now(),
            }),
          },
        ).catch(() => {});
        // #endregion
        await relayLog(
          `Dialog attempt ${attempt}: SUCCESS via MAIN —`,
          result.method,
        );
        return "ConnectionSent";
      }
      if (result?.intermediate) {
        await relayLog(
          `Dialog attempt ${attempt}: Intermediate step via MAIN —`,
          result.intermediate,
          result.debug || "",
        );
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }

      // After first attempt, check if note is mandatory (no "Send without a note" button)
      if (result?.noteMandatory && !premiumEnabled && !noteMandatory) {
        await relayLog(
          "'Send without a note' not found - note is mandatory, generating note...",
        );
        noteMandatory = true;
        if (!generatedNote) {
          generatedNote = await generateNote();
          await relayLog("Generated note:", generatedNote.slice(0, 50) + "...");
        }
        // Continue to next attempt with note flow
        continue;
      }

      await relayLog(
        `Dialog attempt ${attempt}/${MAX_ATTEMPTS}:`,
        result || "null",
      );
    } catch (err) {
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
            hypothesisId: "H1-NoDialogHandler",
            location: "background.js:handleSendInviteDialog:catch",
            message: "Error inside handleSendInviteDialog attempt loop",
            data: {
              tabId,
              scraperTabId,
              attempt,
              error: err?.message || String(err),
            },
            timestamp: Date.now(),
          }),
        },
      ).catch(() => {});
      // #endregion
      await relayLog(`Dialog attempt ${attempt} ERROR:`, err.message);
      if (attempt >= 5) return "ConnectFailed";
    }
  }

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
      hypothesisId: "H2-DialogNotFound",
      location: "background.js:handleSendInviteDialog:exit",
      message:
        "handleSendInviteDialog finished without finding send/connect button",
      data: { tabId, scraperTabId, MAX_ATTEMPTS },
      timestamp: Date.now(),
    }),
  }).catch(() => {});
  // #endregion

  return "DialogNotFound";
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
        const prevState = await getState();
        const state = await setState(message.patch || {});

        // When running state changes, relay START/STOP to LinkedIn tabs
        if (
          message.patch?.isAgentRunning !== undefined &&
          prevState.isAgentRunning !== state.isAgentRunning
        ) {
          const action = state.isAgentRunning ? "START_SCRAPE" : "STOP_SCRAPE";
          const tabs = await chrome.tabs.query({
            url: "*://www.linkedin.com/*",
          });
          for (const tab of tabs) {
            chrome.tabs.sendMessage(tab.id, { action }).catch(() => {});
          }
        }

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

        let years = 0;
        try {
          const parsed = parseJsonResponse(data.response);
          years = Number(parsed.required_experience_years);
          if (isNaN(years) || years < 0) years = 0;
        } catch {
          // If Ollama didn't return parseable experience, treat as 0
          years = 0;
        }
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
      case "RELAY_PROFILE_LOG": {
        // Forward profile.js debug logs to the scraper tab console
        const targetTabId = message.scraperTabId;
        if (targetTabId) {
          try {
            await chrome.tabs.sendMessage(targetTabId, {
              action: "RELAY_LOG",
              args: message.args || [],
            });
          } catch (_) {
            /* scraper tab may be gone */
          }
        }
        sendResponse({ ok: true });
        break;
      }
      case "CONNECT_WITH_RECRUITER": {
        // Open recruiter profile in a new tab, let profile.js handle the
        // connection flow, then close the tab and return the result.
        const recruiterUrl = message.hrDetails?.linkedinUrl;
        const scraperTabId = sender.tab?.id || null; // scraper tab for log relay
        if (!recruiterUrl) {
          sendResponse({ ok: false, connectionStatus: "NoRecruiter" });
          break;
        }

        try {
          const connectionStatus = await new Promise((resolve) => {
            const TIMEOUT_MS = 60000; // 60 s total timeout
            let settled = false;
            let tabId = null;
            let profileReady = false;

            const cleanup = () => {
              chrome.runtime.onMessage.removeListener(listener);
              chrome.tabs.onUpdated.removeListener(onTabUpdated);
              if (tabId) chrome.tabs.remove(tabId).catch(() => {});
            };

            const timeout = setTimeout(() => {
              if (!settled) {
                settled = true;
                console.log(
                  "[GetEmployed][bg] Timeout — profileReady:",
                  profileReady,
                  "tabId:",
                  tabId,
                );
                cleanup();
                resolve("ConnectTimeout");
              }
            }, TIMEOUT_MS);

            const sendStartFlow = (targetTabId) => {
              getState()
                .then((s) => {
                  console.log(
                    "[GetEmployed][bg] Sending START_PROFILE_FLOW to tab",
                    targetTabId,
                  );
                  return chrome.tabs.sendMessage(targetTabId, {
                    action: "START_PROFILE_FLOW",
                    hrDetails: message.hrDetails,
                    jobMeta: message.jobMeta,
                    jobDescription: message.jobDescription,
                    yearsRequired: message.yearsRequired || 0,
                    premiumEnabled: s.premiumEnabled,
                    eligibilityMaxYears: s.eligibilityMaxYears || 0,
                    scraperTabId,
                  });
                })
                .then(() => {
                  console.log(
                    "[GetEmployed][bg] START_PROFILE_FLOW delivered OK",
                  );
                })
                .catch((err) => {
                  console.error(
                    "[GetEmployed][bg] START_PROFILE_FLOW delivery failed:",
                    err,
                  );
                  // Retry once after a short delay
                  setTimeout(() => {
                    if (settled) return;
                    console.log(
                      "[GetEmployed][bg] Retrying START_PROFILE_FLOW...",
                    );
                    getState().then((s) =>
                      chrome.tabs
                        .sendMessage(targetTabId, {
                          action: "START_PROFILE_FLOW",
                          hrDetails: message.hrDetails,
                          jobMeta: message.jobMeta,
                          jobDescription: message.jobDescription,
                          yearsRequired: message.yearsRequired || 0,
                          premiumEnabled: s.premiumEnabled,
                          eligibilityMaxYears: s.eligibilityMaxYears || 0,
                          scraperTabId,
                        })
                        .catch((retryErr) => {
                          console.error(
                            "[GetEmployed][bg] Retry also failed:",
                            retryErr,
                          );
                          if (!settled) {
                            settled = true;
                            clearTimeout(timeout);
                            cleanup();
                            resolve("ConnectFailed");
                          }
                        }),
                    );
                  }, 2000);
                });
            };

            const listener = (msg, msgSender) => {
              // Only handle messages from our profile tab
              if (!tabId || msgSender.tab?.id !== tabId) return;

              if (msg.action === "PROFILE_READY" && !settled) {
                console.log(
                  "[GetEmployed][bg] PROFILE_READY received from tab",
                  tabId,
                );
                profileReady = true;
                sendStartFlow(tabId);
              }

              if (msg.action === "CONNECT_CLICKED" && !settled) {
                console.log(
                  "[GetEmployed][bg] CONNECT_CLICKED — taking over dialog handling via executeScript",
                );
                // profile.js clicked the Connect button. Now we handle
                // the dialog by injecting fresh code into the tab.
                // Pass context needed for note generation
                handleSendInviteDialog(tabId, scraperTabId, {
                  recruiterName: msg.recruiterName,
                  jobDescription: msg.jobDescription,
                  yearsRequired: msg.yearsRequired,
                  eligibilityMaxYears: msg.eligibilityMaxYears,
                  premiumEnabled: msg.premiumEnabled,
                  jobMeta: msg.jobMeta,
                })
                  .then((status) => {
                    if (!settled) {
                      console.log(
                        "[GetEmployed][bg] Dialog handler result:",
                        status,
                      );
                      settled = true;
                      clearTimeout(timeout);
                      cleanup();
                      resolve(status);
                    }
                  })
                  .catch((err) => {
                    console.error(
                      "[GetEmployed][bg] Dialog handler error:",
                      err,
                    );
                    if (!settled) {
                      settled = true;
                      clearTimeout(timeout);
                      cleanup();
                      resolve("ConnectFailed");
                    }
                  });
              }

              if (msg.action === "CONNECTION_RESULT" && !settled) {
                console.log("[GetEmployed][bg] CONNECTION_RESULT:", msg.status);
                settled = true;
                clearTimeout(timeout);
                cleanup();
                // Map "already-pending" to "ConnectionSent" for the scraper
                const finalStatus =
                  msg.status === "already-pending"
                    ? "ConnectionSent"
                    : msg.status || "ConnectFailed";
                resolve(finalStatus);
              }
            };

            // Fallback: if profile.js content script doesn't inject or send
            // PROFILE_READY, re-inject it once the page finishes loading.
            const onTabUpdated = (updatedTabId, changeInfo) => {
              if (updatedTabId !== tabId || settled) return;
              if (changeInfo.status === "complete" && !profileReady) {
                console.log(
                  "[GetEmployed][bg] Tab load complete but no PROFILE_READY yet — waiting 3s then re-injecting",
                );
                setTimeout(() => {
                  if (profileReady || settled) return;
                  console.log(
                    "[GetEmployed][bg] Re-injecting profile.js via scripting API",
                  );
                  chrome.scripting
                    .executeScript({
                      target: { tabId },
                      files: ["content/profile.js"],
                    })
                    .catch((err) =>
                      console.error(
                        "[GetEmployed][bg] Re-injection failed:",
                        err,
                      ),
                    );
                }, 3000);
              }
            };

            // Register listeners BEFORE creating the tab
            chrome.runtime.onMessage.addListener(listener);
            chrome.tabs.onUpdated.addListener(onTabUpdated);

            // Now create the tab
            chrome.tabs
              .create({
                url: recruiterUrl,
                active: true, // Must be active for LinkedIn to fully render profile buttons
              })
              .then((tab) => {
                tabId = tab.id;
                console.log(
                  "[GetEmployed][bg] Profile tab created:",
                  tab.id,
                  recruiterUrl,
                );
              })
              .catch((err) => {
                console.error("[GetEmployed][bg] Tab creation failed:", err);
                if (!settled) {
                  settled = true;
                  clearTimeout(timeout);
                  cleanup();
                  resolve("ConnectFailed");
                }
              });
          });

          sendResponse({ ok: true, connectionStatus });
        } catch (err) {
          sendResponse({
            ok: false,
            connectionStatus: "ConnectFailed",
            error: err.message,
          });
        }
        break;
      }

      case "OLLAMA_GENERATE_NOTE": {
        const { recruiterName, jobTitle, company, jobDescription } = message;
        const state = await getState();
        const model = message.model || state.selectedModel;
        if (!model) {
          sendResponse({ ok: false, error: "No model selected" });
          break;
        }

        const notePrompt =
          `Write a short, professional LinkedIn connection note (under 200 characters) ` +
          `to ${recruiterName} at ${company} regarding the ${jobTitle} position. ` +
          `Mention interest in the role briefly. Be warm but concise. ` +
          `Return ONLY a JSON object: {"note": "<your message>"}.\n\n` +
          `Job Description summary:\n${(jobDescription || "").slice(0, 500)}`;

        const notePayload = {
          model,
          prompt: notePrompt,
          stream: false,
          format: "json",
        };

        const noteData = await fetchJson("/api/generate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(notePayload),
        });

        let note = "";
        try {
          const parsed = parseJsonResponse(noteData.response);
          note = String(parsed.note || "").slice(0, 200);
        } catch {
          note =
            `Hi ${recruiterName}, I'm interested in the ${jobTitle} role at ${company}. Would love to connect!`.slice(
              0,
              200,
            );
        }
        sendResponse({ ok: true, note });
        break;
      }

      case "GENERATE_RECRUITER_MESSAGE": {
        const {
          recruiterName,
          jobTitle,
          company,
          jobDescription,
          applicationStatus,
          wasEligibleAndApplied,
          experienceRequired,
        } = message;

        const state = await getState();
        const model = state.selectedModel;
        if (!model) {
          sendResponse({ ok: false, error: "No model selected" });
          break;
        }

        let prompt;
        if (wasEligibleAndApplied) {
          // Specific message — recruiter accepted, user applied/in-process
          prompt =
            `Write a professional LinkedIn message to ${recruiterName} who is a recruiter at ${company}. ` +
            `They recently accepted my connection request. ` +
            `I have already applied for the "${jobTitle}" position at ${company} (status: ${applicationStatus}). ` +
            `The job requires ${experienceRequired || "N/A"} years of experience. ` +
            `Thank them for accepting, mention my application for the specific role, and express enthusiasm. ` +
            `Keep it professional, warm, and under 500 characters. ` +
            `Return ONLY a JSON object: {"message": "<your message>"}\n\n` +
            `Job Description summary:\n${(jobDescription || "").slice(0, 500)}`;
        } else {
          // Generic message — not eligible or didn't apply
          prompt =
            `Write a professional LinkedIn message to ${recruiterName} who is a recruiter at ${company}. ` +
            `They recently accepted my connection request. ` +
            `Thank them for accepting and ask about any available opportunities ` +
            `that might be a good fit for a candidate with data science / ML background. ` +
            `Keep it professional, warm, and under 500 characters. ` +
            `Return ONLY a JSON object: {"message": "<your message>"}`;
        }

        const payload = {
          model,
          prompt,
          stream: false,
          format: "json",
        };

        const msgData = await fetchJson("/api/generate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });

        let generatedMessage = "";
        try {
          const parsed = parseJsonResponse(msgData.response);
          generatedMessage = String(parsed.message || "").slice(0, 600);
        } catch {
          if (wasEligibleAndApplied) {
            generatedMessage =
              `Hi ${recruiterName}, thank you for accepting my connection request! ` +
              `I recently applied for the ${jobTitle} position at ${company} and ` +
              `I'm very excited about the opportunity. I'd love to learn more about the role. ` +
              `Looking forward to hearing from you!`;
          } else {
            generatedMessage =
              `Hi ${recruiterName}, thank you for accepting my connection request! ` +
              `I'm exploring opportunities in data science and ML, and I'd love to ` +
              `learn about any relevant openings at ${company}. ` +
              `Looking forward to connecting!`;
          }
        }

        sendResponse({ ok: true, message: generatedMessage });
        break;
      }

      case "UPDATE_RECORD_MESSAGE": {
        // Update applicationRecords: mark message as generated for the
        // matching recruiter's most recent record
        const { linkedinId, generatedMessage } = message;
        if (!linkedinId) {
          sendResponse({ ok: false, error: "No linkedinId" });
          break;
        }

        const { applicationRecords = [] } = await chrome.storage.local.get({
          applicationRecords: [],
        });

        let updated = false;
        // Find the most recent record for this recruiter and update it
        for (let i = applicationRecords.length - 1; i >= 0; i--) {
          if (applicationRecords[i].hrDetails?.linkedinId === linkedinId) {
            applicationRecords[i].messageGenerated = true;
            applicationRecords[i].generatedMessage = generatedMessage || "";
            applicationRecords[i].messageTimestamp = Date.now();
            updated = true;
            break;
          }
        }

        if (updated) {
          await chrome.storage.local.set({ applicationRecords });
        }
        sendResponse({ ok: true, updated });
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
