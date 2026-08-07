/**
 * The turn machine, driven against the real store and the real applier.
 *
 * Two kinds of referee here, and the split is deliberate:
 *
 *   a SCRIPTED referee — a queue of replies — for the transitions, because a
 *   transition test should say what the referee answered and nothing else;
 *
 *   the STUB referee, for the branches a player actually reaches, because that
 *   is the thing App.tsx runs and a fixture nobody exercises rots.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTurnMachine, type RefereeReply, type RefereeRequest } from "./turn.ts";
import { generateOffline, testCharacter } from "./__fixtures__/offline.ts";
import { respond, stubReferee } from "./__fixtures__/stub-referee.ts";
import { PLAYER_ID, type Commit, type Diff } from "./diffs/types.ts";
import { farSide, isSurfaceExit, touches } from "../engine/index.ts";
import { useGame } from "../store/game.ts";
import { theRoom } from "../store/selectors.ts";
import { acceptsInput } from "./types.ts";

const SEED = 1005;
const dungeon = generateOffline(SEED, 1);

const state = () => useGame.getState().run!;

function fresh() {
  useGame.getState().reset();
  useGame.getState().start(dungeon, testCharacter());
}

beforeEach(fresh);

// ---------------------------------------------------------------------------
// SCRIPTING
// ---------------------------------------------------------------------------

const say = (narration: string, commit: Commit): RefereeReply => ({ narration, commit });

const open = (diffs: Diff[] = []): Commit => ({
  nextStage: "awaiting_action",
  nextStep: "1-target",
  diffs,
});

/** Describe the room, so an entry can get out of the way. */
const describeRoom = (): Commit =>
  open([
    { entityId: state().currentRoomId, path: "state", value: "as found" },
    { entityId: state().currentRoomId, path: "composed", value: "A room." },
  ]);

interface Script {
  referee: (req: RefereeRequest) => Promise<RefereeReply>;
  calls: RefereeRequest[];
}

/** A queue of replies. Each may be a value or a function of the request. */
function script(...replies: (RefereeReply | ((req: RefereeRequest) => RefereeReply))[]): Script {
  const calls: RefereeRequest[] = [];
  let i = 0;
  return {
    calls,
    referee: async (req) => {
      calls.push(req);
      const next = replies[i++];
      if (!next) throw new Error(`the script ran out after ${i - 1} replies`);
      return typeof next === "function" ? next(req) : next;
    },
  };
}

// ===========================================================================
// STAGE TRANSITIONS
// ===========================================================================

