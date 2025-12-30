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
  
  if (!content) {
    throw new Error("No response from AI.");
  }

  // Parse the JSON response
  try {
    const parsed = JSON.parse(content);
    // Handle both array and object with issues property
    if (Array.isArray(parsed)) {
      return parsed;
    } else if (parsed.issues && Array.isArray(parsed.issues)) {
      return parsed.issues;
    } else {
      return [];
    }
  } catch (e) {
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

// POST version for larger documents (body can be bigger than URL)
app.post("/api/review-stream", async (req, res) => {
  // Set SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.flushHeaders();

  const { text, instructions, riskProfile } = req.body || {};

  if (!text || typeof text !== "string") {
    res.write(`data: ${JSON.stringify({ type: "error", message: "Missing contract text." })}\n\n`);
    res.end();
    return;
  }

  // Send start event
  res.write(`data: ${JSON.stringify({ type: "start", message: "Starting analysis..." })}\n\n`);

  try {
    const messages = buildStreamingReviewMessages({ text, instructions, riskProfile });

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
    console.log(`Goosefarm AI server running on https://localhost:${port}`);
  });
} else {
  app.listen(port, () => {
    console.log(`Goosefarm AI server running on http://localhost:${port} (no certs found)`);
  });
}
