import { motion } from "motion/react";

const BAR_COUNT = 64;
const MIN_HEIGHT = 6;
const MAX_HEIGHT = 120;

function SoundWave({
  isActive = false,
  level = 0,
  frequencyData = [],
}) {
  const bars = Array.from({ length: BAR_COUNT });

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-x-0 top-1/2 z-0 flex h-64 -translate-y-1/2 items-center justify-center"
    >
      <div className="flex h-full w-full max-w-6xl items-center justify-center gap-1 px-4">
        {bars.map((_, index) => {
          const center = (BAR_COUNT - 1) / 2;

          /*
           * Distance from the center of the orb.
           */
          const distance =
            Math.abs(index - center) / center;

          /*
           * Natural wave envelope.
           */
          const shape = Math.pow(
            1 - distance,
            0.65,
          );

          /*
           * Mirror both sides around the center.
           *
           * This prevents the left/right sides
           * from looking completely different.
           */
          const sideIndex =
            index < center
              ? index
              : BAR_COUNT - 1 - index;

          /*
           * Use only the lower portion of the
           * frequency spectrum because that is
           * where speech energy is strongest.
           */
          const spectrumSize =
            Math.max(
              1,
              Math.floor(
                frequencyData.length * 0.55,
              ),
            );

          const frequencyIndex = Math.min(
            spectrumSize - 1,
            Math.floor(
              (sideIndex / center) *
                (spectrumSize - 1),
            ),
          );

          const rawFrequency =
            frequencyData[frequencyIndex] ?? 0;

          const normalizedFrequency =
            rawFrequency / 255;

          const audioStrength =
            normalizedFrequency * 0.75 +
            level * 0.25;

          const idleHeight =
            MIN_HEIGHT + shape * 35;

          const activeHeight = Math.min(
            MAX_HEIGHT,
            MIN_HEIGHT +
              shape *
                (25 + audioStrength * 110),
          );

          return (
            <motion.span
              key={index}
              className="block w-[3px] shrink-0 rounded-full bg-gradient-to-t from-violet-500/20 via-violet-400 to-cyan-300"
              animate={{
                height: isActive
                  ? Math.max(
                      MIN_HEIGHT,
                      activeHeight,
                    )
                  : idleHeight,

                opacity: isActive
                  ? 0.35 +
                    audioStrength * 0.65
                  : 0.3,
              }}
              transition={{
                height: {
                  duration: 0.08,
                  ease: "easeOut",
                },
                opacity: {
                  duration: 0.12,
                  ease: "easeOut",
                },
              }}
            />
          );
        })}
      </div>
    </div>
  );
}

export default SoundWave;