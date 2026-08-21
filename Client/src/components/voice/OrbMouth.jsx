import { motion } from "motion/react";

function OrbMouth({
  level = 0,
  isListening = false,
  compact = false,
}) {
  // Make even small microphone changes visible.
  const sensitivity = 1.8;

  const normalizedLevel = Math.min(
    Math.max(level * sensitivity, 0),
    1,
  );

  const width = compact
    ? 20 + normalizedLevel * 22
    : 38 + normalizedLevel * 42;

  const height = compact
    ? 11 + normalizedLevel * 22
    : 18 + normalizedLevel * 34;

  return (
    <motion.div
      aria-hidden="true"
      className="shrink-0 rounded-full bg-[#171717]"
      animate={{
        width: isListening ? width : compact ? 20 : 38,
        height: isListening ? height : compact ? 11 : 18,
      }}
      transition={{
        duration: 0.045,
        ease: "linear",
      }}
    />
  );
}

export default OrbMouth;