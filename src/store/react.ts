/**
 * THE ONE PLACE GAME STATE MEETS REACT
 * ====================================
 *
 * `game.ts` builds a vanilla store on purpose — see the note at the top of it —
 * and everything that is not a component reads it through `getState`. A
 * component cannot: it has to re-render when the state changes, which means
 * subscribing, which means a hook.
 *
 * So the hook lives here, alone, and this is the only module below `src/ui` and
 * `App.tsx` that imports React. Keeping it to one file is what lets the turn
 * machine, the referee, and their tests stay renderer-free — and what will let
 * the same runtime run on a server without dragging React along.
 */

import { useStore } from "zustand/react";
import type { GameStore, GameStoreApi } from "./game.ts";

/**
 * Subscribe to a run's store.
 *
 * With no selector this re-renders on every change, which is what the play
 * screen wants — nearly every commit touches something it is showing. Pass a
 * selector for anything narrower.
 */
export function useGame(store: GameStoreApi): GameStore;
export function useGame<T>(store: GameStoreApi, select: (s: GameStore) => T): T;
export function useGame<T>(store: GameStoreApi, select?: (s: GameStore) => T): T | GameStore {
  // The identity default is the no-selector overload, which returns the whole
  // state; the signatures above are what callers see.
  return useStore(store, (select ?? ((s: GameStore) => s)) as (s: GameStore) => T);
}
