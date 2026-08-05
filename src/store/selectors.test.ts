import { describe, expect, it } from "vitest";
import { generateOffline, testCharacter } from "../runtime/__fixtures__/offline.ts";
import { newRun, useGame } from "./game.ts";
import {
  characterView, mapView, needsComposition, roomView, UNARMORED_DEFENSE,
} from "./selectors.ts";
import { pathMidpoint, pointLayout, shapeCenter } from "../runtime/layout.ts";
import type { Diff } from "../runtime/diffs/types.ts";
import type { IItem } from "../engine/index.ts";

const SEED = 1005;
const dungeon = generateOffline(SEED, 2);

function freshRun() {
  return newRun(dungeon, testCharacter());
}

const turn = (...diffs: Diff[]) =>
  ({ nextStage: "awaiting_action", nextStep: "1-target", diffs }) as const;

// ===========================================================================
// LAYOUT
// ===========================================================================

describe("pointLayout", () => {
  const layout = pointLayout(dungeon.graph);

  it("keys rooms and connectors by ENTITY id, not graph index", () => {
    // The one thing joining a dot on the map to the room the player stands in.
    const roomIds = new Set(dungeon.entities.rooms.map((r) => r.id));
    for (const r of layout.rooms) expect(roomIds.has(r.id)).toBe(true);

    const connectorIds = new Set(dungeon.entities.connectors.map((c) => c.id));
    for (const c of layout.connectors) expect(connectorIds.has(c.id)).toBe(true);
  });

  it("covers every room and connector exactly once", () => {
    expect(layout.rooms).toHaveLength(dungeon.entities.rooms.length);
    expect(new Set(layout.rooms.map((r) => r.id)).size).toBe(layout.rooms.length);
    expect(layout.connectors).toHaveLength(dungeon.entities.connectors.length);
  });

  it("joins each connector to the two rooms it actually joins", () => {
    const byId = new Map(dungeon.entities.connectors.map((c) => [c.id, c]));
    for (const c of layout.connectors) {
      const entity = byId.get(c.id)!;
      expect([c.from, c.to].sort()).toEqual([entity.endpointA, entity.endpointB].sort());
    }
  });

  it("normalises positions into its own bounds", () => {
    for (const room of layout.rooms) {
      const at = shapeCenter(room.shape);
      expect(at.x).toBeGreaterThanOrEqual(0);
      expect(at.y).toBeGreaterThanOrEqual(0);
      expect(at.x).toBeLessThanOrEqual(layout.bounds.w);
      expect(at.y).toBeLessThanOrEqual(layout.bounds.h);
    }
  });

  it("scales both axes together, so the relaxed shape is not distorted", () => {
    const wide = pointLayout(dungeon.graph, { size: 1520 });
    const ratio = (l: typeof layout) => l.bounds.w / l.bounds.h;
    expect(ratio(wide)).toBeCloseTo(ratio(layout), 1);
  });

  it("puts a connector's midpoint between its endpoints", () => {
    const c = layout.connectors[0];
    const mid = pathMidpoint(c.path);
    const from = shapeCenter(layout.rooms.find((r) => r.id === c.from)!.shape);
    const to = shapeCenter(layout.rooms.find((r) => r.id === c.to)!.shape);
    expect(mid.x).toBeCloseTo((from.x + to.x) / 2, 5);
  });

  it("marks the long links between regions", () => {
    expect(layout.connectors.some((c) => c.interChunk)).toBe(true);
  });
});

// ===========================================================================
// THE CURRENT ROOM
// ===========================================================================

