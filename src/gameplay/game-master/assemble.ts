/**
 * BUILDING THE CALL
 * =================
 *
 * BUILD-PLAN §4.4, in code. **Rebuilt fresh every call. Never appended to.**
 *
 * The layout, and the reason for each part:
 *
 *   system, block 1   SKILL.md — the conventions, the commit, the dice  ← cached, everyone
 *   system, block 2   the current step's files, and only those          ← cached, everyone
 *   system, block 3   dungeonContext — theme, history, the goal         ← cached, this run
 *   system, block 4   what play has established, once there is any
 *   user              the character sheet, the room, and every creature elsewhere
 *   user/assistant    the exchange for the action in progress, capped
 *   user              what has just happened, and what to do about it   ← cached at step 5
 *
 * ORDERED BY HOW MANY CALLS SHARE IT. Caching is a prefix match, and the cache
 * belongs to the API key, not the run: any request that opens with the same
 * bytes reads them back at a tenth of the price. So what is identical for EVERY
 * player goes first — the playbook, then the step files, which are fixed per
 * step and the same in every dungeon — and the first per-run thing, the
 * dungeon's fiction, goes after both. Two strangers playing different dungeons
 * within the cache's five minutes share the ~20K tokens of rules between them.
 * The run's own fiction grows, so it goes last of all.
 *
 * (The tool definitions come before all of this — the API's order, not ours —
 * which is why `game-master.ts` sends one tool list on every call.)
 *
 * THE STEP FILES USED TO SIT BEHIND THE ONE BREAKPOINT, AND THEY ARE THE BULK
 * OF IT. `1-target` alone is ~34K characters. In R1 it was sent at full price on
 * all 53 of its calls — about half the input the whole run paid for — because
 * the only breakpoint was ahead of it, and the growing fiction block sat
 * between the two so no second breakpoint could have held. A cache read is a
 * tenth of the price.
 *
 * (Whether it caches at all is the model's business: the minimum cacheable
 * prefix is model-dependent and a prefix under it silently does not cache,
 * without charge. The ordering costs nothing and is right whenever it does.)
 *
 * WHAT IS NOT HERE. The scrollback. `run.log` is what the player reads and it
 * grows for the whole run; the game master gets the exchange for the action in
 * progress and structured records for the two turns before it, and everything
 * older reaches it through the entities' own `state`. That is the point of the
 * three prose lifetimes.
 */

import type { Message, SystemBlock } from "../../llm/client.ts";
import type { GeneratedDungeon } from "../../generation/generate.ts";
import type { RunState, TranscriptEntry } from "../state/store.ts";
import type { Step } from "../../shared/types/turn.ts";
import type { RolledOutcome } from "../turn.ts";
import { characterView } from "../view/character.ts";
import { censusView } from "../view/census.ts";
import { needsComposition, roomView } from "../view/room.ts";
import { SKILL, stepPrompt } from "../../prompts/loader.ts";
import {
  renderCharacter,
  renderDraws,
  renderKnown,
  renderOtherRoomCreatures,
  renderRecords,
  renderRoll,
  renderRoom,
  type KnownFact,
} from "./render.ts";
import { offerDraws } from "../mechanics/challenges.ts";
import { CHALLENGE_LABEL } from "../../generation/content/challenges.ts";

/**
 * A player renegotiating forever cannot blow the budget: the exchange is cut to
 * its last N messages. §4.4 sets the number.
 */
export const MAX_EXCHANGE = 12;

/** Completed turns carried forward, as records. */
export const CARRIED_TURNS = 2;

export interface PromptInput {
  step: Step;
  dungeon: GeneratedDungeon;
  run: RunState;
  /** what the player typed, when this call was triggered by input */
  input?: string;
  /** the roll they just made, when this call is a resolution */
  roll?: RolledOutcome;
  /** why the last commit was refused; present only on a retry */
  rejections?: string[];
}

export interface TurnPrompt {
  system: SystemBlock[];
  messages: Message[];
}

export function assemble(req: PromptInput): TurnPrompt {
  const { dungeon, run } = req;

  const system: SystemBlock[] = [
    // The same for every call anyone makes. A breakpoint of its own, so a step
    // nobody has reached in five minutes still reads the playbook from cache.
    { type: "text", text: SKILL, cache_control: { type: "ephemeral" } },
    // The same for every call AT THIS STEP, in any dungeon.
    { type: "text", text: stepPrompt(req.step), cache_control: { type: "ephemeral" } },
    // The first thing that belongs to this run alone.
    {
      type: "text",
      text: `# This dungeon\n\n${dungeon.dungeonContext}`,
      cache_control: { type: "ephemeral" },
    },
    // LAST, because it is the one system block that grows during the run. What
    // play has established belongs with the dungeon's fiction, but anything
    // that moves has to sit behind everything that does not or the cached
    // prefix dies with it.
    ...fiction(run),
  ];

  const close = instruction(req);
  return {
    system,
    messages: [
      brief(req),
      ...exchange(run),
      // THE FOURTH AND LAST BREAKPOINT, AND ONLY AT STEP 5. Everything above is
      // resent unchanged on every round of one turn, and a resolution nearly
      // always takes two — the dice, then the commit (all three in R3 did).
      // Caching it costs a quarter extra on the first round and saves nine
      // tenths on the next. Step 1 usually commits in one round, where the same
      // breakpoint would be a quarter extra for nothing.
      req.step === "5-resolution" ? cached(close) : close,
    ],
  };
}

