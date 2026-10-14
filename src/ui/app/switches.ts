/**
 * THE DEV SWITCHES, read off the URL.
 *
 * A pure function of the query string, so the logic can be tested rather than
 * trusted. `App.tsx` calls it once with `location.search`; the test calls it
 * with whatever it likes.
 */

import type { Size } from "../../generation/content/blueprint.ts";

export interface Switches {
  /**
   * The fixture dungeon AND the stub game master, played in the browser. No
   * model, no server, no account. Both halves at once, because a fixture
   * dungeon with the real game master still calls the model on room entry.
   */
  offline: boolean;
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

const NAMES = ["seed", "size", "level", "offline"] as const;

export function readSwitches(search: string): Switches {
  const params = new URLSearchParams(search);

  return {
    offline: params.get("offline") === "1",
    bypass: NAMES.some((k) => params.has(k)),
    seed: Number(params.get("seed") ?? 1005),
    pinnedSeed: params.has("seed"),
    size: Number(params.get("size") ?? 2) as Size,
    level: Number(params.get("level") ?? 1),
    endings: params.has("endings"),
  };
}
