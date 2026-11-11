/**
 * THE SHOWCASE: what `GET /api/illustrations/recent` does.
 *
 * The landing page shows drawn rooms, picked at random, with the creatures
 * generation put in them, and dungeon covers. Nothing here draws: a picture is
 * shown only if some player's run has paid for it.
 *
 * Rooms are found by what the plate says it is (`plates.kind`, written when it
 * was claimed), never by rebuilding keys: a key is a hash of the prompt, and
 * every prompt change would leave the page with no rooms.
 *
 *   1. random drawn rooms and random drawn covers, one query each;
 *   2. for rooms whose plate says where it was drawn from, the dungeon as
 *      generated (at most `SHOWCASE_DUNGEONS` of them: each is a whole `doc`);
 *   3. the sprite key of every creature generation stood in those rooms, and
 *      one lookup for which are drawn;
 *   4. figures placed only from creatures whose sprite is drawn, as the game
 *      places them (`roomClusters`, `illustrationFigures`).
 *
 * The creatures are the dungeon's as GENERATED, not any run's: the room as it
 * was stocked, before anyone fought in it. Hidden ones are left out, as the
 * game leaves them out. A room drawn before plates said where shows empty and
 * without a caption.
 *
 * Node only.
 */

import { roomIllustration } from "../../illustrations/room-illustration.ts";
import { drawableCreatures, illustrationFigures, roomClusters, spriteKeyOf } from "../../illustrations/figures.ts";
import { spriteSubject } from "../../illustrations/sprites.ts";
import type { ShowcaseIllustration } from "../../illustrations/showcase.ts";
import type { ICreature } from "../../shared/world/entities.ts";
import type * as repo from "../db/repo.ts";
import { lookKey, parseLook, spriteKey } from "./sprites.ts";

/** The most rooms one answer carries. */
export const SHOWCASE_MAX = 24;
/** The most covers one answer carries, on top of the rooms. */
export const SHOWCASE_COVERS = 8;
/** How many dungeons are read to stand creatures in their rooms: each is a whole `doc` read. */
export const SHOWCASE_DUNGEONS = 8;

export type ShowcaseStore = Pick<
  typeof repo,
  "randomRoomPlates" | "randomCoverPlates" | "getCompleteDungeons" | "readyIllustrations" | "illustrationWordsFor"
>;

/** What keying sprites needs from the workers, and where a stored file is served. */
export interface ShowcaseWork {
  spriteReferences: number;
  urlOf(path: string): string;
}

/** Random drawn rooms, at most `limit`, then random covers. Every picture appears once. */
export async function pickShowcase(work: ShowcaseWork, store: ShowcaseStore, limit = SHOWCASE_MAX): Promise<ShowcaseIllustration[]> {
  const [plates, covers] = await Promise.all([store.randomRoomPlates(limit), store.randomCoverPlates(SHOWCASE_COVERS)]);

  const ids = [...new Set(plates.flatMap((r) => (r.dungeonId && r.roomId && r.entryId && r.dungeonTitle ? [r.dungeonId] : [])))];
  const docs = new Map((await store.getCompleteDungeons(ids.slice(0, SHOWCASE_DUNGEONS))).map((s) => [s.id, s.doc]));

  const rooms = plates.map((plate) => {
    const d = plate.dungeonId ? docs.get(plate.dungeonId) : undefined;
    const p = d && plate.roomId && plate.entryId ? roomIllustration(d, plate.roomId, plate.entryId) : undefined;
    const creatures: { c: ICreature; sprite: string }[] =
      d && p
        ? drawableCreatures(d.entities.creatures, plate.roomId!).flatMap((c) => {
            const subject = spriteSubject(d.entities, spriteKeyOf(c));
            return subject ? [{ c, sprite: spriteKey(subject, d.pass.theme, work.spriteReferences) }] : [];
          })
        : [];
    return { plate, p, creatures };
  });

  const sprites = [...new Set(rooms.flatMap((r) => r.creatures.map((x) => x.sprite)))];
  const ready = await store.readyIllustrations(sprites);
  const looks = await store.illustrationWordsFor(sprites.filter((s) => ready.has(s)).map(lookKey));

  const shown: ShowcaseIllustration[] = rooms.map(({ plate, p, creatures }) => {
    const drawn = creatures.filter((x) => ready.has(x.sprite));
    // Keyed by the creature's sprite id, which is what a placed figure names.
    const spriteOf = new Map(drawn.map((x) => [spriteKeyOf(x.c), x.sprite]));
    const placed = p && drawn.length ? illustrationFigures(p.input, p.view, roomClusters(drawn.map((x) => x.c))) : [];
    const figures = placed.map((f) => {
      const key = spriteOf.get(f.sprite)!;
      return { ...f, url: work.urlOf(ready.get(key)!), size: parseLook(looks.get(lookKey(key)))?.size ?? "medium" };
    });
    return {
      kind: "room",
      url: work.urlOf(plate.path),
      ...(plate.title ? { roomTitle: plate.title } : {}),
      dungeonTitle: plate.dungeonTitle ?? "",
      figures,
    };
  });
  for (const c of covers) shown.push({ kind: "cover", url: work.urlOf(c.path), dungeonTitle: c.dungeonTitle, figures: [] });
  return shown;
}
