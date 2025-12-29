function normalizeResponse(data) {
  const revisedText = typeof data?.revisedText === "string" ? data.revisedText.trim() : "";
  const comments = Array.isArray(data?.comments) ? data.comments : [];
  const summary = typeof data?.summary === "string" ? data.summary.trim() : "";

  return {
    revisedText,
    comments: comments
      .filter((item) => item && item.comment)
      .map((item) => ({
        anchorText: item.anchorText || "",
        comment: item.comment,
      })),
    summary,
  };
}

export async function reviewClause({ endpoint, text, instructions, riskProfile, scope }) {
  if (!endpoint) {
    throw new Error("Set a review API endpoint first.");
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 60000);

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text,
        instructions,
        riskProfile,
        scope,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const message = await response.text();
      throw new Error(message || `Request failed with ${response.status}.`);
    }

    const data = await response.json();
    return normalizeResponse(data);
  } finally {
    clearTimeout(timeoutId);
  }
}
