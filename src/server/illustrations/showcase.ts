/**
 * THE SHOWCASE: what `GET /api/illustrations/recent` does.
 *
 * The landing page shows rooms drawn in recent runs, with the creatures
 * generation put in them, and the covers of the dungeons they are in. Nothing
 * here draws: a picture is shown only if some player's run has paid for it.
 *
 * An illustration row says nothing about where it came from — it is keyed by a
 * hash of what it was drawn from (`serve.ts`) — so the rooms are found from the
 * runs instead:
 *
 *   1. the rooms recent runs walked into, and the door each was first entered
 *      by (`recentArrivals`, `illustrationEntryFor`);
 *   2. each room's key, built the way the room's own route builds it
 *      (`roomIllustration`, `illustrationKey`), and the sprite key of every
 *      creature generation stood in it;
 *   3. one lookup for which of those are drawn;
 *   4. figures placed only from creatures whose sprite is drawn, as the game
 *      places them (`roomClusters`, `illustrationFigures`).
 *
 * The creatures are the dungeon's as GENERATED, not any run's: the room as it
 * was stocked, before anyone fought in it. Hidden ones are left out, as the
 * game leaves them out.
 *
 * Node only.
 */

import { illustrationEntryFor, roomIllustration, type RoomIllustration } from "../../illustrations/room-illustration.ts";
import { drawableCreatures, illustrationFigures, roomClusters, spriteKeyOf } from "../../illustrations/figures.ts";
import { spriteSubject } from "../../illustrations/sprites.ts";
import type { ShowcaseIllustration } from "../../illustrations/showcase.ts";
import type { GeneratedDungeon } from "../../generation/generate.ts";
import type { ICreature } from "../../shared/world/entities.ts";
import type * as repo from "../db/repo.ts";
import { illustrationKey } from "./serve.ts";
import { lookKey, parseLook, spriteKey } from "./sprites.ts";

/** How many recent runs are read. */
export const SHOWCASE_RUNS = 24;
/** How many distinct dungeons those runs may bring in: each is a whole `doc` read. */
export const SHOWCASE_DUNGEONS = 8;
/**
 * How many rooms are keyed. Each is a camera search and a guide image, a few
 * milliseconds apiece, so this bounds the request's time.
 */
export const SHOWCASE_ROOMS = 48;
/** The most pictures one answer carries. */
export const SHOWCASE_MAX = 24;

export type ShowcaseStore = Pick<
  typeof repo,
  "recentArrivals" | "getCompleteDungeons" | "readyIllustrations" | "illustrationWordsFor"
>;

/** What keying needs from the workers: their reference counts and where a stored file is served. */
export interface ShowcaseWork {
  illustrationReferences: number;
  spriteReferences: number;
  urlOf(path: string): string;
}

/** One room found in a run, keyed, with the sprite key of each creature stood in it. */
interface Candidate {
  key: string;
  d: GeneratedDungeon;
  p: RoomIllustration;
  creatures: { c: ICreature; sprite: string }[];
}

/**
 * The pictures, most recently played first: at most `limit` rooms, then the
 * covers. The page shuffles them.
 */
export async function recentShowcase(work: ShowcaseWork, store: ShowcaseStore, limit = SHOWCASE_MAX): Promise<ShowcaseIllustration[]> {
  const runs = await store.recentArrivals(SHOWCASE_RUNS);
  const ids = [...new Set(runs.map((r) => r.dungeonId))].slice(0, SHOWCASE_DUNGEONS);
  const dungeons = await store.getCompleteDungeons(ids);
  const byId = new Map(dungeons.map((d) => [d.id, d]));

  const rooms: Candidate[] = [];
  const keyed = new Set<string>();
  for (const run of runs) {
    const stored = byId.get(run.dungeonId);
    if (!stored) continue;
    const d = stored.doc;
    const walked = [...new Set([...run.log.map((e) => e.roomId), run.currentRoomId])];
    for (const roomId of walked) {
      if (rooms.length >= SHOWCASE_ROOMS) break;
      const entryId = illustrationEntryFor(d, run, roomId);
      const p = entryId ? roomIllustration(d, roomId, entryId) : undefined;
      if (!p) continue;
      const key = illustrationKey(p, d.pass.theme, work.illustrationReferences);
      // A copy of a dungeon builds the same key, and so does a second run in it.
      if (keyed.has(key)) continue;
      keyed.add(key);
      const creatures = drawableCreatures(d.entities.creatures, roomId).flatMap((c) => {
        const subject = spriteSubject(d.entities, spriteKeyOf(c));
        return subject ? [{ c, sprite: spriteKey(subject, d.pass.theme, work.spriteReferences) }] : [];
      });
      rooms.push({ key, d, p, creatures });
    }
  }

  // A copy carries its source's cover key, so two rows can share one picture.
  const covers = [...new Map(dungeons.flatMap((s) => (s.cover ? [[s.cover, { key: s.cover, d: s.doc }] as const] : []))).values()];
  const sprites = [...new Set(rooms.flatMap((r) => r.creatures.map((x) => x.sprite)))];
  const ready = await store.readyIllustrations([...rooms.map((r) => r.key), ...covers.map((c) => c.key), ...sprites]);
  const drawnSprites = sprites.filter((s) => ready.has(s));
  const looks = await store.illustrationWordsFor(drawnSprites.map(lookKey));

  const shown: ShowcaseIllustration[] = [];
  for (const r of rooms) {
    const path = ready.get(r.key);
    if (!path) continue;
    // Keyed by the creature's sprite id, which is what a placed figure names.
    const spriteOf = new Map(r.creatures.filter((x) => ready.has(x.sprite)).map((x) => [spriteKeyOf(x.c), x.sprite]));
    const standing = r.creatures.filter((x) => ready.has(x.sprite)).map((x) => x.c);
    const placed = standing.length ? illustrationFigures(r.p.input, r.p.view, roomClusters(standing)) : [];
    const figures = placed.flatMap((f) => {
      const key = spriteOf.get(f.sprite)!;
      return [{ ...f, url: work.urlOf(ready.get(key)!), size: parseLook(looks.get(lookKey(key)))?.size ?? "medium" }];
    });
    shown.push({ kind: "room", url: work.urlOf(path), roomTitle: r.p.roomName, dungeonTitle: r.d.pass.name, figures });
  }
  // Covers ride on top of the rooms' limit: at most one per dungeon read.
  for (const c of covers) {
    const path = ready.get(c.key);
    if (path) shown.push({ kind: "cover", url: work.urlOf(path), dungeonTitle: c.d.pass.name, figures: [] });
  }
  return [...shown.filter((s) => s.kind === "room").slice(0, limit), ...shown.filter((s) => s.kind === "cover")];
}
