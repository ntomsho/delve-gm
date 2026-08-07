/**
 * The model referee, with canned API responses in place of a model.
 *
 * What is worth testing here is the LOOP and its stopping rules — everything
 * that decides how a turn ends when the answer is not the one expected. The
 * prose is the model's business and no test can have an opinion about it.
 *
 * The transport is stubbed at `fetch`, which means the real client, the real
 * schemas and the real tool definitions are all in the path. A canned response
 * that the referee would reject is a canned response the model's would be too.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createModelReferee, postOf } from "./referee.ts";
import { generateOffline, testCharacter } from "./__fixtures__/offline.ts";
import { useGame } from "../store/game.ts";
import { dcFromDefense } from "../engine/index.ts";
import type { RefereeRequest } from "./turn.ts";
import type { Step } from "./types.ts";

const dungeon = generateOffline(1005, 1);

// ---------------------------------------------------------------------------
// A MODEL THAT SAYS WHAT IT IS TOLD TO
// ---------------------------------------------------------------------------

const text = (t: string) => ({ type: "text", text: t });
const use = (id: string, name: string, input: unknown) => ({ type: "tool_use", id, name, input });

const reply = (...content: unknown[]) => ({
  content,
  stop_reason: "tool_use",
  usage: { input_tokens: 100, output_tokens: 40 },
});

const commit = (input: Record<string, unknown>) =>
  use("c1", "commit_state", { nextStage: "awaiting_action", nextStep: "1-target", diffs: [], ...input });

let queue: unknown[] = [];
let sent: Record<string, any>[] = [];

beforeEach(() => {
  queue = [];
  sent = [];
  useGame.getState().reset();
  useGame.getState().start(dungeon, testCharacter());

  vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
    sent.push(JSON.parse(init.body));
    const next = queue.shift();
    // An empty queue is a test that did not expect this call. A 400 surfaces it
    // straight away; a thrown error would be retried three times with backoff.
    if (next === undefined) {
      return { ok: false, status: 400, statusText: "no canned response left", text: async () => "" };
    }
    return { ok: true, json: async () => next };
  });
});

afterEach(() => vi.unstubAllGlobals());

const request = (over: Partial<RefereeRequest> = {}): RefereeRequest => ({
  step: "1-target" as Step,
  dungeon,
  run: useGame.getState().run!,
  ...over,
});

const referee = (maxRounds = 4) => createModelReferee({ maxRounds });

// ---------------------------------------------------------------------------

describe("the post, and the working-out around it", () => {
  it("keeps the reasoning off the screen", () => {
    // The shape observed live: the heuristic worked through in the open, the
    // paragraph at the end. Only the paragraph is the player's.
    const said = `Step 1: the target is the desk.
Step 2: valid, information.

<post>
The desk is oak, and someone has been through the drawers already.
</post>`;

    expect(postOf(said)).toBe("The desk is oak, and someone has been through the drawers already.");
  });

  it("joins a post the referee wrote in pieces", () => {
    expect(postOf("<post>First.</post>\nthinking\n<post>Then this.</post>")).toBe("First.\n\nThen this.");
  });

  it("takes everything after an unclosed tag, rather than nothing", () => {
    // A response cut off at max_tokens still has a post in it.
    expect(postOf("reasoning\n<post>The door gives.")).toBe("The door gives.");
  });

  it("falls through whole when the convention was ignored", () => {
    expect(postOf("The door gives.")).toBe("The door gives.");
  });
});

describe("an ordinary turn", () => {
  it("returns the prose and the commit, in one call", async () => {
    queue.push(
      reply(
        text("Step 1: the door.\n<post>The door gives, and the smell comes out to meet you.</post>"),
        commit({})
      )
    );

    const out = await referee()(request());

    expect(out.narration).toBe("The door gives, and the smell comes out to meet you.");
    expect(out.commit).toEqual({ nextStage: "awaiting_action", nextStep: "1-target", diffs: [] });
    expect(sent).toHaveLength(1);
  });

  it("puts the dice and the commit on the table, and leaves the model free to write", () => {
    queue.push(reply(commit({})));
    return referee()(request()).then(() => {
      expect(sent[0].tools.map((t: { name: string }) => t.name)).toEqual(["roll", "commit_state"]);
      // NOT `any`. Forcing a tool call suppresses the prose, and the prose is
      // what the player is here for — see the note in referee.ts.
      expect(sent[0].tool_choice).toEqual({ type: "auto" });
    });
  });

  it("logs what the call cost, which the turn machine cannot know", async () => {
    queue.push(reply(commit({})));
    await referee()(request());

    const [entry] = useGame.getState().run!.callLog;
    expect(entry.step).toBe("1-target");
    expect(entry.inputTokens).toBe(100);
    expect(entry.outputTokens).toBe(40);
    expect(entry.model).toBeTruthy();
  });

  it("sends the step's own files and no others", async () => {
    queue.push(reply(commit({})));
    await referee()(request({ step: "5-resolution" }));

    // The third block is the step files. SKILL.md names every step in its
    // overview, so the check has to be against that block and not the whole
    // system prompt.
    const steps = sent[0].system[2].text;
    expect(steps).toContain("# Step 5 — Action resolution");
    expect(steps).not.toContain("# Step 1 — Determine the target of the action");
    expect(steps).not.toContain("# Step 4 — Roll confirmation");
  });
});

// ---------------------------------------------------------------------------

describe("walking into a room", () => {
  it("shows the room's own description when the referee wrote no post", async () => {
    // Observed live: a full description written onto the room, and an empty
    // screen. The composed paragraph IS the arrival — see arrival() in
    // referee.ts.
    const here = useGame.getState().run!.currentRoomId;
    queue.push(
      reply(
        commit({
          diffs: [
            { entityId: here, path: "state", value: "as found" },
            { entityId: here, path: "composed", value: "A chasm opens at your feet." },
          ],
        })
      )
    );

    const out = await referee()(request({ step: "room-entry" }));
    expect(out.narration).toBe("A chasm opens at your feet.");
  });

  it("prefers a post the referee actually wrote", async () => {
    const here = useGame.getState().run!.currentRoomId;
    queue.push(
      reply(
        text("<post>You have been here before, and it has not improved.</post>"),
        commit({ diffs: [{ entityId: here, path: "composed", value: "A chasm." }] })
      )
    );

    const out = await referee()(request({ step: "room-entry" }));
    expect(out.narration).toBe("You have been here before, and it has not improved.");
  });

  it("does not read a composed diff as prose on an ordinary turn", async () => {
    const here = useGame.getState().run!.currentRoomId;
    queue.push(reply(commit({ diffs: [{ entityId: here, path: "composed", value: "A chasm." }] })));

    const out = await referee()(request({ step: "1-target" }));
    expect(out.narration).toBe("");
  });
});

describe("the dice", () => {
  it("rolls what was asked for and hands the results back in the same exchange", async () => {
    queue.push(
      reply(use("r1", "roll", { rolls: [{ id: "ghoul", kind: "attack", bonus: 2, targetDefense: 11, damage: "1d6" }] }))
    );
    queue.push(reply(text("It comes at you."), commit({})));

    const out = await referee()(request({ step: "5-resolution" }));

    expect(out.narration).toBe("It comes at you.");
    expect(sent).toHaveLength(2);

    // The second call carries the assistant's own turn back, then the answer.
    const answer = sent[1].messages.at(-1);
    expect(answer.role).toBe("user");
    expect(answer.content[0].tool_use_id).toBe("r1");
    expect(answer.content[0].content).toMatch(/^ghoul: attack — d20/);
  });

  it("draws from the run's stream, and records the draws", async () => {
    queue.push(reply(use("r1", "roll", { rolls: [{ id: "a", kind: "morale" }] })));
    queue.push(reply(commit({})));

    expect(useGame.getState().run!.rngDraws).toBe(0);
    await referee()(request());
    // 2d6, recorded — dice that were rolled but not counted would be rolled
    // again after a reload.
    expect(useGame.getState().run!.rngDraws).toBe(2);
  });

  it("tells the referee when a request could not be rolled", async () => {
    queue.push(reply(use("r1", "roll", { rolls: [{ id: "a", kind: "attack", bonus: 1 }] })));
    queue.push(reply(commit({})));

    await referee()(request());

    const answer = sent[1].messages.at(-1);
    expect(answer.content[0].is_error).toBe(true);
    expect(answer.content[0].content).toContain("targetDefense");
  });
});

// ---------------------------------------------------------------------------

describe("a commit that will not do", () => {
  it("hands back the validation errors and takes the corrected one", async () => {
    queue.push(reply(text("Something happens."), use("c1", "commit_state", { diffs: [] })));
    queue.push(reply(text("Something happens."), commit({})));

    const out = await referee()(request());

    expect(out.commit.nextStage).toBe("awaiting_action");
    const correction = sent[1].messages.at(-1);
    expect(correction.content[0].is_error).toBe(true);
    expect(correction.content[0].content).toContain("nextStage");
  });

  it("refuses a roll_offered with nothing to roll", async () => {
    queue.push(reply(commit({ nextStage: "roll_offered", nextStep: "4-confirm-roll" })));
    queue.push(
      reply(
        commit({
          nextStage: "roll_offered",
          nextStep: "4-confirm-roll",
          rollRequest: {
            kind: "attack",
            ability: "str",
            bonus: 2,
            edge: "none",
            description: "Strike at it.",
            targetDefense: 12,
          },
        })
      )
    );

    const out = await referee()(request());

    expect(sent[1].messages.at(-1).content[0].content).toContain("nothing to roll");
    // And the defense became a number to meet, exactly once.
    expect(out.commit.rollRequest?.dc).toBe(dcFromDefense(12));
  });

  it("refuses a rollRequest on a stage that is not offering one", async () => {
    queue.push(
      reply(
        commit({
          rollRequest: { kind: "save", ability: "str", bonus: 1, edge: "none", description: "Heave." },
        })
      )
    );
    queue.push(reply(commit({})));

    await referee()(request());
    expect(sent[1].messages.at(-1).content[0].content).toContain("only legal when");
  });

  it("defaults a save with no DC to the ordinary bar", async () => {
    queue.push(
      reply(
        commit({
          nextStage: "roll_offered",
          nextStep: "4-confirm-roll",
          rollRequest: { kind: "save", ability: "dex", bonus: 1, edge: "none", description: "Jump it." },
        })
      )
    );

    const out = await referee()(request());
    expect(out.commit.rollRequest?.dc).toBe(16);
  });
});

// ---------------------------------------------------------------------------

describe("damage nobody rolled for", () => {
  const hurt = (by: number) =>
    commit({ diffs: [{ entityId: "player", path: "hp.current", value: testCharacter().hp.current - by }] });

  it("refuses hit points taken off with no dice behind them", async () => {
    queue.push(reply(text("<post>You slip, and the water takes you.</post>"), hurt(2)));
    queue.push(reply(text("<post>You edge back from the lip.</post>"), commit({})));

    const out = await referee()(request());

    const refusal = sent[1].messages.at(-1).content[0];
    expect(refusal.is_error).toBe(true);
    expect(refusal.content).toContain("no dice were rolled this turn");
    expect(out.commit.diffs).toEqual([]);
  });

  it("allows it once the dice have been thrown", async () => {
    queue.push(reply(use("r1", "roll", { rolls: [{ id: "fall", kind: "damage", expr: "1d6" }] })));
    queue.push(reply(text("<post>You land badly.</post>"), hurt(3)));

    const out = await referee()(request());
    expect(out.commit.diffs).toHaveLength(1);
  });

  it("allows it when the player's own roll is what this turn is resolving", async () => {
    queue.push(reply(text("<post>You land badly.</post>"), hurt(3)));

    const out = await referee()(
      request({
        step: "5-resolution",
        roll: {
          spec: { kind: "save", ability: "dex", bonus: 1, edge: "none", description: "Catch yourself.", dc: 16 },
          rolled: [4],
          kept: 4,
          total: 5,
          success: false,
          nat20: false,
          nat1: false,
          crit: { defenderArmor: false, attackerWeapon: false },
        },
      })
    );
    expect(out.commit.diffs).toHaveLength(1);
  });

  it("leaves healing alone — a written salve restores what it says it does", async () => {
    queue.push(
      reply(commit({ diffs: [{ entityId: "player", path: "hp.current", value: testCharacter().hp.max }] }))
    );

    const out = await referee()(request());
    expect(out.commit.diffs).toHaveLength(1);
    expect(sent).toHaveLength(1);
  });
});

describe("a referee that will not stop", () => {
  const rolling = () => reply(use("r1", "roll", { rolls: [{ id: "a", kind: "morale" }] }));

  it("takes the dice away and forces the commit on the last round", async () => {
    queue.push(rolling(), rolling(), rolling());
    queue.push(reply(commit({})));

    await referee(4)(request());

    expect(sent).toHaveLength(4);
    expect(sent[3].tools.map((t: { name: string }) => t.name)).toEqual(["commit_state"]);
    expect(sent[3].tool_choice).toEqual({ type: "tool", name: "commit_state" });
  });

  it("gives up rather than looping, and says so", async () => {
    queue.push(rolling(), rolling(), rolling(), rolling());

    await expect(referee(4)(request())).rejects.toThrow(/did not commit within 4/);
  });

  it("asks again when a turn ends on prose alone", async () => {
    queue.push({ content: [text("I think I will stop here.")], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } });
    queue.push(reply(commit({})));

    await referee()(request());

    expect(sent[1].messages.at(-1).content).toContain("without calling `commit_state`");
  });

  // OBSERVED LIVE: the referee wrote its post, forgot the tool, was nudged, and
  // wrote the same post again alongside the call. Both rounds were accumulated
  // and the player read the paragraph twice, back to back.
  it("does not say it twice when a nudge makes the referee write it again", async () => {
    const post = "<post>You take a breath and step into the corridor.</post>";
    queue.push({ content: [text(post)], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } });
    queue.push(reply(text(`You are right, I did not commit.\n${post}`), commit({})));

    const { narration } = await referee()(request());

    expect(narration).toBe("You take a breath and step into the corridor.");
  });

  // The other half of the same problem: a redo that answers with an apology and
  // no post at all must not wipe out the post it is redoing.
  it("keeps the post when the referee answers a nudge with an apology", async () => {
    queue.push({
      content: [text("<post>The door gives.</post>")],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    queue.push(reply(text("You're right. Let me commit properly:"), commit({})));

    expect((await referee()(request())).narration).toBe("The door gives.");
  });

  // Same rule for a commit the referee refuses before the applier sees it: the
  // round is being redone, not continued.
  it("replaces rather than repeats when a refused commit is rewritten", async () => {
    const post = "<post>The ghoul reels back.</post>";
    queue.push(reply(text(post), commit({ nextStage: "roll_offered" })));
    queue.push(reply(text(post), commit({})));

    expect((await referee()(request())).narration).toBe("The ghoul reels back.");
  });

  // But dice genuinely continue a turn: the approach, then the outcome. Two
  // posts, both owed to the player, in the order they were written.
  it("keeps both posts when dice came between them", async () => {
    queue.push(
      reply(
        text("<post>You swing.</post>"),
        use("r1", "roll", { rolls: [{ id: "a", kind: "morale", rating: 7 }] })
      )
    );
    queue.push(reply(text("<post>It breaks and runs.</post>"), commit({})));

    expect((await referee()(request())).narration).toBe("You swing.\n\nIt breaks and runs.");
  });
});

// ---------------------------------------------------------------------------

describe("what the model is shown", () => {
  it("carries the world, the exchange, and the instruction, in that order", async () => {
    useGame.getState().pushTranscript({ role: "player", text: "I open the door" });
    queue.push(reply(commit({})));

    await referee()(request({ input: "I open the door" }));

    const messages = sent[0].messages;
    expect(messages[0].content).toContain("# The world as it stands");
    expect(messages[1].content).toContain("I open the door");
    expect(messages.at(-1).content).toContain("The player has acted");
  });

  it("puts the cache breakpoint after the fiction and before the step", async () => {
    queue.push(reply(commit({})));
    await referee()(request());

    const system = sent[0].system;
    expect(system).toHaveLength(3);
    expect(system[1].cache_control).toEqual({ type: "ephemeral" });
    expect(system[2].cache_control).toBeUndefined();
  });

  it("tells the referee what it got wrong when the applier refused the last one", async () => {
    queue.push(reply(commit({})));
    await referee()(request({ rejections: ["name: that field is never writable"] }));

    expect(sent[0].messages.at(-1).content).toContain("REFUSED");
    expect(sent[0].messages.at(-1).content).toContain("never writable");
  });
});
