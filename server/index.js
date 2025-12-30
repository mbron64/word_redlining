import "dotenv/config";
import express from "express";
import https from "https";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
});

const PROVIDER = process.env.AI_PROVIDER || "openai";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o";
const AZURE_API_VERSION = process.env.AZURE_OPENAI_API_VERSION || "2024-06-01";

function buildMessages({ text, instructions, riskProfile }) {
  const postureMap = {
    balanced: "Balanced counsel: pragmatic, neutral tone.",
    cautious: "Risk-averse counsel: highlight risks and tighten protections.",
    aggressive: "Aggressive negotiation: push for stronger protections.",
  };

  const posture = postureMap[riskProfile] || postureMap.balanced;

  return [
    {
      role: "system",
      content: [
        "You are a senior contract review assistant.",
        posture,
        "Return JSON only, no markdown.",
        "JSON schema:",
        "{ revisedText: string, comments: [{ anchorText: string, comment: string }], summary: string }",
        "Preserve defined terms and numbering.",
        "Avoid adding facts not present in the clause.",
        "If no changes are needed, return revisedText identical to the input and leave comments empty.",
        "Anchor comments using exact substrings from the revised clause when possible.",
      ].join(" "),
    },
    {
      role: "user",
      content: [
        "Review this clause and suggest tracked-change edits and short comments:",
        text,
        instructions ? `Additional guidance: ${instructions}` : "",
      ].filter(Boolean).join("\n\n"),
    },
  ];
}

function parseModelContent(content) {
  if (!content) {
    return null;
  }

  try {
    return JSON.parse(content);
  } catch (error) {
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) {
      return null;
    }
    try {
      return JSON.parse(match[0]);
    } catch (nestedError) {
      return null;
    }
  }
}

async function callOpenAI({ messages }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not configured.");
  }

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      messages,
      temperature: 0.2,
      max_tokens: 1200,
      response_format: { type: "json_object" },
    }),
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || "OpenAI request failed.");
  }

  const payload = await response.json();
  const content = payload?.choices?.[0]?.message?.content;
  const parsed = parseModelContent(content);
  if (!parsed) {
    throw new Error("Unable to parse model response.");
  }
  return parsed;
}

async function callAzureOpenAI({ messages }) {
  const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
  const apiKey = process.env.AZURE_OPENAI_KEY;
  const deployment = process.env.AZURE_OPENAI_DEPLOYMENT;

  if (!endpoint || !apiKey || !deployment) {
    throw new Error("Azure OpenAI configuration is incomplete.");
  }

  const url = `${endpoint.replace(/\/$/, "")}/openai/deployments/${deployment}/chat/completions?api-version=${AZURE_API_VERSION}`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "api-key": apiKey,
    },
    body: JSON.stringify({
      messages,
      temperature: 0.2,
      max_tokens: 1200,
      response_format: { type: "json_object" },
    }),
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || "Azure OpenAI request failed.");
  }

  const payload = await response.json();
  const content = payload?.choices?.[0]?.message?.content;
  const parsed = parseModelContent(content);
  if (!parsed) {
    throw new Error("Unable to parse model response.");
  }
  return parsed;
}

app.post("/api/review", async (req, res) => {
  const { text, instructions, riskProfile } = req.body || {};

  if (!text || typeof text !== "string") {
    res.status(400).json({ error: "Missing contract text." });
    return;
  }

  const messages = buildMessages({ text, instructions, riskProfile });

  try {
    const result = PROVIDER === "azure"
      ? await callAzureOpenAI({ messages })
      : await callOpenAI({ messages });

    res.json({
      revisedText: result.revisedText || "",
      comments: Array.isArray(result.comments) ? result.comments : [],
      summary: result.summary || "",
    });
  } catch (error) {
    res.status(500).json({ error: error.message || "AI request failed." });
  }
});

// ========================================
// Chat Endpoint
// ========================================

