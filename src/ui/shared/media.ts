/**
 * WHAT KIND OF SCREEN, AND WHAT KIND OF HAND.
 *
 * Two questions, deliberately kept apart (see *Phones* in docs/BUILD-PLAN.md):
 *
 *   PHONE   how wide — whether the play screen is one column of tabs. Width
 *           decides LAYOUT and nothing else.
 *   TOUCH   whether there is a hover at all — whether a tap inspects. Input
 *           type decides BEHAVIOUR: a narrow desktop window still has a mouse,
 *           and a landscape tablet gets the desktop grid with a finger.
 */

import { useSyncExternalStore } from "react";

/** Below this the play screen is tabs. Matches the handoff's `max-[640px]`. */
export const PHONE = "(max-width: 640px)";
/** No pointer that can hover: a finger. */
export const TOUCH = "(hover: none)";

/**
 * Whether a media query matches, kept live.
 *
 * False wherever there is no `matchMedia` — a static render, and jsdom — which
 * is the desktop answer, so every existing test keeps rendering the screen it
 * was written against.
 */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (changed) => {
      const list = typeof window === "undefined" ? undefined : window.matchMedia?.(query);
      list?.addEventListener("change", changed);
      return () => list?.removeEventListener("change", changed);
    },
    () => (typeof window === "undefined" ? false : (window.matchMedia?.(query).matches ?? false)),
    () => false
  );
}
