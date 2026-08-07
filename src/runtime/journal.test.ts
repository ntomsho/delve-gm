/**
 * The journal, driven by a real turn against the stub referee.
 *
 * Two things worth proving. First that a run produces the events it claims to —
 * a log with a hole in it is worse than no log, because you trust it. Second
 * that with no sink attached, nothing happens at all: every other test in this
 * repo runs without a journal, and journalling must not be something they have
 * to opt out of.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  attach,
  detach,
  log,
  logSystem,
  resetSystemCache,
  runId,
  type JournalEvent,
  type JournalRecord,
} from "./journal.ts";
import { render } from "./journal-render.ts";
import { createTurnMachine } from "./turn.ts";
import { stubReferee } from "./__fixtures__/stub-referee.ts";
import { generateOffline, testCharacter } from "./__fixtures__/offline.ts";
import { useGame } from "../store/game.ts";
import { MODELS } from "./llm/models.ts";

const dungeon = generateOffline(1005, 1);

let written: JournalRecord[];

const kinds = () => written.map((r) => r.kind);
const only = <K extends JournalRecord["kind"]>(kind: K) =>
  written.filter((r): r is Extract<JournalRecord, { kind: K }> => r.kind === kind);

beforeEach(() => {
  written = [];
  resetSystemCache();
  attach({ write: (r) => written.push(r) });
  useGame.getState().reset();
  useGame.getState().start(dungeon, testCharacter());
});

afterEach(detach);

// ---------------------------------------------------------------------------

describe("with no sink", () => {
  it("does nothing at all", () => {
    detach();
    log({ kind: "player", text: "this goes nowhere" });
    expect(written).toHaveLength(0);
  });

  it("does not throw when a sink does", () => {
    attach({
      write() {
        throw new Error("the disk is on fire");
      },
    });
    // A journal that takes the game down with it is worse than no journal.
    expect(() => log({ kind: "player", text: "x" })).not.toThrow();
    expect(() => log({ kind: "player", text: "y" })).not.toThrow();
  });
});

describe("every event", () => {
  it("is numbered in order and stamped", () => {
    log({ kind: "player", text: "one" });
    log({ kind: "player", text: "two" });
    log({ kind: "player", text: "three" });

    expect(written.map((r) => r.seq)).toEqual([1, 2, 3]);
    expect(Date.parse(written[0].at)).not.toBeNaN();
  });

  it("writes the standing instructions once per step, not once per call", () => {
    const blocks = [{ type: "text" as const, text: "the playbook" }];
    logSystem("1-target", blocks);
    logSystem("1-target", blocks);
    logSystem("5-resolution", blocks);

    expect(only("system").map((r) => r.step)).toEqual(["1-target", "5-resolution"]);
  });
});

// ---------------------------------------------------------------------------

describe("a turn, end to end", () => {
  it("records the arrival, the input, the change, and every stage between", async () => {
    const machine = createTurnMachine(stubReferee);

    await machine.enterRoom();
    await machine.submit("I search the floor");

    // The shape of a turn: what the player did, what the referee said, what it
    // changed, and where the game went.
    expect(kinds()).toContain("stage");
    expect(kinds()).toContain("narration");
    expect(kinds()).toContain("player");
    expect(kinds()).toContain("commit");
    expect(kinds()).toContain("turn");

    const arrival = only("narration").find((r) => r.arrival);
    expect(arrival?.roomId).toBe(dungeon.stocked.entranceRoomId);

    // The applier's verdict travels with the commit — a proposed diff and an
    // applied diff look identical, and which happened is the whole question.
    const commit = only("commit").at(-1)!;
    expect(commit.ok).toBe(true);
    expect(commit.commit.diffs.length).toBeGreaterThan(0);

    expect(only("player")[0].text).toBe("I search the floor");
    expect(only("turn")[0].turn).toBe(1);
  });

  it("records a refused commit with the applier's reasons, and the retry", async () => {
    const machine = createTurnMachine(stubReferee);
    await machine.enterRoom();
    // The stub's `cheat` branch writes `name`, which is never writable, and
    // says the same thing again when asked — so the turn ends in `error`.
    await machine.submit("cheat");

    const refused = only("commit").filter((r) => !r.ok);
    expect(refused).toHaveLength(2);
    expect(refused[0].reasons?.join(" ")).toContain("name");
    expect(refused[1].retry).toBe(true);

    expect(only("error")[0].where).toBe("turn:1-target");
    expect(only("stage").at(-1)!.to).toBe("error");
  });

  it("records the player's own roll with the dice and the difficulty", async () => {
    const machine = createTurnMachine(stubReferee);
    await machine.enterRoom();
    // "climb", not "force the door" — the stub checks for a door first and
    // asks which one, which is a clarification and not a roll.
    await machine.submit("I climb the far wall");
    await machine.roll();

    const roll = only("roll").find((r) => r.source === "player");
    expect(roll).toBeDefined();
    if (roll?.source !== "player") throw new Error("unreachable");

    expect(roll.outcome.rolled.length).toBeGreaterThan(0);
    // The difficulty is in the journal even though it is never on the screen —
    // this is the file you read to find out whether the bar was fair.
    expect(roll.outcome.spec.dc).toBeGreaterThan(0);
    expect(roll.draws).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------

describe("the transcript", () => {
  it("renders what a reader wants and drops what only a machine does", () => {
    // `Omit` over a union collapses to its common keys, so the event type is
    // the one to take here.
    const at = (e: JournalEvent) =>
      render({ ...e, seq: 1, at: "2026-08-06T00:00:00.000Z" } as JournalRecord);

    expect(at({ kind: "player", text: "I open the door" })).toContain("> I open the door");
    expect(at({ kind: "narration", text: "It gives.", arrival: false })).toContain("It gives.");

    // Prompts and playbooks are the record's business.
    expect(at({ kind: "prompt", step: "1-target", messages: [] })).toBeUndefined();
    expect(at({ kind: "system", step: "1-target", blocks: [] })).toBeUndefined();
    expect(at({ kind: "generation", pass: "dungeon-pass", prompt: "x", response: {}, usage: { inputTokens: 1, outputTokens: 1 } })).toBeUndefined();
  });

  it("keeps the referee's working-out, folded away", () => {
    const text = render({
      kind: "response",
      step: "1-target",
      round: 1,
      text: "Step 1: the desk.\n<post>The desk is oak.</post>",
      toolUses: [],
      usage: { inputTokens: 1, outputTokens: 1 },
      ms: 10,
      seq: 1,
      at: "2026-08-06T00:00:00.000Z",
    });

    expect(text).toContain("<details>");
    expect(text).toContain("Step 1: the desk.");
    // The post itself is rendered from the narration event, not twice from here.
    expect(text).not.toContain("The desk is oak.");
  });

  it("keeps written prose whole, and clips only values", () => {
    const long = "The water is the first thing — ankle-deep across the floor, so still it mirrors the ceiling. Pale limestone walls rise around you, crusted with mineral deposits that catch what little light filters down from above.";

    const text = render({
      kind: "commit",
      commit: {
        nextStage: "awaiting_action",
        nextStep: "1-target",
        diffs: [
          { entityId: "room-1", path: "composed", value: long },
          { entityId: "stair-1", path: "state", value: long },
          { entityId: "player", path: "hp.current", value: 4 },
        ],
      },
      ok: true,
      seq: 1,
      at: "2026-08-06T00:00:00.000Z",
    })!;

    // Both descriptions survive intact. This file exists to be read, and prose
    // truncated at 120 characters is prose you cannot review.
    expect(text).toContain(long);
    expect(text.split(long)).toHaveLength(3);
    expect(text).not.toContain("…");
    // A number is a number and belongs on one line with the rest.
    expect(text).toContain("player · hp.current = 4");
  });

  it("says plainly when a commit was refused", () => {
    const text = render({
      kind: "commit",
      commit: { nextStage: "awaiting_action", nextStep: "1-target", diffs: [] },
      ok: false,
      reasons: ["name: that field is never writable"],
      seq: 1,
      at: "2026-08-06T00:00:00.000Z",
    });

    expect(text).toContain("Commit refused");
    expect(text).toContain("never writable");
  });

  it("gives the dungeon a section you can read", () => {
    const text = render({ kind: "dungeon", dungeon, seq: 1, at: "2026-08-06T00:00:00.000Z" })!;

    expect(text).toContain(dungeon.pass.name);
    expect(text).toContain("## Rooms");
    for (const room of dungeon.entities.rooms) expect(text).toContain(room.name);
  });
});

describe("the run id", () => {
  it("sorts by time and says which seed it was", () => {
    const id = runId(1005);
    expect(id).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-seed1005$/);
    // It becomes a directory name, so nothing in it may be a path.
    expect(id).not.toMatch(/[/\\:]/);
  });

  it("names every model the run could use", () => {
    const text = render({
      kind: "run",
      runId: "x",
      seed: 1,
      size: 1,
      level: 1,
      offline: false,
      models: MODELS,
      character: testCharacter(),
      seq: 1,
      at: "2026-08-06T00:00:00.000Z",
    })!;

    for (const task of Object.keys(MODELS)) expect(text).toContain(task);
  });
});
