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
import { createModelReferee } from "./game-master.ts";
import { generateOffline, testCharacter } from "../../fixtures/offline.ts";
import { createGameStore } from "../state/store.ts";
import { dcFromDefense } from "../../rules/knave/rolls.ts";
import { armorDefense as pcArmorDefense } from "../../rules/knave/character.ts";
import type { RefereeRequest } from "../turn.ts";
import type { Step } from "../../shared/types/turn.ts";

const dungeon = generateOffline(1005, 1);

/** This file's own store — see the note atop `gameplay/state/store.ts`. */
const useGame = createGameStore();

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

/**
 * A commit, with a post on it unless the test is about not having one.
 *
 * The post is a FIELD now (§8a A9), so an ordinary commit carrying none is the
 * unusual case rather than the default — and a referee that writes one is what
 * these tests are mostly standing in for. Pass `post: null` to build the
 * blank-screen case on purpose — the key is required, so null is how a
 * referee says it wrote none.
 */
const commit = (input: Record<string, unknown>) =>
  use("c1", "commit_state", {
    post: "The turn passes.",
    nextStage: "awaiting_action",
    nextStep: "1-target",
    timeSpent: "instant",
    diffs: [],
    ...input,
  });

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

const referee = (maxRounds = 4) => createModelReferee({ store: useGame, maxRounds });

// ---------------------------------------------------------------------------

/*
 * THE POST IS A FIELD OF THE COMMIT (§8a A9).
 *
 * It was loose assistant text, gathered across rounds and separated from the
 * working-out by `<post>` tags. That could not survive a referee changing its
 * mind INSIDE one response — two drafts in one block, both printed, the second
 * in a different tense and ending in a roll offer. A field cannot be written
 * twice, so a draft is not narration by construction.
 *
 * These are the tests of that, and they are mostly about what is IGNORED.
 */
