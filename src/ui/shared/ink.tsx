/**
 * INK: a stored picture laid down in the page's own ink.
 *
 * The server keeps every illustration, cover and sprite as black on
 * transparent, and the page uses it as a mask over its own colours: the lines
 * are exactly the text's ink, and the paper is the page's paper. Here rather
 * than in `play/Illustration.tsx` so a screen outside the play chunk (the
 * library, the landing page) can lay one down without pulling in the map.
 */

import { useEffect, useState } from "react";
import { figureHeight, type FigureSize, type IllustrationFigure } from "../../illustrations/figures.ts";

/**
 * A stored illustration or cover laid down as ink: the page's ink colour, masked by
 * the picture. No box, no paper of its own. `className` sets the size; `fit`
 * says whether the whole picture shows (`contain`) or it fills the box, cropped.
 */
export function Ink({
  url,
  className = "",
  label,
  fit = "contain",
}: {
  url: string;
  className?: string;
  label?: string;
  fit?: "contain" | "cover";
}) {
  return <div className={className} style={inkStyle(url, fit)} {...(label ? { role: "img", "aria-label": label } : {})} />;
}

export function inkStyle(url: string, fit: "contain" | "cover" = "contain") {
  return {
    backgroundColor: "var(--color-ink)",
    maskImage: `url("${url}")`,
    WebkitMaskImage: `url("${url}")`,
    maskSize: fit,
    WebkitMaskSize: fit,
    maskRepeat: "no-repeat",
    WebkitMaskRepeat: "no-repeat",
    maskPosition: "center",
    WebkitMaskPosition: "center",
  };
}

/** One coat of a sprite: the page's paper or ink, masked by one half of the stored image. */
function coat(url: string, fill: string, half: "body" | "ink") {
  const position = half === "body" ? "0% 0%" : "100% 0%";
  return {
    backgroundColor: fill,
    maskImage: `url("${url}")`,
    WebkitMaskImage: `url("${url}")`,
    maskSize: "200% 100%",
    WebkitMaskSize: "200% 100%",
    maskPosition: position,
    WebkitMaskPosition: position,
    maskRepeat: "no-repeat",
    WebkitMaskRepeat: "no-repeat",
  };
}

/**
 * A figure whose sprite is already drawn, feet at its point in the illustration it
 * is laid over. Shown once the sprite has loaded and its shape is known.
 */
export function StandingFigure({ figure, url, size }: { figure: IllustrationFigure; url: string; size: FigureSize }) {
  // Width over height of one half of the stored image: the figure's own shape.
  const [aspect, setAspect] = useState<number>();
  useEffect(() => {
    if (!url) return;
    let live = true;
    const img = new Image();
    img.onload = () => live && img.naturalHeight > 0 && setAspect(img.naturalWidth / 2 / img.naturalHeight);
    img.src = url;
    return () => {
      live = false;
    };
  }, [url]);
  if (!aspect) return null;
  const tall = figureHeight(figure, size);
  return (
    <div
      className="pointer-events-none absolute"
      data-figure={figure.sprite}
      style={{
        left: `${figure.x * 100}%`,
        top: `${figure.y * 100}%`,
        height: `${tall * 100}%`,
        aspectRatio: String(aspect),
        transform: `translate(-50%, -100%)${figure.flop ? " scaleX(-1)" : ""}`,
      }}
    >
      <div className="absolute inset-0" style={coat(url, "var(--color-paper)", "body")} />
      <div className="absolute inset-0" style={coat(url, "var(--color-ink)", "ink")} />
    </div>
  );
}