describe("stage transitions", () => {
  it("room_entry -> awaiting_action, and an entry is not a turn", async () => {
    const s = script(say("You are somewhere.", describeRoom()));
    const m = createTurnMachine(s.referee);

    expect(state().stage).toBe("room_entry");
    await m.enterRoom();

    expect(state().stage).toBe("awaiting_action");
    expect(state().step).toBe("1-target");
    expect(s.calls[0].step).toBe("room-entry");
    // The move that caused the entry already ticked the clock; describing where
    // the player landed must not tick it again.
    expect(state().turnCount).toBe(0);
    expect(state().log.at(-1)).toMatchObject({ kind: "arrival", roomId: state().currentRoomId });
  });

  it("awaiting_action -> thinking -> awaiting_action, and the clock ticks once", async () => {
    const s = script(say("You are somewhere.", describeRoom()), say("You do it.", open([
      { entityId: state().currentRoomId, path: "state", value: "kicked" },
    ])));
    const m = createTurnMachine(s.referee);
    await m.enterRoom();

    await m.submit("kick the wall");

    expect(state().stage).toBe("awaiting_action");
    expect(state().turnCount).toBe(1);
    expect(state().turnRecords).toHaveLength(1);
    expect(state().turnRecords[0].action).toBe("kick the wall");
  });

  it("shows `thinking` while the referee is working", async () => {
    let release!: (r: RefereeReply) => void;
    const pending = new Promise<RefereeReply>((r) => { release = r; });

    const m = createTurnMachine(async (req) =>
      req.step === "room-entry" ? say("Here.", describeRoom()) : pending
    );
    await m.enterRoom();

    const inFlight = m.submit("wait for it");
    expect(state().stage).toBe("thinking");
    expect(acceptsInput(state().stage)).toBe(false);

    release(say("Done.", open([{ entityId: state().currentRoomId, path: "state", value: "done" }])));
    await inFlight;
    expect(state().stage).toBe("awaiting_action");
  });

  it("roll_offered -> rolling -> resolving -> awaiting_action", async () => {
    const s = script(
      say("Here.", describeRoom()),
      say("It will come down to the swing.", {
        nextStage: "roll_offered",
        nextStep: "4-confirm-roll",
        rollRequest: {
          kind: "save", ability: "str", bonus: 2, edge: "none",
          description: "Force the grate.", dc: 16,
        },
        diffs: [],
      }),
      (req) =>
        say(`Rolled ${req.roll!.total}.`, open([
          { entityId: state().currentRoomId, path: "state", value: "forced" },
        ]))
    );
    const m = createTurnMachine(s.referee);
    await m.enterRoom();

    await m.submit("force the grate");
    expect(state().stage).toBe("roll_offered");
    expect(state().step).toBe("4-confirm-roll");
    expect(state().pendingRoll?.dc).toBe(16);
    // A roll on the table is not a completed turn.
    expect(state().turnCount).toBe(0);

    await m.roll();
    expect(state().stage).toBe("awaiting_action");
    expect(state().turnCount).toBe(1);
    // The resolution was asked at step 5, with the dice in hand.
    expect(s.calls[2].step).toBe("5-resolution");
    expect(s.calls[2].roll?.spec.dc).toBe(16);
    expect(state().turnRecords[0].roll).toMatchObject({ kind: "save" });
    expect(state().log.some((l) => l.kind === "roll")).toBe(true);
  });

  it("-> dead, whatever the referee thought came next", async () => {
    const s = script(
      say("Here.", describeRoom()),
      // The referee says the floor is open; the hit points say otherwise.
      say("It does not stop.", open([{ entityId: PLAYER_ID, path: "hp.current", value: 0 }]))
    );
    const m = createTurnMachine(s.referee);
    await m.enterRoom();
    await m.submit("drink it");

    expect(state().stage).toBe("dead");
    expect(acceptsInput("dead")).toBe(false);
    expect(state().turnCount).toBe(1);
  });

  it("-> goal_met", async () => {
    const s = script(
      say("Here.", describeRoom()),
      say("You have it.", {
        nextStage: "goal_met",
        nextStep: "5-resolution",
        diffs: [{ entityId: state().currentRoomId, path: "state", value: "left behind" }],
      })
    );
    const m = createTurnMachine(s.referee);
    await m.enterRoom();
    await m.submit("carry it out");

    expect(state().stage).toBe("goal_met");
    expect(state().turnCount).toBe(1);
  });

  it("closes the input while it works and reopens it after", async () => {
    const s = script(say("Here.", describeRoom()));
    const m = createTurnMachine(s.referee);

    // Busy at the start of the run, so typing goes nowhere. The briefing is
    // already on the page — it belongs to no turn and is there from the start.
    await m.submit("too early");
    expect(state().log.map((l) => l.kind)).toEqual(["opening"]);

    await m.enterRoom();
    expect(acceptsInput(state().stage)).toBe(true);
  });
});

// ===========================================================================
// NOTHING CHANGES WHEN NOTHING SHOULD
// ===========================================================================