function buildChatMessages({ message, documentContext, selectionContext, history }) {
  // Build system prompt with document context as background knowledge
  const systemParts = [
    "You are a senior contract review assistant embedded in Microsoft Word.",
    "Your role is to help users understand, analyze, and improve contract language.",
    "",
    "Guidelines:",
    "- Be concise and practical in your responses",
    "- When explaining clauses, use plain language",
    "- When identifying risks, be specific about what could go wrong",
    "- When suggesting changes, provide the exact revised text",
    "- Consider the full document context when answering, but focus on any selected text",
    "",
    "If you suggest revised text, include it in your response clearly marked.",
    "Return JSON only with this schema:",
    '{ "response": "your conversational response", "suggestion": "optional revised clause text if you provided one" }',
  ];

  // Include document context in system prompt if available (truncate if very long)
  if (documentContext && documentContext.trim()) {
    const maxDocLength = 8000; // Leave room for other content
    const truncatedDoc = documentContext.length > maxDocLength 
      ? documentContext.substring(0, maxDocLength) + "\n[... document truncated ...]"
      : documentContext;
    
    systemParts.push("");
    systemParts.push("=== FULL DOCUMENT (Background Knowledge) ===");
    systemParts.push(truncatedDoc);
    systemParts.push("=== END DOCUMENT ===");
  }

  const messages = [
    { role: "system", content: systemParts.join("\n") },
  ];

  // Add conversation history
  if (history && history.length > 0) {
    // Limit history to last 10 messages to avoid token limits
    const recentHistory = history.slice(-10);
    recentHistory.forEach((msg) => {
      messages.push({
        role: msg.role,
        content: msg.content,
      });
    });
  }

  // Build current user message with selection focus
  let userContent = message;
  if (selectionContext && selectionContext.trim()) {
    userContent = `[FOCUS: Currently selected text]\n${selectionContext}\n\n[Question]\n${message}`;
  }

  messages.push({ role: "user", content: userContent });

  return messages;
}

async function callOpenAIChat({ messages }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not configured.");
  }

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      messages,
      temperature: 0.4,
      max_tokens: 1500,
      response_format: { type: "json_object" },
    }),
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || "OpenAI request failed.");
  }

  const payload = await response.json();
  const content = payload?.choices?.[0]?.message?.content;
  const parsed = parseModelContent(content);
  
  if (!parsed) {
    // If JSON parsing fails, return raw content as response
    return { response: content || "I couldn't process that request." };
  }
  
  return parsed;
}

async function callAzureOpenAIChat({ messages }) {
  const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
  const apiKey = process.env.AZURE_OPENAI_KEY;
  const deployment = process.env.AZURE_OPENAI_DEPLOYMENT;

  if (!endpoint || !apiKey || !deployment) {
    throw new Error("Azure OpenAI configuration is incomplete.");
  }

  const url = `${endpoint.replace(/\/$/, "")}/openai/deployments/${deployment}/chat/completions?api-version=${AZURE_API_VERSION}`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "api-key": apiKey,
    },
    body: JSON.stringify({
      messages,
      temperature: 0.4,
      max_tokens: 1500,
      response_format: { type: "json_object" },
    }),
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || "Azure OpenAI request failed.");
  }

  const payload = await response.json();
  const content = payload?.choices?.[0]?.message?.content;
  const parsed = parseModelContent(content);
  
  if (!parsed) {
    return { response: content || "I couldn't process that request." };
  }
  
  return parsed;
}

app.post("/api/chat", async (req, res) => {
  const { message, documentContext, selectionContext, history } = req.body || {};

  if (!message || typeof message !== "string") {
    res.status(400).json({ error: "Missing message." });
    return;
  }

  const messages = buildChatMessages({ message, documentContext, selectionContext, history });

  try {
    const result = PROVIDER === "azure"
      ? await callAzureOpenAIChat({ messages })
      : await callOpenAIChat({ messages });

    res.json({
      response: result.response || "",
      suggestion: result.suggestion || null,
    });
  } catch (error) {
    console.error("[/api/chat] Error:", error.message);
    res.status(500).json({ error: error.message || "Chat request failed." });
  }
});

// ========================================
// Live Document Markup - SSE Streaming
// ========================================

