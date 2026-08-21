"use client";

import { useEffect, useRef } from "react";
import gsap from "gsap";

const STICKERS = [
  {
    id: 1,
    src: "/Card-Sticker SVG/goa-hindi.svg",
    top: "-54%",
    left: "-1%",
    rotate: -14,
    width: 135,
  },
  {
    id: 2,
    src: "/Card-Sticker SVG/2-47.svg",
    top: "-60%",
    left: "90%",
    rotate: 11,
    width: 115,
  },
  {
    id: 3,
    src: "/Card-Sticker SVG/gujarati.png",
    top: "4%",
    left: "7%",
    rotate: 12,
    width: 165,
  },
  {
    id: 4,
    src: "/Card-Sticker SVG/hindi.png",
    top: "8%",
    left: "73%",
    rotate: 14,
    width: 120,
  },
  {
    id: 5,
    src: "/Card-Sticker SVG/marathi.png",
    top: "82%",
    left: "3%",
    rotate: 9,
    width: 130,
  },
  {
    id: 6,
    src: "/Card-Sticker SVG/bangla.png",
    top: "78%",
    left: "76%",
    rotate: -10,
    width: 145,
  },
  {
    id: 7,
    src: "/Card-Sticker SVG/tamil.png",
    top: "37%",
    left: "94%",
    rotate: -7,
    width: 195,
  },
  {
    id: 8,
    src: "/Card-Sticker SVG/punjabi.png",
    top: "37%",
    left: "23%",
    rotate: -7,
    width: 195,
  },
];

function HeroStickers() {
  const stickerRefs = useRef([]);

  useEffect(() => {
    const cleanupFunctions = [];

    stickerRefs.current.forEach((sticker) => {
      if (!sticker) return;

      const image = sticker.querySelector(
        ".sticker-image",
      );

      if (!image) return;

      const handleMove = (event) => {
        const rect =
          sticker.getBoundingClientRect();

        const x =
          event.clientX -
          rect.left -
          rect.width / 2;

        const y =
          event.clientY -
          rect.top -
          rect.height / 2;

        /*
         * Move the sticker slightly toward
         * the cursor.
         */
        gsap.to(sticker, {
          x: x * 0.25,
          y: y * 0.25,
          scale: 1.08,
          duration: 0.35,
          ease: "power3.out",
        });

        /*
         * Move the spotlight to the cursor.
         */
        const spotlightX =
          event.clientX - rect.left;

        const spotlightY =
          event.clientY - rect.top;

        image.style.maskImage = `
          radial-gradient(
            circle 90px at
            ${spotlightX}px ${spotlightY}px,
            black 0%,
            black 45%,
            transparent 100%
          )
        `;

        image.style.webkitMaskImage = `
          radial-gradient(
            circle 90px at
            ${spotlightX}px ${spotlightY}px,
            black 0%,
            black 45%,
            transparent 100%
          )
        `;
      };

      const handleLeave = () => {
        /*
         * Hide the sticker again.
         */
        gsap.to(sticker, {
          x: 0,
          y: 0,
          scale: 1,
          duration: 1,
          ease: "elastic.out(1,0.35)",
        });

        image.style.maskImage = `
          radial-gradient(
            circle 0px at 50% 50%,
            black 0%,
            transparent 100%
          )
        `;

        image.style.webkitMaskImage = `
          radial-gradient(
            circle 0px at 50% 50%,
            black 0%,
            transparent 100%
          )
        `;
      };

      sticker.addEventListener(
        "mousemove",
        handleMove,
      );

      sticker.addEventListener(
        "mouseleave",
        handleLeave,
      );

      cleanupFunctions.push(() => {
        sticker.removeEventListener(
          "mousemove",
          handleMove,
        );

        sticker.removeEventListener(
          "mouseleave",
          handleLeave,
        );
      });
    });

    return () => {
      cleanupFunctions.forEach((cleanup) => cleanup());
    };
  }, []);

  return (
    <div
      aria-hidden="true"
      className="
        pointer-events-none
        absolute
        inset-0
        z-30
        overflow-visible
      "
    >
      {STICKERS.map((sticker, index) => (
        <div
          key={sticker.id}
          ref={(element) => {
            stickerRefs.current[index] = element;
          }}
          className="
            pointer-events-auto
            absolute
            select-none
            
          "
          style={{
            top: sticker.top,
            left: sticker.left,
            width: `${sticker.width}px`,
            height: `${sticker.width}px`,
            transform:
              `translate(-50%, -50%) rotate(${sticker.rotate}deg)`,
          }}
        >
          <img
            src={sticker.src}
            alt=""
            draggable="false"
            className="
              sticker-image
              h-full
              w-full
              object-contain
            "
            style={{
              maskImage:
                "radial-gradient(circle 0px at 50% 50%, black 0%, transparent 100%)",
              WebkitMaskImage:
                "radial-gradient(circle 0px at 50% 50%, black 0%, transparent 100%)",
            }}
          />
        </div>
      ))}
    </div>
  );
}

export default HeroStickers;