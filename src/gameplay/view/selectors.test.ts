import { describe, expect, it } from "vitest";
import { generateOffline, testCharacter } from "../../fixtures/offline.ts";
import { createGameStore, newRun } from "../state/store.ts";
/** This file's own store — see the note atop `gameplay/state/store.ts`. */
const useGame = createGameStore();

import {
  characterView, censusView, exitLabel, mapView, needsComposition, roomView, UNARMORED_DEFENSE,
} from "./selectors.ts";
import { floorplanLayout, pathMidpoint, pointLayout, shapeCenter } from "../../generation/floorplan/map-layout.ts";
import type { Diff } from "../../shared/types/commit.ts";
import { describeGeometry, siteRooms } from "../../generation/floorplan/geometry.ts";
import { isSurfaceExit, maxHp, setState } from "../../shared/world/entities.ts";
import { positionPhrase, POSITION_WORDS } from "../../generation/floorplan/fixtures.ts";
import type { IArmor, IItem } from "../../shared/world/entities.ts";
import { placedThings } from "../mechanics/occupancy.ts";
import { roomDistances } from "../mechanics/travel.ts";

const SEED = 1005;
const dungeon = generateOffline(SEED, 2);

function freshRun() {
  return newRun(dungeon, testCharacter());
}

/**
 * A character carrying nothing and wearing nothing.
 *
 * The shared `testCharacter()` now arrives armed and armoured, which is right
 * for the fixture — a player with an empty inventory exercises none of the slot
 * or equipment logic. But the three tests below are ABOUT the empty case, and a
 * test whose subject is "unarmoured" should say so rather than inherit it from
 * whatever the fixture happens to be wearing this week.
 */
function barehandedRun() {
  return newRun(dungeon, testCharacter({ inventory: [], equipped: {} }));
}

const turn = (...diffs: Diff[]) =>
  ({ nextStage: "awaiting_action", nextStep: "1-target", timeSpent: "instant", diffs }) as const;

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

  // Every way BETWEEN rooms. A way out of the dungeon has no second point to
  // draw to, and is left to whatever real geometry pass replaces this — §7.
  const interior = dungeon.entities.connectors.filter((c) => !isSurfaceExit(c));

  it("covers every room and connector exactly once", () => {
    expect(layout.rooms).toHaveLength(dungeon.entities.rooms.length);
    expect(new Set(layout.rooms.map((r) => r.id)).size).toBe(layout.rooms.length);
    expect(layout.connectors).toHaveLength(interior.length);
    expect(interior.length).toBeGreaterThan(0);
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

    // The game master must see it, or nothing is findable.
    const gameMaster = roomView(run, dungeon, room, { includeHidden: true })!;
    expect(gameMaster.contents.map((c) => c.id)).toContain("secret");
  });

  it("nests what a thing holds inside it", () => {
    const run = freshRun();
    const room = run.entities.rooms[0].id;
    const chest = { id: "chest", name: "Chest", type: "RoomFeature" as const, base: "a chest", roomId: room };
    const coin: IItem = { id: "coin", name: "Coin", type: "Item", base: "a coin", parentId: "chest", slots: 1, value: 24 };
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
    for (const exit of view.exits.filter((x) => !x.surface)) {
      expect(exit.blocked).toBe(exit.requirement !== undefined);
      expect(run.entities.rooms.some((r) => r.id === exit.toRoomId)).toBe(true);
      // Nothing is known at the start of a run.
      expect(exit.toKnown).toBe(false);
    }
  });

  // The run starts on the entrance room, which is the room with the way out.
  it("marks the way out of the dungeon, which leads to no room at all", () => {
    const run = freshRun();
    const out = roomView(run, dungeon)!.exits.filter((x) => x.surface);

    expect(out).toHaveLength(1);
    expect(out[0].toRoomId).toBeNull();
    // Known from the first turn: they walked in through it.
    expect(out[0].toKnown).toBe(true);
    expect(exitLabel(out[0])).toBe(`${out[0].name} — out of the dungeon`);
  });

  // A connector is one entity read from both ends, so its name says what it is
  // and never where it goes. The destination is joined on per side, and withheld
  // until they have been through — which is also when they can ask for it by name.
  it("names the room a way out leads to, once the player has been there", () => {
    const run = freshRun();
    const view = roomView(run, dungeon)!;
    // Not the way out of the dungeon, which is named from the first turn — see
    // the test above it. The first room's other exits are all unexplored.
    const exit = view.exits.find((x) => !x.surface)!;
    expect(exitLabel(exit)).toBe(exit.name);

    const beyond = run.entities.rooms.find((r) => r.id === exit.toRoomId)!;
    beyond.name = "Kennel";
    beyond.composed = "they have stood in it";
    const known = roomView(run, dungeon)!.exits.find((x) => x.connectorId === exit.connectorId)!;
    expect(exitLabel(known)).toBe(`${exit.name} to the Kennel`);

    // A name that brought its own article does not get a second one.
    beyond.name = "The Long Gallery";
    const titled = roomView(run, dungeon)!.exits.find((x) => x.connectorId === exit.connectorId)!;
    expect(exitLabel(titled)).toBe(`${exit.name} to The Long Gallery`);
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
      id: "coin", name: "Coin", type: "Item", base: "a copper penny", parentId: "drawer", slots: 1, value: 1,
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
    // The game master still needs to know it is there to be found.
    const all = run.entities.connectors.filter((c) => c.endpointA === room || c.endpointB === room);
    expect(roomView(run, dungeon, room, { includeHidden: true })!.exits).toHaveLength(all.length);
  });

  it("returns undefined for a room that does not exist", () => {
    expect(roomView(freshRun(), dungeon, "nowhere")).toBeUndefined();
  });
});