describe("what the player reads", () => {
  /*
   * THE MODEL'S CALL SYNTAX, RUN INTO THE POST. Seen in R2 and again in R4:
   * the field closed with `</post>` and the next parameter begun inside the
   * string. Cut in code — refusing would spend a round on a few characters.
   */
  it("cuts the model's own call markup off the end of a post", async () => {
    queue.push(
      reply(
        commit({
          post:
            'Something deliberate and slow.</post>\n<parameter name="nextStage">awaiting_action',
        })
      )
    );
    const out = await referee()(request());
    expect(out.narration).toBe("Something deliberate and slow.");
    expect(sent).toHaveLength(1);
  });

  it("refuses a post that was nothing but markup, as the blank it is", async () => {
    queue.push(reply(commit({ post: "</post>" })));
    queue.push(reply(commit({ post: "The door gives." })));
    const out = await referee()(request());
    expect(sent[1].messages.at(-1).content[0].content).toContain("blank screen");
    expect(out.narration).toBe("The door gives.");
  });

  it("leaves angle brackets that are not call markup alone", async () => {
    queue.push(reply(commit({ post: "The sign reads <KEEP OUT> in red." })));
    const out = await referee()(request());
    expect(out.narration).toBe("The sign reads <KEEP OUT> in red.");
  });

  /*
   * BLANK PLACEHOLDERS. R3 lost two rounds on one look at some claw marks to
   * `coinGrant: { why: "" }`, and the third attempt wrote `why: "none"` — valid,
   * and a coin grant for nothing. A blank optional is the field left out.
   */
  it("reads blank optional fields as left out, rather than refusing them", async () => {
    queue.push(
      reply(
        commit({
          post: "The gouges are fresh.",
          coinGrant: { why: "" },
          learned: [],
          fictionNote: "  ",
          draw: { challengeId: "" },
        })
      )
    );

    const out = await referee()(request());
    expect(sent).toHaveLength(1);
    expect(out.commit.coinGrant).toBeUndefined();
    expect(out.commit.learned).toBeUndefined();
    expect(out.commit.fictionNote).toBeUndefined();
    expect(out.commit.draw).toBeUndefined();
  });

  it("still refuses a coin grant with a reason, if that is all that is wrong", async () => {
    // Only BLANK is forgiven. A grant with words in it is a grant.
    queue.push(reply(commit({ coinGrant: { why: "in the drain" } })));
    const out = await referee()(request());
    expect(out.commit.coinGrant).toEqual({ why: "in the drain" });
  });

  it("puts post on the wire as a required field that may be null", async () => {
    queue.push(reply(commit({})));
    await referee()(request());
    const schema = sent[0].tools.find((t: { name: string }) => t.name === "commit_state").input_schema;
    expect(schema.required).toContain("post");
  });

  it("is the commit's post, and nothing else in the response", async () => {
    queue.push(
      reply(
        text("Step 1: the target is the desk.\nStep 2: valid, information."),
        commit({ post: "The desk is oak, and someone has been through the drawers already." })
      )
    );

    const out = await referee()(request());
    expect(out.narration).toBe("The desk is oak, and someone has been through the drawers already.");
  });

  it("ignores loose prose entirely, however much it looks like a post", async () => {
    // A referee that writes the paragraph in the open has written it to nobody.
    // No tags, no heuristic headings, nothing to tell it from a real post — and
    // it still does not reach the player, because the field is the only channel.
    queue.push(reply(text("The door gives, and the smell comes out to meet you."), commit({})));

    const out = await referee()(request());
    expect(out.narration).toBe("The turn passes.");
  });

  /**
   * A9 ITSELF. The referee wrote a draft, thought better of it mid-response, and
   * wrote another — its own trace saying *"Wait, I should not write that post
   * yet… Let me rewrite."* Both reached the player, one after the other.
   *
   * There is nowhere for the first one to go now.
   */
  it("cannot print a draft the referee thought better of", async () => {
    queue.push(
      reply(
        text(
          "You heave at the slab and it grinds aside.\n\n" +
            "Wait — I should not write that post yet. I need to present the roll offer first. " +
            "Let me rewrite.\n\n" +
            "The slab is heavier than it looks. You could get a shoulder under it."
        ),
        commit({ post: "The slab is heavier than it looks. You could get a shoulder under it." })
      )
    );

    const out = await referee()(request());
    expect(out.narration).toBe("The slab is heavier than it looks. You could get a shoulder under it.");
    expect(out.narration).not.toContain("grinds aside");
  });

  it("refuses a commit that would reach the player as a blank screen", async () => {
    queue.push(reply(text("The door gives."), commit({ post: null })));
    queue.push(reply(commit({ post: "The door gives." })));

    const out = await referee()(request());

    const refusal = sent[1].messages.at(-1).content[0];
    expect(refusal.is_error).toBe(true);
    expect(refusal.content).toContain("blank screen");
    expect(out.narration).toBe("The door gives.");
  });
});

