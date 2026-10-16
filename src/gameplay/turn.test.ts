/**
 * The turn machine, driven against the real store and the real applier.
 *
 * Two kinds of game master here, and the split is deliberate:
 *
 *   a SCRIPTED game master — a queue of replies — for the transitions, because a
 *   transition test should say what the game master answered and nothing else;
 *
 *   the STUB game master, for the branches a player actually reaches, because that
 *   is the thing App.tsx runs and a fixture nobody exercises rots.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTurnMachine as machineFor, type GameMaster, type GameMasterReply, type GameMasterRequest } from "./turn.ts";
import { generateOffline, testCharacter } from "../fixtures/offline.ts";
import { respond, stubGameMaster } from "../fixtures/stub-game-master.ts";
import { PLAYER_ID, type Commit, type Diff } from "../shared/types/commit.ts";
import { farSide, isSurfaceExit, touches } from "../shared/world/entities.ts";
import { armorDefense as pcArmorDefense } from "../rules/knave/character.ts";
import { createGameStore } from "./state/store.ts";
import { needsComposition, shownRoom, theRoom } from "./view/room.ts";
import { acceptsInput } from "../shared/types/turn.ts";

const SEED = 1005;
const dungeon = generateOffline(SEED, 1);

/**
 * One store for this file, made once rather than imported. Every test below
 * resets it in `beforeEach`, which is what the module singleton used to give
 * them for free — see the note atop `gameplay/state/store.ts` for why it no longer does.
 */
const useGame = createGameStore();

/** The machine under test always drives that store, and is not journalled. */
const createTurnMachine = (gameMaster: GameMaster) => machineFor(gameMaster, { store: useGame });

const state = () => useGame.getState().run!;

function fresh() {
  useGame.getState().reset();
  useGame.getState().start(dungeon, testCharacter());
}

beforeEach(fresh);

// ---------------------------------------------------------------------------
// SCRIPTING
// ---------------------------------------------------------------------------

const say = (narration: string, commit: Commit): GameMasterReply => ({ narration, commit });

const open = (diffs: Diff[] = []): Commit => ({
  nextStage: "awaiting_action",
  timeSpent: "instant",
  nextStep: "1-target",
  diffs,
});

const theRoomNow = () => state().entities.rooms.find((r) => r.id === state().currentRoomId)!;

/** Describe the room, so an entry can get out of the way. */
const describeRoom = (): Commit =>
  open([
    { entityId: state().currentRoomId, path: "state", value: "as found" },
    { entityId: state().currentRoomId, path: "composed", value: "A room." },
  ]);

interface Script {
  gameMaster: (req: GameMasterRequest) => Promise<GameMasterReply>;
  calls: GameMasterRequest[];
}