// ===========================================================================
// THE ORDER THE WAYS OUT ARE READ IN
// ===========================================================================

describe("exit order", () => {
  /** The best-connected room, so there is something to put in every band. */
  function busyRoom(run: ReturnType<typeof freshRun>) {
    const ways = (id: string) =>
      run.entities.connectors.filter(
        (c) => (c.endpointA === id || c.endpointB === id) && !isSurfaceExit(c) && c.isHidden !== true
      );
    return run.entities.rooms
      .map((r) => ({ id: r.id, ways: ways(r.id) }))
      .sort((a, b) => b.ways.length - a.ways.length)[0];
  }

  it("puts the way they came in first, then the known, then the unexplored", () => {
    const run = freshRun();
    const busy = busyRoom(run);
    run.currentRoomId = busy.id;
    const room = run.currentRoomId;
    const exits = busy.ways;
    expect(exits.length).toBeGreaterThan(1);

    // Walked in by the last of them, and one of the others goes somewhere they
    // have already stood.
    run.arrivedVia = exits[exits.length - 1].id;
    const known = exits[0];
    const beyond = run.entities.rooms.find(
      (r) => r.id === (known.endpointA === room ? known.endpointB : known.endpointA)
    )!;
    beyond.composed = "they have stood in it";

    const view = roomView(run, dungeon)!;
    expect(view.exits[0].connectorId).toBe(run.arrivedVia);
    expect(view.exits[0].cameFrom).toBe(true);
    expect(view.exits[1].connectorId).toBe(known.id);

    // Everything unexplored is below everything known, and nothing else claims
    // to be the way they came.
    const bands = view.exits.map((e) => (e.cameFrom ? 0 : e.toKnown ? 1 : 2));
    expect(bands).toEqual([...bands].sort());
    expect(view.exits.filter((e) => e.cameFrom)).toHaveLength(1);
  });

  it("holds its order between turns", () => {
    const run = freshRun();
    const first = roomView(run, dungeon)!.exits.map((e) => e.connectorId);
    expect(roomView(run, dungeon)!.exits.map((e) => e.connectorId)).toEqual(first);
  });

  it("marks nothing as the way in when asked about another room", () => {
    // A way they came in by is a fact about where they are standing. Asked about
    // the room next door, the same connector is just a way through.
    const run = freshRun();
    const other = run.entities.rooms.find((r) => r.id !== run.currentRoomId)!;
    const view = roomView(run, dungeon, other.id)!;
    expect(view.exits.every((e) => !e.cameFrom)).toBe(true);
  });

  it("starts a run with the way out of the dungeon behind them", () => {
    // They walked in through it, which is both true and the thing they will want
    // to find again.
    const view = roomView(freshRun(), dungeon)!;
    expect(view.exits[0].surface).toBe(true);
    expect(view.exits[0].cameFrom).toBe(true);
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

    // The game master settles it as concealed and writes only its state. `composed`
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
    const pc = testCharacter({ inventory: [], equipped: {} });
    const view = characterView(newRun(dungeon, pc));

    expect(view.armorDefense).toBe(UNARMORED_DEFENSE); // 11 with nothing worn
    expect(view.meleeBonus).toBe(pc.abilities.str);
    expect(view.rangedBonus).toBe(pc.abilities.wis);
    expect(view.slots.capacity).toBe(pc.abilities.con + 10); // CON defense
    expect(view.slots.used).toBe(0);
  });

  it("tracks slots and overburdening as things are picked up", () => {
    const run = barehandedRun();
    const capacity = characterView(run).slots.capacity;
    for (let i = 0; i < capacity + 1; i++) {
      run.pc.inventory.push({
        id: `rock-${i}`, name: "Rock", type: "Item", base: "a rock", parentId: run.pc.id, slots: 1, value: 0,
      });
    }
    const view = characterView(run);
    expect(view.slots.used).toBe(capacity + 1);
    expect(view.slots.overburdened).toBe(true);
  });

  it("reports every equipment slot, filled or not", () => {
    const gambeson: IArmor = {
      id: "gambeson", name: "Gambeson", type: "Item", base: "a quilted coat",
      parentId: "pc-1", slots: 1, value: 60,
      itemKind: "armor", armor: { armorType: "body", defense: 12 },
    };
    const run = barehandedRun();
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
    expect(all.connectors).toHaveLength(
      run.entities.connectors.filter((c) => !isSurfaceExit(c)).length
    );
  });

  it("accepts a prebuilt layout, so geometry is computed once and not per frame", () => {
    const layout = pointLayout(dungeon.graph);
    const view = mapView(freshRun(), dungeon, layout);
    expect(view.rooms).toHaveLength(layout.rooms.length);
    expect(view.bounds).toEqual(layout.bounds);
  });
});

