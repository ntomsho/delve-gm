/**
 * ROUTING — the graph half of "go back to the Laboratory".
 *
 * The failure this exists to prevent is silent: a referee guessing between two
 * exits and putting the player somewhere they did not choose. So the assertions
 * are about where a walk ENDS, which is the only part the player experiences.
 */

import { describe, expect, it } from "vitest";
import { routeTo } from "./travel.ts";
import type { World } from "./diffs/types.ts";
import type {
  EntityPassResult,
  ICreature,
  IRoom,
  IRoomConnector,
  PlayerCharacter,
} from "../engine/index.ts";

// ===========================================================================
// A CORRIDOR AND A LOOP
// ===========================================================================
//
//   A — B — C — D          the corridor; D is somewhere they have never been
//   └───── E ──┘           a longer way round from A to C
//
// Everything but D is a room they have stood in, which is what makes it
// walkable: a route is retracing steps.

const KNOWN = { composed: "they have stood in it" };

function makeWorld(over: Partial<EntityPassResult> = {}): World {
  const rooms: IRoom[] = [
    { id: "a", name: "Antechamber", type: "Room", base: "", ...KNOWN },
    { id: "b", name: "Gallery", type: "Room", base: "", ...KNOWN },
    { id: "c", name: "Vault", type: "Room", base: "", ...KNOWN },
    { id: "d", name: "Oubliette", type: "Room", base: "" },
    { id: "e", name: "Stair", type: "Room", base: "", ...KNOWN },
  ];

  const link = (id: string, a: string, b: string, over: Partial<IRoomConnector> = {}) =>
    ({ id, name: id, type: "RoomConnector", base: "", endpointA: a, endpointB: b, ...over }) as IRoomConnector;

  const entities = {
    registry: { creatures: {}, hazards: {}, groups: {} },
    rooms,
    connectors: [
      link("ab", "a", "b"),
      link("bc", "b", "c"),
      link("cd", "c", "d"),
      link("ae", "a", "e"),
      link("ec", "e", "c"),
    ],
    creatures: [],
    features: [],
    items: [],
    hazards: [],
    effects: [],
    bindings: [],
    detailCandidates: [],
    pendingGoal: { roomId: "d", reward: "", mission: "", instruction: "" },
    ...over,
  } satisfies EntityPassResult;

  const pc = {
    id: "pc-1", name: "Wren", level: 1,
    hp: { current: 6, max: 6 },
    abilities: { str: 1, dex: 1, con: 1, int: 1, wis: 1, cha: 1 },
    traits: {} as PlayerCharacter["traits"],
    inventory: [], equipped: {}, conditions: [], copper: 0,
  } as unknown as PlayerCharacter;

  return { entities, pc, currentRoomId: "a", goalMet: false };
}

/**
 * The corridor with the loop taken out, so the Gallery is the ONLY way through.
 *
 * The stopper tests need this. With the loop in place a route simply goes round
 * whatever is in the Gallery — which is the right answer, and tested for its own
 * sake below, but it hides what happens when there is no way round.
 */
function corridor(over: Partial<EntityPassResult> = {}): World {
  const w = makeWorld(over);
  w.entities.connectors = w.entities.connectors.filter((c) => c.id !== "ae" && c.id !== "ec");
  return w;
}

/** The corridor, with a hazard in the Gallery in whatever state is asked for. */
function trapped(state: { active?: boolean; sprung?: boolean }): World {
  const w = corridor({
    hazards: [{ id: "gas", name: "Choke-damp", type: "Hazard", base: "", blueprintId: "t", ...state }],
  });
  w.entities.rooms.find((r) => r.id === "b")!.hazardId = "gas";
  return w;
}

const ghoul = (roomId: string): ICreature => ({
  id: `ghoul-${roomId}`, name: "Ghoul", type: "Creature", base: "a lean grey thing",
  roomId,
  stats: { hitDice: 2, hp: 8, modifiers: {} },
  narrative: { blueprintId: "tpl" },
});

// ===========================================================================

describe("routing to a room they have been in", () => {
  it("walks the whole way when nothing is in it", () => {
    const r = routeTo(makeWorld(), "c");
    expect(r.endsAt).toBe("c");
    expect(r.legs.map((l) => l.roomId)).toEqual(["b", "c"]);
    expect(r.stoppedBy).toBeUndefined();
  });

  it("goes nowhere when they are already there", () => {
    const r = routeTo(makeWorld(), "a");
    expect(r).toEqual({ legs: [], endsAt: "a" });
  });

  // The ordinary case: one step into the next room, which is new by definition.
  it("steps into somewhere new that adjoins where they stand", () => {
    const w = makeWorld();
    w.currentRoomId = "c";
    expect(routeTo(w, "d").endsAt).toBe("d");
  });

  // But there is nothing to retrace through unfamiliar ground.
  it("refuses a route that would pass through somewhere they have never been", () => {
    const w = makeWorld();
    delete w.entities.rooms.find((r) => r.id === "b")!.composed;
    delete w.entities.rooms.find((r) => r.id === "e")!.composed;
    expect(routeTo(w, "c").unreachable).toMatch(/only walk where they have already been/);
  });

  it("refuses a room with no way to it at all", () => {
    const w = makeWorld();
    w.entities.connectors = [];
    expect(routeTo(w, "c").unreachable).toBeDefined();
  });

  it("will not route through a way they have not discovered", () => {
    const w = makeWorld();
    for (const c of w.entities.connectors) if (c.id !== "ab") c.isHidden = true;
    expect(routeTo(w, "c").unreachable).toBeDefined();
    expect(routeTo(w, "b").endsAt).toBe("b");
  });
});