/** A queue of replies. Each may be a value or a function of the request. */
function script(...replies: (GameMasterReply | ((req: GameMasterRequest) => GameMasterReply))[]): Script {
  const calls: GameMasterRequest[] = [];
  let i = 0;
  return {
    calls,
    gameMaster: async (req) => {
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

/**
 * Compose everything the room currently owes, so that a re-entry into it has
 * nothing left to write. `state` first and `composed` second on purpose:
 * writing `state` opens the description debt and writing `composed` settles
 * it, which is the order a real room-entry commit uses.
 */
const describeAll = (): Commit =>
  open(
    needsComposition(state()).flatMap((e) => [
      { entityId: e.id, path: "state", value: "as found" },
      { entityId: e.id, path: "composed", value: `${e.name}, as described.` },
    ])
  );

// ===========================================================================
// RE-ENTRY IS FREE. 8a A4.
// ===========================================================================

/**
 * A room the player has not affected cannot drift in its retelling, so there
 * is nothing for a model to add and no reason to pay one. The sweep used to
 * run inside `assemble`, after the prompt was built — 5 of 11 arrivals in the
 * 2026-08-10 run were full-price round trips that wrote nothing.
 */
describe("re-entering a room that has not changed", () => {
  it("costs no call at all, and re-shows what they last read", async () => {
    const s = script(say("You are somewhere.", describeAll()));
    const m = createTurnMachine(s.gameMaster);

    await m.enterRoom();
    expect(s.calls).toHaveLength(1);

    await m.enterRoom();

    // The script would have thrown on a second ask; assert it directly, since
    // that is the whole point of the change.
    expect(s.calls).toHaveLength(1);
    expect(state().stage).toBe("awaiting_action");
    expect(state().step).toBe("1-target");

    // And the player is told where they are, in the words they already have.
    const arrivals = state().log.filter((l) => l.kind === "arrival");
    expect(arrivals).toHaveLength(2);
    expect(arrivals[1].text).toBe(theRoomNow().composed);
    expect(shownRoom(state())).toBe(state().currentRoomId);
  });

  it("still costs a call when something in the room has moved on", async () => {
    // The last thing the sweep reports is a content of the room where the room
    // has any, and the room itself where it has none — so this picks the more
    // interesting target without a branch that could quietly pick neither.
    const owed = needsComposition(state());
    expect(owed.length).toBeGreaterThan(0);
    const target = owed.at(-1)!;

    const s = script(
      say("You are somewhere.", describeAll()),
      say("It stirs.", open([{ entityId: target.id, path: "state", value: "changed since" }])),
      say("Here it is again.", describeAll())
    );
    const m = createTurnMachine(s.gameMaster);

    await m.enterRoom();
    await m.submit("watch it");
    // `state` opened a description debt that nothing has settled.
    expect(needsComposition(state()).map((e) => e.id)).toEqual([target.id]);

    await m.enterRoom();
    expect(s.calls).toHaveLength(3);
    expect(s.calls[2].step).toBe("room-entry");
  });

  it("does not skip the first entry, when nothing has been described at all", async () => {
    const s = script(say("You are somewhere.", describeAll()));
    const m = createTurnMachine(s.gameMaster);

    expect(theRoomNow().composed).toBeUndefined();
    await m.enterRoom();
    expect(s.calls).toHaveLength(1);
  });

  // The free path has to leave the game master's next call indistinguishable from
  // the paid one — same log, same exchange, same stage.
  it("puts the re-shown description in the exchange, as a written arrival would", async () => {
    const s = script(say("You are somewhere.", describeAll()));
    const m = createTurnMachine(s.gameMaster);

    await m.enterRoom();
    await m.enterRoom();

    expect(state().transcript.at(-1)).toEqual({
      role: "game-master",
      text: theRoomNow().composed,
    });
  });
});

describe("stage transitions", () => {
  it("room_entry -> awaiting_action, and an entry is not a turn", async () => {
    const s = script(say("You are somewhere.", describeRoom()));
    const m = createTurnMachine(s.gameMaster);

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
    const m = createTurnMachine(s.gameMaster);
    await m.enterRoom();

    await m.submit("kick the wall");

    expect(state().stage).toBe("awaiting_action");
    expect(state().turnCount).toBe(1);
    expect(state().turnRecords).toHaveLength(1);
    expect(state().turnRecords[0].action).toBe("kick the wall");
  });

  it("shows `thinking` while the game master is working", async () => {
    let release!: (r: GameMasterReply) => void;
    const pending = new Promise<GameMasterReply>((r) => { release = r; });

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
        timeSpent: "instant",
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
    const m = createTurnMachine(s.gameMaster);
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

  /*
   * WHAT IT COST THEM, under the prose. A wound in the middle of a sentence is
   * read past; a line in the margin is not.
   */
  it("writes what the turn did to the character after the narration", async () => {
    const s = script(
      say("Here.", describeRoom()),
      say("The ledge gives and you land hard.", open([{ entityId: PLAYER_ID, path: "hp.current", value: 11 }]))
    );
    const m = createTurnMachine(s.gameMaster);
    await m.enterRoom();
    await m.submit("climb the ledge");

    const log = state().log;
    expect(log.at(-2)).toMatchObject({ kind: "game-master" });
    expect(log.at(-1)).toMatchObject({
      kind: "effects",
      effects: [{ kind: "hp", from: 15, to: 11 }],
    });
  });

  it("shows the creature's roll that hurt them, above the prose that tells it", async () => {
    const armor = pcArmorDefense(testCharacter());
    const s = script(say("Here.", describeRoom()), {
      ...say("The ghoul's claws find you.", open([{ entityId: PLAYER_ID, path: "hp.current", value: 10 }])),
      rolls: [
        {
          id: "ghoul-attack", kind: "attack", line: "", failed: false, targetDefense: armor,
          d20: { rolled: [17], kept: 17, bonus: 2, total: 19, success: true, nat20: false, nat1: false },
          damage: { expr: "1d6", rolls: [5], total: 5 },
        },
      ],
    });
    const m = createTurnMachine(s.gameMaster);
    await m.enterRoom();
    await m.submit("stand my ground");

    const kinds = state().log.slice(-3).map((l) => l.kind);
    expect(kinds).toEqual(["foe", "game-master", "effects"]);
    expect(state().log.at(-3)!.foe).toEqual([
      expect.objectContaining({ label: "Ghoul attack", damage: { expr: "1d6", rolls: [5], total: 5 } }),
    ]);
  });

  // The death screen said 'The last thing you tried was "(continued)"': a turn
  // closed by a roll has no input of its own, so it recorded none.
  it("records what they typed as the action of a turn a roll closed", async () => {
    const s = script(
      say("Here.", describeRoom()),
      say("Then heave.", {
        nextStage: "roll_offered",
        timeSpent: "instant",
        nextStep: "4-confirm-roll",
        rollRequest: { kind: "save", ability: "str", bonus: 2, edge: "none", description: "Force the grate.", dc: 16 },
        diffs: [],
      }),
      (req) => say(`Rolled ${req.roll!.total}.`, open([{ entityId: state().currentRoomId, path: "state", value: "forced" }]))
    );
    const m = createTurnMachine(s.gameMaster);
    await m.enterRoom();
    await m.submit("force the grate");
    await m.roll();

    expect(state().turnRecords.at(-1)!.action).toBe("force the grate");
  });

  it("writes nothing extra for a turn that cost nothing", async () => {
    const s = script(say("Here.", describeRoom()), say("Nothing stirs.", open()));
    const m = createTurnMachine(s.gameMaster);
    await m.enterRoom();
    await m.submit("listen");
    expect(state().log.some((l) => l.kind === "effects")).toBe(false);
  });

  /*
   * THE DICE BEFORE THE PROSE. Over the wire the throw and the resolution are
   * two requests, so the player sees the die while the game master writes. The
   * first half must leave everything the second needs in the run itself —
   * the server builds a fresh machine per request.
   */
  describe("a roll in two halves", () => {
    const offer = () =>
      script(
        say("Here.", describeRoom()),
        say("Then heave.", {
          nextStage: "roll_offered",
          timeSpent: "instant",
          nextStep: "4-confirm-roll",
          rollRequest: {
            kind: "save", ability: "str", bonus: 2, edge: "none",
            description: "Force the grate.", dc: 16,
          },
          diffs: [],
        }),
        (req) => say(`Rolled ${req.roll!.total}.`, open())
      );

    it("throws the dice onto the log without asking the game master anything", async () => {
      const s = offer();
      const m = createTurnMachine(s.gameMaster);
      await m.enterRoom();
      await m.submit("force the grate");

      m.throwDice();
      expect(s.calls).toHaveLength(2);
      expect(state().stage).toBe("resolving");
      const logged = state().log.at(-1)!;
      expect(logged.kind).toBe("roll");
      // The die itself, for the screen to draw — the same one in `pending`.
      expect(logged.outcome?.total).toBe(state().pending?.roll?.total);
    });

    it("resolves from what the run kept, in a machine that never saw the throw", async () => {
      const s = offer();
      const first = createTurnMachine(s.gameMaster);
      await first.enterRoom();
      await first.submit("force the grate");
      first.throwDice();
      const thrown = state().pending!.roll!.total;

      // A fresh machine, as the server builds one per request.
      await createTurnMachine(s.gameMaster).resolve();
      expect(s.calls[2].step).toBe("5-resolution");
      expect(s.calls[2].roll!.total).toBe(thrown);
      expect(state().stage).toBe("awaiting_action");
    });

    it("picks up a run left between the two as a retry, with the same dice", async () => {
      const s = offer();
      const m = createTurnMachine(s.gameMaster);
      await m.enterRoom();
      await m.submit("force the grate");
      m.throwDice();
      const thrown = state().pending!.roll!.total;

      await createTurnMachine(s.gameMaster).retry();
      expect(s.calls[2].roll!.total).toBe(thrown);
      expect(state().stage).toBe("awaiting_action");
    });
  });

  // 8a A1, the second half. The roll used to reach the game master through exactly
  // one line of `assemble`, and a retry that did not render that line was a
  // retry with no roll in it. It goes in the exchange as well now, so the
  // number survives however the instruction is built.
  it("puts the roll in the exchange, not only in the scrollback", async () => {
    const s = script(
      say("Here.", describeRoom()),
      say("Then swing.", {
        nextStage: "roll_offered",
        timeSpent: "instant",
        nextStep: "4-confirm-roll",
        rollRequest: {
          kind: "save", ability: "str", bonus: 2, edge: "none",
          description: "Force the grate.", dc: 16,
        },
        diffs: [],
      }),
      (req) => say(`Rolled ${req.roll!.total}.`, open())
    );
    const m = createTurnMachine(s.gameMaster);
    await m.enterRoom();
    await m.submit("force the grate");

    expect(state().transcript.some((e) => e.role === "roll")).toBe(false);
    await m.roll();

    // The game master saw the roll on the request AND in the exchange it was
    // handed — the second is what a rebuilt retry prompt cannot drop.
    const entry = s.calls[2].run.transcript.find((e) => e.role === "roll");
    expect(entry).toBeDefined();
    expect(entry!.text).toContain(`= ${s.calls[2].roll!.total}`);
  });

  it("-> dead, whatever the game master thought came next", async () => {
    const s = script(
      say("Here.", describeRoom()),
      // The game master says the floor is open; the hit points say otherwise.
      say("It does not stop.", open([{ entityId: PLAYER_ID, path: "hp.current", value: 0 }]))
    );
    const m = createTurnMachine(s.gameMaster);
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
        timeSpent: "instant",
        nextStep: "5-resolution",
        diffs: [{ entityId: state().currentRoomId, path: "state", value: "left behind" }],
      })
    );
    const m = createTurnMachine(s.gameMaster);
    await m.enterRoom();
    await m.submit("carry it out");

    expect(state().stage).toBe("goal_met");
    expect(state().turnCount).toBe(1);
  });

  it("closes the input while it works and reopens it after", async () => {
    const s = script(say("Here.", describeRoom()));
    const m = createTurnMachine(s.gameMaster);

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
      say("Which door?", { timeSpent: "instant", nextStage: "clarifying", nextStep: "1-target", diffs: [] })
    );
    const m = createTurnMachine(s.gameMaster);
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
      say("There is no window.", { timeSpent: "instant", nextStage: "rejected", nextStep: "1-target", diffs: [] })
    );
    const m = createTurnMachine(s.gameMaster);
    await m.enterRoom();
    await m.submit("look out the window");

    expect(state().stage).toBe("rejected");
    expect(state().turnCount).toBe(0);
  });

  it("refuses a clarifying reply that carries diffs, and says so twice", async () => {
    const bad = (): GameMasterReply =>
      say("Which door?", {
        nextStage: "clarifying",
        timeSpent: "instant",
        nextStep: "1-target",
        diffs: [{ entityId: state().currentRoomId, path: "state", value: "should never land" }],
      });

    const s = script(say("Here.", describeRoom()), bad(), bad());
    const m = createTurnMachine(s.gameMaster);
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
        timeSpent: "instant",
        nextStep: "4-confirm-roll",
        rollRequest: { kind: "save", ability: "dex", bonus: 1, edge: "none", description: "Jump it.", dc: 16 },
        diffs: [],
      }),
      say("You think better of it.", open([]))
    );
    const m = createTurnMachine(s.gameMaster);
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
    const m = createTurnMachine(s.gameMaster);
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
    const m = createTurnMachine(s.gameMaster);
    await m.enterRoom();

    const before = structuredClone(state().entities);
    await m.submit("do the thing");

    expect(state().stage).toBe("error");
    expect(state().step).toBe("1-target");
    expect(state().entities).toEqual(before);
    expect(state().turnCount).toBe(0);
    expect(acceptsInput("error")).toBe(true);
  });

  it("a game master that throws lands on error too", async () => {
    const s = script(say("Here.", describeRoom()));
    const m = createTurnMachine(async (req) => {
      if (req.step === "room-entry") return s.gameMaster(req);
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

  /**
   * A DIFFERENT MACHINE ANSWERS THE RETRY.
   *
   * This is what the server does on every single request: build a session,
   * `resume` it from the row, act, throw it away. The ask to repeat used to be a
   * closure variable in the machine that failed, so the machine that answered
   * the retry had none and `retry` returned having done nothing — the button
   * bumped the version and nothing else, for the whole of Phase 10 and 11. It is
   * in the run state now, which is the only place that survives the swap.
   */
  it("can be retried by a machine that never made the ask", async () => {
    const failing = createTurnMachine(async (req) => {
      if (req.step === "room-entry") return say("Here.", describeRoom());
      throw new Error("the network is out");
    });

    await failing.enterRoom();
    await failing.submit("push the statue");
    expect(state().stage).toBe("error");
    expect(state().pending).toMatchObject({ input: "push the statue", entering: false });

    // The row, as the server would have stored and re-read it.
    const stored = structuredClone(state());
    useGame.setState({ run: stored, lastEvents: [] });

    const reborn = createTurnMachine(async (req) =>
      say(`Second time: ${req.input}`, open([
        { entityId: state().currentRoomId, path: "state", value: "retried" },
      ]))
    );
    await reborn.retry();

    expect(state().stage).toBe("awaiting_action");
    expect(state().log.some((l) => l.text === "Second time: push the statue")).toBe(true);
    // And the ask it repeated is not left lying around to be repeated again.
    expect(state().pending).toBeUndefined();
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

  // A game master resolving a move writes the room beyond out of nothing, and the
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
    // game master routing "go back the way I came" needs, and did not have.
    const name = (id: string) =>
      theRoom(state().entities.rooms.find((r) => r.id === id)!.name);
    const record = state().turnRecords.at(-1)!;
    expect(record.outcome).not.toContain("nobody handed you");
    expect(record.outcome).toBe(`They left ${name(entrance)} and are now in ${name(there)}.`);
    expect(entrance).not.toBe(there);
  });

  // The panel is not allowed to arrive before the prose does. Between the move
  // applying and the entry pass finishing, the player is standing somewhere they
  // have been told nothing about, and listing its contents would be the interface
  // spoiling the paragraph that is still being written.
  it("holds the panel on the last room the player has read", async () => {
    const entrance = dungeon.stocked.entranceRoomId;
    const link = dungeon.entities.connectors.find(
      (c) => touches(c, entrance) && c.conditional === undefined && !isSurfaceExit(c)
    )!;
    const there = farSide(link, entrance)!;

    const seen: (string | undefined)[] = [];
    const m = createTurnMachine(async (req) => {
      if (req.step === "room-entry") {
        // Mid-entry: standing in the new room, still showing the old one.
        seen.push(shownRoom(state()));
        return say("A room.", open([
          { entityId: req.run.currentRoomId, path: "state", value: "as found" },
          { entityId: req.run.currentRoomId, path: "composed", value: "A room." },
        ]));
      }
      return say("You go through.", open([{ entityId: PLAYER_ID, path: "roomId", value: there }]));
    });

    // Nothing has been read at all yet, so nothing is shown.
    expect(shownRoom(state())).toBeUndefined();
    await m.enterRoom();
    expect(shownRoom(state())).toBe(entrance);

    await m.submit("go through");
    expect(state().currentRoomId).toBe(there);
    expect(shownRoom(state())).toBe(there);
    // While each entry was being written: nothing, then the room they came from.
    expect(seen).toEqual([undefined, entrance]);
  });

  // A room they have already been told about owes them no new prose, so the
  // entry pass writes none — and the panel still has to catch up.
  it("catches the panel up even when the arrival says nothing", async () => {
    const entrance = dungeon.stocked.entranceRoomId;
    const link = dungeon.entities.connectors.find(
      (c) => touches(c, entrance) && c.conditional === undefined && !isSurfaceExit(c)
    )!;
    const there = farSide(link, entrance)!;

    const m = createTurnMachine(async (req) => {
      if (req.step === "room-entry") {
        return req.run.currentRoomId === entrance
          ? say("Here.", describeRoom())
          : say("", { timeSpent: "instant", nextStage: "awaiting_action", nextStep: "1-target", diffs: [] });
      }
      return say("You go through.", open([{ entityId: PLAYER_ID, path: "roomId", value: there }]));
    });

    await m.enterRoom();
    await m.submit("go through");

    expect(state().log.filter((l) => l.kind === "arrival")).toHaveLength(1);
    expect(shownRoom(state())).toBe(there);
  });

  it("refuses a roomId that does not name a room", async () => {
    const creature = dungeon.entities.creatures[0]!;
    const bad = () => say("...", open([{ entityId: PLAYER_ID, path: "roomId", value: creature.id }]));
    const s = script(say("Here.", describeRoom()), bad(), bad());
    const m = createTurnMachine(s.gameMaster);
    await m.enterRoom();

    const was = state().currentRoomId;
    await m.submit("walk into the ghoul");

    expect(state().stage).toBe("error");
    expect(state().currentRoomId).toBe(was);
  });

  // The failure this whole change is about: a game master guessing between two exits
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
        ? say("Never mind.", { timeSpent: "instant", nextStage: "awaiting_action", nextStep: "1-target", diffs: [] })
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
    timeSpent: "instant",
    nextStep: "5-resolution",
    diffs: [],
    ...(goalMet ? { goalMet } : {}),
  });

  it("without the goal is an escape, and ends the run", async () => {
    const s = script(say("Here.", describeRoom()), say("You climb out.", leave()));
    const m = createTurnMachine(s.gameMaster);
    await m.enterRoom();
    await m.submit("climb out");

    expect(state().stage).toBe("escaped");
    expect(acceptsInput(state().stage)).toBe(false);
  });

  it("with it is the win", async () => {
    const s = script(say("Here.", describeRoom()), say("You climb out.", leave(true)));
    const m = createTurnMachine(s.gameMaster);
    await m.enterRoom();
    await m.submit("climb out");

    expect(state().stage).toBe("goal_met");
  });

  // The goal LATCHES. It is set on the turn it happens, which may be twenty
  // turns before the player reaches the surface, and a game master that stops
  // mentioning it cannot take the win back.
  it("counts a goal met turns earlier, without it being said again", async () => {
    const s = script(
      say("Here.", describeRoom()),
      say("You lift it from the dais.", { ...open(), goalMet: true }),
      say("You walk.", open()),
      say("You climb out.", leave())
    );
    const m = createTurnMachine(s.gameMaster);
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
    const m = createTurnMachine(script(say("Here.", describeRoom())).gameMaster);

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
      say("Which door?", { timeSpent: "instant", nextStage: "clarifying", nextStep: "1-target", diffs: [] }),
      say("You open it.", open([{ entityId: state().currentRoomId, path: "state", value: "opened" }]))
    );
    const m = createTurnMachine(s.gameMaster);
    await m.enterRoom();

    await m.submit("open the door");
    const midway = state().transcript.length;
    expect(midway).toBeGreaterThan(1); // the entry, the player, the question

    await m.submit("the west one");

    // The exchange the game master is shown is thrown away with the turn...
    expect(state().transcript).toHaveLength(0);
    // ...and the page the player reads is not.
    expect(state().log.map((l) => l.kind)).toEqual([
      "opening", "arrival", "player", "game-master", "player", "game-master",
    ]);
    expect(state().log.at(-1)!.turn).toBe(1);
  });

  it("stamps each line with the turn it belongs to", async () => {
    const s = script(
      say("Here.", describeRoom()),
      say("One.", open([{ entityId: state().currentRoomId, path: "state", value: "a" }])),
      say("Two.", open([{ entityId: state().currentRoomId, path: "state", value: "b" }]))
    );
    const m = createTurnMachine(s.gameMaster);
    await m.enterRoom();
    await m.submit("first");
    await m.submit("second");

    expect(state().log.filter((l) => l.turn === 1)).toHaveLength(3); // arrival + player + game master
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
        timeSpent: "instant",
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
    const m = createTurnMachine(s.gameMaster);
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
    const m = createTurnMachine(s.gameMaster);
    await m.enterRoom();

    await m.roll();
    expect(state().stage).toBe("awaiting_action");
    expect(state().rngDraws).toBe(0);
  });
});

