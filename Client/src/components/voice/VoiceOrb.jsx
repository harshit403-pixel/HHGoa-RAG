import { motion } from "motion/react";
import OrbVisual from "./OrbVisual";
import useOrbParallax from "../../hooks/useOrbParallax";

function VoiceOrb({
  isListening = false,
  level = 0,
  onClick,
  compact = false,
}) {
  const {
    rotateX,
    rotateY,
    translateX,
    translateY,
  } = useOrbParallax({
    intensity: compact ? 5 : 10,
    stiffness: 140,
    damping: 20,
  });

  return (
    <motion.button
      type="button"
      aria-label={
        isListening
          ? "Stop listening"
          : "Start speaking"
      }
      aria-pressed={isListening}
      onClick={onClick}
      style={{
        rotateX,
        rotateY,
        x: translateX,
        y: translateY,
        transformPerspective: 800,
      }}
      whileHover={{
        scale: 1.04,
      }}
      whileTap={{
        scale: 0.96,
      }}
      className="
        relative
        h-full
        w-full
        cursor-pointer
        rounded-full
        outline-none
        focus-visible:ring-2
        focus-visible:ring-[#FF0080]
        focus-visible:ring-offset-4
        focus-visible:ring-offset-[#F8F5E8]
      "
    >
      <OrbVisual
        isListening={isListening}
        level={level}
        compact={compact}
      />
    </motion.button>
  );
}

export default VoiceOrb;