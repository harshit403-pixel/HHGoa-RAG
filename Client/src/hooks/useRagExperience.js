import { useCallback, useState } from "react";

const INITIAL_STATE = {
  messages: [],
  isProcessing: false,
  error: null,
};

const MOCK_RESPONSE = {
  query: "What is multilingual information retrieval?",
  answer:
    "Multilingual information retrieval is the process of finding relevant information across multiple languages. It allows a user to submit a query in one language and retrieve useful information from documents written in the same or different languages.",
  grounded: true,
  sources: [
    {
      id: "source-1",
      text: "Multilingual information retrieval deals with retrieving information across multiple languages and enables users to access relevant content regardless of the language in which that content is written.",
      score: 0.94,
      metadata: {
        dataset: "MSMARCO-XI",
        type: "retrieved context",
      },
    },
    {
      id: "source-2",
      text: "Cross-language information retrieval systems can accept a query in one language and return documents or passages written in another language.",
      score: 0.89,
      metadata: {
        dataset: "MSMARCO-XI",
        type: "retrieved context",
      },
    },
  ],
};

function useRagExperience() {
  const [state, setState] = useState(INITIAL_STATE);

  const addUserMessage = useCallback((query) => {
    setState((current) => ({
      ...current,
      messages: [
        ...current.messages,
        {
          id: crypto.randomUUID(),
          role: "user",
          content: query,
        },
      ],
      error: null,
    }));
  }, []);

  const startProcessing = useCallback(() => {
    setState((current) => ({
      ...current,
      isProcessing: true,
      error: null,
    }));
  }, []);

  const addAssistantMessage = useCallback(() => {
    setState((current) => ({
      ...current,
      messages: [
        ...current.messages,
        {
          id: crypto.randomUUID(),
          role: "assistant",
          content: MOCK_RESPONSE.answer,
          grounded: MOCK_RESPONSE.grounded,
          sources: MOCK_RESPONSE.sources,
        },
      ],
      isProcessing: false,
      error: null,
    }));
  }, []);

  const setError = useCallback((message) => {
    setState((current) => ({
      ...current,
      isProcessing: false,
      error: message,
    }));
  }, []);

  const clearConversation = useCallback(() => {
    setState(INITIAL_STATE);
  }, []);

  return {
    messages: state.messages,
    isProcessing: state.isProcessing,
    error: state.error,

    addUserMessage,
    startProcessing,
    addAssistantMessage,
    setError,
    clearConversation,
  };
}

export default useRagExperience;