function buildStreamingReviewMessages({ text, instructions, riskProfile }) {
  const postureMap = {
    balanced: "Balanced counsel: pragmatic, neutral tone.",
    cautious: "Risk-averse counsel: highlight risks and tighten protections.",
    aggressive: "Aggressive negotiation: push for stronger protections.",
  };

  const posture = postureMap[riskProfile] || postureMap.balanced;

  return [
    {
      role: "system",
      content: [
        "You are a senior contract review assistant that analyzes contracts clause by clause.",
        posture,
        "",
        "CRITICAL: You must respond with a JSON array of issues found in the contract.",
        "Each issue should be a separate object in the array.",
        "",
        "Issue types:",
        "- 'edit': A suggested change to the contract text",
        "- 'comment': A note or risk flag without changing text",
        "",
        "JSON schema (array of issues):",
        "[",
        "  {",
        '    "type": "edit" | "comment",',
        '    "originalText": "exact text from contract to find/change",',
        '    "newText": "replacement text (only for edit type)",',
        '    "explanation": "brief explanation of why this change/comment is needed",',
        '    "severity": "low" | "medium" | "high"',
        "  }",
        "]",
        "",
        "Rules:",
        "- originalText must be an EXACT substring from the input contract",
        "- For edits, provide the revised text in newText",
        "- For comments, omit newText and just provide explanation",
        "- Keep explanations concise (1-2 sentences)",
        "- Order issues by their appearance in the document",
        "- If no issues found, return empty array []",
        "- Return ONLY valid JSON array, no other text",
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        "Analyze this contract and identify all issues, suggested edits, and risk flags:",
        "",
        "---CONTRACT START---",
        text,
        "---CONTRACT END---",
        "",
        instructions ? `Additional guidance: ${instructions}` : "",
        "",
        "Return a JSON array of issues found.",
      ].filter(Boolean).join("\n"),
    },
  ];
}

async function callOpenAIForIssues({ messages }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not configured.");
  }

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      messages,
      temperature: 0.2,
      max_tokens: 4000,
      response_format: { type: "json_object" },
    }),
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || "OpenAI request failed.");
  }

  const payload = await response.json();
  const content = payload?.choices?.[0]?.message?.content;
  
  console.log("[callOpenAIForIssues] Raw AI content:", content?.substring(0, 1000));
  
  if (!content) {
    throw new Error("No response from AI.");
  }

  // Parse the JSON response
  try {
    const parsed = JSON.parse(content);
    console.log("[callOpenAIForIssues] Parsed type:", typeof parsed, "isArray:", Array.isArray(parsed), "keys:", Object.keys(parsed));
    
    // Handle various response formats
    if (Array.isArray(parsed)) {
      // Already an array of issues
      return parsed;
    } else if (parsed.issues && Array.isArray(parsed.issues)) {
      // Object with issues property
      return parsed.issues;
    } else if (parsed.type && parsed.originalText) {
      // Single issue object - wrap in array
      console.log("[callOpenAIForIssues] Single issue object detected, wrapping in array");
      return [parsed];
    } else {
      console.log("[callOpenAIForIssues] Unknown format, returning empty array. Parsed:", JSON.stringify(parsed).substring(0, 500));
      return [];
    }
  } catch (e) {
    console.log("[callOpenAIForIssues] JSON parse failed:", e.message);
    // Try to extract array from response
    const match = content.match(/\[[\s\S]*\]/);
    if (match) {
      return JSON.parse(match[0]);
    }
    throw new Error("Could not parse AI response as JSON array.");
  }
}

