import { getScopeText, applyRedlines } from "./services/wordService.js";
import { reviewClause } from "./services/aiService.js";
import { sendChatMessage } from "./services/chatService.js";
import { diffTokens, formatDiff, formatDiffHtml } from "./utils/diff.js";
import { loadSettings, saveSettings } from "./utils/storage.js";

const state = {
  // Mode
  mode: "chat", // "chat" | "redlining"
  
  // Redlining state
  scope: "selection",
  riskProfile: "balanced",
  trackChanges: true,
  instructions: "",
  endpoint: "",
  rememberEndpoint: true,
  originalText: "",
  result: null,
  
  // Live markup state
  isAnalyzing: false,
  issues: [],
  currentIssueIndex: -1,
  
  // Chat state
  chatMessages: [],
  documentContext: "",  // Full document as background
  selectionContext: "", // Currently selected text to focus on
  isChatLoading: false,
};

const dom = {
  // Redlining elements
  scopeButtons: document.querySelectorAll(".segment[data-scope]"),
  scopeHint: document.getElementById("scopeHint"),
  refreshSelection: document.getElementById("refreshSelection"),
  riskProfile: document.getElementById("riskProfile"),
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
  if (dom.runMeta) {
    dom.runMeta.textContent = message;
  }
}

// Metrics display removed - now showing issues-focused results instead

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
    return;
  }

  const { revisedText, comments } = state.result;

  // Always show diff with red/green highlighting
  if (state.originalText && revisedText) {
    const diff = diffTokens(state.originalText, revisedText);
    const diffHtml = formatDiffHtml(diff);
    dom.suggestedClause.innerHTML = diffHtml;
  } else {
    dom.suggestedClause.textContent = revisedText || "No revisions suggested.";
  }
  dom.commentPill.textContent = comments.length.toString();
  renderComments(comments);
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

    setStatus("Applied changes to document.");
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

// ========================================
// Live Document Markup Functions
// ========================================

async function enableTrackChanges() {
  return Word.run(async (context) => {
    context.document.changeTrackingMode = Word.ChangeTrackingMode.trackAll;
    await context.sync();
  });
}

async function disableTrackChanges() {
  return Word.run(async (context) => {
    context.document.changeTrackingMode = Word.ChangeTrackingMode.off;
    await context.sync();
  });
}

async function findAndReplaceText(originalText, newText) {
  return Word.run(async (context) => {
    const body = context.document.body;
    const searchResults = body.search(originalText, { matchCase: false, matchWholeWord: false });
    searchResults.load("items");
    await context.sync();

    if (searchResults.items.length > 0) {
      // Replace the first occurrence
      searchResults.items[0].insertText(newText, Word.InsertLocation.replace);
      await context.sync();
      return true;
    }
    return false;
  });
}

async function addCommentToText(targetText, commentText) {
  return Word.run(async (context) => {
    const body = context.document.body;
    const searchResults = body.search(targetText, { matchCase: false, matchWholeWord: false });
    searchResults.load("items");
    await context.sync();

    if (searchResults.items.length > 0) {
      // Add comment to the first occurrence
      searchResults.items[0].insertComment(commentText);
      await context.sync();
      return true;
    }
    return false;
  });
}

async function selectTextInDocument(targetText) {
  return Word.run(async (context) => {
    const body = context.document.body;
    const searchResults = body.search(targetText, { matchCase: false, matchWholeWord: false });
    searchResults.load("items");
    await context.sync();

    if (searchResults.items.length > 0) {
      searchResults.items[0].select();
      await context.sync();
      return true;
    }
    return false;
  });
}