describe("rejections and clarifications", () => {
  it("clarifying leaves the world alone and the floor open", async () => {
    const s = script(
      say("Here.", describeRoom()),
      say("Which door?", { nextStage: "clarifying", nextStep: "1-target", diffs: [] })
    );
    const m = createTurnMachine(s.referee);
    await m.enterRoom();

    const before = structuredClone(state().entities);
    await m.submit("open the door");

    expect(state().stage).toBe("clarifying");
    expect(acceptsInput("clarifying")).toBe(true);
    expect(state().turnCount).toBe(0);
    expect(state().entities).toEqual(before);
    // The exchange stays open across a clarification — that is the whole point.
    expect(state().transcript.length).toBeGreaterThan(0);
  });

  it("rejected leaves the world alone and does not spend a turn", async () => {
    const s = script(
      say("Here.", describeRoom()),
      say("There is no window.", { nextStage: "rejected", nextStep: "1-target", diffs: [] })
    );
    const m = createTurnMachine(s.referee);
    await m.enterRoom();
    await m.submit("look out the window");

    expect(state().stage).toBe("rejected");
    expect(state().turnCount).toBe(0);
  });

  it("refuses a clarifying reply that carries diffs, and says so twice", async () => {
    const bad = (): RefereeReply =>
      say("Which door?", {
        nextStage: "clarifying",
        nextStep: "1-target",
        diffs: [{ entityId: state().currentRoomId, path: "state", value: "should never land" }],
      });

    const s = script(say("Here.", describeRoom()), bad(), bad());
    const m = createTurnMachine(s.referee);
    await m.enterRoom();

    const before = structuredClone(state().entities);
    await m.submit("open the door");

    expect(state().stage).toBe("error");
    expect(state().entities).toEqual(before);
    expect(state().turnCount).toBe(0);
    // The second ask carried the reasons.
    expect(s.calls[2].rejections?.join(" ")).toContain("must not change the world");
  });

  it("a cancelled roll returns to the floor without spending a turn", async () => {
    const s = script(
      say("Here.", describeRoom()),
      say("The roll is there if you want it.", {
        nextStage: "roll_offered",
        nextStep: "4-confirm-roll",
        rollRequest: { kind: "save", ability: "dex", bonus: 1, edge: "none", description: "Jump it.", dc: 16 },
        diffs: [],
      }),
      say("You think better of it.", open([]))
    );
    const m = createTurnMachine(s.referee);
    await m.enterRoom();
    await m.submit("jump the gap");
    await m.submit("never mind");

    expect(state().stage).toBe("awaiting_action");
    expect(state().pendingRoll).toBeUndefined();
    // Dithering is not a turn.
    expect(state().turnCount).toBe(0);
  });
});

// ===========================================================================
// THE RETRY PATH
// ===========================================================================

describe("a refused commit", () => {
  it("is asked once more, with the reasons, and accepted", async () => {
    const s = script(
      say("Here.", describeRoom()),
      // `name` is never writable.
      say("...", open([{ entityId: state().currentRoomId, path: "name", value: "Elsewhere" }])),
      say("You do it.", open([{ entityId: state().currentRoomId, path: "state", value: "second time" }]))
    );
    const m = createTurnMachine(s.referee);
    await m.enterRoom();
    await m.submit("do the thing");

    expect(state().stage).toBe("awaiting_action");
    expect(state().turnCount).toBe(1);
    expect(s.calls).toHaveLength(3);
    expect(s.calls[2].rejections?.[0]).toContain("name");
    // Only the accepted narration reached the player.
    expect(state().log.some((l) => l.text === "...")).toBe(false);
  });

  it("twice refused lands on error with the world untouched", async () => {
    const bad = () => say("...", open([{ entityId: state().currentRoomId, path: "name", value: "Elsewhere" }]));
    const s = script(say("Here.", describeRoom()), bad(), bad());
    const m = createTurnMachine(s.referee);
    await m.enterRoom();

    const before = structuredClone(state().entities);
    await m.submit("do the thing");

    expect(state().stage).toBe("error");
    expect(state().step).toBe("1-target");
    expect(state().entities).toEqual(before);
    expect(state().turnCount).toBe(0);
    expect(acceptsInput("error")).toBe(true);
  });

  it("a referee that throws lands on error too", async () => {
    const s = script(say("Here.", describeRoom()));
    const m = createTurnMachine(async (req) => {
      if (req.step === "room-entry") return s.referee(req);
      throw new Error("the network is out");
    });
    await m.enterRoom();
    await m.submit("do the thing");

    expect(state().stage).toBe("error");
  });

  it("retry asks the same thing again and can succeed", async () => {
    let fail = true;
    const m = createTurnMachine(async (req) => {
      if (req.step === "room-entry") return say("Here.", describeRoom());
      if (fail) {
        fail = false;
        throw new Error("the network is out");
      }
      return say(`Second time: ${req.input}`, open([
        { entityId: state().currentRoomId, path: "state", value: "retried" },
      ]));
    });

    await m.enterRoom();
    await m.submit("push the statue");
    expect(state().stage).toBe("error");

    await m.retry();
    expect(state().stage).toBe("awaiting_action");
    // The player's words were not lost.
    expect(state().log.some((l) => l.text.includes("push the statue"))).toBe(true);
    expect(state().turnCount).toBe(1);
  });
});

