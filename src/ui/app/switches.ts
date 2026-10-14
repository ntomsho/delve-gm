/**
 * THE DEV SWITCHES, read off the URL.
 *
 * Pulled out of `App.tsx` because this is where a bug lived that nothing could
 * have caught: `?offline=1` swapped the generator and left the game master real, so
 * an "offline" page called the model on room entry before the player had typed
 * anything. One line of logic, no way to test it while it read `location`
 * directly at module scope, and a switch nobody could trust as a result.
 *
 * A pure function of the query string. `App.tsx` calls it once with
 * `location.search`; the test calls it with whatever it likes.
 */

import type { Size } from "../../generation/content/blueprint.ts";

export interface Switches {
  /** the fixture dungeon rather than a generated one */
  offline: boolean;
  /** the Phase 3 fixture game master rather than the model */
  stub: boolean;
  /**
   * Any switch at all was given, so the front of the app is not what the
   * developer came for: skip it and start a run with the first saved character.
   */
  bypass: boolean;
  seed: number;
  /** the seed was named, so a reload returns to the same dungeon */
  pinnedSeed: boolean;
  size: Size;
  level: number;
  /**
   * The end-of-run preview — `EndOfRun` over fixture data, every ending a click
   * apart. Not a run at all, so it is not one of `NAMES`: it does not bypass the
   * front of the app, it replaces the app. `main.tsx` reads it.
   */
  endings: boolean;
}

const NAMES = ["seed", "size", "level", "offline", "stub"] as const;

export function readSwitches(search: string): Switches {
  const params = new URLSearchParams(search);
  const offline = params.get("offline") === "1";

  return {
    offline,
    /**
     * OFFLINE MEANS OFFLINE. Asked for outright, or implied by `?offline=1`
     * and not refused — `?stub=0` is how a developer keeps the real game master on
     * a fixture dungeon, which is the one combination that wants the network
     * without wanting to pay to generate.
     */
    stub: params.get("stub") === "1" || (offline && params.get("stub") !== "0"),
    bypass: NAMES.some((k) => params.has(k)),
    seed: Number(params.get("seed") ?? 1005),
    pinnedSeed: params.has("seed"),
    size: Number(params.get("size") ?? 2) as Size,
    level: Number(params.get("level") ?? 1),
    endings: params.has("endings"),
  };
}
