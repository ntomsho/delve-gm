/**
 * ROOM ILLUSTRATIONS — the join with a generated dungeon
 *
 * The contract that matters is concealment: nothing hidden at generation ever
 * reaches the brief, whichever door the viewer came in by. Swept over real
 * offline dungeons, plus one forced case so the sweep cannot pass vacuously.
 */

import { describe, expect, it } from "vitest";
import { isSurfaceExit, touches } from "../shared/world/entities.ts";
import { generateOffline } from "../fixtures/offline.ts";
import { illustrationSketchSvg } from "./sketch.ts";
import {
  hasEntered,
  illustrationBrief,
  illustrationDoor,
  illustrationEntries,
  illustrationTags,
  roomIllustration,
} from "./room-illustration.ts";

const SEEDS = [1005, 42, 4201];

describe("roomIllustration", () => {
  for (const seed of SEEDS) {
    it(`seed ${seed}: every visible door is a way in, and nothing hidden is in a brief`, () => {
      const d = generateOffline(seed, 1);
      expect(d.blockplan).not.toBeNull();
      let views = 0;
      for (const gr of d.graph.rooms) {
        const roomId = gr.entityId;
        for (const entryId of illustrationEntries(d, roomId)) {
          const p = roomIllustration(d, roomId, entryId)!;
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
        for (const entryId of illustrationEntries(d, gr.entityId)) {
          const p = roomIllustration(d, gr.entityId, entryId)!;
          const svg = illustrationSketchSvg(p);
          for (const [id, t] of illustrationTags(p)) {
            if (!svg.includes(`data-tag="${t}"`)) missing.push(`seed ${seed} ${p.roomName} via ${entryId}: ${t} (${id})`);
          }
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it("gives every way out and drawable feature something to put on the illustration", () => {
    for (const seed of SEEDS) {
      const d = generateOffline(seed, 2);
      for (const gr of d.graph.rooms) {
        for (const entryId of illustrationEntries(d, gr.entityId)) {
          const p = roomIllustration(d, gr.entityId, entryId)!;
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
          const tags = illustrationTags(p);
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
    const entryId = illustrationEntries(d, roomId).find((id) => id !== door?.id)!;
    if (feature) (feature as { isHidden?: boolean }).isHidden = true;
    if (door) (door as { isHidden?: boolean }).isHidden = true;

    const p = roomIllustration(d, roomId, entryId)!;
    const brief = illustrationBrief(p);
    if (feature) expect(brief).not.toContain(feature.name);
    if (door) expect(p.exits.map((x) => x.id)).not.toContain(door.id);
    expect(illustrationEntries(d, roomId)).not.toContain(door?.id);
  });

  it("is undefined for a door that is not this room's", () => {
    const d = generateOffline(1005, 1);
    const roomId = d.graph.rooms[0].entityId;
    const elsewhere = d.entities.connectors.find((c) => !touches(c, roomId))!;
    expect(roomIllustration(d, roomId, elsewhere.id)).toBeUndefined();
  });
});

describe("illustrationDoor", () => {
  for (const seed of SEEDS) {
    it(`seed ${seed}: the entrance from the surface, every other room from the door nearer the entrance`, () => {
      const d = generateOffline(seed, 1);
      const entrance = d.stocked.entranceRoomId;
      // Steps from the entrance over doors that are not concealed.
      const steps = new Map([[entrance, 0]]);
      const queue = [entrance];
      while (queue.length) {
        const at = queue.shift()!;
        for (const c of d.entities.connectors) {
          if (c.isHidden === true || isSurfaceExit(c) || !touches(c, at)) continue;
          const next = c.endpointA === at ? c.endpointB! : c.endpointA;
          if (!steps.has(next)) {
            steps.set(next, steps.get(at)! + 1);
            queue.push(next);
          }
        }
      }
      for (const { entityId: roomId } of d.graph.rooms) {
        const door = illustrationDoor(d, roomId);
        const entries = illustrationEntries(d, roomId);
        if (!entries.length) {
          expect(door).toBeUndefined();
          continue;
        }
        expect(entries).toContain(door);
        const c = d.entities.connectors.find((x) => x.id === door)!;
        if (roomId === entrance && entries.some((id) => isSurfaceExit(d.entities.connectors.find((x) => x.id === id)!))) {
          expect(isSurfaceExit(c)).toBe(true);
        } else if (steps.has(roomId) && roomId !== entrance && !isSurfaceExit(c)) {
          const from = c.endpointA === roomId ? c.endpointB! : c.endpointA;
          expect(steps.get(from)).toBe(steps.get(roomId)! - 1);
        }
        // The same for any copy of the dungeon: it depends on nothing else.
        expect(illustrationDoor(structuredClone(d), roomId)).toBe(door);
      }
    });
  }
});

describe("hasEntered", () => {
  it("is the room they are in, or one an arrival was logged in", () => {
    const log = [{ kind: "arrival", roomId: "b" }];
    expect(hasEntered({ log, currentRoomId: "a" }, "a")).toBe(true);
    expect(hasEntered({ log, currentRoomId: "a" }, "b")).toBe(true);
    expect(hasEntered({ log, currentRoomId: "a" }, "c")).toBe(false);
  });
});

describe("the floor kept clear for figures", () => {
  for (const seed of SEEDS) {
    it(`seed ${seed}: nearly every illustration keeps one, the guide dots it and the prompt names it`, async () => {
      const { illustrationImagePrompt, rawVisual } = await import("./visual.ts");
      const d = generateOffline(seed, 1);
      let illustrations = 0;
      let staged = 0;
      for (const gr of d.graph.rooms) {
        for (const entryId of illustrationEntries(d, gr.entityId)) {
          const p = roomIllustration(d, gr.entityId, entryId)!;
          illustrations++;
          const svg = illustrationSketchSvg(p, { marks: true });
          const prompt = illustrationImagePrompt(p, "marks", "", rawVisual(p), undefined, 4);
          if (p.stage) staged++;
          // Dotted only for the stage; the features' outlines are dashed "5 4".
          expect(svg.includes('stroke-dasharray="0.1 4"')).toBe(p.stage !== undefined);
          expect(prompt.includes("OPEN FLOOR")).toBe(p.stage !== undefined);
          // Never on the unmarked guide, which the prompt then has nothing to point at.
          expect(illustrationImagePrompt(p, "plain", "", rawVisual(p), undefined, 4)).not.toContain("OPEN FLOOR");
        }
      }
      expect(staged / illustrations).toBeGreaterThan(0.8);
    });
  }
});

describe("roomFigures", () => {
  for (const seed of SEEDS) {
    it(`seed ${seed}: everyone stands in the frame, far to near, the first on the stage`, async () => {
      const { roomFigures } = await import("./room-illustration.ts");
      const { drawableCreatures, roomClusters } = await import("./figures.ts");
      const d = generateOffline(seed, 1);
      let rooms = 0;
      for (const gr of d.graph.rooms) {
        const roomId = gr.entityId;
        const entryId = illustrationEntries(d, roomId)[0];
        if (!entryId) continue;
        const clusters = roomClusters(drawableCreatures(d.entities.creatures, roomId));
        if (!clusters.length) continue;
        rooms++;
        const run = { log: [{ kind: "arrival", roomId, via: entryId }], currentRoomId: roomId, entities: d.entities };
        const figs = roomFigures(d, run, roomId);
        const wanted = clusters.reduce((k, c) => k + c.front.length + c.behind.length, 0);
        expect(figs.length).toBeGreaterThan(0);
        expect(figs.length).toBeLessThanOrEqual(wanted);
        for (const f of figs) {
          expect(f.perFoot).toBeGreaterThan(0);
          expect(f.y).toBeGreaterThan(0);
          expect(f.y).toBeLessThanOrEqual(1);
        }
        // Back to front: the nearer a figure, the bigger it is per foot.
        for (let i = 1; i < figs.length; i++) expect(figs[i].perFoot).toBeGreaterThanOrEqual(figs[i - 1].perFoot - 1e-9);
        // Deterministic.
        expect(roomFigures(d, run, roomId)).toEqual(figs);
      }
      expect(rooms).toBeGreaterThan(0);
    });
  }

  it("a creature slain is gone; a room with no one in it has no figures", async () => {
    const { roomFigures } = await import("./room-illustration.ts");
    const d = generateOffline(4201, 1);
    const c = d.entities.creatures.find((x) => illustrationEntries(d, x.roomId).length > 0)!;
    const roomId = c.roomId;
    const run = { log: [], currentRoomId: roomId, entities: d.entities };
    const others = { ...d.entities, creatures: d.entities.creatures.filter((x) => x.roomId !== roomId) };
    expect(roomFigures(d, run, roomId).length).toBeGreaterThan(0);
    expect(roomFigures(d, { ...run, entities: others }, roomId)).toEqual([]);
  });
});