// ===========================================================================
// MOVEMENT
// ===========================================================================

describe("moving between rooms", () => {
  it("a player roomId diff triggers exactly one room entry", async () => {
    const entrance = dungeon.stocked.entranceRoomId;
    const next = dungeon.entities.connectors.find(
      (c) => touches(c, entrance) && !isSurfaceExit(c)
    )!;
    const there = farSide(next, entrance)!;

    const entries: string[] = [];
    const m = createTurnMachine(async (req) => {
      if (req.step === "room-entry") {
        entries.push(req.run.currentRoomId);
        return say("A room.", open([
          { entityId: req.run.currentRoomId, path: "state", value: "as found" },
          { entityId: req.run.currentRoomId, path: "composed", value: "A room." },
        ]));
      }
      return say("You go through.", open([{ entityId: PLAYER_ID, path: "roomId", value: there }]));
    });

    await m.enterRoom();
    expect(entries).toEqual([entrance]);

    await m.submit("go through");

    expect(state().currentRoomId).toBe(there);
    expect(entries).toEqual([entrance, there]);
    expect(state().stage).toBe("awaiting_action");
    // One move, one tick — the entry that followed it does not add a second.
    expect(state().turnCount).toBe(1);
    expect(state().entities.rooms.find((r) => r.id === there)!.composed).toBeDefined();
    expect(state().log.filter((l) => l.kind === "arrival")).toHaveLength(2);
  });

  // A referee resolving a move writes the room beyond out of nothing, and the
  // arrival pass then describes the real one. Two accounts of one place, a
  // moment apart. Discarding the first is the only fix that cannot be ignored.
  it("throws away the moving turn's prose and lets the arrival speak", async () => {
    const entrance = dungeon.stocked.entranceRoomId;
    // Not the surface exit — that ends the run rather than moving them.
    const link = dungeon.entities.connectors.find(
      (c) => touches(c, entrance) && c.conditional === undefined && !isSurfaceExit(c)
    )!;
    const there = farSide(link, entrance)!;

    const m = createTurnMachine(async (req) => {
      if (req.step === "room-entry") {
        return say("You are standing in it.", open([
          { entityId: req.run.currentRoomId, path: "state", value: "as found" },
          { entityId: req.run.currentRoomId, path: "composed", value: "You are standing in it." },
        ]));
      }
      return say(
        "You emerge into a vaulted hall of black stone that nobody handed you.",
        open([{ entityId: PLAYER_ID, path: "roomId", value: there }])
      );
    });

    await m.enterRoom();
    await m.submit("go through");

    const said = state().log.filter((l) => l.kind !== "player").map((l) => l.text);
    expect(said.some((t) => t.includes("nobody handed you"))).toBe(false);
    expect(said.filter((t) => t.includes("standing in it"))).toHaveLength(2);
    // Nor does it survive as the turn's outcome, which is read back as fact.
    // What replaces it names both ends — which is the movement history a
    // referee routing "go back the way I came" needs, and did not have.
    const name = (id: string) =>
      theRoom(state().entities.rooms.find((r) => r.id === id)!.name);
    const record = state().turnRecords.at(-1)!;
    expect(record.outcome).not.toContain("nobody handed you");
    expect(record.outcome).toBe(`They left ${name(entrance)} and are now in ${name(there)}.`);
    expect(entrance).not.toBe(there);
  });

  it("refuses a roomId that does not name a room", async () => {
    const creature = dungeon.entities.creatures[0]!;
    const bad = () => say("...", open([{ entityId: PLAYER_ID, path: "roomId", value: creature.id }]));
    const s = script(say("Here.", describeRoom()), bad(), bad());
    const m = createTurnMachine(s.referee);
    await m.enterRoom();

    const was = state().currentRoomId;
    await m.submit("walk into the ghoul");

    expect(state().stage).toBe("error");
    expect(state().currentRoomId).toBe(was);
  });

  // The failure this whole change is about: a referee guessing between two exits
  // and picking the far one. It is now a rejection with the reason attached, and
  // the one retry §5 allows is enough to walk it back.
  it("refuses a room the current one does not connect to, and recovers on the retry", async () => {
    const entrance = dungeon.stocked.entranceRoomId;
    const near = new Set(
      dungeon.entities.connectors
        .filter((c) => touches(c, entrance))
        .flatMap((c) => [c.endpointA, c.endpointB])
    );
    const far = dungeon.entities.rooms.find((r) => !near.has(r.id))!;

    let reasons: string[] | undefined;
    const m = createTurnMachine(async (req) => {
      if (req.step === "room-entry") return say("Here.", describeRoom());
      reasons = req.rejections;
      return req.rejections
        ? say("Never mind.", { nextStage: "awaiting_action", nextStep: "1-target", diffs: [] })
        : say("Off you go.", open([{ entityId: PLAYER_ID, path: "roomId", value: far.id }]));
    });

    await m.enterRoom();
    await m.submit("go to the vault");

    expect(reasons?.join(" ")).toMatch(/no way leads/);
    expect(state().currentRoomId).toBe(entrance);
    expect(state().stage).toBe("awaiting_action");
  });

  // The way OUT is a connector like any other, and a route that took it would
  // end the run on the way to somewhere else.
  it("never routes a walk through the way out of the dungeon", async () => {
    const entrance = dungeon.stocked.entranceRoomId;
    const out = dungeon.entities.connectors.filter(isSurfaceExit);
    expect(out).toHaveLength(1);
    expect(out[0].endpointA).toBe(entrance);

    const m = createTurnMachine(async (req) =>
      req.step === "room-entry" ? say("Here.", describeRoom()) : say("...", open())
    );
    await m.enterRoom();

    // Nothing on the far side to walk to, so nothing can route through it.
    expect(state().currentRoomId).toBe(entrance);
    expect(state().stage).toBe("awaiting_action");
  });
});

