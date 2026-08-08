/**
 * BUILDING THE CALL
 * =================
 *
 * BUILD-PLAN §4.4, in code. **Rebuilt fresh every call. Never appended to.**
 *
 * The layout, and the reason for each part:
 *
 *   system, block 1   SKILL.md — the conventions, the commit, the dice
 *   system, block 2   dungeonContext — theme, history, the goal      ← cached
 *   system, block 3   the current step's files, and only those
 *   user              the character sheet and the room, re-rendered
 *   user/assistant    the exchange for the action in progress, capped
 *   user              what has just happened, and what to do about it
 *
 * THE CACHE BREAKPOINT IS ON BLOCK 2, AND THE ORDER IS WHY. Caching is a prefix
 * match: everything stable has to come before anything that moves. The playbook
 * never changes and the dungeon's fiction never changes, so they go first and
 * the breakpoint goes after them; the step files change from call to call, so
 * they go last. Reverse those two and the cache would be dead on every turn
 * where the heuristic moved — which is most of them.
 *
 * (Whether it caches at all is the model's business: the minimum cacheable
 * prefix is model-dependent and a prefix under it silently does not cache,
 * without charge. The ordering costs nothing and is right whenever it does.)
 *
 * WHAT IS NOT HERE. The scrollback. `run.log` is what the player reads and it
 * grows for the whole run; the referee gets the exchange for the action in
 * progress and structured records for the two turns before it, and everything
 * older reaches it through the entities' own `state`. That is the point of the
 * three prose lifetimes.
 */

import type { Message, SystemBlock } from "../llm/client.ts";
import type { GeneratedDungeon } from "../generate.ts";
import type { RunState } from "../../store/game.ts";
import type { Step } from "../types.ts";
import type { RolledOutcome } from "../turn.ts";
import { characterView, needsComposition, roomView } from "../../store/selectors.ts";
import { SKILL, stepPrompt } from "./loader.ts";
import { renderCharacter, renderRecords, renderRoll, renderRoom } from "./render.ts";

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
    { type: "text", text: SKILL },
    // Stable for the whole run, and the last thing that is — so the breakpoint
    // goes here.
    {
      type: "text",
      text: `# This dungeon\n\n${dungeon.dungeonContext}`,
      cache_control: { type: "ephemeral" },
    },
    // AFTER the breakpoint, and that is the whole reason it is its own block.
    // What play has established about the place belongs with the dungeon's
    // fiction and reads as a continuation of it — but it grows during the run,
    // and anything that moves has to sit behind everything that does not or the
    // cached prefix dies with it. So: same subject, later block.
    ...fiction(run),
    { type: "text", text: stepPrompt(req.step) },
  ];

  return { system, messages: [brief(req), ...exchange(run), instruction(req)] };
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

  // Hidden things and creature numbers are both included: the referee has to
  // know what is there to be found, and somebody has to set a difficulty.
  // Neither reaches the screen — see RoomViewOptions.
  const room = roomView(run, dungeon, run.currentRoomId, {
    includeHidden: true,
    includeStats: true,
  });

  const records = run.turnRecords.slice(-CARRIED_TURNS);

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
 */
function exchange(run: RunState): Message[] {
  return run.transcript.slice(-MAX_EXCHANGE).map((e) => ({
    role: e.role === "player" ? ("user" as const) : ("assistant" as const),
    content: e.role === "player" ? `The player says: ${e.text}` : e.text,
  }));
}

// ---------------------------------------------------------------------------
// WHAT TO DO NOW
// ---------------------------------------------------------------------------

const CLOSE = [
  `Work through the heuristic in the open — none of it is shown to the player.`,
  `Put the words they read inside \`<post>\` tags, once, at the end.`,
  `Then end your turn with a single \`commit_state\` call.`,
  `Every number you use must have come from the \`roll\` tool or from the player's own roll above.`,
].join(" ");

function instruction(req: PromptInput): Message {
  return { role: "user", content: [task(req), ``, CLOSE].join("\n") };
}

function task(req: PromptInput): string {
  // A refused commit outranks whatever the turn was about: nothing was applied,
  // and the same answer a second time ends the turn in `error`.
  if (req.rejections?.length) {
    return [
      `# Your last commit was REFUSED`,
      ``,
      `**Nothing was applied.** The world is exactly as the section above describes it. The reasons:`,
      ``,
      ...req.rejections.map((r) => `- ${r}`),
      ``,
      `Write the turn again with those fixed. Ids must appear verbatim in the sheet or the room above, or have been created earlier in the same commit; \`base\`, \`name\`, \`id\` and \`type\` are never writable; a \`clarifying\` or \`rejected\` commit must carry no diffs at all.`,
    ].join("\n");
  }

  if (req.step === "room-entry") {
    const owed = needsComposition(req.run);
    return [
      `# The player has just walked in here`,
      ``,
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