// ===========================================================================
// THE STUB, END TO END
// ===========================================================================

describe("the stub game master", () => {
  it("plays a run through every branch it offers", async () => {
    const m = createTurnMachine(stubGameMaster);
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

    // children[] with a ref, addressed twice in the same commit. The stub asks
    // for "brass key" and gets "Brass key" — a name is capitalised at the mint
    // (8f), and this is the whole of what the game master sees of that rule.
    await m.submit("search the floor");
    expect(state().pc.inventory.some((i) => i.name === "Brass key")).toBe(true);
    expect(state().entities.items.some((i) => i.name === "Tin box")).toBe(true);

    // A move, and the entry it causes.
    const was = state().currentRoomId;
    await m.submit("go through");
    expect(state().currentRoomId).not.toBe(was);
    expect(state().stage).toBe("awaiting_action");

    await m.submit("drink the poison");
    expect(state().stage).toBe("dead");
  });

  it("offers a roll for an attack and spends the dice on the target", async () => {
    const m = createTurnMachine(stubGameMaster);
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
    const m = createTurnMachine(stubGameMaster);
    await m.enterRoom();

    const before = structuredClone(state().entities);
    await m.submit("cheat");

    expect(state().stage).toBe("error");
    expect(state().entities).toEqual(before);
    warn.mockRestore();
  });

  it("answers a room entry with nothing to say when nothing is owed prose", async () => {
    const m = createTurnMachine(stubGameMaster);
    await m.enterRoom();

    const first = respond({ step: "room-entry", dungeon, run: state() });
    // Everything was described on the way in, so a second look owes no writes.
    expect(first.commit.diffs).toHaveLength(0);
    expect(first.commit.nextStage).toBe("awaiting_action");
  });
});
