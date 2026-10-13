/**
 * A ROOM'S PLATE, at its first arrival — the module booklet held up.
 *
 * The space is held at 3:2 from the moment the arrival is on the page, with a
 * faint pencil frame, so a plate landing a few seconds later fills it rather
 * than shoving the text being read. It closes only when there will be no plate.
 *
 * DRAWN AS INK, NOT SHOWN AS A PHOTOGRAPH. The server stores black on
 * transparent, and the page uses it as a mask over its own ink colour: the
 * lines are exactly the text's ink, the paper is the page's paper, and there is
 * no box edge. A click opens it full size.
 */

import { useEffect, useRef, useState } from "react";
import type { PlateAnswer } from "../../runtime/plates.ts";

/** How long between asks while somebody else's request is drawing it. */
const PLATE_POLL_MS = 4000;
/** Asks before giving up on a pending plate: past the server's stale-claim timeout. */
const PLATE_POLL_TRIES = 50;

/**
 * A stored plate or cover laid down as ink: the page's ink colour, masked by
 * the picture. No box, no paper of its own. `className` sets the size.
 */
export function Ink({ url, className = "", label }: { url: string; className?: string; label?: string }) {
  return <div className={className} style={inkStyle(url)} {...(label ? { role: "img", "aria-label": label } : {})} />;
}

function inkStyle(url: string) {
  return {
    backgroundColor: "var(--color-ink)",
    maskImage: `url("${url}")`,
    WebkitMaskImage: `url("${url}")`,
    maskSize: "contain",
    WebkitMaskSize: "contain",
    maskRepeat: "no-repeat",
    WebkitMaskRepeat: "no-repeat",
    maskPosition: "center",
    WebkitMaskPosition: "center",
  };
}

/**
 * `id` names what is being drawn — a room, or the dungeon's cover — and a new
 * one restarts the asking. `subject` is said to a screen reader: "A drawing of …".
 */
export function Plate({
  id,
  subject,
  load,
}: {
  id: string;
  subject: string;
  load: () => Promise<PlateAnswer>;
}) {
  const [answer, setAnswer] = useState<PlateAnswer>({ status: "pending" });
  const [open, setOpen] = useState(false);
  // Read through a ref so a parent that hands over a new function every render
  // does not restart the asking.
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ask = async (tries: number) => {
      const got = await loadRef.current().catch((): PlateAnswer => ({ status: "none" }));
      if (!live) return;
      if (got.status === "pending" && tries < PLATE_POLL_TRIES) {
        timer = setTimeout(() => void ask(tries + 1), PLATE_POLL_MS);
        return;
      }
      setAnswer(got.status === "pending" ? { status: "none" } : got);
    };
    void ask(1);
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, [id]);

  useEffect(() => {
    if (!open) return;
    const close = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [open]);

  if (answer.status === "none") return null;

  if (answer.status === "pending") {
    return (
      <div
        className="mb-4 flex aspect-[3/2] w-full max-w-[62ch] items-center justify-center border border-dashed border-rule-faint"
        role="img"
        aria-label={`A drawing of ${subject}, still being drawn`}
      >
        {/* Says the space is waiting on something, not empty for good. */}
        <span className="h-6 w-6 animate-spin rounded-full border-2 border-rule border-t-graphite" />
      </div>
    );
  }

  return (
    <>
      <button
        type="button"
        className="mb-4 block aspect-[3/2] w-full max-w-[62ch] cursor-zoom-in"
        style={inkStyle(answer.url)}
        onClick={() => setOpen(true)}
        aria-label={`A drawing of ${subject}. Open it full size.`}
      />
      {open && (
        <div
          className="fixed inset-0 z-50 flex cursor-zoom-out items-center justify-center bg-paper p-4"
          onClick={() => setOpen(false)}
          role="dialog"
          aria-label={`A drawing of ${subject}`}
        >
          <div className="aspect-[3/2] w-full max-w-[1536px]" style={{ ...inkStyle(answer.url), maxHeight: "100%" }} />
        </div>
      )}
    </>
  );
}
