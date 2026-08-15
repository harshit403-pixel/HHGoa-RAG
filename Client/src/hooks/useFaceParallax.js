import { useEffect } from "react";
import {
  useMotionValue,
  useSpring,
} from "motion/react";

function useFaceParallax({
  intensity = 28,
  stiffness = 120,
  damping = 18,
} = {}) {
  const pointerX = useMotionValue(0);
  const pointerY = useMotionValue(0);

  const x = useSpring(pointerX, {
    stiffness,
    damping,
    mass: 0.6,
  });

  const y = useSpring(pointerY, {
    stiffness,
    damping,
    mass: 0.6,
  });

  useEffect(() => {
    const handlePointerMove = (event) => {
      const normalizedX =
        (event.clientX / window.innerWidth) * 2 - 1;

      const normalizedY =
        (event.clientY / window.innerHeight) * 2 - 1;

      pointerX.set(normalizedX * intensity);
      pointerY.set(normalizedY * intensity);
    };

    const handlePointerLeave = () => {
      pointerX.set(0);
      pointerY.set(0);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerleave", handlePointerLeave);

    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerleave", handlePointerLeave);
    };
  }, [intensity, pointerX, pointerY]);

  return {
    x,
    y,
  };
}

export default useFaceParallax;