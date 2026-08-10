/**
 * Zod for every model response. Nothing reaches the engine unvalidated.
 *
 * These mirror the response interfaces the engine declares — the engine owns
 * the shape, this file owns the checking. `satisfies` on each export keeps the
 * two from drifting apart silently: change the interface without changing the
 * schema and this file stops compiling.
 */

import { z } from "zod";
import type { DungeonPassResponse } from "../../engine/dungeon-pass.ts";
import type { ContentPassResponse } from "../../engine/dungeon-content-pass.ts";
import type { SeamsPassResponse } from "../../engine/dungeon-seams-pass.ts";
import type { Diff, EntitySpec } from "../diffs/types.ts";
import type { Stage, Step } from "../types.ts";

const nonEmpty = z.string().trim().min(1);

// ---------------------------------------------------------------------------
// DUNGEON PASS
// ---------------------------------------------------------------------------

export const dungeonPassSchema = z.object({
  name: nonEmpty,
  theme: nonEmpty,
  history: nonEmpty,
  goal: z.object({ summary: nonEmpty, spec: nonEmpty }),
  openingProse: nonEmpty,
  groups: z
    .array(z.object({ id: nonEmpty, name: nonEmpty, base: nonEmpty }))
    .min(1),
});

// ---------------------------------------------------------------------------
// CONTENT PASS
// ---------------------------------------------------------------------------

// Spelled out rather than `z.record(z.enum([...]), …)`. A record turns into
// `additionalProperties: { type: "integer" }` in JSON Schema, which structured
// outputs rejects outright — and the key set is fixed and short anyway, so
// naming the keys is both more precise and more useful to the model.
const modifiers = z.object({
  str: z.number().int().optional(),
  dex: z.number().int().optional(),
  con: z.number().int().optional(),
  int: z.number().int().optional(),
  wis: z.number().int().optional(),
  cha: z.number().int().optional(),
  attack: z.number().int().optional(),
});

const statDeviations = z.object({
  damage: z.string().optional(),
  armorDefense: z.number().int().optional(),
  morale: z.number().int().optional(),
  modifiers: modifiers.optional(),
});

/**
 * Where in the room something stands.
 *
 * A LOOSE STRING, not an enum, and deliberately: a position that does not parse
 * is a fixture in the middle of the room instead of at the far end, where a
 * rejected batch is six unwritten rooms and a retry. `applyContentPass` does the
 * narrowing (`isPositionWord`) and falls back to the centre. Same reasoning for
 * `kind` below — the difference is that an unrecognised kind cannot be drawn at
 * all, so apply drops the fixture rather than guessing at one.
 */
const position = z.string().optional();

const writtenEntity = z.object({
  ref: nonEmpty,
  name: nonEmpty,
  base: nonEmpty,
  position,
});

const fixtureResponse = z.object({
  kind: nonEmpty,
  position: nonEmpty,
  name: nonEmpty,
  base: nonEmpty,
});

const promotedDetail = z.object({
  text: nonEmpty,
  name: nonEmpty,
  base: nonEmpty,
  hidden: z.boolean().optional(),
  position,
});

const connectorResponse = z.object({
  ref: nonEmpty,
  name: nonEmpty,
  form: nonEmpty,
  requirement: z.string().optional(),
});

const groupResponse = z.object({
  name: nonEmpty,
  base: nonEmpty,
  activity: nonEmpty,
  stats: statDeviations.optional(),
});

const distinctResponse = z.object({
  kind: z.enum(["elite", "named"]),
  member: z.string().optional(),
  name: nonEmpty,
  base: nonEmpty,
  isLeader: z.boolean().optional(),
  activity: nonEmpty,
  stats: statDeviations.optional(),
});

const encounterResponse = z.object({
  ref: nonEmpty,
  group: groupResponse.optional(),
  distinct: z.array(distinctResponse).optional(),
});

const roomResponse = z.object({
  ref: nonEmpty,
  name: nonEmpty,
  base: nonEmpty,
  entities: z.array(writtenEntity).optional(),
  fixtures: z.array(fixtureResponse).optional(),
  promotions: z.array(promotedDetail).optional(),
  connectors: z.array(connectorResponse).optional(),
  encounters: z.array(encounterResponse).optional(),
  goal: z
    .object({
      entityType: z.enum(["Item", "RoomFeature", "Creature"]),
      name: nonEmpty,
      base: nonEmpty,
      position,
    })
    .optional(),
});

export const contentPassSchema = z.object({ rooms: z.array(roomResponse).min(1) });

// ---------------------------------------------------------------------------
// SEAMS PASS
// ---------------------------------------------------------------------------
// The ways between chunks, written once both their rooms exist. Same connector
// shape a chunk returns — one job, one schema.

export const seamsPassSchema = z.object({
  connectors: z.array(connectorResponse).min(1),
});

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
const edge = z.enum(["none", "advantage", "disadvantage"]);

// ---------------------------------------------------------------------------
// commit_state
// ---------------------------------------------------------------------------

/**
 * The stages a REFEREE may name — a strict subset of `Stage`.
 *
 * `thinking`, `rolling`, `room_entry` and `error` are the software talking, and
 * `resolving` is the machine's own marker for the call it is making right now.
 * A commit that named one of them would leave the player looking at a closed
 * input area with nothing running. Narrowing the enum makes that unsayable
 * rather than merely discouraged.
 */