// ===========================================================================
// LEAVING
// ===========================================================================

describe("walking out of the dungeon", () => {
  const leave = (goalMet?: boolean): Commit => ({
    nextStage: "departed",
    nextStep: "5-resolution",
    diffs: [],
    ...(goalMet ? { goalMet } : {}),
  });

  it("without the goal is an escape, and ends the run", async () => {
    const s = script(say("Here.", describeRoom()), say("You climb out.", leave()));
    const m = createTurnMachine(s.referee);
    await m.enterRoom();
    await m.submit("climb out");

    expect(state().stage).toBe("escaped");
    expect(acceptsInput(state().stage)).toBe(false);
  });

  it("with it is the win", async () => {
    const s = script(say("Here.", describeRoom()), say("You climb out.", leave(true)));
    const m = createTurnMachine(s.referee);
    await m.enterRoom();
    await m.submit("climb out");

    expect(state().stage).toBe("goal_met");
  });

  // The goal LATCHES. It is set on the turn it happens, which may be twenty
  // turns before the player reaches the surface, and a referee that stops
  // mentioning it cannot take the win back.
  it("counts a goal met turns earlier, without it being said again", async () => {
    const s = script(
      say("Here.", describeRoom()),
      say("You lift it from the dais.", { ...open(), goalMet: true }),
      say("You walk.", open()),
      say("You climb out.", leave())
    );
    const m = createTurnMachine(s.referee);
    await m.enterRoom();

    await m.submit("take the idol");
    expect(state().goalMet).toBe(true);
    expect(state().stage).toBe("awaiting_action"); // holding it is not winning

    await m.submit("catch your breath");
    await m.submit("climb out");
    expect(state().stage).toBe("goal_met");
  });

  it("is refused from a room with no way to the surface", async () => {
    const entrance = dungeon.stocked.entranceRoomId;
    // Move them off the entrance first, then try to leave from where they land.
    const link = dungeon.entities.connectors.find(
      (c) => touches(c, entrance) && c.conditional === undefined && !isSurfaceExit(c)
    )!;
    const there = farSide(link, entrance)!;

    let reasons: string[] | undefined;
    const m = createTurnMachine(async (req) => {
      if (req.step === "room-entry") return say("Here.", describeRoom());
      if (req.run.currentRoomId === entrance) {
        return say("You go through.", open([{ entityId: PLAYER_ID, path: "roomId", value: there }]));
      }
      reasons = req.rejections;
      return req.rejections ? say("You cannot.", open()) : say("You climb out.", leave());
    });

    await m.enterRoom();
    await m.submit("go through");
    expect(state().currentRoomId).toBe(there);

    await m.submit("climb out");
    expect(reasons?.join(" ")).toMatch(/no way to the surface/);
    expect(state().stage).toBe("awaiting_action");
  });
});

