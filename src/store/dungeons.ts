/**
 * WHERE DUNGEONS LIVE
 * ===================
 *
 * The counterpart to `characters.ts`, and it exists for the same reason: one
 * module that knows the API shape, so nothing above it does.
 *
 * A WORLD OUTLIVES THE RUN THAT WAS PLAYED IN IT, and until Phase 13a nothing
 * in the interface said so. A dungeon was written, played once, and then sat in
 * Postgres unreachable — `GET /api/dungeons` had been serving summaries since
 * Phase 10 with nothing fetching them. So every run cost a fresh N+2 generation
 * even when the player wanted to go back down a hole they already owned.
 *
 * NEVER THE `doc`. A summary is name, objective, size, level, seed and status,
 * and that is the whole cross-owner vocabulary — the document holds every
 * answer in the world and is served only to the player who owns the row, by
 * `GET /api/runs/:id` once they are actually in it.
 */

import { authedFetch } from "./auth.ts";

const BASE = "/api/dungeons";

/**
 * What a dungeon looks like from outside itself.
 *
 * Mirrors `DungeonSummary` in `src/server/repo.ts`. Declared rather than
 * imported: this file runs in the browser and that one is Node-only.
 */
export interface DungeonSummary {
  id: string;
  name: string;
  objective: string;
  size: number;
  level: number;
  seed: number;
  status: "partial" | "complete";
  createdAt: string;
  /** the cover's URL, once drawn; absent on a dungeon written before covers */
  cover?: string;
}

/** The server's own sentence when it has one — see the note in `characters.ts`. */
async function json<T>(res: Response, what: string): Promise<T> {
  if (!res.ok) {
    const detail = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(detail.error ?? `could not ${what} (${res.status})`);
  }
  return (await res.json()) as T;
}

/**
 * The player's own worlds, newest first.
 *
 * INCLUDING THE PARTIAL ONES, deliberately. A half-written dungeon is a failed
 * generation, and it is a thing that happened to this player rather than a
 * thing to hide from them — the caller decides whether to offer it. `RunSetup`
 * does not, because `POST /api/runs` refuses one.
 */
export async function listDungeons(): Promise<DungeonSummary[]> {
  return json(await authedFetch(BASE), "read the dungeons");
}

/**
 * One batch of the library, and where to carry on from.
 *
 * `cursor` IS OPAQUE. It is the server's bookkeeping, handed back unread — this
 * file must never parse, compose or compare one, and nothing above it should
 * know it is a string rather than a token. Absent means the end of the shelf.
 */
export interface LibraryPage {
  dungeons: DungeonSummary[];
  cursor?: string;
}

/**
 * Worlds other players made, newest first.
 *
 * ONE BATCH PER CALL. A `doc` is half a megabyte and a summary is a line, but
 * there is no ceiling on how many lines the shelf holds, and a screen that asks
 * for all of them asks for a slower answer every week it exists. Pass the
 * `cursor` from the last page back to get the next one.
 */
export async function listLibrary(cursor?: string): Promise<LibraryPage> {
  const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
  return json(await authedFetch(`${BASE}/library${query}`), "read the library");
}

/**
 * Take a copy of a world, and get back the id of YOUR row.
 *
 * `already` is the second click: a copy is recorded as a copy, so this is safe
 * to press twice and the answer names the copy that already exists rather than
 * making another.
 */
export async function duplicateDungeon(
  id: string
): Promise<{ dungeonId: string; already: boolean }> {
  return json(
    await authedFetch(`${BASE}/${encodeURIComponent(id)}/duplicate`, { method: "POST" }),
    "take a copy of that dungeon"
  );
}
