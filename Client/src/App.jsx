import { useCallback } from "react";
import AppShell from "./components/layout/AppShell";
import Conversation from "./components/conversation/Conversation";
import VoiceExperience from "./components/voice/VoiceExperience";
import useRagExperience from "./hooks/useRagExperience";

function App() {
  const {
    messages,
    isProcessing,
    statusUpdates,
    submitQuery,
  } = useRagExperience();

  const handleVoiceQuery = useCallback(
    (query) => {
      if (!query) {
        return;
      }
      submitQuery(query);
    },
    [submitQuery],
  );

  return (
    <AppShell>
      <Conversation
        messages={messages}
        isProcessing={isProcessing}
        statusUpdates={statusUpdates}
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