// ===========================================================================
// THE MAP OVER A FLOORPLAN
// ===========================================================================

describe("mapView over the floorplan", () => {
  const layout = floorplanLayout(dungeon.blockplan!, dungeon.graph);

  it("has a floorplan to draw", () => {
    // The fixture retries the graph until one draws, so this should not be
    // flaky — and if it ever is, everything below is proving nothing.
    expect(dungeon.blockplan).not.toBeNull();
  });

  it("gives every way through a door in a wall", () => {
    const view = mapView(freshRun(), dungeon, layout);
    for (const c of view.connectors) {
      expect(c.door, `${c.name || c.id} has no door`).toBeDefined();
    }
  });

  it("draws the way out of the dungeon, which is on no graph edge", () => {
    // The regression this exists for: the surface connector is minted by the
    // entities pass, not Phase A, so it is absent from `graph.edges` and every
    // door-placing loop walked straight past it.
    const view = mapView(freshRun(), dungeon, layout);
    const out = view.connectors.filter((c) => c.surface);
    expect(out).toHaveLength(1);
    expect(out[0].to).toBeNull();

    const real = dungeon.entities.connectors.find(isSurfaceExit)!;
    expect(out[0].id, "joined to the real connector, not invented").toBe(real.id);
    expect(out[0].from).toBe(dungeon.graph.rooms[dungeon.blockplan!.surface!.room].entityId);
  });

  it("shows the way out exactly when its room is shown", () => {
    // It hangs off one room and reaches into blank paper, so drawing it before
    // that room has been described leaves a stub attached to nothing.
    const run = freshRun();
    const surface = () => mapView(run, dungeon, layout).connectors.find((c) => c.surface)!;
    expect(surface().known, "drawn before its room was").toBe(false);

    const entrance = run.entities.rooms.find((r) => r.id === surface().from)!;
    entrance.composed = "Daylight behind you, and the stair going down.";
    expect(surface().known).toBe(true);
    // Never a stub into the dark: there is no far room to be unexplored.
    expect(surface().toUnknown).toBe(false);
  });

  it("still hides what the player has not seen", () => {
    // Real geometry does not change what fog is for. A room they have not
    // entered is drawn as nothing, and carries neither name nor prose.
    const run = freshRun();
    const view = mapView(run, dungeon, layout);
    const unknown = view.rooms.filter((r) => !r.known);
    expect(unknown.length).toBeGreaterThan(0);
    for (const r of unknown) {
      expect(r.name).toBeUndefined();
      expect(r.composed).toBeUndefined();
    }
  });

  it("carries name and prose for a room the player has read", () => {
    const run = freshRun();
    const here = run.entities.rooms.find((r) => r.id === run.currentRoomId)!;
    here.composed = "A low vaulted cell, the floor gritty underfoot.";
    const shown = mapView(run, dungeon, layout).rooms.find((r) => r.id === here.id)!;
    expect(shown.known).toBe(true);
    expect(shown.name).toBe(here.name);
    expect(shown.composed).toBe(here.composed);
  });
});

