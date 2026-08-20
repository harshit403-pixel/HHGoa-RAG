import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useRef } from "react";

import SoundWave from "./SoundWave";
import VoiceOrb from "./VoiceOrb";
import useAudioAnalyser from "../../hooks/useAudioAnalyser";

function VoiceExperience({
  onVoiceQuery,
  hasConversation = false,
  isProcessing = false,
}) {
  const {
    isActive,
    level,
    frequencyData,
    error,
    start,
    stop,
    onSilence,
    onAudioReady,
  } = useAudioAnalyser();

  const processingTimerRef = useRef(null);

  /*
   * Pass the recorded voice audio blob up when ready.
   */
  useEffect(() => {
    onAudioReady((blob) => {
      onVoiceQuery(blob);
    });
  }, [onAudioReady, onVoiceQuery]);

  /*
   * Automatically process when the analyser
   * detects that the user has stopped speaking.
   */
  useEffect(() => {
    onSilence(() => {
      if (!isActive || isProcessing) {
        return;
      }

      stop();
    });
  }, [
    isActive,
    isProcessing,
    onSilence,
    stop,
  ]);

  /*
   * Orb click:
   *
   * Initial state:
   * click → start listening
   *
   * While listening:
   * clicking does nothing.
   *
   * Speech ending is handled automatically
   * by useAudioAnalyser.
   */
  const handleOrbClick = useCallback(() => {
    if (isProcessing) {
      return;
    }

    if (isActive) {
      return;
    }

    start();
  }, [
    isActive,
    isProcessing,
    start,
  ]);

  /*
   * Cleanup pending processing timer.
   */
  useEffect(() => {
    return () => {
      if (processingTimerRef.current !== null) {
        window.clearTimeout(
          processingTimerRef.current,
        );
      }
    };
  }, []);

  /*
   * Hero orb:
   * 256px
   *
   * Composer orb:
   * 104px
   */
  const orbSize = hasConversation
    ? 104
    : 256;

  return (
    <>
      {/* =========================================
          HERO / INITIAL STATE
      ========================================= */}

      <AnimatePresence>
        {!hasConversation && (
          <motion.section
            key="voice-hero"
            initial={{
              opacity: 0,
            }}
            animate={{
              opacity: 1,
            }}
            exit={{
              opacity: 0,
              scale: 0.97,
            }}
            transition={{
              duration: 0.35,
            }}
            aria-labelledby="voice-experience-title"
            className="
              relative
              flex
              min-h-[calc(100vh-5rem)]
              items-center
              justify-center
              overflow-hidden
              px-6
            "
          >
            <div className="mx-auto flex w-full max-w-7xl flex-col items-center">
              {/* Hero text */}

              <motion.div
                initial={{
                  opacity: 0,
                  y: 20,
                }}
                animate={{
                  opacity: 1,
                  y: 0,
                }}
                transition={{
                  duration: 0.5,
                  ease: [0.22, 1, 0.36, 1],
                }}
                className="max-w-3xl text-center"
              >
                <p className="mb-5 mt-10 text-xs font-medium uppercase tracking-[0.3em] text-violet-300/70">
                  Voice-powered knowledge
                </p>

                <h1
                  id="voice-experience-title"
                  className="
                    text-balance
                    text-5xl
                    font-medium
                    tracking-[-0.04em]
                    text-white
                    sm:text-6xl
                    lg:text-7xl
                  "
                >
                  Ask anything.
                  <br />

                  <span className="text-white/45">
                    Find the answer.
                  </span>
                </h1>

                <p className="mx-auto mt-6 max-w-xl text-pretty text-sm leading-7 text-white/45 sm:text-base">
                  Speak naturally and explore answers
                  grounded in the knowledge base.
                </p>
              </motion.div>

              {/* Voice stage */}

              <div className="relative mt-12 h-[420px] w-full">
                {/* Wave */}

                <div className="absolute inset-0 z-0 flex items-center justify-center">
                  <SoundWave
                    isActive={isActive}
                    level={level}
                    frequencyData={frequencyData}
                  />
                </div>

                {/* Orb */}

                <div className="absolute inset-0 z-10 flex items-center justify-center">
                  <motion.div
                    layout
                    className="relative shrink-0"
                    style={{
                      width: orbSize,
                      height: orbSize,
                    }}
                    transition={{
                      layout: {
                        duration: 0.6,
                        ease: [0.22, 1, 0.36, 1],
                      },
                    }}
                  >
                    <VoiceOrb
                      isListening={isActive}
                      level={level}
                      onClick={handleOrbClick}
                    />
                  </motion.div>
                </div>

                {/* Status */}

                <div className="absolute bottom-0 left-1/2 z-20 -translate-x-1/2 text-center">
                  <StatusText
                    isActive={isActive}
                    isProcessing={isProcessing}
                    error={error}
                  />
                </div>
              </div>
            </div>
          </motion.section>
        )}
      </AnimatePresence>

      {/* =========================================
          BOTTOM VOICE COMPOSER
      ========================================= */}

      <AnimatePresence>
        {hasConversation && (
          <motion.div
            key="voice-composer"
            initial={{
              opacity: 0,
              y: 40,
            }}
            animate={{
              opacity: 1,
              y: 0,
            }}
            exit={{
              opacity: 0,
              y: 40,
            }}
            transition={{
              duration: 0.45,
              ease: [0.22, 1, 0.36, 1],
            }}
            className="
              pointer-events-none
              fixed
              inset-x-0
              bottom-0
              z-50
            "
          >
            {/* Bottom fade */}

            <div
              className="
                absolute
                inset-x-0
                bottom-0
                h-40
                bg-gradient-to-t
                from-[#05050a]
                via-[#05050a]/95
                to-transparent
              "
            />

            <div
              className="
                relative
                mx-auto
                flex
                w-full
                max-w-3xl
                flex-col
                items-center
                pb-5
              "
            >
              {/* Compact waveform */}

              <div
                className="
                  absolute
                  bottom-[74px]
                  left-1/2
                  h-14
                  w-full
                  max-w-xl
                  -translate-x-1/2
                  opacity-50
                "
              >
                <SoundWave
                  isActive={isActive}
                  level={level}
                  frequencyData={frequencyData}
                />
              </div>

              {/* Compact orb */}

              <div className="pointer-events-auto relative z-10">
                <motion.div
                  layout
                  className="relative shrink-0"
                  style={{
                    width: orbSize,
                    height: orbSize,
                  }}
                  transition={{
                    layout: {
                      duration: 0.6,
                      ease: [0.22, 1, 0.36, 1],
                    },
                  }}
                >
                  <VoiceOrb
                    isListening={isActive}
                    level={level}
                    onClick={handleOrbClick}
                    compact
                  />
                </motion.div>
              </div>

              {/* Status */}

              <div className="pointer-events-auto relative z-20 mt-1 text-center">
                <StatusText
                  isActive={isActive}
                  isProcessing={isProcessing}
                  error={error}
                  compact
                />
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}

function StatusText({
  isActive,
  isProcessing,
  error,
  compact = false,
}) {
  let text = "Tap to start speaking";
  let className =
    "text-sm mb-3 text-white/50";

  if (error) {
    text = "Microphone unavailable";
    className =
      "text-sm mb-3 text-red-300";
  } else if (isProcessing) {
    text = "Searching the knowledge base...";
    className =
      "text-sm mb-3 text-violet-300";
  } else if (isActive) {
    text = "Listening...";
    className =
      "text-sm mb-3 text-cyan-300";
  } else if (compact) {
    text = "Tap to ask again";
  }

  return (
    <>
      <p className={className}>{text}</p>

      {!compact && (
        <p className="mt-2 max-w-sm text-xs text-white/25">
          {error ||
            "Your voice, transformed into knowledge."}
        </p>
      )}
    </>
  );
}

export default VoiceExperience;