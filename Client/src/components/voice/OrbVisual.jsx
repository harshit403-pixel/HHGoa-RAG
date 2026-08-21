import { motion } from "motion/react";
import OrbFace from "./OrbFace";

function OrbVisual({
  isListening = false,
  level = 0,
  compact = false,
}) {
  return (
    <div
      aria-hidden="true"
      className="relative h-full w-full"
    >
      {/* Ambient glow */}
      <motion.div
        className="
          absolute
          inset-[5%]
          z-0
          rounded-full
          bg-violet-500/20
          blur-[50px]
        "
        animate={{
          scale: isListening
            ? 1 + level * 0.12
            : [1, 1.04, 1],

          opacity: isListening
            ? 0.35 + level * 0.3
            : [0.2, 0.3, 0.2],
        }}
        transition={{
          duration: isListening ? 0.12 : 3.5,
          repeat: isListening ? 0 : Infinity,
          ease: "easeInOut",
        }}
      />

      {/* Orb body (Pure CSS Solid Purple) */}
      <motion.div
        className="
          absolute
          inset-0
          z-10
          h-full
          w-full
          rounded-full
          bg-[#8b5cf6]
          border
          border-white/10
          shadow-[0_0_80px_rgba(139,92,246,0.25)]
          select-none
        "
        animate={{
          y: isListening
            ? level * -4
            : [0, -2, 0, 2, 0],

          scale: isListening
            ? 1 + level * 0.025
            : 1,
        }}
        transition={{
          duration: isListening ? 0.12 : 4,
          repeat: isListening ? 0 : Infinity,
          ease: "easeInOut",
        }}
      />

      {/* Face */}
      <div className="absolute inset-0 z-20">
        <OrbFace
          level={level}
          isListening={isListening}
          compact={compact}
        />
      </div>
    </div>
  );
}

export default OrbVisual;