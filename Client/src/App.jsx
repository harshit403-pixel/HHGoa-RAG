import { useCallback } from "react";
import AppShell from "./components/layout/AppShell";
import Conversation from "./components/conversation/Conversation";
import VoiceExperience from "./components/voice/VoiceExperience";
import useRagExperience from "./hooks/useRagExperience";

function App() {
  const {
    messages,
    isProcessing,
    addUserMessage,
    startProcessing,
    addAssistantMessage,
  } = useRagExperience();

  const handleVoiceQuery = useCallback(
    (query) => {
      if (!query?.trim()) {
        return;
      }

      addUserMessage(query);
      startProcessing();

      // Temporary mock RAG response.
      // Backend will replace this later.
      window.setTimeout(() => {
        addAssistantMessage();
      }, 900);
    },
    [
      addUserMessage,
      startProcessing,
      addAssistantMessage,
    ],
  );

  return (
    <AppShell>
      <Conversation
        messages={messages}
        isProcessing={isProcessing}
      />

      <VoiceExperience
        onVoiceQuery={handleVoiceQuery}
        hasConversation={messages.length > 0}
        isProcessing={isProcessing}
      />
    </AppShell>
  );
}

export default App;