describe("roomView", () => {
  it("gathers the room, everything in it, its exits, and the fiction", () => {
    const run = freshRun();
    const view = roomView(run, dungeon)!;

    expect(view.id).toBe(dungeon.stocked.entranceRoomId);
    expect(view.base).toBeTruthy();
    expect(view.exits.length).toBeGreaterThan(0);
    expect(view.fiction).toBe(dungeon.dungeonContext);
  });

  it("hides features the player has not found, by default", () => {
    const run = freshRun();
    const room = run.entities.rooms[0].id;
    run.entities.features.push({
      id: "secret", name: "Loose flagstone", type: "RoomFeature",
      base: "a flagstone worn smooth", roomId: room, isHidden: true,
    });

    const shown = roomView(run, dungeon, room)!;
    expect(shown.contents.map((c) => c.id)).not.toContain("secret");

    // The referee must see it, or nothing is findable.
    const referee = roomView(run, dungeon, room, { includeHidden: true })!;
    expect(referee.contents.map((c) => c.id)).toContain("secret");
  });

  it("nests what a thing holds inside it", () => {
    const run = freshRun();
    const room = run.entities.rooms[0].id;
    const chest = { id: "chest", name: "Chest", type: "RoomFeature" as const, base: "a chest", roomId: room };
    const coin: IItem = { id: "coin", name: "Coin", type: "Item", base: "a coin", parentId: "chest", slots: 1 };
    run.entities.features.push(chest);
    run.entities.items.push(coin);

    const view = roomView(run, dungeon, room)!;
    const chestView = view.contents.find((c) => c.id === "chest")!;
    expect(chestView.contains.map((c) => c.id)).toEqual(["coin"]);
    // …and not also loose in the room.
    expect(view.contents.map((c) => c.id)).not.toContain("coin");
  });

  it("reports which exits are blocked and where they lead", () => {
    const run = freshRun();
    const view = roomView(run, dungeon)!;
    for (const exit of view.exits) {
      expect(exit.blocked).toBe(exit.requirement !== undefined);
      expect(run.entities.rooms.some((r) => r.id === exit.toRoomId)).toBe(true);
      // Nothing is known at the start of a run.
      expect(exit.toKnown).toBe(false);
    }
  });

  it("conceals what is inside a concealed thing, whoever marked it", () => {
    const run = freshRun();
    const room = run.entities.rooms[0].id;
    run.entities.features.push({
      id: "drawer", name: "False-backed drawer", type: "RoomFeature",
      base: "a drawer with a shallow back", roomId: room, isHidden: true,
    });
    run.entities.items.push({
      // Nobody marked the coin — it is unseen because the drawer is.
      id: "coin", name: "Coin", type: "Item", base: "a copper penny", parentId: "drawer", slots: 1,
    });

    const shown = roomView(run, dungeon, room)!;
    expect(shown.contents.flatMap((c) => c.contains).map((c) => c.id)).not.toContain("coin");
    expect(roomView(run, dungeon, room, { includeHidden: true })!.contents.map((c) => c.id)).toContain("drawer");
  });

  it("keeps a concealed way out of the exit list", () => {
    const run = freshRun();
    const room = run.currentRoomId;
    const exit = run.entities.connectors.find(
      (c) => (c.endpointA === room || c.endpointB === room) && c.isHidden !== true
    )!;
    const before = roomView(run, dungeon)!.exits.length;

    exit.isHidden = true;
    expect(roomView(run, dungeon)!.exits).toHaveLength(before - 1);
    // The referee still needs to know it is there to be found.
    const all = run.entities.connectors.filter((c) => c.endpointA === room || c.endpointB === room);
    expect(roomView(run, dungeon, room, { includeHidden: true })!.exits).toHaveLength(all.length);
  });

  it("returns undefined for a room that does not exist", () => {
    expect(roomView(freshRun(), dungeon, "nowhere")).toBeUndefined();
  });
});