function renderIssuesList() {
  const container = document.getElementById("issuesList");
  if (!container) return;

  if (state.issues.length === 0) {
    container.innerHTML = `
      <div class="issues-empty">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" d="M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
        </svg>
        <p>No issues found yet</p>
      </div>
    `;
    return;
  }

  container.innerHTML = state.issues.map((issue, index) => {
    const isEdit = issue.type === "edit";
    const severityClass = issue.severity || "medium";
    const statusClass = issue.applied ? "applied" : "";
    
    return `
      <div class="issue-card ${statusClass}" data-index="${index}">
        <div class="issue-header">
          <span class="issue-type ${isEdit ? 'edit' : 'comment'}">
            ${isEdit ? `
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" d="m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L10.582 16.07a4.5 4.5 0 0 1-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 0 1 1.13-1.897l8.932-8.931Zm0 0L19.5 7.125" />
              </svg>
              Edit
            ` : `
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" d="M7.5 8.25h9m-9 3H12m-9.75 1.51c0 1.6 1.123 2.994 2.707 3.227 1.129.166 2.27.293 3.423.379.35.026.67.21.865.501L12 21l2.755-4.133a1.14 1.14 0 0 1 .865-.501 48.172 48.172 0 0 0 3.423-.379c1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0 0 12 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018Z" />
              </svg>
              Comment
            `}
          </span>
          <span class="issue-severity ${severityClass}">${severityClass}</span>
        </div>
        <div class="issue-text">${escapeHtml(truncateText(issue.originalText, 80))}</div>
        <div class="issue-explanation">${escapeHtml(issue.explanation)}</div>
        ${issue.applied ? '<div class="issue-status">✓ Applied</div>' : ''}
      </div>
    `;
  }).join("");

  // Add click handlers
  container.querySelectorAll(".issue-card").forEach((card) => {
    card.addEventListener("click", () => {
      const index = parseInt(card.dataset.index, 10);
      handleIssueClick(index);
    });
  });
}

function truncateText(text, maxLength) {
  if (!text) return "";
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength) + "...";
}

async function handleIssueClick(index) {
  const issue = state.issues[index];
  if (!issue) return;

  state.currentIssueIndex = index;
  
  // Highlight the card
  document.querySelectorAll(".issue-card").forEach((card, i) => {
    card.classList.toggle("is-selected", i === index);
  });

  // Select the text in Word
  try {
    await selectTextInDocument(issue.originalText);
  } catch (error) {
    console.warn("Could not select text:", error);
  }
}

async function applyIssueToDocument(issue) {
  try {
    if (issue.type === "edit" && issue.newText) {
      // Apply text replacement with track changes
      const success = await findAndReplaceText(issue.originalText, issue.newText);
      if (success) {
        // Also add a comment with the explanation
        await addCommentToText(issue.newText, issue.explanation);
      }
      return success;
    } else if (issue.type === "comment") {
      // Just add a comment
      return await addCommentToText(issue.originalText, issue.explanation);
    }
    return false;
  } catch (error) {
    console.error("Error applying issue:", error);
    return false;
  }
}

function updateAnalysisProgress(current, total) {
  const progressEl = document.getElementById("analysisProgress");
  if (progressEl) {
    const percent = total > 0 ? Math.round((current / total) * 100) : 0;
    progressEl.innerHTML = `
      <div class="progress-bar">
        <div class="progress-fill" style="width: ${percent}%"></div>
      </div>
      <span class="progress-text">Analyzing... ${current}/${total} issues found</span>
    `;
  }
}

function showAnalysisStart() {
  const container = document.getElementById("issuesList");
  if (container) {
    container.innerHTML = `
      <div class="analysis-loading">
        <div class="thinking-shimmer">Analyzing contract...</div>
      </div>
    `;
  }
  
  const progressEl = document.getElementById("analysisProgress");
  if (progressEl) {
    progressEl.innerHTML = `
      <div class="progress-bar">
        <div class="progress-fill progress-indeterminate"></div>
      </div>
      <span class="progress-text">Starting analysis...</span>
    `;
    progressEl.classList.remove("is-hidden");
  }
}

function showAnalysisComplete(totalIssues) {
  const progressEl = document.getElementById("analysisProgress");
  if (progressEl) {
    progressEl.innerHTML = `
      <div class="progress-summary">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" d="M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
        </svg>
        <span>${totalIssues} issue${totalIssues !== 1 ? 's' : ''} found and applied</span>
      </div>
    `;
  }
}

