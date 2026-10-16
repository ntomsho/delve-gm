/**
 * ZOD FOR THE GAME MASTER'S TOOLS. Nothing the model commits reaches the
 * applier unvalidated.
 *
 * `commit_state` is here. The `roll` tool's request schema lives with the dice
 * that answer it, in `rules/knave/roll-tool.ts`.
 */

import { z } from "zod";
import { edgeSchema } from "../../rules/knave/roll-tool.ts";
import type { Diff, EntitySpec, TimeSpent } from "../../shared/types/commit.ts";
import type { Stage, Step } from "../../shared/types/turn.ts";
import { nonEmpty, type Assignable } from "../../shared/utils/schema.ts";

// ===========================================================================
// THE RUNTIME TOOLS
// ===========================================================================
// Two tools, and the difference between them is the difference between saying
// what happened and asking what the dice did.
//
//   commit_state   terminal, once per turn: where the game goes and what changed
//   roll           mid-turn, as often as needed: a batch of dice
//
// Both schemas go on the wire as the tool's `input_schema` — see tool-schema.ts
// for why an accurate one matters — and both validate the response coming back.

const ability = z.enum(["str", "dex", "con", "int", "wis", "cha"]);

// ---------------------------------------------------------------------------
// commit_state
// ---------------------------------------------------------------------------

/**
 * The stages a GAME MASTER may name — a strict subset of `Stage`.
 *
 * `thinking`, `rolling`, `room_entry` and `error` are the software talking, and
 * `resolving` is the machine's own marker for the call it is making right now.
 * A commit that named one of them would leave the player looking at a closed
 * input area with nothing running. Narrowing the enum makes that unsayable
 * rather than merely discouraged.
 */
const gameMasterStage = z.enum([
  "awaiting_action",
  "clarifying",
  "rejected",
  "roll_offered",
  "dead",
  // The player walked out. NOT which ending that was — the store settles that
  // from whether the goal was met, so `goal_met` and `escaped` are unsayable
  // here and the game master cannot award itself a win it did not earn.
  "departed",
]);

/**
 * The steps a turn can RESUME at. The rest are mid-cascade — a single call runs
 * step 1 through step 3 without stopping — so they are not resume points and
 * naming one would only cost a retry.
 */
const gameMasterStep = z.enum(["1-target", "4-confirm-roll", "5-resolution"]);

/**
 * HOW LONG THE ACTION TOOK, which is how the rest of the dungeon finds out that
 * a turn has passed. Not a duration — see `TimeSpent` for why there is no clock
 * — but the four cases named so the game master reads what each one covers.
 *
 * `long` is on the wire and is refused on the way back in until Rest exists to
 * produce it (ROADMAP, *Rest*); the description says so, because a model offered a value it
 * cannot use will reach for it.
 */
const timeSpent = z.enum(["instant", "round", "short", "long"]).describe(
  "How long this action took, which decides who else got to move. " +
    'instant — a glance, a word, drawing a blade: nobody moves. ' +
    'round — ten seconds or less, one exchange, a lunge, a shove. ' +
    'short — up to an hour: searching, picking a lock, binding a wound. ' +
    'long — a night\'s rest, and ONLY that; nothing else you can be asked to ' +
    "resolve is long, and a turn that says so is refused. Forced to instant on " +
    "clarifying, rejected and roll_offered, because those turns have not happened yet."
);

/**
 * What goes on the table. The player-facing terms sit alongside the two
 * game-master-side numbers, and the interface renders only the former — see
 * RollSpec, and `InputArea` which never reads `dc`.
 *
 * A save carries `dc`; an attack or a stunt carries `targetDefense`, which the
 * game master converts through `dcFromDefense`. That keeps the vocabulary the
 * playbook uses on the wire and the one `+1` in the codebase in one function.
 */
const rollRequest = z.object({
  kind: z.enum(["save", "attack", "stunt"]),
  ability,
  bonus: z.number().int(),
  edge: edgeSchema,
  description: nonEmpty,
  weapon: z.string().optional(),
  mode: z.enum(["damage", "stunt"]).optional(),
  advantageUse: z.enum(["normal", "stunt-and-damage"]).optional(),
  /** saves: the number to meet. Defaults to the ordinary 16. Never rendered. */
  dc: z.number().int().optional(),
  /** attacks and stunts: the target's defense, converted here. Never rendered. */
  targetDefense: z.number().int().optional(),
  damage: z.string().optional(),
  targetId: z.string().optional(),
});

/** A thing being brought into existence, appended to a holder's `children[]`. */
const entitySpec = z.object({
  type: z.enum(["Item", "RoomFeature"]),
  name: nonEmpty,
  base: nonEmpty,
  state: z.string().optional(),
  slots: z.number().int().optional(),
  amount: z.string().optional(),
  hidden: z.boolean().optional(),
  /** address it from a later diff in this same commit */
  ref: z.string().optional(),
});

/**
 * Spelled out rather than left as `unknown`.
 *
 * `unknown` compiles to `{}` in JSON Schema, which tells the model nothing —
 * and the one value shape it cannot guess is the entity spec behind
 * `children[]`. An `anyOf` costs a few lines and puts that shape on the wire.
 */
