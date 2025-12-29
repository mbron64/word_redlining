import { getScopeText, applyRedlines } from "./services/wordService.js";
import { reviewClause } from "./services/aiService.js";
import { diffTokens, formatDiff } from "./utils/diff.js";
import { loadSettings, saveSettings } from "./utils/storage.js";

const state = {
  scope: "selection",
  riskProfile: "balanced",
  granularity: "replace",
  trackChanges: true,
  instructions: "",
  endpoint: "",
  rememberEndpoint: true,
  originalText: "",
  result: null,
};

const dom = {
  selectionLength: document.getElementById("selectionLength"),
  commentCount: document.getElementById("commentCount"),
  revisionCount: document.getElementById("revisionCount"),
  scopeButtons: document.querySelectorAll(".segment"),
  scopeHint: document.getElementById("scopeHint"),
  refreshSelection: document.getElementById("refreshSelection"),
  riskProfile: document.getElementById("riskProfile"),
  granularity: document.getElementById("granularity"),
  trackChanges: document.getElementById("trackChanges"),
  instructions: document.getElementById("instructions"),
  runReview: document.getElementById("runReview"),
  runMeta: document.getElementById("runMeta"),
  status: document.getElementById("status"),
  suggestedClause: document.getElementById("suggestedClause"),
  commentList: document.getElementById("commentList"),
  commentPill: document.getElementById("commentPill"),
  applyRedlines: document.getElementById("applyRedlines"),
  discardResult: document.getElementById("discardResult"),
  copySuggestion: document.getElementById("copySuggestion"),
  apiEndpoint: document.getElementById("apiEndpoint"),
  rememberEndpoint: document.getElementById("rememberEndpoint"),
};

function setStatus(message, tone = "neutral") {
  dom.status.textContent = message;
  if (tone === "neutral") {
    delete dom.status.dataset.tone;
  } else {
    dom.status.dataset.tone = tone;
  }
}

function setRunMeta(message) {
  dom.runMeta.textContent = message;
}

function updateMetrics({ wordCount = 0, commentCount = 0, revisionCount = 0 }) {
  dom.selectionLength.textContent = wordCount;
  dom.commentCount.textContent = commentCount;
  dom.revisionCount.textContent = revisionCount;
}

function setScope(scope) {
  state.scope = scope;
  dom.scopeButtons.forEach((button) => {
    button.classList.toggle("is-active", button.dataset.scope === scope);
  });

  const hintByScope = {
    selection: "Tip: Highlight a clause for best results.",
    paragraph: "Tip: Place the cursor in a paragraph to review it.",
    document: "Tip: Entire document review may take longer.",
  };
  dom.scopeHint.textContent = hintByScope[scope] || "";
}

function renderComments(comments) {
  dom.commentList.innerHTML = "";
  if (!comments.length) {
    dom.commentList.innerHTML = "<li>No comments generated.</li>";
    return;
  }

  comments.forEach((comment) => {
    const item = document.createElement("li");
    item.textContent = comment.comment;
    dom.commentList.appendChild(item);
  });
}

function renderPreview() {
  if (!state.result) {
    dom.suggestedClause.textContent = "No suggestions yet.";
    dom.commentPill.textContent = "0";
    dom.commentList.innerHTML = "";
    updateMetrics({ wordCount: 0, commentCount: 0, revisionCount: 0 });
    return;
  }

  const { revisedText, comments } = state.result;
  let previewText = revisedText || "No revisions suggested.";
  let revisionCount = 0;

  if (state.granularity === "diff" && state.originalText) {
    const diff = diffTokens(state.originalText, revisedText);
    previewText = formatDiff(diff);
    if (diff) {
      revisionCount = diff.filter((segment) => segment.type !== "equal").length;
    }
  }

  dom.suggestedClause.textContent = previewText;
  dom.commentPill.textContent = comments.length.toString();
  renderComments(comments);
  updateMetrics({
    wordCount: countWords(state.originalText),
    commentCount: comments.length,
    revisionCount,
  });
}

function countWords(text) {
  const matches = text.trim().match(/\S+/g);
  return matches ? matches.length : 0;
}