async function handleLiveAnalysis() {
  if (state.isAnalyzing) return;

  // Get document text based on scope
  const { text } = await getScopeText(state.scope);
  if (!text || !text.trim()) {
    setStatus("No text to analyze. Select text or choose a different scope.", "warning");
    return;
  }

  state.isAnalyzing = true;
  state.issues = [];
  state.currentIssueIndex = -1;
  
  // Update button state
  const analyzeBtn = document.getElementById("runReview");
  if (analyzeBtn) {
    analyzeBtn.disabled = true;
    analyzeBtn.innerHTML = `
      <div class="spinner"></div>
      <span>Analyzing...</span>
    `;
  }

  showAnalysisStart();

  // Enable track changes if setting is on
  if (state.trackChanges) {
    try {
      await enableTrackChanges();
    } catch (error) {
      console.warn("Could not enable track changes:", error);
    }
  }

  // Create streaming request
  const streamEndpoint = state.endpoint.replace("/api/review", "/api/review-stream");
  
  try {
    // Use fetch with ReadableStream for POST request
    const response = await fetch(streamEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        instructions: state.instructions,
        riskProfile: state.riskProfile,
      }),
    });

    if (!response.ok) {
      throw new Error(`Request failed: ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      
      // Process complete SSE events
      const lines = buffer.split("\n");
      buffer = lines.pop() || ""; // Keep incomplete line in buffer

      for (const line of lines) {
        if (line.startsWith("data: ")) {
          const data = line.slice(6);
          try {
            const event = JSON.parse(data);
            await handleStreamEvent(event);
          } catch (e) {
            console.warn("Could not parse SSE event:", data);
          }
        }
      }
    }

  } catch (error) {
    console.error("Streaming error:", error);
    setStatus(`Analysis failed: ${error.message}`, "error");
  } finally {
    state.isAnalyzing = false;
    
    // Reset button
    if (analyzeBtn) {
      analyzeBtn.disabled = false;
      analyzeBtn.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="btn-icon-left">
          <path stroke-linecap="round" stroke-linejoin="round" d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09ZM18.259 8.715 18 9.75l-.259-1.035a3.375 3.375 0 0 0-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 0 0 2.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 0 0 2.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 0 0-2.456 2.456ZM16.894 20.567 16.5 21.75l-.394-1.183a2.25 2.25 0 0 0-1.423-1.423L13.5 18.75l1.183-.394a2.25 2.25 0 0 0 1.423-1.423l.394-1.183.394 1.183a2.25 2.25 0 0 0 1.423 1.423l1.183.394-1.183.394a2.25 2.25 0 0 0-1.423 1.423Z" />
        </svg>
        <span>Analyze Contract</span>
      `;
    }
  }
}

async function handleStreamEvent(event) {
  switch (event.type) {
    case "start":
      setStatus("Analysis started...", "info");
      break;

    case "issue":
      const issue = event.issue;
      state.issues.push(issue);
      
      // Update progress
      updateAnalysisProgress(issue.index + 1, issue.total);
      
      // Apply the issue to the document immediately
      const applied = await applyIssueToDocument(issue);
      issue.applied = applied;
      
      // Re-render the issues list
      renderIssuesList();
      break;

    case "complete":
      showAnalysisComplete(event.totalIssues);
      setStatus(`Analysis complete. ${event.totalIssues} issue${event.totalIssues !== 1 ? 's' : ''} found.`, "success");
      break;

    case "error":
      setStatus(event.message || "Analysis failed.", "error");
      break;
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
    <div class="thinking-shimmer">Thinking...</div>
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
  dom.trackChanges.addEventListener("change", (event) => {
    state.trackChanges = event.target.checked;
  });
  dom.instructions.addEventListener("input", (event) => {
    state.instructions = event.target.value;
  });
  dom.runReview.addEventListener("click", handleLiveAnalysis);
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