const diffValue = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(z.string()),
  entitySpec,
]);

const diff = z.object({
  entityId: nonEmpty,
  path: nonEmpty,
  value: diffValue,
});

export const commitSchema = z.object({
  /**
   * WHAT THE PLAYER READS. The only place a post can come from.
   *
   * A FIELD, NOT LOOSE TEXT. When narration was the concatenation of every
   * text block in the response, nothing distinguished a draft from the post. A
   * game master that thought better of a
   * paragraph mid-response — *"Wait, I should not write that post yet… Let me
   * rewrite"* — had BOTH drafts printed, one after the other, the second in a
   * different tense and ending in a roll offer. No streaming rule catches that;
   * the buffer is complete and valid, it is just two answers stapled together.
   *
   * A field cannot be written twice. The last `commit_state` call is the only
   * one that counts, so a draft is not narration BY CONSTRUCTION rather than by
   * the loop guessing which block the game master meant — and the rule that a player
   * reads nothing until the commit has validated gets its second guarantee,
   * because the prose now travels inside the thing being validated.
   *
   * REQUIRED, AND NULL ON THE TWO TURNS THAT WRITE NONE: a room entry, where the
   * room's own `composed` IS the paragraph, and a commit that moves the player,
   * whose prose is discarded unread because the arrival pass is about to
   * describe the real room. Anything else with a null post is refused — see
   * `missingPost` in game-master.ts.
   *
   * REQUIRED, because an optional key is one the model can simply not write.
   * As `.optional()` it did, a quarter of the time: playtest R3 (2026-10-11) had 4 of 19 calls spent on
   * "this commit has no `post`", the game master filling `coinGrant` and `learned`
   * with blank placeholders and skipping the one field that mattered. `commit_state`
   * goes out strict, so a required key is one the API will not let it leave out —
   * and `null` keeps the exempt turns to four tokens rather than a paragraph
   * written to be thrown away (which they were writing anyway: both R3 room
   * entries carried a post duplicating `composed`).
   */
  post: z.string().trim().min(1).nullable(),
  nextStage: gameMasterStage,
  nextStep: gameMasterStep,
  timeSpent,
  rollRequest: rollRequest.optional(),
  diffs: z.array(diff),
  /**
   * The dungeon's objective is accomplished. It does NOT end the run — the
   * player still has to carry it out — so it is a flag rather than a stage, and
   * it latches: saying it once is enough, forever.
   */
  goalMet: z.boolean().optional(),
  /**
   * One fact this turn established about the DUNGEON — its history, its makers,
   * what a place was really for. Appended to the run's fiction and shown back on
   * every later call, so the story of the place only ever grows.
   *
   * Capped, and deliberately short of a paragraph: this is a line for the record,
   * not a second draft of the narration. Anything true of a single entity belongs
   * in that entity's `state` instead, which is why the length is the check.
   */
  fictionNote: z.string().trim().min(1).max(300).optional(),
  /**
   * ONE challenge answered out of the reserve, and one at most per turn.
   *
   * The id must be one the offer list carried — the applier refuses anything
   * else, including an entry already spent and a challenge already resolved.
   * `entityRef` names an entity created by a `children[]` diff in this same
   * commit, for a draw the player can pick up; an information draw omits it.
   */
  draw: z
    .object({ challengeId: nonEmpty, entityRef: z.string().optional() })
    .optional(),
  /**
   * Challenges whose fact the player has now been told, in as many words.
   *
   * The applier writes the DUNGEON'S wording onto the thing the fact is about,
   * not whatever was written in the post — so this is a list of ids and carries
   * no prose of its own.
   */
  learned: z.array(nonEmpty).optional(),
  /**
   * The player found money. HOW MUCH IS NOT YOURS TO SAY — the dungeon holds an
   * allowance settled before play and the amount is rolled from it. `why` is one
   * line for the record.
   */
  coinGrant: z.object({ why: nonEmpty }).optional(),
});

// ---------------------------------------------------------------------------
// DRIFT GUARDS
// ---------------------------------------------------------------------------

export type CommitParsed = z.infer<typeof commitSchema>;

// A parsed commit is not itself a `Commit` — its `rollRequest` carries a
// `targetDefense` the game master converts and a `dc` the game master defaults, so the
// two differ by exactly that normalisation (see game-master.ts). What must hold is
// that everything the applier and the store consume lines up: the stage, the
// step, and the diffs go through untouched.
export type CommitStageIsAStage = Assignable<CommitParsed["nextStage"], Stage>;
export type CommitStepIsAStep = Assignable<CommitParsed["nextStep"], Step>;
export type CommitTimeIsATimeSpent = Assignable<CommitParsed["timeSpent"], TimeSpent>;
export type CommitDiffIsADiff = Assignable<CommitParsed["diffs"][number], Diff>;
export type NewEntityIsAnEntitySpec = Assignable<z.infer<typeof entitySpec>, EntitySpec>;
