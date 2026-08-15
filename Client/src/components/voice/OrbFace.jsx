import { motion } from "motion/react";
import useFaceParallax from "../../hooks/useFaceParallax";
import OrbMouth from "./OrbMouth";

function OrbFace({
  level = 0,
  isListening = false,
  compact = false,
}) {
  const { x, y } = useFaceParallax({
    intensity: compact ? 8 : 28,
    stiffness: 120,
    damping: 18,
  });

  return (
    <motion.div
      aria-hidden="true"
      style={{
        x,
        y,
      }}
      className="absolute inset-0 flex items-center justify-center"
    >
      <div className="relative h-[72%] w-[72%]">
        {/* Eyes */}
        <div
          className="
            absolute
            inset-x-0
            top-[8%]
            flex
            items-start
            justify-between
            px-[8%]
          "
        >
          <OrbEye compact={compact} />
          <OrbEye compact={compact} />
        </div>

        {/* Mouth */}
        <div
          className="
            absolute
            inset-x-0
            top-[52%]
            flex
            justify-center
          "
        >
          <OrbMouth
            level={level}
            isListening={isListening}
            compact={compact}
          />
        </div>
      </div>
    </motion.div>
  );
}

function OrbEye({ compact = false }) {
  return (
    <motion.img
      src="/eyes.svg"
      alt=""
      draggable="false"
      className={`
        select-none
        object-contain
        ${
          compact
            ? "h-[22px] w-[22px]"
            : "h-16 w-16"
        }
      `}
      animate={{
        rotate: [0, 360],
      }}
      transition={{
        duration: 4,
        ease: "linear",
        repeat: Infinity,
      }}
    />
  );
}

export default OrbFace;