/**
 * What the run itself has established about the dungeon.
 *
 * Empty until a turn writes a `fictionNote`, and no block at all until then —
 * an empty heading would read as "nothing has been learned here", which is a
 * claim, and on turn one it is not one worth making.
 */
function fiction(run: RunState): SystemBlock[] {
  const notes = run.fiction ?? [];
  if (notes.length === 0) return [];
  return [
    {
      type: "text",
      text: [
        `# What play has since established about this place\n`,
        `Written during the run, in the order it came out, and as binding as`,
        `anything above — most of it has already reached the player. Do not`,
        `contradict it. Build on it.\n`,
        ...notes.map((n) => `- ${n}`),
      ].join("\n"),
    },
  ];
}

// ---------------------------------------------------------------------------
// THE STANDING BRIEF
// ---------------------------------------------------------------------------

function brief(req: PromptInput): Message {
  const { run, dungeon } = req;

  // Hidden things and creature numbers are both included: the game master has to
  // know what is there to be found, and somebody has to set a difficulty.
  // Neither reaches the screen — see RoomViewOptions.
  const room = roomView(run, dungeon, run.currentRoomId, {
    includeHidden: true,
    includeStats: true,
  });

  const records = run.turnRecords.slice(-CARRIED_TURNS);

  // A run saved before any of this existed has no challenge state, and gets
  // neither section rather than a crash.
  const cs = run.challengeState;
  const challenges = dungeon.stocked.challenges ?? [];
  const draws = cs
    ? offerDraws(cs, challenges, dungeon.stocked.reserve ?? [], run.currentRoomId, CHALLENGE_LABEL)
    : [];
  const known: KnownFact[] = (cs?.known ?? []).flatMap((id) => {
    const c = challenges.find((x) => x.id === id);
    return c ? [{ about: CHALLENGE_LABEL[c.kind], fact: c.property }] : [];
  });

  return {
    role: "user",
    content: [
      `# The world as it stands`,
      ``,
      `This is regenerated every turn and is always current. Turn ${run.turnCount + 1}.`,
      ``,
      renderCharacter(characterView(run)),
      ``,
      room ? renderRoom(room) : `## The room the player is standing in\n\n(missing — this is a bug)`,
      // AFTER THE ROOM, AND EVERY CALL. Until this existed the game master held one
      // room and nothing in the dungeon did anything until the player walked in
      // on it. Sending all of them every time was measured rather than assumed —
      // see `censusView` — and it costs about a twentieth of a resolution turn.
      //
      // Under the room's own heading on purpose: it is a `###` beside "In it"
      // and "Ways out", because what it says is *where everything else is*, and
      // that is the same subject as the room the player is standing in.
      ``,
      renderOtherRoomCreatures(censusView(run)),
      // WHAT THE DUNGEON STILL OWES, and what it has already paid out. Both are
      // short — the offer list is trimmed to the eight nearest, and the known
      // list is only what this run has actually learned — and both are here
      // rather than in the step files because they change every turn.
      //
      // The LEDGER is deliberately not here. It is written for the end-of-run
      // tally and never read by a turn, which is what makes it free.
      draws.length ? `\n${renderDraws(draws)}` : ``,
      known.length ? `\n${renderKnown(known)}` : ``,
      records.length ? `\n${renderRecords(records)}` : ``,
    ].join("\n"),
  };
}

// ---------------------------------------------------------------------------
// THE EXCHANGE IN PROGRESS
// ---------------------------------------------------------------------------

/**
 * The conversation for the action currently being resolved — a clarification
 * asked and answered, a roll argued over. Cleared the moment a turn closes,
 * which is what keeps it short without anything having to trim it.
 *
 * A roll is the player's, so it goes on their side of the exchange — but they
 * did not *say* it, and a die result introduced as speech is a die result the
 * game master may argue with. See `turn.ts`: the transcript entry is defence in
 * depth behind `renderRoll`, not the authoritative copy.
 */
function exchange(run: RunState): Message[] {
  return run.transcript.slice(-MAX_EXCHANGE).map((e) => ({
    role: e.role === "game-master" ? ("assistant" as const) : ("user" as const),
    content: spoken(e),
  }));
}