// ===========================================================================
// THE DRAWING, AS THE GAME MASTER READS IT
// ===========================================================================
//
// The whole point of 6c: the content pass wrote the room against a description
// of how it was drawn, and the game master has to be reading the SAME description.
// If these two ever diverge the map and the prose start describing different
// rooms, and the player is the only one in a position to notice.

describe("roomView geometry", () => {
  const sited = () => {
    const corridors = new Set(dungeon.stocked.rooms.filter((r) => r.isCorridor).map((r) => r.index));
    return siteRooms(dungeon.blockplan!, dungeon.graph, { isCorridor: (i) => corridors.has(i) });
  };

  it("gives the room the same sentence the content pass was given", () => {
    const run = freshRun();
    const view = roomView(run, dungeon)!;
    expect(view.geometry, "no geometry on a dungeon that drew").toBeDefined();

    // The one carve-out is concealment, below — so this room having no concealed
    // way is what makes the two sentences comparable, and saying so is what
    // stops this test passing for the wrong reason if a seed ever gives it one.
    const here = run.entities.connectors.filter((c) => c.endpointA === view.id || c.endpointB === view.id);
    expect(here.some((c) => c.isHidden === true)).toBe(false);

    // Rebuilt independently here, from the plan, rather than compared against a
    // string literal — a literal would only prove that this test and the code
    // were written on the same afternoon.
    const i = dungeon.graph.rooms.findIndex((r) => r.entityId === view.id);
    expect(view.geometry).toBe(describeGeometry(sited().geometry[i]));
  });

  // 8f. Three sources tell the game master how many ways out a room has and they
  // disagreed: the ways-out list filtered concealed connectors, the geometry
  // sentence counted every one of them, and R2's arrival post duly announced
  // four ways out of a room with three and described the concealed fissure as
  // one of them. The sentence is a count, and a count cannot be half-believed.
  describe("a concealed way out", () => {
    /** The first room in this dungeon that has one, with a run standing in it. */
    const withSecret = () => {
      const run = freshRun();
      const secret = run.entities.connectors.find((c) => c.isHidden === true && !isSurfaceExit(c));
      expect(secret, "no concealed way in this dungeon").toBeDefined();
      run.currentRoomId = secret!.endpointA;
      return { run, secret: secret! };
    };

    it("is not counted in the sentence, for either reader", () => {
      const { run, secret } = withSecret();
      const i = dungeon.graph.rooms.findIndex((r) => r.entityId === run.currentRoomId);
      const unfiltered = describeGeometry(sited().geometry[i]);

      // Both views, and the game master's especially: it is shown the secret way in
      // the list below, where it is marked, and must not meet it again in a
      // sentence that presents it as one more door.
      for (const opts of [{}, { includeHidden: true }]) {
        const view = roomView(run, dungeon, undefined, opts)!;
        expect(view.geometry).not.toBe(unfiltered);
        expect(view.geometry).toBe(describeGeometry(sited().geometry[i], { omit: new Set([secret.id]) }));
      }
    });

    it("comes back into the count the moment the player finds it", () => {
      const { run, secret } = withSecret();
      const hidden = roomView(run, dungeon)!.geometry;
      secret.isHidden = false;
      const found = roomView(run, dungeon)!.geometry;

      expect(found).not.toBe(hidden);
      const i = dungeon.graph.rooms.findIndex((r) => r.entityId === run.currentRoomId);
      expect(found).toBe(describeGeometry(sited().geometry[i]));
    });

    it("is marked on the exit the game master is shown, and absent from the player's", () => {
      const { run, secret } = withSecret();

      const gameMaster = roomView(run, dungeon, undefined, { includeHidden: true })!;
      const shown = gameMaster.exits.find((x) => x.connectorId === secret.id);
      expect(shown?.isHidden).toBe(true);
      // And nothing else in the room is marked by accident.
      expect(gameMaster.exits.filter((x) => x.isHidden)).toHaveLength(1);

      const player = roomView(run, dungeon)!;
      expect(player.exits.find((x) => x.connectorId === secret.id)).toBeUndefined();
    });
  });

  it("tells every way out which wall it is in, the surface exit included", () => {
    // The surface connector is on no graph edge, so it is joined by its missing
    // far end rather than by an id — the join that 6b had to add for the map and
    // that would silently give every OTHER exit a wall while missing this one.
    const view = roomView(freshRun(), dungeon)!;
    expect(view.exits.length).toBeGreaterThan(0);
    for (const x of view.exits) {
      expect(x.wall, `${x.name || x.connectorId} has no wall`).toMatch(
        /^the (north|south|east|west) wall, (at the middle|toward the (north|south|east|west) end)$/
      );
    }
    const out = view.exits.find((x) => x.surface);
    expect(out?.wall, "the way out is the one that is on no edge").toBeDefined();
  });

  it("carries each placed thing's position, and nothing else's", () => {
    const view = roomView(freshRun(), dungeon, undefined, { includeHidden: true })!;
    const placed = view.contents.filter((c) => c.position !== undefined);
    expect(placed.length, "nothing in the entrance room was placed").toBeGreaterThan(0);
    for (const c of placed) expect(POSITION_WORDS).toContain(c.position);
    // A creature has no footprint — nothing tracks where one is standing.
    for (const c of view.contents.filter((x) => x.kind === "Creature")) {
      expect(c.position).toBeUndefined();
    }
  });

  it("says positions as prose, not as enum values", () => {
    // "at throughout" and "at near the entrance" are what a naive prefix gives,
    // and both went into a prompt before this existed.
    expect(positionPhrase("throughout")).toBe("spread through the room");
    expect(positionPhrase("centre")).toBe("in the middle of the room");
    expect(positionPhrase("north wall")).toBe("along the north wall");
    for (const w of POSITION_WORDS) {
      const said = positionPhrase(w);
      expect(said.length, w).toBeGreaterThan(0);
      expect(said, `${w} was rendered as itself`).not.toBe(w);
    }
    // Anything unrecognised falls through rather than throwing: this renders
    // what was stored, and validation happened when it was written.
    expect(positionPhrase("under the stairs")).toBe("under the stairs");
  });
});