async function refreshSelection() {
  setStatus("Reading selection...");
  try {
    const { text, wordCount } = await getScopeText(state.scope);
    state.originalText = text;
    updateMetrics({ wordCount, commentCount: 0, revisionCount: 0 });
    setStatus(wordCount ? "Selection ready." : "No text found in scope.");
  } catch (error) {
    setStatus(`Unable to read from Word. ${error.message}`, "error");
  }
}

async function handleReview() {
  setStatus("");
  setRunMeta("Working...");

  try {
    const { text } = await getScopeText(state.scope);
    if (!text || !text.trim()) {
      setStatus("Select some text before running a review.", "error");
      setRunMeta("Ready");
      return;
    }

    state.originalText = text;

    const result = await reviewClause({
      endpoint: state.endpoint,
      text,
      instructions: state.instructions,
      riskProfile: state.riskProfile,
      scope: state.scope,
    });

    if (!result.revisedText) {
      setStatus("AI returned no suggested edits.", "warning");
    } else {
      setStatus("Preview ready. Review before applying.");
    }

    state.result = result;
    renderPreview();
  } catch (error) {
    setStatus(error.message || "AI request failed.", "error");
  } finally {
    setRunMeta("Ready");
  }
}

async function handleApply() {
  if (!state.result || !state.result.revisedText) {
    setStatus("No revisions to apply.", "warning");
    return;
  }

  setStatus("Applying tracked changes...");
  try {
    await applyRedlines({
      scope: state.scope,
      revisedText: state.result.revisedText,
      comments: state.result.comments,
      trackChanges: state.trackChanges,
    });

    const note = state.granularity === "diff"
      ? "Applied clause replacement with Track Changes."
      : "Applied tracked changes and comments.";

    setStatus(note);
  } catch (error) {
    setStatus(`Failed to apply changes. ${error.message}`, "error");
  }
}

function handleDiscard() {
  state.result = null;
  renderPreview();
  setStatus("Draft cleared.");
}

async function handleCopy() {
  if (!state.result || !state.result.revisedText) {
    setStatus("Nothing to copy yet.", "warning");
    return;
  }

  try {
    await navigator.clipboard.writeText(state.result.revisedText);
    setStatus("Copied suggestion to clipboard.");
  } catch (error) {
    setStatus("Clipboard unavailable.", "warning");
  }
}

function handleEndpointChange() {
  state.endpoint = dom.apiEndpoint.value.trim();
  state.rememberEndpoint = dom.rememberEndpoint.checked;

  saveSettings({ endpoint: state.rememberEndpoint ? state.endpoint : "" });
}

function bindEvents() {
  dom.scopeButtons.forEach((button) => {
    button.addEventListener("click", () => setScope(button.dataset.scope));
  });

  dom.refreshSelection.addEventListener("click", refreshSelection);
  dom.riskProfile.addEventListener("change", (event) => {
    state.riskProfile = event.target.value;
  });
  dom.granularity.addEventListener("change", (event) => {
    state.granularity = event.target.value;
    renderPreview();
  });
  dom.trackChanges.addEventListener("change", (event) => {
    state.trackChanges = event.target.checked;
  });
  dom.instructions.addEventListener("input", (event) => {
    state.instructions = event.target.value;
  });
  dom.runReview.addEventListener("click", handleReview);
  dom.applyRedlines.addEventListener("click", handleApply);
  dom.discardResult.addEventListener("click", handleDiscard);
  dom.copySuggestion.addEventListener("click", handleCopy);
  dom.apiEndpoint.addEventListener("change", handleEndpointChange);
  dom.rememberEndpoint.addEventListener("change", handleEndpointChange);
}

async function initFromSettings() {
  const stored = await loadSettings();
  if (stored?.endpoint) {
    state.endpoint = stored.endpoint;
    dom.apiEndpoint.value = stored.endpoint;
  }
}

if (!window.Office) {
  setStatus("Office.js not available. Load this pane inside Word.", "error");
} else {
  Office.onReady(async () => {
    await initFromSettings();
    bindEvents();
    setScope(state.scope);
    setStatus("Ready.");
    await refreshSelection();
  });
}