// ===========================================================================
// THE LOG AND THE TRANSCRIPT
// ===========================================================================

describe("the scrollback and the exchange", () => {
  // It was written during generation, belongs to no turn, and so nothing in the
  // turn machine would ever push it — which is how it came to reach the journal
  // file and never the player, who arrived in the first room with no idea what
  // they were doing there.
  it("opens on the briefing, above the first room", async () => {
    const m = createTurnMachine(script(say("Here.", describeRoom())).referee);

    expect(state().log[0]).toMatchObject({
      kind: "opening",
      text: dungeon.pass.openingProse,
      turn: 0,
    });

    await m.enterRoom();
    // Still first, and the arrival lands under it rather than over it.
    expect(state().log.map((l) => l.kind)).toEqual(["opening", "arrival"]);
  });

  it("keeps the log across a closed turn while the transcript clears", async () => {
    const s = script(
      say("Here.", describeRoom()),
      say("Which door?", { nextStage: "clarifying", nextStep: "1-target", diffs: [] }),
      say("You open it.", open([{ entityId: state().currentRoomId, path: "state", value: "opened" }]))
    );
    const m = createTurnMachine(s.referee);
    await m.enterRoom();

    await m.submit("open the door");
    const midway = state().transcript.length;
    expect(midway).toBeGreaterThan(1); // the entry, the player, the question

    await m.submit("the west one");

    // The exchange the referee is shown is thrown away with the turn...
    expect(state().transcript).toHaveLength(0);
    // ...and the page the player reads is not.
    expect(state().log.map((l) => l.kind)).toEqual([
      "opening", "arrival", "player", "referee", "player", "referee",
    ]);
    expect(state().log.at(-1)!.turn).toBe(1);
  });

  it("stamps each line with the turn it belongs to", async () => {
    const s = script(
      say("Here.", describeRoom()),
      say("One.", open([{ entityId: state().currentRoomId, path: "state", value: "a" }])),
      say("Two.", open([{ entityId: state().currentRoomId, path: "state", value: "b" }]))
    );
    const m = createTurnMachine(s.referee);
    await m.enterRoom();
    await m.submit("first");
    await m.submit("second");

    expect(state().log.filter((l) => l.turn === 1)).toHaveLength(3); // arrival + player + referee
    expect(state().log.filter((l) => l.turn === 2)).toHaveLength(2);
  });
});

// ===========================================================================
// DICE
// ===========================================================================

