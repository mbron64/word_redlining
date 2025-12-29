import express from "express";

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

const port = process.env.PORT || 8787;
app.listen(port, () => {
  console.log(`Redline AI server running on port ${port}`);
});
