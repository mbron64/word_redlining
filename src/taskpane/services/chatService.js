/**
 * Chat Service
 * Handles conversational AI interactions for contract review
 */

/**
 * Send a chat message to the AI backend
 * @param {Object} params
 * @param {string} params.endpoint - The chat API endpoint
 * @param {string} params.message - The user's message
 * @param {string} params.documentContext - Full document as background knowledge
 * @param {string} params.selectionContext - Currently selected text to focus on
 * @param {Array} params.history - Previous messages in the conversation
 * @returns {Promise<{response: string, suggestion?: string}>}
 */
export async function sendChatMessage({ endpoint, message, documentContext, selectionContext, history }) {
  if (!endpoint) {
    throw new Error("Set a chat API endpoint first.");
  }

  const body = {
    message,
    documentContext: documentContext || "",
    selectionContext: selectionContext || "",
    history: history.map((msg) => ({
      role: msg.role,
      content: msg.content,
    })),
  };

  console.log("[chatService] Sending to:", endpoint);
  console.log("[chatService] Request body:", JSON.stringify(body, null, 2));

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  console.log("[chatService] Response status:", response.status);

  if (!response.ok) {
    const errorText = await response.text();
    console.error("[chatService] Error response:", errorText);
    throw new Error(errorText || "Chat request failed.");
  }

  const data = await response.json();
  console.log("[chatService] Response data:", data);

  return {
    response: data.response || "I couldn't generate a response.",
    suggestion: data.suggestion || null,
  };
}

