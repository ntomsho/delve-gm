/**
 * "Go through this door?"
 *
 * Clicking a door does not travel. It asks, and only on confirmation does it
 * submit — as ordinary text, through the ordinary turn path, identical to the
 * player having typed it. Two reasons the click cannot be the action itself:
 *
 *   - A misclick on a map costs a turn, and a turn is a model call and a slice
 *     of the run. Typing has a keystroke of friction built in; clicking has
 *     none, so the friction has to be put back.
 *   - The player should see the sentence that is about to be sent. The referee
 *     answers text, so a click that silently becomes text the player never read
 *     makes the one thing they can hold the referee to invisible.
 *
 * A blocked way is still offered, and the copy says what is in the way rather
 * than refusing. The referee is the one that gets to say no — the map only
 * reports what the player has been told.
 */

import { useEffect, useRef } from "react";
import { theRoom, type ExitView } from "../../store/selectors.ts";

/** The sentence that gets sent. Plain, and exactly what a player would type. */
export function travelSentence(exit: ExitView): string {
  const what = exit.name || "the way out";
  if (exit.surface) return `I leave the dungeon through ${what}.`;
  if (exit.toKnown && exit.toRoomName) {
    return `I go through ${what} to ${theRoom(exit.toRoomName)}.`;
  }
  return `I go through ${what}.`;
}

export interface TravelConfirmProps {
  exit: ExitView;
  onConfirm(text: string): void;
  onCancel(): void;
}

export function TravelConfirm({ exit, onConfirm, onCancel }: TravelConfirmProps) {
  const go = useRef<HTMLButtonElement>(null);
  const text = travelSentence(exit);

  useEffect(() => {
    go.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/25 p-6"
      onClick={onCancel}
      role="presentation"
    >
      <div
        className="w-full max-w-[380px] rounded-sm border border-rule bg-paper p-5 shadow-lg"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Confirm travel"
      >
        <div className="font-mono text-[9px] uppercase tracking-[0.16em] text-graphite">
          {exit.surface ? "Leave the dungeon" : "Go through"}
        </div>

        <h2 className="mt-1.5 font-display text-[17px] font-bold leading-tight text-ink">
          {exit.name || "The way out"}
        </h2>

        {/* What they are walking into, as far as they know it. An unexplored
            room is named as unexplored rather than named. */}
        <p className="mt-1 font-prose text-[13px] leading-snug text-graphite">
          {exit.surface
            ? "Out, and the run ends there — with whatever you are carrying."
            : exit.toKnown && exit.toRoomName
              ? `Back to ${theRoom(exit.toRoomName)}.`
              : "You have not been through it. You do not know what is on the other side."}
        </p>

        {exit.blocked && (
          <p className="mt-2 border-l-2 border-torch pl-2 font-prose text-[12px] italic leading-snug text-torch">
            {exit.requirement}
          </p>
        )}

        {/* The sentence itself, shown before it is sent. */}
        <p className="mt-3 border-t border-rule pt-3 font-prose text-[13px] leading-snug text-indigo">
          “{text}”
        </p>

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="border border-rule px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-graphite hover:bg-panel"
          >
            Stay
          </button>
          <button
            ref={go}
            type="button"
            onClick={() => onConfirm(text)}
            className="border border-ink bg-ink px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-paper hover:bg-graphite"
          >
            {exit.surface ? "Leave" : "Go"}
          </button>
        </div>
      </div>
    </div>
  );
}
