import { AnimatePresence, motion } from "motion/react";
import { useCallback,useState, useEffect, useRef } from "react";

import SoundWave from "./SoundWave";
import VoiceOrb from "./VoiceOrb";
import HeroStickers from "./HeroStickers";
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
   * Pass the recorded voice audio blob
   * to the parent when recording is ready.
   */
  useEffect(() => {
    onAudioReady((blob) => {
      onVoiceQuery(blob);
    });
  }, [onAudioReady, onVoiceQuery]);

  /*
   * Automatically stop recording when
   * the user stops speaking.
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
   * Orb interaction.
   *
   * Not processing:
   *   click -> start listening
   *
   * Listening:
   *   click -> stop listening
   *
   * Normally silence detection handles
   * stopping automatically.
   */
  const handleOrbClick = useCallback(() => {
    if (isProcessing) {
      return;
    }

    if (isActive) {
      stop();
      return;
    }

    start();
  }, [
    isActive,
    isProcessing,
    start,
    stop,
  ]);

  /*
   * Cleanup.
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
   * Large hero orb before conversation.
   *
   * Compact orb after conversation.
   */
  const orbSize = hasConversation
    ? 104
    : 256;


    const LANGUAGE_PHRASES = [
  {
    language: "Assamese",
    text: "সোধ ভাই।",
  },
  {
    language: "Bengali",
    text: "জিজ্ঞেস কর ভাই।",
  },
  {
    language: "Gujarati",
    text: "પૂછ ભાઈ.",
  },
  {
    language: "Hindi",
    text: "पूछ भाई।",
  },
  {
    language: "Kannada",
    text: "ಕೇಳು ಬ್ರೋ.",
  },
  {
    language: "Malayalam",
    text: "ചോദിക്കൂ ബ്രോ.",
  },
  {
    language: "Marathi",
    text: "विचार भाऊ.",
  },
  {
    language: "Nepali",
    text: "सोध न भाइ।",
  },
  {
    language: "Odia",
    text: "ପଚାର ଭାଇ।",
  },
  {
    language: "Punjabi",
    text: "ਪੁੱਛ ਭਰਾ।",
  },
  {
    language: "Sanskrit",
    text: "पृच्छ भ्रातः।",
  },
  {
    language: "Tamil",
    text: "கேளு ப்ரோ.",
  },
  {
    language: "Telugu",
    text: "అడుగు బ్రో.",
  },
  {
    language: "Urdu",
    text: "پوچھو بھائی۔",
  },
];

const [languageIndex, setLanguageIndex] = useState(0);

useEffect(() => {
  const interval = window.setInterval(() => {
    setLanguageIndex((current) =>
      (current + 1) % LANGUAGE_PHRASES.length
    );
  }, 2500);

  return () => {
    window.clearInterval(interval);
  };
}, []);

  return (
    <>
      {/* =================================================
          INITIAL HERO
          ================================================= */}

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

              {/* =================================================
                  HERO TEXT
                  ================================================= */}

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
                <p className="mb-5 mt-8 text-xs font-medium uppercase tracking-[0.3em] text-[#08733F]/70">
                  Voice RAG · HHGoa · 13 Languages
                </p>

               <h1
  id="voice-experience-title"
  className="
    text-balance
    text-5xl
    font-medium
    leading-[1.05]
    tracking-[-0.04em]
    text-[#171717]
    sm:text-6xl
    lg:text-7xl
  "
>
  Ask Bro
  <br />

  <AnimatePresence mode="wait">
    <motion.span
      key={LANGUAGE_PHRASES[languageIndex].text}
      initial={{
        opacity: 0,
        y: 18,
        filter: "blur(6px)",
      }}
      animate={{
        opacity: 1,
        y: 0,
        filter: "blur(0px)",
      }}
      exit={{
        opacity: 0,
        y: -18,
        filter: "blur(6px)",
      }}
      transition={{
        duration: 0.45,
        ease: [0.22, 1, 0.36, 1],
      }}
      className="inline-block text-[#171717]/45"
    >
      {LANGUAGE_PHRASES[languageIndex].text}
    </motion.span>
  </AnimatePresence>
</h1>

                <p className="mx-auto mt-6 max-w-xl text-pretty text-sm leading-7 text-[#171717]/55 sm:text-base">
                  Speak naturally and we'll look through
                  the HHGoa knowledge base to find an
                  answer grounded in the data.
                </p>
              </motion.div>

              {/* =================================================
                  VOICE STAGE
                  ================================================= */}

              <div className="relative mt-8 h-[370px] w-full">

                {/* =================================================
                    STICKERS

                    These exist ONLY while hasConversation
                    is false.

                    As soon as the first result arrives,
                    the entire hero exits and these disappear.
                    ================================================= */}

                <HeroStickers />

                {/* =================================================
                    SOUND WAVE
                    ================================================= */}

                <div className="absolute inset-0 z-0 flex items-center justify-center">
                  <SoundWave
                    isActive={isActive}
                    level={level}
                    frequencyData={frequencyData}
                  />
                </div>

                {/* =================================================
                    VOICE ORB
                    ================================================= */}

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

                {/* =================================================
                    STATUS
                    ================================================= */}

                <div className="absolute bottom-0 left-1/2 z-40 -translate-x-1/2 text-center">
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

      {/* =================================================
          BOTTOM VOICE COMPOSER

          Only appears after the first conversation/result.
          ================================================= */}

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
                from-[#F8F5E8]
                via-[#F8F5E8]/95
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

              {/* Compact status */}

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

/* =========================================================
   STATUS TEXT
   ========================================================= */

function StatusText({
  isActive,
  isProcessing,
  error,
  compact = false,
}) {
  let text = "Tap the orb and start talking";

  let className =
    "mb-3 text-sm text-[#171717]/50";

  if (error) {
    text = "We couldn't access your microphone";

    className =
      "mb-3 text-sm text-red-600";
  } else if (isProcessing) {
    text = "Looking through the Goa knowledge base...";

    className =
      "mb-3 text-sm text-[#08733F]";
  } else if (isActive) {
    text = "Listening...";

    className =
      "mb-3 text-sm text-[#08733F]";
  } else if (compact) {
    text = "Ask another question";
  }

  return (
    <>
      <p className={className}>
        {text}
      </p>

      {!compact && (
        <p className="mt-1 max-w-sm text-xs text-[#171717]/30">
          Speak naturally we will find the
          relevant information for you.
        </p>
      )}
    </>
  );
}

export default VoiceExperience;