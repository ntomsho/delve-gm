/**
 * HOW MANY RUNS ARE LEFT TODAY
 * ============================
 *
 * A "run" is writing a dungeon plus the first run into it, or a run into a
 * dungeon that is already written. See `src/server/allowance.ts`.
 *
 * The browser half of `src/server/allowance.ts`. Read when run setup opens, so
 * the screen can say how many are left before the player presses anything. It
 * decides nothing: the server asks again on every start, and a refusal it makes
 * that this did not predict still arrives in the server's own words.
 */

import { authedFetch } from "./auth.ts";

/** Mirrors `Allowance` in `src/server/allowance.ts`. */
export interface Allowance {
  guest: boolean;
  unlimited: boolean;
  used: number;
  /** `null` for an unlimited account. */
  limit: number | null;
  /** `null` for an unlimited account. */
  left: number | null;
  maxSize: number;
  /** ISO timestamp of the next midnight UTC. */
  resetsAt: string;
  /**
   * The player's own written dungeons nobody has run yet. The first run into
   * one rides on its writing, so it is free even with none left.
   */
  unplayed: string[];
}

export async function fetchAllowance(): Promise<Allowance> {
  const res = await authedFetch("/api/allowance");
  if (!res.ok) throw new Error(`could not read today's allowance (${res.status})`);
  return (await res.json()) as Allowance;
}

/** "in 3 hours", "in 40 minutes" — how long until `resetsAt`, roughly. */
export function untilReset(resetsAt: string, now: Date = new Date()): string {
  const minutes = Math.max(1, Math.round((Date.parse(resetsAt) - now.getTime()) / 60_000));
  if (minutes < 60) return `in ${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.round(minutes / 60);
  return `in ${hours} hour${hours === 1 ? "" : "s"}`;
}
