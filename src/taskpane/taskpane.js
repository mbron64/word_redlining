import { getScopeText, applyRedlines } from "./services/wordService.js";
import { reviewClause } from "./services/aiService.js";
import { sendChatMessage } from "./services/chatService.js";
import { diffTokens, formatDiff } from "./utils/diff.js";
import { loadSettings, saveSettings } from "./utils/storage.js";

const state = {
  // Mode
  mode: "chat", // "chat" | "redlining"
  
  // Redlining state
  scope: "selection",
  riskProfile: "balanced",
  granularity: "replace",
  trackChanges: true,
  instructions: "",
  endpoint: "",
  rememberEndpoint: true,
  originalText: "",
  result: null,
  
  // Chat state
  chatMessages: [],
  documentContext: "",  // Full document as background
  selectionContext: "", // Currently selected text to focus on
  isChatLoading: false,
};

const dom = {
  // Redlining elements
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
  settingsToggle: document.getElementById("settingsToggle"),
  settingsPanel: document.getElementById("settingsPanel"),
  
  // Mode toggle elements
  modeButtons: document.querySelectorAll(".mode-btn"),
  redliningView: document.getElementById("redliningView"),
  chatView: document.getElementById("chatView"),
  
  // Chat elements
  quickPromptButtons: document.querySelectorAll(".quick-prompt-btn"),
  chatContext: document.getElementById("chatContext"),
  contextPreview: document.getElementById("contextPreview"),
  refreshContext: document.getElementById("refreshContext"),
  documentIndicator: document.getElementById("documentIndicator"),
  chatMessages: document.getElementById("chatMessages"),
  chatInput: document.getElementById("chatInput"),
  sendChat: document.getElementById("sendChat"),
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

function toggleSettings() {
  const isVisible = dom.settingsPanel.classList.toggle("is-visible");
  dom.settingsToggle.classList.toggle("is-active", isVisible);
}

// ========================================
// Mode Switching
// ========================================

function setMode(mode) {
  state.mode = mode;
  
  // Update toggle buttons
  dom.modeButtons.forEach((button) => {
    button.classList.toggle("is-active", button.dataset.mode === mode);
  });
  
  // Show/hide views
  dom.redliningView.classList.toggle("is-hidden", mode !== "redlining");
  dom.chatView.classList.toggle("is-hidden", mode !== "chat");
  
  // Refresh contexts when switching to chat
  if (mode === "chat") {
    refreshDocumentContext();
    refreshSelectionContext();
  }
}

// ========================================
// Chat Functions
// ========================================

async function refreshDocumentContext() {
  try {
    const { text } = await getScopeText("document");
    state.documentContext = text;
    updateDocumentIndicator();
  } catch (error) {
    state.documentContext = "";
    updateDocumentIndicator();
  }
}

async function refreshSelectionContext() {
  try {
    const { text } = await getScopeText("selection");
    state.selectionContext = text;
    
    if (text && text.trim()) {
      dom.contextPreview.textContent = text.length > 200 ? text.substring(0, 200) + "..." : text;
      dom.contextPreview.classList.add("has-text");
    } else {
      dom.contextPreview.textContent = "No text selected";
      dom.contextPreview.classList.remove("has-text");
    }
  } catch (error) {
    dom.contextPreview.textContent = "Unable to read selection";
    dom.contextPreview.classList.remove("has-text");
  }
}

function updateDocumentIndicator() {
  if (dom.documentIndicator) {
    const wordCount = state.documentContext ? state.documentContext.trim().split(/\s+/).length : 0;
    dom.documentIndicator.textContent = wordCount > 0 ? `${wordCount} words loaded` : "No document";
  }
}

// Legacy function name for compatibility
async function refreshChatContext() {
  await refreshSelectionContext();
}

function renderChatMessages() {
  // Clear existing messages but keep welcome if no messages
  if (state.chatMessages.length === 0) {
    dom.chatMessages.innerHTML = `
      <div class="chat-welcome">
        <div class="welcome-icon">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" d="M8.625 12a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0H8.25m4.125 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0H12m4.125 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 0 1-2.555-.337A5.972 5.972 0 0 1 5.41 20.97a5.969 5.969 0 0 1-.474-.065 4.48 4.48 0 0 0 .978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25Z" />
          </svg>
        </div>
        <h3>Chat with your contract</h3>
        <p>Ask questions about the selected text, request explanations, or get suggestions for revisions.</p>
      </div>
    `;
    return;
  }
  
  dom.chatMessages.innerHTML = "";
  
  state.chatMessages.forEach((msg) => {
    const messageEl = document.createElement("div");
    messageEl.className = `chat-message ${msg.role}`;
    
    const bubbleEl = document.createElement("div");
    bubbleEl.className = "message-bubble";
    bubbleEl.textContent = msg.content;
    
    messageEl.appendChild(bubbleEl);
    
    // Add suggestion preview and action buttons for assistant messages with suggestions
    if (msg.role === "assistant" && msg.suggestion) {
      const suggestionEl = document.createElement("div");
      suggestionEl.className = "suggestion-preview";
      
      const suggestionLabel = document.createElement("div");
      suggestionLabel.className = "suggestion-label";
      suggestionLabel.textContent = "Suggested revision:";
      
      const suggestionText = document.createElement("div");
      suggestionText.className = "suggestion-text";
      
      // Show diff if we have original context, otherwise just show the suggestion
      if (state.selectionContext && state.selectionContext.trim()) {
        const diffSegments = diffTokens(state.selectionContext, msg.suggestion);
        if (diffSegments) {
          suggestionText.innerHTML = formatDiffHtml(diffSegments, state.selectionContext, msg.suggestion);
        } else {
          suggestionText.textContent = msg.suggestion;
        }
      } else {
        suggestionText.textContent = msg.suggestion;
      }
      
      const actionsEl = document.createElement("div");
      actionsEl.className = "message-actions";
      
      const applyBtn = document.createElement("button");
      applyBtn.className = "message-action-btn primary";
      applyBtn.textContent = "Apply to Document";
      applyBtn.addEventListener("click", () => applyChatSuggestion(msg.suggestion));
      
      const copyBtn = document.createElement("button");
      copyBtn.className = "message-action-btn";
      copyBtn.textContent = "Copy";
      copyBtn.addEventListener("click", () => copyChatSuggestion(msg.suggestion));
      
      actionsEl.appendChild(applyBtn);
      actionsEl.appendChild(copyBtn);
      
      suggestionEl.appendChild(suggestionLabel);
      suggestionEl.appendChild(suggestionText);
      suggestionEl.appendChild(actionsEl);
      
      messageEl.appendChild(suggestionEl);
    }
    
    const timeEl = document.createElement("div");
    timeEl.className = "message-time";
    timeEl.textContent = formatTime(msg.timestamp);
    messageEl.appendChild(timeEl);
    
    dom.chatMessages.appendChild(messageEl);
  });
  
  // Scroll to bottom
  dom.chatMessages.scrollTop = dom.chatMessages.scrollHeight;
}

function formatTime(timestamp) {
  const date = new Date(timestamp);
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatDiffHtml(segments, original, revised) {
  // Only treat equal segments as separators if they're significant (more than 10 chars)
  // Otherwise, merge small equal segments into the surrounding change region
  const MIN_EQUAL_LENGTH = 10;
  
  const regions = [];
  let pendingDeletes = "";
  let pendingInserts = "";
  
  for (const segment of segments) {
    if (segment.type === "equal") {
      const text = segment.text;
      const isSignificant = text.trim().length >= MIN_EQUAL_LENGTH;
      
      if (isSignificant) {
        // This is a real separator - flush pending changes first
        if (pendingDeletes || pendingInserts) {
          regions.push({ type: "change", deleted: pendingDeletes, inserted: pendingInserts });
          pendingDeletes = "";
          pendingInserts = "";
        }
        regions.push({ type: "equal", text: text });
      } else {
        // Small equal segment - include in both delete and insert to keep context
        pendingDeletes += text;
        pendingInserts += text;
      }
    } else if (segment.type === "delete") {
      pendingDeletes += segment.text;
    } else if (segment.type === "insert") {
      pendingInserts += segment.text;
    }
  }
  
  // Flush any remaining changes
  if (pendingDeletes || pendingInserts) {
    // Check if they're actually different
    if (pendingDeletes.trim() !== pendingInserts.trim()) {
      regions.push({ type: "change", deleted: pendingDeletes, inserted: pendingInserts });
    } else {
      // They're the same, just show as equal
      regions.push({ type: "equal", text: pendingInserts });
    }
  }
  
  return regions
    .map((region) => {
      if (region.type === "equal") {
        return escapeHtml(region.text);
      }
      let html = "";
      if (region.deleted && region.deleted.trim()) {
        html += `<span class="diff-delete">${escapeHtml(region.deleted)}</span>`;
      }
      if (region.inserted && region.inserted.trim()) {
        html += `<span class="diff-insert">${escapeHtml(region.inserted)}</span>`;
      }
      return html;
    })
    .join("");
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function addTypingIndicator() {
  const typingEl = document.createElement("div");
  typingEl.className = "chat-message assistant";
  typingEl.id = "typingIndicator";
  typingEl.innerHTML = `
    <div class="typing-indicator">
      <span></span>
      <span></span>
      <span></span>
    </div>
  `;
  dom.chatMessages.appendChild(typingEl);
  dom.chatMessages.scrollTop = dom.chatMessages.scrollHeight;
}

function removeTypingIndicator() {
  const indicator = document.getElementById("typingIndicator");
  if (indicator) {
    indicator.remove();
  }
}

async function handleSendChat() {
  const input = dom.chatInput.value.trim();
  if (!input || state.isChatLoading) return;
  
  // Add user message
  state.chatMessages.push({
    role: "user",
    content: input,
    timestamp: Date.now(),
  });
  
  dom.chatInput.value = "";
  renderChatMessages();
  
  // Show loading state
  state.isChatLoading = true;
  dom.sendChat.disabled = true;
  addTypingIndicator();
  
  try {
    const endpoint = state.endpoint.replace("/api/review", "/api/chat");
    
    const response = await sendChatMessage({
      endpoint,
      message: input,
      documentContext: state.documentContext,
      selectionContext: state.selectionContext,
      history: state.chatMessages.slice(0, -1), // Exclude current message
    });
    
    removeTypingIndicator();
    
    // Add assistant response
    state.chatMessages.push({
      role: "assistant",
      content: response.response,
      suggestion: response.suggestion || null,
      timestamp: Date.now(),
    });
    
    renderChatMessages();
  } catch (error) {
    removeTypingIndicator();
    
    state.chatMessages.push({
      role: "assistant",
      content: `Sorry, I encountered an error: ${error.message}`,
      timestamp: Date.now(),
    });
    
    renderChatMessages();
  } finally {
    state.isChatLoading = false;
    dom.sendChat.disabled = false;
  }
}

function handleQuickPrompt(promptType) {
  const prompts = {
    explain: "Can you explain what this clause means in plain language?",
    risks: "What are the potential risks or concerns with this clause?",
    suggest: "Can you suggest improvements to make this clause more favorable?",
    compare: "How does this compare to standard market terms?",
  };
  
  const prompt = prompts[promptType];
  if (prompt) {
    dom.chatInput.value = prompt;
    handleSendChat();
  }
}

async function applyChatSuggestion(suggestion) {
  try {
    await applyRedlines({
      scope: "selection",
      revisedText: suggestion,
      comments: [],
      trackChanges: true,
    });
    
    // Add confirmation message
    state.chatMessages.push({
      role: "assistant",
      content: "✓ Applied the suggestion to your document with Track Changes enabled.",
      timestamp: Date.now(),
    });
    renderChatMessages();
  } catch (error) {
    state.chatMessages.push({
      role: "assistant",
      content: `Failed to apply changes: ${error.message}`,
      timestamp: Date.now(),
    });
    renderChatMessages();
  }
}

async function copyChatSuggestion(suggestion) {
  try {
    await navigator.clipboard.writeText(suggestion);
    // Brief feedback could be added here
  } catch (error) {
    console.error("Failed to copy:", error);
  }
}

function bindEvents() {
  // Mode toggle
  dom.modeButtons.forEach((button) => {
    button.addEventListener("click", () => setMode(button.dataset.mode));
  });
  
  // Redlining events
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
  dom.settingsToggle.addEventListener("click", toggleSettings);
  
  // Chat events
  dom.refreshContext.addEventListener("click", refreshChatContext);
  dom.sendChat.addEventListener("click", handleSendChat);
  dom.chatInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      handleSendChat();
    }
  });
  
  // Auto-resize chat input
  dom.chatInput.addEventListener("input", () => {
    dom.chatInput.style.height = "auto";
    dom.chatInput.style.height = Math.min(dom.chatInput.scrollHeight, 120) + "px";
  });
  
  // Quick prompts
  dom.quickPromptButtons.forEach((button) => {
    button.addEventListener("click", () => handleQuickPrompt(button.dataset.prompt));
  });
}

async function initFromSettings() {
  const stored = await loadSettings();
  if (stored?.endpoint) {
    state.endpoint = stored.endpoint;
    dom.apiEndpoint.value = stored.endpoint;
  } else {
    // Use the default value from HTML if no stored endpoint
    state.endpoint = dom.apiEndpoint.value.trim();
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
    // Load both document context (background) and selection context (focus)
    await Promise.all([refreshDocumentContext(), refreshSelectionContext()]);
    
    // Listen for selection changes to auto-refresh chat context
    Office.context.document.addHandlerAsync(
      Office.EventType.DocumentSelectionChanged,
      handleSelectionChanged,
      (result) => {
        if (result.status === Office.AsyncResultStatus.Failed) {
          console.warn("Could not add selection handler:", result.error.message);
        }
      }
    );
  });
}

// Debounced handler for selection changes
let selectionDebounceTimer = null;
function handleSelectionChanged() {
  // Debounce to avoid too many calls while user is still selecting
  clearTimeout(selectionDebounceTimer);
  selectionDebounceTimer = setTimeout(() => {
    // Only auto-refresh if we're in chat mode
    if (state.mode === "chat") {
      refreshChatContext();
    }
  }, 300);
}
