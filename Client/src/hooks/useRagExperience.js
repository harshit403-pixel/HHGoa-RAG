import { useCallback, useState } from "react";

const INITIAL_STATE = {
  messages: [],
  isProcessing: false,
  error: null,
  statusUpdates: [],
};

const API_BASE = "";

function useRagExperience() {
  const [state, setState] = useState(INITIAL_STATE);

  const clearConversation = useCallback(() => {
    setState(INITIAL_STATE);
  }, []);

  const submitQuery = useCallback(async (payload) => {
    setState((current) => ({
      ...current,
      isProcessing: true,
      error: null,
      statusUpdates: [],
    }));

    const userMsgId = crypto.randomUUID();
    const assistantMsgId = crypto.randomUUID();
    const isAudio = payload instanceof Blob;

    // Add placeholder messages
    setState((current) => ({
      ...current,
      messages: [
        ...current.messages,
        {
          id: userMsgId,
          role: "user",
          content: isAudio ? "Transcribing voice..." : payload,
        },
        {
          id: assistantMsgId,
          role: "assistant",
          content: "",
          sources: [],
          grounded: true,
        },
      ],
    }));

    try {
      const headers = {};
      let body;

      if (isAudio) {
        const formData = new FormData();
        formData.append("audio", payload, "query.wav");
        body = formData;
      } else {
        headers["Content-Type"] = "application/json";
        body = JSON.stringify({ query: payload, language: "en-IN" });
      }

      const response = await fetch(`${API_BASE}/api/query`, {
        method: "POST",
        headers,
        body,
      });

      if (!response.ok) {
        throw new Error(`HTTP API error ${response.status}`);
      }

      if (!response.body) {
        throw new Error("Server returned empty response stream");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let currentEvent = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          if (trimmed.startsWith("event: ")) {
            currentEvent = trimmed.slice(7).trim();
          } else if (trimmed.startsWith("data: ")) {
            const dataStr = trimmed.slice(6).trim();
            try {
              const data = JSON.parse(dataStr);
              
              // Handle SSE Events
              if (currentEvent === "status") {
                if (data.step === "stt_done" || data.step === "stt_none") {
                  setState((current) => ({
                    ...current,
                    messages: current.messages.map((m) => {
                      if (m.id === userMsgId) {
                        return { ...m, content: data.queryText };
                      }
                      return m;
                    }),
                  }));
                }

                setState((current) => {
                  const update = {
                    step: data.step,
                    message: data.message,
                    timestamp: data.timestamp,
                    latency: data.latency,
                  };
                  return {
                    ...current,
                    statusUpdates: [...current.statusUpdates, update],
                    messages: current.messages.map((m) => {
                      if (m.id === assistantMsgId) {
                        return {
                          ...m,
                          statusUpdates: [...(m.statusUpdates || []), update],
                        };
                      }
                      return m;
                    }),
                  };
                });
              } else if (currentEvent === "metadata") {
                setState((current) => ({
                  ...current,
                  messages: current.messages.map((m) => {
                    if (m.id === userMsgId) {
                      return { ...m, content: data.query };
                    }
                    if (m.id === assistantMsgId) {
                      return { 
                        ...m, 
                        sources: data.citations,
                        performance: {
                          stt: data.sttMs,
                          translate: data.translationMs,
                          search: data.searchMs,
                          embed: data.embedMs,
                          retrieve: data.retrieveMs,
                          total: data.totalMs
                        }
                      };
                    }
                    return m;
                  }),
                }));
              } else if (currentEvent === "chunk") {
                setState((current) => ({
                  ...current,
                  messages: current.messages.map((m) => {
                    if (m.id === assistantMsgId) {
                      return { ...m, content: m.content + data.text };
                    }
                    return m;
                  }),
                }));
              } else if (currentEvent === "error") {
                setState((current) => ({
                  ...current,
                  error: data.message,
                  isProcessing: false,
                }));
              } else if (currentEvent === "done") {
                setState((current) => ({
                  ...current,
                  isProcessing: false,
                }));
              }
            } catch (e) {
              // skip malformed JSON lines
            }
          }
        }
      }
    } catch (err) {
      setState((current) => ({
        ...current,
        error: err.message || "Failed to retrieve RAG response",
        isProcessing: false,
      }));
    }
  }, []);

  return {
    messages: state.messages,
    isProcessing: state.isProcessing,
    error: state.error,
    statusUpdates: state.statusUpdates,

    submitQuery,
    clearConversation,
  };
}

export default useRagExperience;