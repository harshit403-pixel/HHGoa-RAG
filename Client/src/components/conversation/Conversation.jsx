import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef } from "react";
import SourceCard from "../answer/SourceCard";

function Conversation({
  messages = [],
  isProcessing = false,
  statusUpdates = [],
}) {
  const bottomRef = useRef(null);

  useEffect(() => {
    if (!bottomRef.current) {
      return;
    }

    bottomRef.current.scrollIntoView({
      behavior: "smooth",
      block: "end",
    });
  }, [messages.length, isProcessing, statusUpdates.length]);

  if (messages.length === 0 && !isProcessing) {
    return null;
  }

  return (
    <main
      aria-label="Conversation"
      className="mx-auto w-full max-w-4xl px-6 pb-56 pt-10"
    >
      <div className="space-y-10">
        <AnimatePresence initial={false}>
          {messages.map((message) => {
            if (message.role === "user") {
              return (
                <motion.div
                  key={message.id}
                  initial={{
                    opacity: 0,
                    y: 16,
                  }}
                  animate={{
                    opacity: 1,
                    y: 0,
                  }}
                  transition={{
                    duration: 0.35,
                    ease: [0.22, 1, 0.36, 1],
                  }}
                  className="flex justify-end"
                >
                  <div className="max-w-2xl">
                    <p className="mb-2 px-1 text-right text-[10px] font-medium uppercase tracking-[0.2em] text-white/25">
                      You
                    </p>

                    <div className="rounded-3xl rounded-br-md border border-white/[0.07] bg-white/[0.045] px-5 py-4 sm:px-6">
                      <p className="text-sm leading-7 text-white/75 sm:text-base">
                        {message.content}
                      </p>
                    </div>
                  </div>
                </motion.div>
              );
            }

            return (
              <motion.article
                key={message.id}
                initial={{
                  opacity: 0,
                  y: 20,
                }}
                animate={{
                  opacity: 1,
                  y: 0,
                }}
                transition={{
                  duration: 0.45,
                  ease: [0.22, 1, 0.36, 1],
                }}
                className="space-y-7"
              >
                {/* Assistant identity */}
                <div className="flex items-center gap-3">
                  <div className="flex h-8 w-8 items-center justify-center rounded-full border border-violet-400/20 bg-violet-400/10">
                    <span className="text-[10px] font-semibold text-violet-300">
                      R
                    </span>
                  </div>

                  <span className="text-xs font-medium uppercase tracking-[0.2em] text-white/35">
                    RAG in Goa
                  </span>

                  {message.grounded && (
                    <span className="rounded-full border border-emerald-400/15 bg-emerald-400/10 px-2.5 py-1 text-[10px] font-medium text-emerald-300">
                      Grounded
                    </span>
                  )}
                </div>

                {/* Answer */}
                <div className="max-w-3xl">
                  <p className="text-[15px] leading-8 text-white/75 sm:text-base">
                    {message.content || (isProcessing ? "Thinking..." : "")}
                  </p>
                </div>

                {/* Sources */}
                {message.sources?.length > 0 && (
                  <div>
                    <div className="mb-4 flex items-center justify-between">
                      <p className="text-[10px] font-medium uppercase tracking-[0.2em] text-white/30">
                        Retrieved context
                      </p>

                      <span className="text-[10px] text-white/20">
                        {message.sources.length} sources
                      </span>
                    </div>

                    <div className="grid gap-3 sm:grid-cols-2">
                      {message.sources.map(
                        (source, index) => (
                          <SourceCard
                            key={
                              source.chunk_id ?? source.id ?? index
                            }
                            source={source}
                            index={index}
                          />
                        ),
                      )}
                    </div>
                  </div>
                )}
              </motion.article>
            );
          })}
        </AnimatePresence>

        {/* Pipeline SSE Status Logs Console */}
        {statusUpdates.length > 0 && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4 }}
          >
            <PipelineConsole statusUpdates={statusUpdates} isProcessing={isProcessing} />
          </motion.div>
        )}

        {/* Processing */}
        <AnimatePresence>
          {isProcessing && (
            <ProcessingMessage />
          )}
        </AnimatePresence>

        {/* Scroll target */}
        <div
          ref={bottomRef}
          aria-hidden="true"
          className="h-px"
        />
      </div>
    </main>
  );
}

function PipelineConsole({ statusUpdates = [], isProcessing = false }) {
  const terminalEndRef = useRef(null);

  useEffect(() => {
    if (terminalEndRef.current) {
      terminalEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [statusUpdates.length]);

  return (
    <div className="rounded-2xl border border-white/[0.08] bg-[#0c0c14] p-5 font-mono text-[11px] text-violet-300/80 shadow-2xl">
      <div className="mb-3 flex items-center justify-between border-b border-white/[0.05] pb-2 text-[10px] uppercase tracking-wider text-white/35">
        <span>RAG Pipeline Execution Logs (SSE Stream)</span>
        {isProcessing ? (
          <span className="flex items-center gap-1.5 text-emerald-400">
            <span className="h-1.5 w-1.5 animate-ping rounded-full bg-emerald-400" />
            Streaming Live
          </span>
        ) : (
          <span className="text-white/20">Finished</span>
        )}
      </div>
      <div className="max-h-48 overflow-y-auto space-y-2 pr-2 scrollbar-thin scrollbar-thumb-white/10 scrollbar-track-transparent">
        {statusUpdates.map((update, idx) => {
          const date = new Date(update.timestamp);
          const timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) + '.' + String(date.getMilliseconds()).padStart(3, '0');
          const isDone = update.step.endsWith("_done") || update.step === "guardrails_done" || update.step === "generate_done";
          const isFailed = update.step.endsWith("_failed");
          
          let prefix = "●";
          let color = "text-violet-300/60";
          if (isDone) {
            prefix = "✔";
            color = "text-emerald-400/90";
          } else if (isFailed) {
            prefix = "✖";
            color = "text-red-400";
          } else if (isProcessing && idx === statusUpdates.length - 1) {
            prefix = "⚡";
            color = "text-cyan-400 animate-pulse";
          }
          
          return (
            <div key={idx} className={`flex items-start gap-2 leading-relaxed ${color}`}>
              <span className="shrink-0 font-medium text-white/25">[{timeStr}]</span>
              <span className="shrink-0 font-bold">{prefix}</span>
              <span>
                {update.message}
                {update.latency !== undefined && (
                  <span className="ml-2 rounded bg-white/[0.06] px-1 py-0.5 text-[9px] font-semibold text-white/40">
                    {update.latency}ms
                  </span>
                )}
              </span>
            </div>
          );
        })}
        <div ref={terminalEndRef} />
      </div>
    </div>
  );
}

function ProcessingMessage() {
  return (
    <motion.div
      initial={{
        opacity: 0,
        y: 8,
      }}
      animate={{
        opacity: 1,
        y: 0,
      }}
      exit={{
        opacity: 0,
      }}
      className="flex items-center gap-3 py-4 text-sm text-white/35"
    >
      <div className="flex items-center gap-1.5">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-violet-400" />

        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-violet-400 [animation-delay:150ms]" />

        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-violet-400 [animation-delay:300ms]" />
      </div>

      <span>
        Searching the knowledge base...
      </span>
    </motion.div>
  );
}

export default Conversation;