describe("the dice", () => {
  const offerAndResolve = () =>
    script(
      say("Here.", describeRoom()),
      say("A roll.", {
        nextStage: "roll_offered",
        nextStep: "4-confirm-roll",
        rollRequest: {
          kind: "attack", ability: "str", bonus: 2, edge: "advantage",
          description: "Swing.", dc: 12, damage: "1d8", mode: "damage",
        },
        diffs: [],
      }),
      (req) => say(`t=${req.roll!.total} d=${req.roll!.damage?.total ?? 0}`, open([
        { entityId: state().currentRoomId, path: "state", value: "swung at" },
      ]))
    );

  async function play() {
    fresh();
    const s = offerAndResolve();
    const m = createTurnMachine(s.referee);
    await m.enterRoom();
    await m.submit("attack");
    await m.roll();
    return { s, outcome: s.calls[2].roll! };
  }

  it("draws from the run seed, and the same seed rolls the same dice", async () => {
    const a = await play();
    const b = await play();

    expect(a.outcome.rolled).toEqual(b.outcome.rolled);
    expect(a.outcome.total).toBe(b.outcome.total);
    expect(a.outcome.damage?.total).toBe(b.outcome.damage?.total);
    expect(state().rngDraws).toBeGreaterThan(0);
  });

  it("keeps the better of two under advantage, and only rolls damage on a hit", async () => {
    const { outcome } = await play();

    expect(outcome.rolled).toHaveLength(2);
    expect(outcome.kept).toBe(Math.max(...outcome.rolled));
    expect(outcome.total).toBe(outcome.kept + 2);
    expect(outcome.success).toBe(outcome.total >= 12);
    expect(outcome.damage !== undefined).toBe(outcome.success);
  });

  it("will not roll when there is nothing on the table", async () => {
    const s = script(say("Here.", describeRoom()));
    const m = createTurnMachine(s.referee);
    await m.enterRoom();

    await m.roll();
    expect(state().stage).toBe("awaiting_action");
    expect(state().rngDraws).toBe(0);
  });
});

// ===========================================================================
// THE STUB, END TO END
// ===========================================================================

describe("the stub referee", () => {
  it("plays a run through every branch it offers", async () => {
    const m = createTurnMachine(stubReferee);
    await m.enterRoom();
    expect(state().stage).toBe("awaiting_action");
    expect(state().entities.rooms.find((r) => r.id === state().currentRoomId)!.composed).toBeDefined();

    await m.submit("look out the window");
    expect(state().stage).toBe("rejected");

    await m.submit("open the door");
    expect(state().stage).toBe("clarifying");

    await m.submit("the west one");
    expect(state().stage).toBe("awaiting_action");
    expect(state().turnCount).toBe(1);

    // children[] with a ref, addressed twice in the same commit.
    await m.submit("search the floor");
    expect(state().pc.inventory.some((i) => i.name === "brass key")).toBe(true);
    expect(state().entities.items.some((i) => i.name === "tin box")).toBe(true);

    // A move, and the entry it causes.
    const was = state().currentRoomId;
    await m.submit("go through");
    expect(state().currentRoomId).not.toBe(was);
    expect(state().stage).toBe("awaiting_action");

    await m.submit("drink the poison");
    expect(state().stage).toBe("dead");
  });

  it("offers a roll for an attack and spends the dice on the target", async () => {
    const m = createTurnMachine(stubReferee);
    await m.enterRoom();

    // Stand where something lives.
    const occupied = dungeon.entities.creatures[0]!;
    useGame.setState({ run: { ...state(), currentRoomId: occupied.roomId } });
    await m.enterRoom();

    const before = state().entities.creatures.find((c) => c.id === occupied.id)!.stats.hp;
    await m.submit("attack it");
    expect(state().stage).toBe("roll_offered");
    expect(state().pendingRoll?.targetId).toBeDefined();
    // The bet is shown; the difficulty is carried but never rendered.
    expect(state().pendingRoll?.dc).toBeGreaterThan(0);

    await m.roll();
    expect(state().stage).toBe("awaiting_action");

    const after = state().entities.creatures.find((c) => c.id === occupied.id);
    const rolled = state().log.find((l) => l.kind === "roll")!.text;
    if (rolled.includes("success")) {
      // Slain creatures leave the list entirely.
      expect(after === undefined || after.stats.hp < before).toBe(true);
    } else {
      expect(after!.stats.hp).toBe(before);
    }
  });

  it("reaches error on a commit it cannot make good", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const m = createTurnMachine(stubReferee);
    await m.enterRoom();

    const before = structuredClone(state().entities);
    await m.submit("cheat");

    expect(state().stage).toBe("error");
    expect(state().entities).toEqual(before);
    warn.mockRestore();
  });

  it("answers a room entry with nothing to say when nothing is owed prose", async () => {
    const m = createTurnMachine(stubReferee);
    await m.enterRoom();

    const first = respond({ step: "room-entry", dungeon, run: state() });
    // Everything was described on the way in, so a second look owes no writes.
    expect(first.commit.diffs).toHaveLength(0);
    expect(first.commit.nextStage).toBe("awaiting_action");
  });
});
