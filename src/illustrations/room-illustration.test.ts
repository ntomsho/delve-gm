/**
 * ROOM PLATES — the join with a generated dungeon
 *
 * The contract that matters is concealment: nothing hidden at generation ever
 * reaches the brief, whichever door the viewer came in by. Swept over real
 * offline dungeons, plus one forced case so the sweep cannot pass vacuously.
 */

import { describe, expect, it } from "vitest";
import { isSurfaceExit, touches } from "../shared/world/entities.ts";
import { generateOffline } from "../fixtures/offline.ts";
import { plateSketchSvg } from "./sketch.ts";
import { plateBrief, plateEntries, plateEntryFor, plateTags, roomPlate } from "./room-illustration.ts";

const SEEDS = [1005, 42, 4201];

describe("roomPlate", () => {
  for (const seed of SEEDS) {
    it(`seed ${seed}: every visible door is a way in, and nothing hidden is in a brief`, () => {
      const d = generateOffline(seed, 1);
      expect(d.blockplan).not.toBeNull();
      let views = 0;
      for (const gr of d.graph.rooms) {
        const roomId = gr.entityId;
        for (const entryId of plateEntries(d, roomId)) {
          const p = roomPlate(d, roomId, entryId)!;
          expect(p).toBeDefined();
          views++;

          const hiddenIds = [
            ...d.entities.features.filter((f) => f.roomId === roomId && f.isHidden === true).map((f) => f.id),
            ...d.entities.connectors.filter((c) => touches(c, roomId) && c.isHidden === true).map((c) => c.id),
          ];
          const listed = [...p.exits.map((x) => x.id), ...p.features.map((f) => f.id)];
          for (const h of hiddenIds) expect(listed).not.toContain(h);
          // The way in is behind the camera; it is not one of the things drawn.
          expect(p.exits.map((x) => x.id)).not.toContain(entryId);
          // One view entry per subject, in the same order.
          expect(p.view.exits.map((s) => s.id)).toEqual(p.exits.map((x) => x.id));
          expect(p.view.features.map((s) => s.id)).toEqual(p.features.map((f) => f.id));
        }
      }
      expect(views).toBeGreaterThan(d.graph.rooms.length);
    });
  }

  it("draws a tag in the guide image for everything the brief tags", () => {
    // The brief and the guide are read together: a door the brief calls
    // "[A] in the right wall" has to be where the guide's A is.
    const missing: string[] = [];
    for (const seed of SEEDS) {
      const d = generateOffline(seed, 2);
      for (const gr of d.graph.rooms) {
        for (const entryId of plateEntries(d, gr.entityId)) {
          const p = roomPlate(d, gr.entityId, entryId)!;
          const svg = plateSketchSvg(p);
          for (const [id, t] of plateTags(p)) {
            if (!svg.includes(`data-tag="${t}"`)) missing.push(`seed ${seed} ${p.roomName} via ${entryId}: ${t} (${id})`);
          }
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it("gives every way out and drawable feature something to put on the plate", () => {
    for (const seed of SEEDS) {
      const d = generateOffline(seed, 2);
      for (const gr of d.graph.rooms) {
        for (const entryId of plateEntries(d, gr.entityId)) {
          const p = roomPlate(d, gr.entityId, entryId)!;
          const ids = p.hotspots.map((h) => h.id);
          // Every door, the way in among them, has a hotspot.
          for (const x of [...p.exits, p.entry]) expect(ids).toContain(x.id);
          expect(p.hotspots.find((h) => h.id === entryId)?.role).toBe("entry");
          for (const h of p.hotspots) {
            // Exactly one control: buttons, a corner arrow, a dashed button, or an edge arrow.
            if (h.status === "shown" || h.status === "behind-wall") expect(h.points.length).toBeGreaterThan(0);
            if (h.status === "around") expect([h.points.length, h.edge]).toEqual([0, undefined]);
            if (h.status === "off-frame") expect([h.points.length, h.around]).toEqual([0, undefined]);
            expect(h.around !== undefined).toBe(h.status === "around");
            expect(h.edge !== undefined).toBe(h.status === "off-frame");
            if (h.status === "shown") {
              for (const q of h.points) {
                expect(q.x).toBeGreaterThanOrEqual(0);
                expect(q.x).toBeLessThanOrEqual(1);
                expect(q.y).toBeGreaterThanOrEqual(0);
                expect(q.y).toBeLessThanOrEqual(1);
              }
            }
          }
          // A sound has no button and no tag; a surface has a button but no tag.
          const tags = plateTags(p);
          for (const x of p.senses) {
            expect(ids).not.toContain(x.id);
            expect(tags.has(x.id)).toBe(false);
          }
          for (const f of p.features.filter((x) => x.presence === "surface")) expect(tags.has(f.id)).toBe(false);
        }
      }
    }
  });

  it("leaves a concealed feature and a concealed door out of the brief", () => {
    const d = generateOffline(1005, 1);
    const roomId = d.graph.rooms[0].entityId;
    const feature = d.entities.features.find((f) => f.roomId === roomId);
    const door = d.entities.connectors.find((c) => touches(c, roomId) && !isSurfaceExit(c));
    const entryId = plateEntries(d, roomId).find((id) => id !== door?.id)!;
    if (feature) (feature as { isHidden?: boolean }).isHidden = true;
    if (door) (door as { isHidden?: boolean }).isHidden = true;

    const p = roomPlate(d, roomId, entryId)!;
    const brief = plateBrief(p);
    if (feature) expect(brief).not.toContain(feature.name);
    if (door) expect(p.exits.map((x) => x.id)).not.toContain(door.id);
    expect(plateEntries(d, roomId)).not.toContain(door?.id);
  });

  it("is undefined for a door that is not this room's", () => {
    const d = generateOffline(1005, 1);
    const roomId = d.graph.rooms[0].entityId;
    const elsewhere = d.entities.connectors.find((c) => !touches(c, roomId))!;
    expect(roomPlate(d, roomId, elsewhere.id)).toBeUndefined();
  });
});

describe("plateEntryFor", () => {
  const d = generateOffline(1005, 1);
  const entrance = d.stocked.entranceRoomId;
  const other = d.graph.rooms.map((r) => r.entityId).find((id) => id !== entrance && plateEntries(d, id).length > 1)!;
  const [first, second] = plateEntries(d, other);

  it("refuses a room the run has not been in", () => {
    expect(plateEntryFor(d, { log: [], currentRoomId: entrance }, other)).toBeUndefined();
  });

  it("draws from the door the first arrival was logged with", () => {
    const log = [
      { kind: "arrival", roomId: other, via: second },
      { kind: "arrival", roomId: other, via: first },
    ];
    expect(plateEntryFor(d, { log, currentRoomId: entrance }, other)).toBe(second);
  });

  it("falls back to arrivedVia, then the way out of the dungeon", () => {
    expect(plateEntryFor(d, { log: [], currentRoomId: other, arrivedVia: second }, other)).toBe(second);
    const out = plateEntryFor(d, { log: [{ kind: "arrival", roomId: entrance }], currentRoomId: other }, entrance)!;
    expect(isSurfaceExit(d.entities.connectors.find((c) => c.id === out)!)).toBe(true);
  });
});