describe("needsComposition", () => {
  it("wants everything described on a first visit", () => {
    const run = freshRun();
    const stale = needsComposition(run);
    expect(stale.length).toBeGreaterThan(0);
    expect(stale.map((x) => x.id)).toContain(run.currentRoomId);
  });

  it("wants nothing once everything has been described", () => {
    useGame.getState().reset();
    useGame.getState().start(dungeon, testCharacter());
    const room = dungeon.stocked.entranceRoomId;

    const stale = needsComposition(useGame.getState().run!);
    useGame.getState().commit(
      turn(...stale.map((x) => ({ entityId: x.id, path: "composed", value: `${x.name}.` })))
    );

    // A room the player has not disturbed can be re-shown for free.
    expect(needsComposition(useGame.getState().run!, room)).toEqual([]);
  });

  it("stops asking once a thing is concealed, and asks again when it is found", () => {
    useGame.getState().reset();
    useGame.getState().start(dungeon, testCharacter());
    const room = dungeon.stocked.entranceRoomId;
    useGame.setState({
      run: {
        ...useGame.getState().run!,
        entities: {
          ...useGame.getState().run!.entities,
          features: [
            ...useGame.getState().run!.entities.features,
            { id: "secret", name: "False back", type: "RoomFeature", base: "a panel that rings hollow", roomId: room },
          ],
        },
      },
    });

    // Never described, so it owes prose.
    expect(needsComposition(useGame.getState().run!, room).map((x) => x.id)).toContain("secret");

    // The referee settles it as concealed and writes only its state. `composed`
    // is prose for the player, and a concealed thing owes them none — so the
    // debt is settled and it stops being handed to the compose pass.
    useGame.getState().commit(
      turn(
        { entityId: "secret", path: "state", value: "unopened" },
        { entityId: "secret", path: "isHidden", value: true }
      )
    );
    expect(needsComposition(useGame.getState().run!, room).map((x) => x.id)).not.toContain("secret");
    expect(useGame.getState().run!.entities.features.find((f) => f.id === "secret")!.composed).toBeUndefined();

    // Found: the debt reopens, and now there is somebody to read it.
    useGame.getState().commit(turn({ entityId: "secret", path: "isHidden", value: false }));
    expect(needsComposition(useGame.getState().run!, room).map((x) => x.id)).toContain("secret");
  });

  it("wants it again once something in it changes", () => {
    useGame.getState().reset();
    useGame.getState().start(dungeon, testCharacter());
    const room = dungeon.stocked.entranceRoomId;
    const stale = needsComposition(useGame.getState().run!);
    useGame.getState().commit(
      turn(...stale.map((x) => ({ entityId: x.id, path: "composed", value: `${x.name}.` })))
    );

    useGame.getState().commit(turn({ entityId: room, path: "state", value: "ransacked" }));
    expect(needsComposition(useGame.getState().run!, room).map((x) => x.id)).toEqual([room]);
  });
});

// ===========================================================================
// THE CHARACTER PANEL
// ===========================================================================

describe("characterView", () => {
  it("shows every ability as bonus and defense", () => {
    const view = characterView(freshRun());
    expect(view.abilities).toHaveLength(6);
    for (const a of view.abilities) expect(a.defense).toBe(a.bonus + 10);
  });

  it("computes the numbers the player should not have to", () => {
    const view = characterView(freshRun());
    expect(view.armorDefense).toBe(UNARMORED_DEFENSE); // 11 with nothing worn
    expect(view.meleeBonus).toBe(2); // STR
    expect(view.rangedBonus).toBe(1); // WIS
    expect(view.slots.capacity).toBe(12); // CON defense
    expect(view.slots.used).toBe(0);
  });

  it("tracks slots and overburdening as things are picked up", () => {
    const run = freshRun();
    for (let i = 0; i < 13; i++) {
      run.pc.inventory.push({
        id: `rock-${i}`, name: "Rock", type: "Item", base: "a rock", parentId: run.pc.id, slots: 1,
      });
    }
    const view = characterView(run);
    expect(view.slots.used).toBe(13);
    expect(view.slots.overburdened).toBe(true);
  });

  it("reports every equipment slot, filled or not", () => {
    const gambeson: IItem = {
      id: "gambeson", name: "Gambeson", type: "Item", base: "a quilted coat",
      parentId: "pc-1", slots: 1, armor: { armorType: "body", defense: 12 },
    };
    const run = freshRun();
    run.pc.inventory.push(gambeson);
    run.pc.equipped.armor = "gambeson";

    const view = characterView(run);
    expect(view.equipped).toHaveLength(4);
    expect(view.equipped.find((e) => e.slot === "armor")!.item!.name).toBe("Gambeson");
    expect(view.equipped.find((e) => e.slot === "weapon")!.item).toBeUndefined();
    expect(view.armorDefense).toBe(12);
  });

  it("carries conditions through in order", () => {
    const run = freshRun();
    run.pc.conditions.push("poisoned", "leg wound");
    expect(characterView(run).conditions).toEqual(["poisoned", "leg wound"]);
  });
});

// ===========================================================================
// THE MAP
// ===========================================================================