describe("an ordinary turn", () => {
  it("returns the prose and the commit, in one call", async () => {
    queue.push(
      reply(
        text("Step 1: the door."),
        commit({ post: "The door gives, and the smell comes out to meet you." })
      )
    );

    const out = await referee()(request());

    expect(out.narration).toBe("The door gives, and the smell comes out to meet you.");
    // The post is NOT on the commit the applier sees. `Commit` is what the
    // applier and the store consume and neither has any business with prose.
    expect(out.commit).toEqual({
      nextStage: "awaiting_action",
      nextStep: "1-target",
      timeSpent: "instant",
      diffs: [],
    });
    expect(sent).toHaveLength(1);
  });

  it("puts the dice and the commit on the table, and leaves the model free to write", () => {
    queue.push(reply(commit({})));
    return referee()(request()).then(() => {
      expect(sent[0].tools.map((t: { name: string }) => t.name)).toEqual(["roll", "commit_state"]);
      // NOT `any`. Forcing a tool call suppresses the prose, and the prose is
      // what the player is here for — see the note in game-master.ts.
      expect(sent[0].tool_choice).toEqual({ type: "auto" });

      // `actor` is the way out of a refused batch, so it has to be on the wire
      // for the referee to know it exists — and "player" must not be, because
      // the player's roll is offered rather than thrown.
      const roll = sent[0].tools[0].input_schema.properties.rolls.items.properties;
      expect(roll.actor.enum).toEqual(["creature", "world"]);

      // The two schemas spend one strict budget between them and do not both
      // fit, so the guarantee goes to the one that writes state. `roll` still
      // goes out with its real schema; zod checks the batch coming back.
      expect(sent[0].tools.map((t: { strict?: boolean }) => t.strict)).toEqual([
        undefined,
        true,
      ]);
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
    // Nothing cached on this reply, and the wire left the fields out entirely.
    expect(entry.cacheWriteTokens).toBe(0);
    expect(entry.cacheReadTokens).toBe(0);
  });

  it("logs the cached input apart from the rest, because it is billed apart", async () => {
    queue.push({
      ...reply(commit({})),
      usage: {
        input_tokens: 900,
        output_tokens: 40,
        cache_creation_input_tokens: 2000,
        cache_read_input_tokens: 7000,
      },
    });
    await referee()(request());

    const [entry] = useGame.getState().run!.callLog;
    expect(entry).toMatchObject({
      inputTokens: 900,
      cacheWriteTokens: 2000,
      cacheReadTokens: 7000,
    });
  });

  it("carries a fact about the place through to the commit", async () => {
    queue.push(
      reply(
        commit({
          post: "Salt has come through the plaster in white feathers.",
          fictionNote: "The gaol was built over a salt mine.",
        })
      )
    );

    const out = await referee()(request());
    expect(out.commit?.fictionNote).toBe("The gaol was built over a salt mine.");
  });

  it("sends the step's own files and no others", async () => {
    queue.push(reply(commit({})));
    await referee()(request({ step: "5-resolution" }));

    // The step files are the last block. SKILL.md names every step in its
    // overview, so the check has to be against that block and not the whole
    // system prompt.
    const steps = sent[0].system[1].text;
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
    // game-master.ts.
    const here = useGame.getState().run!.currentRoomId;
    queue.push(
      reply(
        commit({
          // One of exactly two commits allowed to carry no post — see
          // `missingPost`. The room's own paragraph is the arrival, and writing
          // it twice would invite the two copies to drift.
          post: null,
          diffs: [
            { entityId: here, path: "state", value: "as found" },
            { entityId: here, path: "composed", value: "A chasm opens at your feet." },
          ],
        })
      )
    );

    const out = await referee()(request({ step: "room-entry" }));
    expect(out.narration).toBe("A chasm opens at your feet.");
    expect(sent).toHaveLength(1);
  });

  /*
   * THE STORED PARAGRAPH WINS. A room-entry post is null by the playbook, and
   * one written anyway is the same paragraph twice — R4's was, with tool markup
   * run into its end. `composed` is what the game keeps and shows again.
   */
  it("shows the room's composed paragraph even when a post was written too", async () => {
    const here = useGame.getState().run!.currentRoomId;
    queue.push(
      reply(
        commit({
          post: 'A chasm opens at your feet.</post>\n<parameter name="nextStage">awaiting_action',
          diffs: [{ entityId: here, path: "composed", value: "A chasm opens at your feet." }],
        })
      )
    );

    const out = await referee()(request({ step: "room-entry" }));
    expect(out.narration).toBe("A chasm opens at your feet.");
  });

  it("falls back to the post when the room wrote no paragraph", async () => {
    queue.push(reply(commit({ post: "You have been here before, and it has not improved." })));
    const out = await referee()(request({ step: "room-entry" }));
    expect(out.narration).toBe("You have been here before, and it has not improved.");
  });

  it("does not read a composed diff as prose on an ordinary turn", async () => {
    const here = useGame.getState().run!.currentRoomId;
    queue.push(
      reply(
        commit({
          post: "You wipe the dust off it.",
          diffs: [{ entityId: here, path: "composed", value: "A chasm." }],
        })
      )
    );

    const out = await referee()(request({ step: "1-target" }));
    expect(out.narration).toBe("You wipe the dust off it.");
  });

  /**
   * The other turn allowed to commit without one: a move. The arrival pass runs
   * the moment it lands and it is the one with the new room in front of it, so
   * prose here is discarded unread and asking for it would be asking for waste.
   */
  it("lets a commit that moves the player go without one", async () => {
    const to = dungeon.entities.rooms[1]!.id;
    queue.push(
      reply(commit({ post: null, diffs: [{ entityId: "player", path: "roomId", value: to }] }))
    );

    const out = await referee()(request({ step: "5-resolution" }));
    expect(out.narration).toBe("");
    expect(sent).toHaveLength(1);
  });
});

describe("the dice", () => {
  it("rolls what was asked for and hands the results back in the same exchange", async () => {
    queue.push(
      reply(use("r1", "roll", { rolls: [{ id: "ghoul", kind: "attack", bonus: 2, targetDefense: 11, damage: "1d6" }] }))
    );
    queue.push(reply(commit({ post: "It comes at you." })));

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
    queue.push(reply(hurt(2)));
    queue.push(reply(commit({ post: "You edge back from the lip." })));

    const out = await referee()(request());

    const refusal = sent[1].messages.at(-1).content[0];
    expect(refusal.is_error).toBe(true);
    expect(refusal.content).toContain("no dice were rolled this turn");
    expect(out.commit.diffs).toEqual([]);
  });

  it("allows it once the dice have been thrown", async () => {
    queue.push(reply(use("r1", "roll", { rolls: [{ id: "fall", kind: "damage", expr: "1d6" }] })));
    queue.push(reply(hurt(3)));

    const out = await referee()(request());
    expect(out.commit.diffs).toHaveLength(1);
  });

  it("allows it when the player's own roll is what this turn is resolving", async () => {
    queue.push(reply(hurt(3)));

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

  it("forces the commit on the last round, without changing the tool list", async () => {
    queue.push(rolling(), rolling(), rolling());
    queue.push(reply(commit({})));

    await referee(4)(request());

    expect(sent).toHaveLength(4);
    expect(sent[3].tool_choice).toEqual({ type: "tool", name: "commit_state" });
    // The tool list leads the cached prefix. A closing round that dropped
    // `roll` missed the whole cache and wrote it again (R3, 22K tokens).
    expect(sent[3].tools).toEqual(sent[0].tools);
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

  /*
   * WHAT A TURN SPANNING SEVERAL ROUNDS SAYS.
   *
   * All five of these used to be about the same machinery: two variables that
   * had to work out, from the text alone, whether a round CONTINUED the turn or
   * REDID it — dice continued, a nudge or a refused commit redid. Each case
   * below was a live failure of that guess.
   *
   * There is no guess left to make. One commit per turn, one post on it, and
   * every round before the committing one contributes nothing whatever it wrote.
   */

  // OBSERVED LIVE: the referee wrote its post, forgot the tool, was nudged, and
  // wrote the same post again alongside the call. Both rounds were accumulated
  // and the player read the paragraph twice, back to back.
  it("does not say it twice when a nudge makes the referee write it again", async () => {
    const said = "You take a breath and step into the corridor.";
    queue.push({ content: [text(said)], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } });
    queue.push(reply(text(`You are right, I did not commit.\n${said}`), commit({ post: said })));

    const { narration } = await referee()(request());

    expect(narration).toBe(said);
  });

  // The other half of the same problem: a redo that answers with an apology and
  // no prose of its own still says the thing, because the post rides on the
  // call rather than on whichever round happened to write it.
  it("keeps the post when the referee answers a nudge with an apology", async () => {
    queue.push({
      content: [text("The door gives.")],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    queue.push(reply(text("You're right. Let me commit properly:"), commit({ post: "The door gives." })));

    expect((await referee()(request())).narration).toBe("The door gives.");
  });

  // Same rule for a commit the referee refuses before the applier sees it: only
  // the commit that is finally accepted carries a post anywhere.
  it("says it once when a refused commit is rewritten", async () => {
    const said = "The ghoul reels back.";
    queue.push(reply(commit({ post: said, nextStage: "roll_offered" })));
    queue.push(reply(commit({ post: said })));

    expect((await referee()(request())).narration).toBe(said);
  });

  /**
   * Dice used to CONTINUE a turn — the approach, then the outcome, two posts
   * both owed to the player. They no longer do, and that is the intended change:
   * `SKILL.md` has said "roll first, write nothing before it" for two phases,
   * because an outcome written before the dice came back is a guess. The post
   * written after them is the whole of what the turn says.
   */
  it("says only what was written after the dice", async () => {
    queue.push(
      reply(
        text("The approach, drafted before rolling — a guess, and not the player's."),
        use("r1", "roll", { rolls: [{ id: "a", kind: "morale", rating: 7 }] })
      )
    );
    queue.push(reply(commit({ post: "It breaks and runs." })));

    expect((await referee()(request())).narration).toBe("It breaks and runs.");
  });

  // OBSERVED LIVE: the heuristic worked through in the open and the `roll` call
  // at the end of it. The whole of "Step 1 — Determine the target" was taken
  // for a post, banked, and printed above the paragraph the next round wrote.
  it("never prints the working-out that reached the dice", async () => {
    queue.push(
      reply(
        text("Step 1 — the target is the forge-mouth.\n\nStep 4 — Confirm and roll."),
        use("r1", "roll", { rolls: [{ id: "a", kind: "morale", rating: 7 }] })
      )
    );
    queue.push(reply(commit({ post: "It breaks and runs." })));

    const { narration } = await referee()(request());
    expect(narration).toBe("It breaks and runs.");
    expect(narration).not.toContain("Step 1");
  });
});

// ---------------------------------------------------------------------------

describe("the roll that was never offered", () => {
  // testCharacter's abilities are all +3, so +3 is unmistakably the player's.
  const asks = (...rolls: Record<string, unknown>[]) => use("r1", "roll", { rolls });
  const offered = commit({
    post: "The forge-mouth is narrow. A Dexterity save, +3.",
    nextStage: "roll_offered",
    nextStep: "4-confirm-roll",
    rollRequest: { kind: "save", ability: "dex", bonus: 3, edge: "none", description: "Squeeze in." },
  });

  it("refuses a save at the player's own bonus, and draws nothing", async () => {
    queue.push(reply(text("Step 4 — confirm and roll."), asks({ id: "hide", kind: "save", bonus: 3 })));
    queue.push(reply(offered));

    const out = await referee()(request());

    const refusal = sent[1].messages.at(-1).content[0];
    expect(refusal.is_error).toBe(true);
    expect(refusal.content).toContain("their roll, and you do not throw it");
    expect(refusal.content).toContain("roll_offered");
    // A refused batch must cost no draws, or the dice it asks for properly come
    // out different from the ones it would have had.
    expect(useGame.getState().run!.rngDraws).toBe(0);
    expect(out.commit.nextStage).toBe("roll_offered");
    // And the refusal is a redo, not a continuation: only the rewrite is prose.
    expect(out.narration).toBe("The forge-mouth is narrow. A Dexterity save, +3.");
  });

  it("still refuses damage written off a batch that never landed", async () => {
    // The turn has no dice behind it, whatever the referee asked for.
    queue.push(reply(asks({ id: "hide", kind: "save", bonus: 3 })));
    queue.push(
      reply(
        commit({ post: "You fall.", diffs: [{ entityId: "player", path: "hp.current", value: 12 }] })
      )
    );
    queue.push(reply(commit({ post: "You catch yourself." })));

    const out = await referee()(request());

    expect(sent[2].messages.at(-1).content[0].content).toContain("no dice were rolled this turn");
    expect(out.commit.diffs).toEqual([]);
  });

  it("lets a creature strike at the player's armour through, whatever its bonus", async () => {
    const armor = pcArmorDefense(useGame.getState().run!.pc);
    queue.push(reply(asks({ id: "ghoul", kind: "attack", bonus: 3, targetDefense: armor, damage: "1d6" })));
    queue.push(reply(commit({ post: "It lands." })));

    await referee()(request({ step: "5-resolution" }));

    expect(sent[1].messages.at(-1).content[0].is_error).toBeUndefined();
    expect(useGame.getState().run!.rngDraws).toBeGreaterThan(0);
  });

  it("takes a referee at its word when it marks whose roll it is", async () => {
    queue.push(reply(asks({ id: "ghoul-holds-on", kind: "save", bonus: 3, actor: "creature" })));
    queue.push(reply(commit({ post: "It clings on." })));

    await referee()(request());

    expect(sent[1].messages.at(-1).content[0].content).toMatch(/^ghoul-holds-on: save — d20/);
  });

  it("never mistakes morale or damage for the player's", async () => {
    queue.push(reply(asks({ id: "nerve", kind: "morale", rating: 7 }, { id: "roof", kind: "damage", expr: "1d6" })));
    queue.push(reply(commit({ post: "The ceiling comes down." })));

    await referee()(request());
    expect(useGame.getState().run!.rngDraws).toBeGreaterThan(0);
  });

  it("leaves the batch alone once the player's own roll is what is being resolved", async () => {
    queue.push(reply(asks({ id: "second-save", kind: "save", bonus: 3 })));
    queue.push(reply(commit({ post: "And then the floor goes." })));

    await referee()(
      request({
        step: "5-resolution",
        roll: {
          spec: { kind: "save", ability: "dex", bonus: 3, edge: "none", description: "Jump.", dc: 16 },
          rolled: [11],
          kept: 11,
          total: 14,
          success: false,
          nat20: false,
          nat1: false,
          crit: { defenderArmor: false, attackerWeapon: false },
        },
      })
    );

    expect(sent[1].messages.at(-1).content[0].content).toMatch(/^second-save: save — d20/);
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
    expect(system[2].cache_control).toEqual({ type: "ephemeral" });
  });

  it("tells the referee what it got wrong when the applier refused the last one", async () => {
    queue.push(reply(commit({})));
    await referee()(request({ rejections: ["name: that field is never writable"] }));

    expect(sent[0].messages.at(-1).content).toContain("REFUSED");
    expect(sent[0].messages.at(-1).content).toContain("never writable");
  });
});

// ---------------------------------------------------------------------------

/*
 * TIME SPENT, AND THE TURNS THAT DID NOT HAPPEN.
 *
 * `timeSpent` is the only thing that lets a creature elsewhere in the dungeon
 * cross a room, so the stages that end a turn without one having taken place
 * have to be pinned to `instant`. It is a rule about what a stage MEANS, which
 * is why it is checked here rather than asked for in the playbook — the same
 * family as the no-diffs rule on a rejection.
 */
describe("timeSpent", () => {
  const refusal = () => sent[1].messages.at(-1).content[0];

  it.each(["clarifying", "rejected", "roll_offered"] as const)(
    "refuses a %s turn that spent time",
    async (nextStage) => {
      queue.push(reply(commit({ nextStage, nextStep: "4-confirm-roll", timeSpent: "short", ...offer(nextStage) })));
      queue.push(reply(commit({})));

      const out = await referee()(request());

      expect(refusal().is_error).toBe(true);
      expect(refusal().content).toContain("has not happened yet");
      expect(out.commit.timeSpent).toBe("instant");
    }
  );

  // A room entry is the consequence of a move that has already been paid for.
  // Without this, walking through a door moves everything else twice.
  it("refuses a room entry that spent time", async () => {
    queue.push(reply(commit({ timeSpent: "round" })));
    queue.push(reply(commit({})));

    await referee()(request({ step: "room-entry" as Step }));

    expect(refusal().is_error).toBe(true);
    expect(refusal().content).toContain("not a turn");
  });

  it("refuses long, and says what would produce one", async () => {
    queue.push(reply(commit({ timeSpent: "long" })));
    queue.push(reply(commit({ timeSpent: "short" })));

    const out = await referee()(request());

    expect(refusal().is_error).toBe(true);
    expect(refusal().content).toContain("Rest button");
    expect(out.commit.timeSpent).toBe("short");
  });

  it("takes an ordinary turn that spent time, and carries it to the applier", async () => {
    queue.push(reply(commit({ timeSpent: "short" })));
    expect((await referee()(request())).commit.timeSpent).toBe("short");
  });
});

/** `roll_offered` needs something to roll, or it is refused for that instead. */
function offer(nextStage: string): Record<string, unknown> {
  return nextStage === "roll_offered"
    ? {
        rollRequest: {
          kind: "save",
          ability: "dex",
          bonus: 1,
          edge: "none",
          description: "Jump it.",
        },
      }
    : {};
}
