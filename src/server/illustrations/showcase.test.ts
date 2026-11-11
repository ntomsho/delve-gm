/**
 * THE SHOWCASE, against an offline dungeon and an in-memory store. What is
 * worth pinning: a room is shown from what its plate says it is, a creature
 * stands in it only once its sprite is drawn, and a room drawn before plates
 * said where still shows, empty and uncaptioned.
 */

import { describe, expect, it } from "vitest";
import { generateOffline } from "../../fixtures/offline.ts";
import { illustrationEntries } from "../../illustrations/room-illustration.ts";
import { drawableCreatures, spriteKeyOf } from "../../illustrations/figures.ts";
import { spriteSubject } from "../../illustrations/sprites.ts";
import type { RoomPlate } from "../db/repo.ts";
import { lookKey, spriteKey } from "./sprites.ts";
import { pickShowcase, type ShowcaseStore, type ShowcaseWork } from "./showcase.ts";

const d = generateOffline(1005, 1);
// A room that can be drawn and has somebody in it.
const roomId = d.graph.rooms
  .map((r) => r.entityId)
  .find((id) => illustrationEntries(d, id).length > 0 && drawableCreatures(d.entities.creatures, id).length > 0)!;
const entryId = illustrationEntries(d, roomId)[0];
const work: ShowcaseWork = { spriteReferences: 3, urlOf: (p) => `https://cdn/${p}` };
const creature = drawableCreatures(d.entities.creatures, roomId)[0];
const sprite = spriteKey(spriteSubject(d.entities, spriteKeyOf(creature))!, d.pass.theme, 3);

const placed: RoomPlate = {
  key: "room-key",
  path: "room-key.png",
  title: "The Room",
  dungeonId: "row-1",
  roomId,
  entryId,
  dungeonTitle: d.pass.name,
};
const unplaced: RoomPlate = { key: "old-key", path: "old-key.png", title: null, dungeonId: null, roomId: null, entryId: null, dungeonTitle: null };

function store(rooms: RoomPlate[], drawnSprites: string[] = []): ShowcaseStore {
  return {
    randomRoomPlates: async (limit) => rooms.slice(0, limit),
    randomCoverPlates: async () => [{ path: "cover-key.png", dungeonTitle: d.pass.name }],
    getCompleteDungeons: async (ids) => ids.map((id) => ({ id, doc: d, cover: "cover-key" })),
    readyIllustrations: async (keys) => new Map(keys.filter((k) => drawnSprites.includes(k)).map((k) => [k, `${k}.png`])),
    illustrationWordsFor: async (keys) =>
      new Map(keys.filter((k) => k === lookKey(sprite)).map((k) => [k, JSON.stringify({ look: "x", size: "large" })])),
  };
}

describe("pickShowcase", () => {
  it("shows a drawn room with its drawn creature, then the covers", async () => {
    const got = await pickShowcase(work, store([placed], [sprite]));
    expect(got.map((g) => g.kind)).toEqual(["room", "cover"]);
    const [room, cover] = got;
    expect(room).toMatchObject({ url: "https://cdn/room-key.png", roomTitle: "The Room", dungeonTitle: d.pass.name });
    expect(room.figures.length).toBeGreaterThan(0);
    expect(room.figures.every((f) => f.url === `https://cdn/${sprite}.png` && f.size === "large")).toBe(true);
    expect(cover).toEqual({ kind: "cover", url: "https://cdn/cover-key.png", dungeonTitle: d.pass.name, figures: [] });
  });

  it("shows the room empty while no sprite is drawn", async () => {
    const [room] = await pickShowcase(work, store([placed]));
    expect(room.figures).toEqual([]);
  });

  it("shows a room drawn before plates said where, empty and uncaptioned", async () => {
    const [room] = await pickShowcase(work, store([unplaced]));
    expect(room).toEqual({ kind: "room", url: "https://cdn/old-key.png", dungeonTitle: "", figures: [] });
  });

  it("asks for no more rooms than the limit", async () => {
    const got = await pickShowcase(work, store([placed, unplaced]), 1);
    expect(got.filter((g) => g.kind === "room")).toHaveLength(1);
  });
});