app.get("/api/review-stream", async (req, res) => {
  // Set SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.flushHeaders();

  // Get parameters from query string
  const text = req.query.text;
  const instructions = req.query.instructions || "";
  const riskProfile = req.query.riskProfile || "balanced";

  if (!text) {
    res.write(`data: ${JSON.stringify({ type: "error", message: "Missing contract text." })}\n\n`);
    res.end();
    return;
  }

  // Send start event
  res.write(`data: ${JSON.stringify({ type: "start", message: "Starting analysis..." })}\n\n`);

  try {
    const messages = buildStreamingReviewMessages({ 
      text: decodeURIComponent(text), 
      instructions: decodeURIComponent(instructions), 
      riskProfile 
    });

    // Get all issues from AI
    const issues = await callOpenAIForIssues({ messages });

    // Stream each issue as a separate event
    for (let i = 0; i < issues.length; i++) {
      const issue = issues[i];
      issue.index = i;
      issue.total = issues.length;
      
      // Send issue event
      res.write(`data: ${JSON.stringify({ type: "issue", issue })}\n\n`);
      
      // Small delay to allow UI to process and show progress
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    // Send completion event
    res.write(`data: ${JSON.stringify({ type: "complete", totalIssues: issues.length })}\n\n`);
    
  } catch (error) {
    console.error("[/api/review-stream] Error:", error.message);
    res.write(`data: ${JSON.stringify({ type: "error", message: error.message || "Analysis failed." })}\n\n`);
  }

  res.end();
});

// Split contract into clauses/paragraphs for clause-by-clause processing
function splitIntoClauses(text) {
  // Normalize line endings (Word may use \r\n, \r, or \n)
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  
  // Split by:
  // - Double newlines (paragraphs)
  // - Single newlines followed by numbers (1. 2. etc)
  // - Single newlines followed by letters in parens ((a) (b) etc)
  // - Sentences ending with period followed by capital letter (fallback)
  let rawClauses = normalized.split(/\n\s*\n/);
  
  // If we only got 1 clause, try splitting by single newlines
  if (rawClauses.length <= 1) {
    rawClauses = normalized.split(/\n(?=\d+\.|\d+\)|\([a-zA-Z0-9]+\)|[A-Z])/);
  }
  
  // If still only 1 clause, try splitting by sentences (every ~500 chars at sentence boundaries)
  if (rawClauses.length <= 1 && normalized.length > 500) {
    rawClauses = [];
    const sentences = normalized.split(/(?<=[.!?])\s+(?=[A-Z])/);
    let buffer = "";
    
    for (const sentence of sentences) {
      buffer += (buffer ? " " : "") + sentence;
      if (buffer.length >= 400) {
        rawClauses.push(buffer);
        buffer = "";
      }
    }
    if (buffer.trim()) {
      rawClauses.push(buffer);
    }
  }
  
  // Filter out empty clauses and combine very short ones
  const clauses = [];
  let buffer = "";
  
  for (const clause of rawClauses) {
    const trimmed = clause.trim();
    if (!trimmed) continue;
    
    buffer += (buffer ? "\n\n" : "") + trimmed;
    
    // If buffer is substantial enough (at least 150 chars and has a sentence), add as a clause
    if (buffer.length >= 150 && buffer.includes(".")) {
      clauses.push(buffer);
      buffer = "";
    }
  }
  
  // Don't forget remaining buffer
  if (buffer.trim()) {
    if (clauses.length > 0 && buffer.length < 100) {
      // Append short remainder to last clause
      clauses[clauses.length - 1] += "\n\n" + buffer;
    } else {
      clauses.push(buffer);
    }
  }
  
  console.log("[splitIntoClauses] Input length:", text.length, "Output clauses:", clauses.length, "Clause lengths:", clauses.map(c => c.length));
  
  return clauses;
}

// Build prompt for analyzing a single clause
function buildClauseReviewMessages({ clause, clauseIndex, totalClauses, instructions, riskProfile }) {
  const postureMap = {
    balanced: "You represent the recipient/customer. Be pragmatic but protect their interests.",
    cautious: "You represent the recipient/customer. Be highly protective - flag any risk and suggest stronger protections.",
    aggressive: "You represent the recipient/customer. Aggressively negotiate - push back on any term favoring the other party.",
  };

  const posture = postureMap[riskProfile] || postureMap.balanced;

  return [
    {
      role: "system",
      content: [
        "You are a senior contracts attorney with 20+ years of experience reviewing commercial agreements.",
        posture,
        "",
        "REVIEW THIS CLAUSE THOROUGHLY. Look for:",
        "",
        "**Risk Areas to Flag:**",
        "- Unlimited liability or uncapped indemnification",
        "- Broad indemnification obligations",
        "- One-sided termination rights",
        "- Auto-renewal clauses without adequate notice periods",
        "- Unilateral amendment rights",
        "- Broad IP assignment or license grants",
        "- Weak confidentiality protections",
        "- Problematic limitation of liability clauses",
        "- Missing limitation on consequential damages",
        "- Unfavorable governing law or venue",
        "- Broad audit rights",
        "- Unreasonable non-compete or non-solicitation",
        "- Vague or undefined key terms",
        "- Missing caps on fees or price increases",
        "- Inadequate data protection or security obligations",
        "- Survival clauses that are too long",
        "- Assignment restrictions that are one-sided",
        "",
        "**Response Format - Return ONE JSON object:**",
        "",
        'For edits: { "type": "edit", "originalText": "exact text", "newText": "improved text", "explanation": "why this protects the client", "severity": "low|medium|high" }',
        'For deletions: { "type": "delete", "originalText": "exact text to remove", "explanation": "why remove it", "severity": "low|medium|high" }',
        'For flags: { "type": "comment", "originalText": "concerning text", "explanation": "the risk and recommendation", "severity": "low|medium|high" }',
        'If acceptable: { "type": "none" }',
        "",
        "**Severity Guide:**",
        "- high: Material risk, could cause significant harm (unlimited liability, broad indemnity, IP issues)",
        "- medium: Notable concern, should be negotiated (auto-renewal, unilateral changes, weak protections)",  
        "- low: Minor issue, nice to fix but acceptable (unclear language, minor imbalances)",
        "",
        "**Rules:**",
        "- originalText MUST be an EXACT substring from the clause (copy-paste accuracy)",
        "- Be specific in explanations - cite the actual risk",
        "- Suggest concrete improvements, not vague recommendations",
        "- Focus on substantive legal issues, not grammar",
        "- Return ONLY valid JSON",
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        `Review clause ${clauseIndex + 1} of ${totalClauses}:`,
        "",
        "---CLAUSE START---",
        clause,
        "---CLAUSE END---",
        "",
        instructions ? `Client's specific concerns: ${instructions}` : "",
        "",
        "Identify the most significant issue in this clause, or return { \"type\": \"none\" } if it's acceptable.",
      ].filter(Boolean).join("\n"),
    },
  ];
}