function spoken(e: TranscriptEntry): string {
  switch (e.role) {
    case "player":
      return `The player says: ${e.text}`;
    case "roll":
      return `The player rolled: ${e.text}`;
    case "game-master":
      return e.text;
  }
}

// ---------------------------------------------------------------------------
// WHAT TO DO NOW
// ---------------------------------------------------------------------------

/*
 * THIS SAID `<post>` TAGS FOR TWO MONTHS AFTER THE TAGS WERE GONE.
 *
 * The post moved into `commit_state` (§8a A9) and SKILL.md and the tool's own
 * description were rewritten for it; this line, the last thing the game master
 * reads on every call, was not. So the final instruction was to finish with
 * the prose in the open and THEN commit — which is a turn that can end on the
 * prose. That is the shape of the "you ended your turn without calling
 * `commit_state`" round, which was 17 of R1's 92 calls.
 */
const CLOSE = [
  `Work through the heuristic in short notes, a line per step — none of it is shown to the player.`,
  `The words they read go in the \`post\` field of \`commit_state\`, and that call is how your turn ends: make it every time.`,
  `Every number you use must have come from the \`roll\` tool or from the player's own roll above.`,
].join(" ");

/** A message carrying a cache breakpoint, which only a content block can hold. */
function cached(m: Message): Message {
  return {
    role: m.role,
    content: [{ type: "text", text: m.content as string, cache_control: { type: "ephemeral" } }],
  };
}

function instruction(req: PromptInput): Message {
  return { role: "user", content: [task(req), ``, CLOSE].join("\n") };
}

/**
 * A RETRY IS THE SAME TURN, ASKED AGAIN.
 *
 * So the reasons are a PREAMBLE and everything the first ask carried follows
 * them, unchanged. They are never a substitute for it.
 *
 * This was an if/else chain whose rejection branch returned early, and the
 * cost was not obvious: the roll reaches the game master through exactly one line
 * — `renderRoll`, in the body below — so a retry after a roll was a prompt
 * with the roll missing from it. A game master at step 5 with a rejection notice,
 * no number, and an action it has not resolved does the only coherent thing
 * left and restarts the heuristic, which means offering the same roll a second
 * time. In the 2026-08-10 playtest the player won a DEX save at 20, had the
 * commit refused for an unrelated reason, was asked to roll again, got a 9,
 * and lost what they had already taken.
 *
 * That one defect also produced the duplicated establishing paragraph — a
 * restarted heuristic re-narrates — and the report that the game master "got
 * completely messed up". It was not confused. It was told nothing.
 */
function task(req: PromptInput): string {
  const parts = req.rejections?.length ? [refused(req.rejections), body(req)] : [body(req)];
  return parts.join("\n\n");
}

function refused(reasons: string[]): string {
  return [
    `# Your last commit was REFUSED`,
    ``,
    `**Nothing was applied.** The world is exactly as the section above describes it. The reasons:`,
    ``,
    ...reasons.map((r) => `- ${r}`),
    ``,
    `Ids must appear verbatim in the sheet or the room above, or have been created earlier in the same commit; \`base\`, \`name\`, \`id\` and \`type\` are never writable; a \`clarifying\` or \`rejected\` commit must carry no diffs at all.`,
    ``,
    // Narration is held back until the commit applies, so a refused attempt
    // reached nobody. A game master that thinks it half-published will write the
    // second attempt as a continuation of prose the player never read.
    `**This is the same turn, not a new one.** What you were asked for follows, unchanged — the same step, the same action, the same roll if there was one. Write it again with the reasons above fixed. The player has not seen any of your last attempt: the narration was held back with the commit, so write the whole turn, not a correction to it.`,
  ].join("\n");
}

function body(req: PromptInput): string {
  if (req.step === "room-entry") {
    const owed = needsComposition(req.run);
    return [
      `# The player has just walked in here`,
      ``,
      // THE EMPTY CASE SHOULD NOT REACH HERE. `enterRoom` runs the same sweep
      // before it builds anything and re-shows the room itself when it comes
      // back empty (8a A4) — a prompt asking a model to confirm that nothing
      // happened is the round trip that fix exists to stop paying for. Kept as
      // a fallback because arriving with no instruction at all is worse, and
      // because a retry can in principle rebuild this after the world moved.
      owed.length
        ? `These need writing — nothing else does:\n\n${owed
            .map((e) => `- [${e.id}] ${e.name} (${e.type})`)
            .join("\n")}`
        : `Nothing here needs new prose. Commit no diffs and hand the turn straight back.`,
      ``,
      `Describe the arrival. Change nothing but \`state\` and \`composed\`.`,
    ].join("\n");
  }

  if (req.roll) {
    return `${renderRoll(req.roll)}\n\nResolve the action at step 5.`;
  }

  return [
    `# The player has acted`,
    ``,
    `Their words are the last message above. Resume the heuristic at the step you were given and carry it as far as it goes.`,
  ].join("\n");
}