describe("mapView", () => {
  it("starts with everything dark and the player nowhere visible", () => {
    const run = freshRun();
    const view = mapView(run, dungeon);
    expect(view.rooms.every((r) => !r.known)).toBe(true);
    expect(view.rooms.filter((r) => r.current)).toHaveLength(1);
    // An unknown room has no name to give away.
    expect(view.rooms.every((r) => r.name === undefined)).toBe(true);
  });

  it("lights a room once it has been described", () => {
    useGame.getState().reset();
    useGame.getState().start(dungeon, testCharacter());
    const room = dungeon.stocked.entranceRoomId;
    useGame.getState().commit(turn({ entityId: room, path: "composed", value: "A cold room." }));

    const view = mapView(useGame.getState().run!, dungeon);
    const lit = view.rooms.find((r) => r.id === room)!;
    expect(lit.known).toBe(true);
    expect(lit.name).toBeTruthy();
    expect(view.rooms.filter((r) => r.known)).toHaveLength(1);
  });

  it("marks a way out of a known room into an unknown one as an inferred exit", () => {
    useGame.getState().reset();
    useGame.getState().start(dungeon, testCharacter());
    const room = dungeon.stocked.entranceRoomId;
    useGame.getState().commit(turn({ entityId: room, path: "composed", value: "A cold room." }));

    const view = mapView(useGame.getState().run!, dungeon);
    const leadingOut = view.connectors.filter((c) => c.from === room || c.to === room);
    expect(leadingOut.length).toBeGreaterThan(0);
    for (const c of leadingOut) {
      expect(c.known).toBe(true);
      expect(c.toUnknown).toBe(true); // the far side is still dark
    }
    // Everything not touching the entrance is still unknown.
    expect(view.connectors.some((c) => !c.known)).toBe(true);
  });

  it("stays lit when a room changes while the player is elsewhere", () => {
    useGame.getState().reset();
    useGame.getState().start(dungeon, testCharacter());
    const room = dungeon.stocked.entranceRoomId;
    useGame.getState().commit(turn({ entityId: room, path: "composed", value: "A cold room." }));
    // Something happens there after the player has gone.
    useGame.getState().commit(turn({ entityId: room, path: "state", value: "now on fire" }));

    // The whole reason staleness is a flag rather than a cleared description:
    // the room must not blink out of the map.
    const view = mapView(useGame.getState().run!, dungeon);
    expect(view.rooms.find((r) => r.id === room)!.known).toBe(true);
  });

  it("shows what blocks a way through", () => {
    const run = freshRun();
    const blocked = run.entities.connectors.find((c) => c.conditional !== undefined);
    expect(blocked, "the generator should produce at least one gated way").toBeDefined();

    const view = mapView(run, dungeon);
    const c = view.connectors.find((x) => x.id === blocked!.id)!;
    expect(c.blocked).toBe(true);
    expect(c.requirement).toBe(blocked!.conditional);
  });

  it("does not draw a concealed way at all — not even as a stub", () => {
    const run = freshRun();
    // Pick one generation did NOT already conceal.
    const secret = run.entities.connectors.find((c) => c.isHidden !== true)!;
    const before = mapView(run, dungeon).connectors.length;

    secret.isHidden = true;
    const after = mapView(run, dungeon).connectors;
    // Drawing it, even faintly, would tell the player a secret door is there,
    // which is the one thing a secret door must not do.
    expect(after).toHaveLength(before - 1);
    expect(after.map((c) => c.id)).not.toContain(secret.id);

    // It comes straight back once found.
    secret.isHidden = false;
    expect(mapView(run, dungeon).connectors).toHaveLength(before);
  });

  it("can be asked for concealed ways anyway, for debugging", () => {
    const run = freshRun();
    run.entities.connectors.find((c) => c.isHidden !== true)!.isHidden = true;
    const all = mapView(run, dungeon, undefined, { includeHidden: true });
    expect(all.connectors).toHaveLength(run.entities.connectors.length);
  });

  it("accepts a prebuilt layout, so geometry is computed once and not per frame", () => {
    const layout = pointLayout(dungeon.graph);
    const view = mapView(freshRun(), dungeon, layout);
    expect(view.rooms).toHaveLength(layout.rooms.length);
    expect(view.bounds).toEqual(layout.bounds);
  });
});
