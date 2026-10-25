/**
 * THE SHOWCASE, against an offline dungeon and an in-memory store. What is
 * worth pinning: only drawn pictures come back, a creature stands in its room
 * only once its sprite is drawn, and two runs through one room show it once.
 */

import { describe, expect, it } from "vitest";
import { generateOffline } from "../../fixtures/offline.ts";
import { illustrationEntries, roomIllustration } from "../../illustrations/room-illustration.ts";
import { drawableCreatures, spriteKeyOf } from "../../illustrations/figures.ts";
import { spriteSubject } from "../../illustrations/sprites.ts";
import type { RunArrivals } from "../db/repo.ts";
import { illustrationKey } from "./serve.ts";
import { lookKey, spriteKey } from "./sprites.ts";
import { recentShowcase, type ShowcaseStore, type ShowcaseWork } from "./showcase.ts";

const d = generateOffline(1005, 1);
// A room that can be drawn and has somebody in it.
const roomId = d.graph.rooms
  .map((r) => r.entityId)
  .find((id) => illustrationEntries(d, id).length > 0 && drawableCreatures(d.entities.creatures, id).length > 0)!;
const entryId = illustrationEntries(d, roomId)[0];
const work: ShowcaseWork = { illustrationReferences: 4, spriteReferences: 3, urlOf: (p) => `https://cdn/${p}` };
const roomKey = illustrationKey(roomIllustration(d, roomId, entryId)!, d.pass.theme, 4);
const creature = drawableCreatures(d.entities.creatures, roomId)[0];
const sprite = spriteKey(spriteSubject(d.entities, spriteKeyOf(creature))!, d.pass.theme, 3);

const run: RunArrivals = { dungeonId: "row-1", currentRoomId: roomId, log: [{ kind: "arrival", roomId, via: entryId }] };

function store(drawn: string[], runs: RunArrivals[] = [run]): ShowcaseStore {
  return {
    recentArrivals: async () => runs,
    // Every row carries the cover, as copies of one dungeon do.
    getCompleteDungeons: async (ids) => ids.map((id) => ({ id, doc: d, cover: "cover-key" })),
    readyIllustrations: async (keys) => new Map(keys.filter((k) => drawn.includes(k)).map((k) => [k, `${k}.png`])),
    illustrationWordsFor: async (keys) =>
      new Map(keys.filter((k) => k === lookKey(sprite)).map((k) => [k, JSON.stringify({ look: "x", size: "large" })])),
  };
}

describe("recentShowcase", () => {
  it("shows a drawn room with its drawn creature, and the dungeon's cover", async () => {
    const got = await recentShowcase(work, store([roomKey, sprite, "cover-key"]));
    const room = got.find((g) => g.kind === "room")!;
    expect(room.url).toBe(`https://cdn/${roomKey}.png`);
    expect(room.dungeonTitle).toBe(d.pass.name);
    expect(room.roomTitle).toBeTruthy();
    expect(room.figures.length).toBeGreaterThan(0);
    expect(room.figures.every((f) => f.url === `https://cdn/${sprite}.png` && f.size === "large")).toBe(true);
    expect(got.filter((g) => g.kind === "cover")).toEqual([
      { kind: "cover", url: "https://cdn/cover-key.png", dungeonTitle: d.pass.name, figures: [] },
    ]);
  });

  it("shows the room empty while no sprite is drawn, and nothing that is not drawn", async () => {
    const got = await recentShowcase(work, store([roomKey]));
    expect(got).toHaveLength(1);
    expect(got[0].figures).toEqual([]);
    expect(await recentShowcase(work, store([]))).toEqual([]);
  });

  it("shows a room, and a cover, once however many runs and copies share it", async () => {
    const got = await recentShowcase(work, store([roomKey, "cover-key"], [run, { ...run, dungeonId: "row-2" }]));
    expect(got.filter((g) => g.kind === "room")).toHaveLength(1);
    expect(got.filter((g) => g.kind === "cover")).toHaveLength(1);
  });
});
