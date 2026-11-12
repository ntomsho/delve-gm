/**
 * THE SHOWCASE, against an offline dungeon and an in-memory store. What is
 * worth pinning: a drawn room comes back with its name and its dungeon's, a
 * creature stands in it only once its sprite is drawn, and the covers follow.
 */

import { describe, expect, it } from "vitest";
import { generateOffline } from "../../fixtures/offline.ts";
import { illustrationDoor } from "../../illustrations/room-illustration.ts";
import { drawableCreatures, spriteKeyOf } from "../../illustrations/figures.ts";
import type { DrawnRoom } from "../db/repo.ts";
import { pickShowcase, type ShowcaseStore, type ShowcaseWork } from "./showcase.ts";

const d = generateOffline(1005, 1);
// A room that can be drawn and has somebody in it.
const roomId = d.graph.rooms
  .map((r) => r.entityId)
  .find((id) => illustrationDoor(d, id) !== undefined && drawableCreatures(d.entities.creatures, id).length > 0)!;
const sprite = spriteKeyOf(drawableCreatures(d.entities.creatures, roomId)[0]);
const work: ShowcaseWork = { urlOf: (p) => `https://cdn/${p}` };

const drawn: DrawnRoom = {
  artRoot: "root-1",
  roomId,
  path: "room/root-1/a.png",
  meta: { entryId: illustrationDoor(d, roomId)!, title: "The Room" },
  dungeonTitle: d.pass.name,
};

function store(rooms: DrawnRoom[], drawnSprites: string[] = []): ShowcaseStore {
  return {
    randomDrawnRooms: async (limit) => rooms.slice(0, limit),
    randomDrawnCovers: async () => [{ path: "cover/root-1/c.png", dungeonTitle: d.pass.name }],
    getCompleteDungeons: async (ids) => ids.map((id) => ({ id, doc: d })),
    drawnSprites: async (refs) =>
      new Map(
        refs
          .filter((r) => drawnSprites.includes(r.subject))
          .map((r) => [`${r.artRoot}|${r.subject}`, { path: `sprite/${r.subject}.png`, meta: { size: "large" } }])
      ),
  };
}

describe("pickShowcase", () => {
  it("shows a drawn room with its drawn creature, then the covers", async () => {
    const got = await pickShowcase(work, store([drawn], [sprite]));
    expect(got.map((g) => g.kind)).toEqual(["room", "cover"]);
    const [room, cover] = got;
    expect(room).toMatchObject({ url: "https://cdn/room/root-1/a.png", roomTitle: "The Room", dungeonTitle: d.pass.name });
    expect(room.figures.length).toBeGreaterThan(0);
    expect(room.figures.every((f) => f.url === `https://cdn/sprite/${sprite}.png` && f.size === "large")).toBe(true);
    expect(cover).toEqual({ kind: "cover", url: "https://cdn/cover/root-1/c.png", dungeonTitle: d.pass.name, figures: [] });
  });

  it("shows the room empty while no sprite is drawn", async () => {
    const [room] = await pickShowcase(work, store([drawn]));
    expect(room.figures).toEqual([]);
  });

  it("asks for no more rooms than the limit", async () => {
    const got = await pickShowcase(work, store([drawn, { ...drawn, roomId: "other", path: "room/root-1/b.png" }]), 1);
    expect(got.filter((g) => g.kind === "room")).toHaveLength(1);
  });
});
