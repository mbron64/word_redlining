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
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
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