// Nothing here has a way round it — see `corridor`.
describe("what ends a walk short", () => {
  it("a creature standing in a room on the way", () => {
    const r = routeTo(corridor({ creatures: [ghoul("b")] }), "c");
    expect(r.endsAt).toBe("b");
    expect(r.stoppedBy).toMatch(/Ghoul is in the way/);
    expect(r.stoppedBy).toContain("Gallery");
  });

  // Arriving is what they asked for. Whatever is waiting there is the arrival
  // pass's business, and stopping them one room short of their own destination
  // would be the walk refusing to finish.
  it("but not a creature in the destination itself", () => {
    const r = routeTo(corridor({ creatures: [ghoul("c")] }), "c");
    expect(r.endsAt).toBe("c");
    expect(r.stoppedBy).toBeUndefined();
  });

  it("a hazard going off", () => {
    const w = trapped({ active: true });
    const r = routeTo(w, "c");
    expect(r.endsAt).toBe("b");
    expect(r.stoppedBy).toMatch(/Choke-damp is going off/);
  });

  // The one that would otherwise go wrong quietly: a route carrying the player
  // over a live trap springs it in silence, in a room they were not looking at.
  it("a trap that has not gone off yet", () => {
    const r = routeTo(trapped({}), "c");
    expect(r.endsAt).toBe("b");
    expect(r.stoppedBy).toMatch(/unsprung/);
  });

  it("but not one already spent", () => {
    expect(routeTo(trapped({ sprung: true }), "c").endsAt).toBe("c");
  });

  it("and one on the way through rather than in a room", () => {
    const w = trapped({ active: true });
    delete w.entities.rooms.find((r) => r.id === "b")!.hazardId;
    w.entities.connectors.find((c) => c.id === "ab")!.hazardId = "gas";

    const r = routeTo(w, "c");
    expect(r.endsAt).toBe("a");
    expect(r.stoppedBy).toMatch(/Choke-damp is going off, in ab/);
  });

  it("a fire filling a room on the way", () => {
    const w = corridor({
      effects: [{ id: "fire", name: "The burning", type: "MobileEffect", base: "", roomIds: ["b"] }],
    });
    expect(routeTo(w, "c").endsAt).toBe("b");
  });

  it("a barred way, leaving them in front of it", () => {
    const w = corridor();
    w.entities.connectors.find((c) => c.id === "ab")!.conditional = "the bar is down";

    const r = routeTo(w, "c");
    expect(r.endsAt).toBe("a");
    expect(r.legs).toEqual([]);
    expect(r.stoppedBy).toMatch(/the bar is down/);
  });
});

describe("choosing between routes", () => {
  it("takes the short way when both are open", () => {
    expect(routeTo(makeWorld(), "c").legs.map((l) => l.roomId)).toEqual(["b", "c"]);
  });

  // A way with something in it is not a way, if there is another. Going round
  // is what a person does, so the route does it rather than stopping at the
  // nearer obstacle — and what counts as an obstacle is the same list the walk
  // itself uses, so the two cannot disagree.
  it("goes the long way round rather than stop at a barrier", () => {
    const w = makeWorld();
    w.entities.connectors.find((c) => c.id === "bc")!.conditional = "vines have sealed it";

    const r = routeTo(w, "c");
    expect(r.endsAt).toBe("c");
    expect(r.legs.map((l) => l.roomId)).toEqual(["e", "c"]);
  });

  it("and round a creature, a fire, or a trap in a room on the short way", () => {
    const around = (over: Partial<EntityPassResult>) =>
      routeTo(makeWorld(over), "c").legs.map((l) => l.roomId);

    expect(around({ creatures: [ghoul("b")] })).toEqual(["e", "c"]);
    expect(
      around({
        effects: [{ id: "fire", name: "The burning", type: "MobileEffect", base: "", roomIds: ["b"] }],
      })
    ).toEqual(["e", "c"]);

    const trap = makeWorld({
      hazards: [{ id: "gas", name: "Choke-damp", type: "Hazard", base: "", blueprintId: "t" }],
    });
    trap.entities.rooms.find((r) => r.id === "b")!.hazardId = "gas";
    expect(routeTo(trap, "c").legs.map((l) => l.roomId)).toEqual(["e", "c"]);
  });

  // Only when every route has something in it does it walk up to the obstacle —
  // so the player ends the turn looking at the thing in their way, rather than
  // being told the room cannot be reached.
  it("walks up to the obstacle when every route has one", () => {
    const w = makeWorld();
    w.entities.connectors.find((c) => c.id === "bc")!.conditional = "vines have sealed it";
    w.entities.connectors.find((c) => c.id === "ec")!.conditional = "the grate is locked";

    const r = routeTo(w, "c");
    expect(r.endsAt).toBe("b");
    expect(r.stoppedBy).toMatch(/vines have sealed it/);
  });
});
