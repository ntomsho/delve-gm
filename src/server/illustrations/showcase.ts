/**
 * THE SHOWCASE: what `GET /api/illustrations/recent` does.
 *
 * The landing page shows drawn rooms, picked at random, with the creatures
 * generation put in them, and dungeon covers. Nothing here draws: a picture is
 * shown only if some player's run has paid for it.
 *
 *   1. random drawn rooms and random drawn covers from `assets`, one query each;
 *   2. the dungeon as generated, for the rooms' first `SHOWCASE_DUNGEONS`
 *      dungeons (each is a whole `doc`);
 *   3. which of the creatures generation stood in those rooms have a drawn
 *      sprite, in one query;
 *   4. figures placed only from those, as the game places them, from the door
 *      the picture was drawn from (`roomClusters`, `illustrationFigures`).
 *
 * The creatures are the dungeon's as GENERATED, not any run's: the room as it
 * was stocked, before anyone fought in it. Hidden ones are left out, as the
 * game leaves them out.
 *
 * Node only.
 */

import { roomIllustration } from "../../illustrations/room-illustration.ts";
import { drawableCreatures, illustrationFigures, roomClusters, spriteKeyOf } from "../../illustrations/figures.ts";
import type { ShowcaseIllustration } from "../../illustrations/showcase.ts";
import type * as repo from "../db/repo.ts";
import type { RoomMeta } from "./serve.ts";
import { spriteSize } from "./sprites.ts";

/** The most rooms one answer carries. */
export const SHOWCASE_MAX = 24;
/** The most covers one answer carries, on top of the rooms. */
export const SHOWCASE_COVERS = 8;
/** How many dungeons are read to stand creatures in their rooms: each is a whole `doc` read. */
export const SHOWCASE_DUNGEONS = 8;

export type ShowcaseStore = Pick<typeof repo, "randomDrawnRooms" | "randomDrawnCovers" | "getCompleteDungeons" | "drawnSprites">;

/** Where a stored file is served. */
export interface ShowcaseWork {
  urlOf(path: string): string;
}

/** Random drawn rooms, at most `limit`, then random covers. Every picture appears once. */
export async function pickShowcase(work: ShowcaseWork, store: ShowcaseStore, limit = SHOWCASE_MAX): Promise<ShowcaseIllustration[]> {
  const [rooms, covers] = await Promise.all([store.randomDrawnRooms(limit), store.randomDrawnCovers(SHOWCASE_COVERS)]);

  const ids = [...new Set(rooms.map((r) => r.artRoot))].slice(0, SHOWCASE_DUNGEONS);
  const docs = new Map((await store.getCompleteDungeons(ids)).map((s) => [s.id, s.doc]));

  const placed = rooms.map((room) => {
    const meta = room.meta as Partial<RoomMeta>;
    const d = docs.get(room.artRoot);
    const p = d && meta.entryId ? roomIllustration(d, room.roomId, meta.entryId) : undefined;
    const creatures = d && p ? drawableCreatures(d.entities.creatures, room.roomId) : [];
    return { room, meta, p, creatures };
  });

  const sprites = await store.drawnSprites(
    placed.flatMap(({ room, creatures }) => creatures.map((c) => ({ artRoot: room.artRoot, subject: spriteKeyOf(c) })))
  );

  const shown: ShowcaseIllustration[] = placed.map(({ room, meta, p, creatures }) => {
    const spriteOf = (id: string) => sprites.get(`${room.artRoot}|${id}`);
    const standing = creatures.filter((c) => spriteOf(spriteKeyOf(c)));
    const figures =
      p && standing.length
        ? illustrationFigures(p.input, p.view, roomClusters(standing)).map((f) => {
            const sprite = spriteOf(f.sprite)!;
            return { ...f, url: work.urlOf(sprite.path), size: spriteSize(sprite.meta) };
          })
        : [];
    return {
      kind: "room",
      url: work.urlOf(room.path),
      ...(meta.title ? { roomTitle: meta.title } : {}),
      dungeonTitle: room.dungeonTitle ?? "",
      figures,
    };
  });
  for (const c of covers) shown.push({ kind: "cover", url: work.urlOf(c.path), dungeonTitle: c.dungeonTitle ?? "", figures: [] });
  return shown;
}
