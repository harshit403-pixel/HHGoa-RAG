import { useEffect } from "react";
import {
  useMotionValue,
  useSpring,
  useTransform,
} from "motion/react";

function useOrbParallax({
  intensity = 12,
  stiffness = 140,
  damping = 20,
} = {}) {
  const pointerX = useMotionValue(0);
  const pointerY = useMotionValue(0);

  const smoothX = useSpring(pointerX, {
    stiffness,
    damping,
    mass: 0.6,
  });

  const smoothY = useSpring(pointerY, {
    stiffness,
    damping,
    mass: 0.6,
  });

  const rotateY = useTransform(
    smoothX,
    [-1, 1],
    [-intensity, intensity],
  );

  const rotateX = useTransform(
    smoothY,
    [-1, 1],
    [intensity, -intensity],
  );

  const translateX = useTransform(
    smoothX,
    [-1, 1],
    [-intensity / 2, intensity / 2],
  );

  const translateY = useTransform(
    smoothY,
    [-1, 1],
    [-intensity / 2, intensity / 2],
  );

  useEffect(() => {
    const handlePointerMove = (event) => {
      // Disable cursor follower on touchscreens and mobile viewports
      if (event.pointerType === "touch" || event.pointerType === "pen" || window.innerWidth < 768) {
        return;
      }

      const normalizedX =
        (event.clientX / window.innerWidth) * 2 - 1;

      const normalizedY =
        (event.clientY / window.innerHeight) * 2 - 1;

      pointerX.set(normalizedX);
      pointerY.set(normalizedY);
    };

    const resetPointer = () => {
      pointerX.set(0);
      pointerY.set(0);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerleave", resetPointer);

    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerleave", resetPointer);
    };
  }, [pointerX, pointerY]);

  return {
    rotateX,
    rotateY,
    translateX,
    translateY,
  };
}

export default useOrbParallax;