// Analyze a single clause
async function analyzeClause({ clause, clauseIndex, totalClauses, instructions, riskProfile }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not configured.");
  }

  const messages = buildClauseReviewMessages({ clause, clauseIndex, totalClauses, instructions, riskProfile });

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      messages,
      temperature: 0.2,
      max_tokens: 800,
      response_format: { type: "json_object" },
    }),
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || "OpenAI request failed.");
  }

  const payload = await response.json();
  const content = payload?.choices?.[0]?.message?.content;
  
  if (!content) return null;

  try {
    const parsed = JSON.parse(content);
    if (parsed.type === "none" || !parsed.type) return null;
    return parsed;
  } catch (e) {
    return null;
  }
}

// POST version - clause-by-clause streaming
app.post("/api/review-stream", async (req, res) => {
  // Set SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.flushHeaders();

  const { text, instructions, riskProfile } = req.body || {};

  console.log("[/api/review-stream] Received request, text length:", text?.length);

  if (!text || typeof text !== "string") {
    res.write(`data: ${JSON.stringify({ type: "error", message: "Missing contract text." })}\n\n`);
    res.end();
    return;
  }

  // Split contract into clauses
  const clauses = splitIntoClauses(text);
  console.log("[/api/review-stream] Split into", clauses.length, "clauses");

  // Send start event
  res.write(`data: ${JSON.stringify({ type: "start", message: "Starting analysis...", totalClauses: clauses.length })}\n\n`);

  const allIssues = [];
  let issueIndex = 0;

  try {
    // Process each clause
    for (let i = 0; i < clauses.length; i++) {
      const clause = clauses[i];
      
      // Send progress event
      res.write(`data: ${JSON.stringify({ type: "progress", clauseIndex: i, totalClauses: clauses.length, message: `Analyzing clause ${i + 1} of ${clauses.length}...` })}\n\n`);
      
      console.log(`[/api/review-stream] Analyzing clause ${i + 1}/${clauses.length} (${clause.length} chars)`);
      
      // Analyze this clause
      const issue = await analyzeClause({
        clause,
        clauseIndex: i,
        totalClauses: clauses.length,
        instructions,
        riskProfile,
      });

      if (issue && issue.type !== "none") {
        issue.index = issueIndex;
        issue.clauseIndex = i;
        issueIndex++;
        allIssues.push(issue);
        
        console.log(`[/api/review-stream] Found issue in clause ${i + 1}:`, issue.type);
        
        // Stream the issue immediately
        res.write(`data: ${JSON.stringify({ type: "issue", issue, clauseIndex: i, totalClauses: clauses.length })}\n\n`);
      }
    }

    // Send completion event
    res.write(`data: ${JSON.stringify({ type: "complete", totalIssues: allIssues.length, totalClauses: clauses.length })}\n\n`);
    console.log("[/api/review-stream] Complete. Found", allIssues.length, "issues in", clauses.length, "clauses");
    
  } catch (error) {
    console.error("[/api/review-stream] Error:", error.message);
    res.write(`data: ${JSON.stringify({ type: "error", message: error.message || "Analysis failed." })}\n\n`);
  }

  res.end();
});

const port = process.env.PORT || 8787;

// Try HTTPS first, fall back to HTTP
const certPath = path.join(__dirname, "..", "certs", "dev.crt");
const keyPath = path.join(__dirname, "..", "certs", "dev.key");

if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
  const httpsOptions = {
    key: fs.readFileSync(keyPath),
    cert: fs.readFileSync(certPath),
  };
  https.createServer(httpsOptions, app).listen(port, () => {
    console.log(`Goosefarm server running on https://localhost:${port}`);
  });
} else {
  app.listen(port, () => {
    console.log(`Goosefarm server running on http://localhost:${port} (no certs found)`);
  });
}
