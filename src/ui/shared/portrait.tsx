/**
 * A CHARACTER'S PORTRAIT, whole or as a head-and-shoulders thumbnail.
 *
 * A drawn portrait is ink on transparent, like an illustration, and is laid
 * down in the page's ink (`Ink`) on whatever paper it sits on. An uploaded one
 * is the player's own picture and is shown as it is. Here rather than in one
 * screen because four show it: creation, the roster, run setup and the sheet
 * in play.
 */

import { useEffect, useState } from "react";
import type { Portrait } from "../../rules/knave/character.ts";
import { Ink } from "./ink.tsx";

/** The picture itself. `thumb` is the head and shoulders, filling a square; otherwise the whole figure, fitted. */
export function PortraitImage({
  portrait,
  thumb = false,
  label,
  className = "",
}: {
  portrait: Portrait;
  thumb?: boolean;
  label: string;
  className?: string;
}) {
  const url = thumb ? portrait.thumbUrl : portrait.url;
  if (portrait.source === "drawn") return <Ink url={url} label={label} fit={thumb ? "cover" : "contain"} className={className} />;
  return <img src={url} alt={label} className={`${thumb ? "object-cover" : "object-contain"} ${className}`} />;
}

/**
 * A square thumbnail on its own bit of paper. With `expandable`, pressing it
 * opens the whole figure over the page; a press anywhere or Escape closes it.
 * Without, it is only a picture, for use inside something already pressable.
 */
export function PortraitThumb({
  portrait,
  name,
  size,
  expandable = false,
}: {
  portrait: Portrait;
  name: string;
  /** the side, in pixels */
  size: number;
  expandable?: boolean;
}) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const close = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [open]);

  const box = "block shrink-0 overflow-hidden border border-rule bg-paper";
  const picture = <PortraitImage portrait={portrait} thumb label={`${name}, head and shoulders`} className="h-full w-full" />;
  if (!expandable) {
    return (
      <span className={box} style={{ width: size, height: size }}>
        {picture}
      </span>
    );
  }
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={`See ${name} whole`}
        aria-label={`See ${name}'s portrait`}
        className={`${box} transition-colors hover:border-graphite active:border-torch`}
        style={{ width: size, height: size }}
      >
        {picture}
      </button>
      {open && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`${name}'s portrait`}
          onClick={() => setOpen(false)}
          className="fixed inset-0 z-50 flex cursor-zoom-out items-center justify-center bg-ink/60 p-4"
        >
          <div className="flex max-h-full w-[min(92vw,480px)] flex-col border border-rule bg-paper p-4 shadow-[6px_6px_0_rgb(34_32_28_/_0.12)]">
            <PortraitImage portrait={portrait} label={`${name}'s portrait`} className="aspect-[2/3] max-h-[78vh] w-full" />
            <div className="mt-3 flex items-baseline justify-between gap-4">
              <span className="font-display text-[16px] font-bold text-ink">{name}</span>
              <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-graphite">Press anywhere to close</span>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