// ===========================================================================
// WHAT IS STANDING IN THE ROOMS
// ===========================================================================
//
// THE RULE: an entity appears on the map, and changes on the map, only when its
// `composed` changes. Every test here is a way of getting that wrong, because
// the failure is silent — a dot that should not be there looks exactly like a
// dot that should, and the one it discloses is a secret that cannot be put back.

describe("mapView fixtures", () => {
  /**
   * The layout is pure geometry and carries EVERY placed entity, concealed ones
   * included. That is deliberate — `map-layout.ts` knows nothing about run state —
   * and it is why the filter has to be somewhere, and why it has to be here.
   */
  const layout = floorplanLayout(dungeon.blockplan!, dungeon.graph, {
    placed: placedThings(dungeon.entities),
  });

  /** The room the player starts in, and something the content pass put in it. */
  function somethingHere(run: ReturnType<typeof freshRun>) {
    const here = run.entities.rooms.find((r) => r.id === run.currentRoomId)!;
    const thing = run.entities.features.find((f) => f.roomId === here.id && f.place);
    return { here, thing };
  }

  it("has placed things to draw at all", () => {
    // Without this the whole block asserts nothing, quietly.
    expect(layout.fixtures.length, "the fixture generated no placements").toBeGreaterThan(5);
  });

  it("draws nothing before the player has read anything", () => {
    // A fresh run has composed nothing, so every test below has somewhere to
    // move FROM. If this ever passes vacuously the rest are meaningless.
    expect(mapView(freshRun(), dungeon, layout).fixtures).toHaveLength(0);
  });

  it("draws a thing once its room and it have both been described", () => {
    const run = freshRun();
    const { here, thing } = somethingHere(run);
    expect(thing, "the entrance room holds nothing placed").toBeDefined();

    // The room alone is not enough: the player has stood here, but this
    // particular thing has not been described to them.
    here.composed = "A low vaulted cell.";
    expect(mapView(run, dungeon, layout).fixtures.find((f) => f.id === thing!.id)).toBeUndefined();

    thing!.composed = "A bench of black stone against the far wall.";
    const shown = mapView(run, dungeon, layout).fixtures.find((f) => f.id === thing!.id);
    expect(shown).toBeDefined();
    expect(shown!.name).toBe(thing!.name);
    expect(shown!.composed).toBe(thing!.composed);
    expect(shown!.at.length, "one entry per entity, one point per cell").toBe(
      thing!.place!.cells.length
    );
  });

  it("draws nothing in a room the player has not seen, however well described", () => {
    // The belt to `composed`'s braces. A composition pass that wrote prose for
    // something two rooms away must not put it on the map.
    const run = freshRun();
    const elsewhere = run.entities.features.find(
      (f) => f.place && f.roomId !== run.currentRoomId
    )!;
    elsewhere.composed = "Written up, and nowhere the player has been.";
    expect(mapView(run, dungeon, layout).fixtures.find((f) => f.id === elsewhere.id)).toBeUndefined();
  });

  it("NEVER draws a concealed thing, even one that has been described", () => {
    // The one that cannot be walked back. A dot where a secret is tells the
    // player it is there, which is the whole of what a secret must not do.
    const run = freshRun();
    const { here, thing } = somethingHere(run);
    here.composed = "A low vaulted cell.";
    thing!.composed = "A flagstone worn smoother than its neighbours.";
    thing!.isHidden = true;
    expect(mapView(run, dungeon, layout).fixtures.find((f) => f.id === thing!.id)).toBeUndefined();

    // And back the moment it is found — which `setIsHidden` makes the next
    // composition pass do, so the dot arrives with the prose rather than before.
    thing!.isHidden = false;
    expect(mapView(run, dungeon, layout).fixtures.find((f) => f.id === thing!.id)).toBeDefined();
  });

  it("shows a concealed thing under includeHidden, for the debug tools only", () => {
    const run = freshRun();
    const { here, thing } = somethingHere(run);
    here.composed = "A low vaulted cell.";
    thing!.composed = "A flagstone worn smoother than its neighbours.";
    thing!.isHidden = true;
    const view = mapView(run, dungeon, layout, { includeHidden: true });
    expect(view.fixtures.find((f) => f.id === thing!.id)).toBeDefined();
  });

  it("leaves a marker where it was last seen when state moves and prose does not", () => {
    // The case the rule exists for. Something changes in a room the player is
    // not in: `setState` marks it stale and LEAVES `composed`, so the map goes
    // on saying what they were told rather than what is now true.
    const run = freshRun();
    const { here, thing } = somethingHere(run);
    here.composed = "A low vaulted cell.";
    thing!.composed = "A bench of black stone, unmarked.";

    const before = mapView(run, dungeon, layout).fixtures.find((f) => f.id === thing!.id)!;
    setState(thing!, "Split down the middle, and the halves shoved apart.");

    const after = mapView(run, dungeon, layout).fixtures.find((f) => f.id === thing!.id)!;
    expect(thing!.needUpdate, "the world knows it moved").toBe(true);
    expect(after.composed, "the map does not").toBe(before.composed);
    expect(after.at).toEqual(before.at);
  });

  it("drops an item's marker once it is no longer lying in that room", () => {
    // NOT the entrance room: this seed puts no loose item in it, and an earlier
    // draft of this test looked there and quietly asserted nothing. Any room
    // with a placed item will do, so it takes the first one it finds and says
    // out loud when there is none.
    const run = freshRun();
    const item = run.entities.items.find(
      (i) => i.place && run.entities.rooms.some((r) => r.id === i.parentId)
    );
    expect(item, "the fixture placed no loose item in any room").toBeDefined();

    const room = run.entities.rooms.find((r) => r.id === item!.parentId)!;
    room.composed = "A flooded gallery, the water black and still.";
    item!.composed = "A tin cup, dented, lying on its side.";
    expect(mapView(run, dungeon, layout).fixtures.find((f) => f.id === item!.id)).toBeDefined();

    // Picked up. Every path that moves one today happens with the player
    // watching, so the dot going is what they saw.
    item!.parentId = run.pc.id;
    expect(mapView(run, dungeon, layout).fixtures.find((f) => f.id === item!.id)).toBeUndefined();
  });
});