const refereeStage = z.enum([
  "awaiting_action",
  "clarifying",
  "rejected",
  "roll_offered",
  "dead",
  // The player walked out. NOT which ending that was — the store settles that
  // from whether the goal was met, so `goal_met` and `escaped` are unsayable
  // here and the referee cannot award itself a win it did not earn.
  "departed",
]);

/**
 * The steps a turn can RESUME at. The rest are mid-cascade — a single call runs
 * step 1 through step 3 without stopping — so they are not resume points and
 * naming one would only cost a retry.
 */
const refereeStep = z.enum(["1-target", "4-confirm-roll", "5-resolution"]);

/**
 * What goes on the table. The player-facing terms sit alongside the two
 * referee-side numbers, and the interface renders only the former — see
 * RollSpec, and `InputArea` which never reads `dc`.
 *
 * A save carries `dc`; an attack or a stunt carries `targetDefense`, which the
 * referee converts through `dcFromDefense`. That keeps the vocabulary the
 * playbook uses on the wire and the one `+1` in the codebase in one function.
 */
const rollRequest = z.object({
  kind: z.enum(["save", "attack", "stunt"]),
  ability,
  bonus: z.number().int(),
  edge,
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
  nextStage: refereeStage,
  nextStep: refereeStep,
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
});

// ---------------------------------------------------------------------------
// roll
// ---------------------------------------------------------------------------

/**
 * One request in the batch. Flat rather than a discriminated union: JSON Schema
 * can express the union but the model reads a flat object with a `kind` more
 * reliably, and zod checks the per-kind requirements on the way back in.
 */
const rollSpecRequest = z.object({
  /** the caller's own label, so the results can be told apart */
  id: nonEmpty,
  kind: z.enum(["save", "attack", "stunt", "morale", "damage"]),
  /**
   * Whose roll this is — and `"player"` is deliberately unsayable, because the
   * player's own roll is offered rather than thrown (see `playersOwnDice`).
   * Optional, and read only when a roll made at one of the player's bonuses
   * would otherwise be refused: saying it is the ghoul's is how a referee gets
   * a genuine coincidence past the guard.
   */
  actor: z.enum(["creature", "world"]).optional(),
  edge: edge.optional(),
  /** save, attack, stunt */
  bonus: z.number().int().optional(),
  /** save: the number to meet. Defaults to 16. */
  dc: z.number().int().optional(),
  /** save: a creature is the source of the risk — pass its defense instead */
  defenseAsDc: z.number().int().optional(),
  /** attack, stunt */
  targetDefense: z.number().int().optional(),
  /** attack: the weapon's die. damage: the expression to roll. */
  damage: z.string().optional(),
  expr: z.string().optional(),
  extraDice: z.number().int().optional(),
  /** attack: the right weapon against the right enemy, for the extra die */
  wellSuited: z.boolean().optional(),
  /** morale: the group's rating. Defaults to 7. */
  rating: z.number().int().optional(),
});

export const rollBatchSchema = z.object({ rolls: z.array(rollSpecRequest).min(1) });

export type RollBatchParsed = z.infer<typeof rollBatchSchema>;
export type RollRequestParsed = z.infer<typeof rollSpecRequest>;

// ---------------------------------------------------------------------------
// DRIFT GUARDS
// ---------------------------------------------------------------------------
// The engine owns the response shapes; this file owns checking them. If the two
// drift apart, that should be a compile error rather than a runtime surprise in
// the middle of an expensive generation run.
//
// `Assignable` fails to instantiate unless A really is assignable to B, so the
// aliases below are a proof carried out by the typechecker and erased after.

export type DungeonPassParsed = z.infer<typeof dungeonPassSchema>;
export type ContentPassParsed = z.infer<typeof contentPassSchema>;
export type SeamsPassParsed = z.infer<typeof seamsPassSchema>;

type Assignable<A extends B, B> = [A, B];

export type DungeonPassMatchesEngine = Assignable<DungeonPassParsed, DungeonPassResponse>;
export type ContentPassMatchesEngine = Assignable<ContentPassParsed, ContentPassResponse>;
export type SeamsPassMatchesEngine = Assignable<SeamsPassParsed, SeamsPassResponse>;

export type CommitParsed = z.infer<typeof commitSchema>;

// A parsed commit is not itself a `Commit` — its `rollRequest` carries a
// `targetDefense` the referee converts and a `dc` the referee defaults, so the
// two differ by exactly that normalisation (see referee.ts). What must hold is
// that everything the applier and the store consume lines up: the stage, the
// step, and the diffs go through untouched.
export type CommitStageIsAStage = Assignable<CommitParsed["nextStage"], Stage>;
export type CommitStepIsAStep = Assignable<CommitParsed["nextStep"], Step>;
export type CommitDiffIsADiff = Assignable<CommitParsed["diffs"][number], Diff>;
export type NewEntityIsAnEntitySpec = Assignable<z.infer<typeof entitySpec>, EntitySpec>;

export type ValidationIssue = { path: string; message: string };

export function issuesOf(error: z.ZodError): ValidationIssue[] {
  return error.issues.map((i) => ({
    path: i.path.join(".") || "(root)",
    message: i.message,
  }));
}

/** Validation errors, formatted for feeding back to the model on retry. */
export function formatIssues(issues: ValidationIssue[]): string {
  return issues.map((i) => `  - ${i.path}: ${i.message}`).join("\n");
}