// ===========================================================================
// EVERY OTHER CREATURE IN THE DUNGEON
// ===========================================================================
//
// The census is what makes the world able to move while the player is elsewhere.
// It is game-master-only, so nothing here is asserted about the screen — what is
// asserted is that it names everything alive that is NOT in front of the player,
// and says how far off it is.

describe("censusView", () => {
  /** A run with a creature stood in a room the player is not in. */
  function stocked() {
    const run = freshRun();
    expect(run.entities.creatures.length, "the fixture stocked no creatures").toBeGreaterThan(0);
    // Somewhere with something in it, and the player nowhere near it.
    run.currentRoomId = dungeon.stocked.entranceRoomId;
    return run;
  }

  it("names every creature the player is not standing with", () => {
    const run = stocked();
    const census = censusView(run);
    const elsewhere = run.entities.creatures.filter((c) => c.roomId !== run.currentRoomId);
    expect(census.map((c) => c.id).sort()).toEqual(elsewhere.map((c) => c.id).sort());
  });

  // The room the player is in is `renderRoom`'s job, in far more detail. Two
  // renderings of one creature is an invitation for the two to disagree.
  it("and leaves out the ones in the room with them", () => {
    const run = stocked();
    run.currentRoomId = run.entities.creatures[0].roomId;
    expect(censusView(run).map((c) => c.id)).not.toContain(run.entities.creatures[0].id);
  });

  it("filters out a group that has been wiped out", () => {
    const run = stocked();
    const doomed = run.entities.creatures.find((c) => c.roomId !== run.currentRoomId)!;
    doomed.count = 0;
    expect(censusView(run).map((c) => c.id)).not.toContain(doomed.id);
  });

  it("counts the rooms between, and agrees with the graph", () => {
    const run = stocked();
    for (const entry of censusView(run)) {
      expect(entry.roomsAway, entry.name).toBe(roomDistances(run, run.currentRoomId).get(entry.roomId));
      expect(entry.roomsAway, entry.name).toBeGreaterThan(0);
    }
  });

  // The departure from `renderRoom`'s ways-out rule, and the point of it: the
  // game master sees the name so it can judge what the character plausibly knows,
  // and sees the mark so it knows the player could not say it.
  it("names an unvisited room and marks it as one", () => {
    const run = stocked();
    const entry = censusView(run)[0];
    expect(entry.roomName).not.toBe("");
    expect(entry.roomVisited).toBe(false);

    run.entities.rooms.find((r) => r.id === entry.roomId)!.composed = "They have stood here.";
    expect(censusView(run)[0].roomVisited).toBe(true);
  });

  it("says WOUNDED rather than hit points, and only when it is hurt", () => {
    const run = stocked();
    const hurt = run.entities.creatures.find((c) => c.roomId !== run.currentRoomId)!;
    expect(censusView(run).find((c) => c.id === hurt.id)!.wounded).toBe(
      hurt.stats.hp < maxHp(hurt.stats)
    );

    hurt.stats.hp = 1;
    expect(censusView(run).find((c) => c.id === hurt.id)!.wounded).toBe(true);
  });

  it("leaves the distance off a room nothing leads to", () => {
    const run = stocked();
    const stranded = run.entities.creatures.find((c) => c.roomId !== run.currentRoomId)!;
    // A room on no graph edge at all — the far side of a connector nobody cut.
    run.entities.rooms.push({ id: "sealed", name: "The Sealed Vault", type: "Room", base: "" });
    stranded.roomId = "sealed";

    const entry = censusView(run).find((c) => c.id === stranded.id)!;
    expect(entry.roomsAway).toBeUndefined();
    expect(entry.roomName).toBe("The Sealed Vault");
  });
});
