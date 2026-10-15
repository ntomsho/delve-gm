/**
 * ZOD FOR THE GENERATION PASSES. Nothing a model writes reaches the dungeon
 * unvalidated.
 *
 * These mirror the response interfaces each pass declares: the pass owns the
 * shape, this file owns the checking. The drift guards at the bottom keep the
 * two from drifting apart silently: change an interface without changing its
 * schema and this file stops compiling.
 */

import { z } from "zod";
import type { DungeonPassResponse } from "./dungeon-pass.ts";
import type { ContentPassResponse } from "./content-pass.ts";
import type { Omission } from "../types.ts";
import type { SeamsPassResponse } from "./seams-pass.ts";
import type { KeysPassResponse } from "./keys-pass.ts";
import type { ValidationIssue } from "../../../llm/validation.ts";
import { nonEmpty, type Assignable } from "../../../shared/utils/schema.ts";

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

// ---------------------------------------------------------------------------
// KEYS PASS
// ---------------------------------------------------------------------------
// The objects that answer the dungeon's questions, written once both the key
// and its lock exist. `goalProperties` is the objective's own keyable
// properties, which do not exist until the content pass has decided what the
// objective physically is — so this is the first call that can ask for them.
//
// `keys` is NOT `.min(1)`: a dungeon can place no keys at all and still want
// the goal's properties out of this call.

const keyResponse = z.object({
  ref: nonEmpty,
  name: nonEmpty,
  base: nonEmpty,
  lockRequirement: z.string().optional(),
});

export const keysPassSchema = z.object({
  keys: z.array(keyResponse),
  goalProperties: z.array(nonEmpty).optional(),
});

// ---------------------------------------------------------------------------
// DRIFT GUARDS
// ---------------------------------------------------------------------------

export type DungeonPassParsed = z.infer<typeof dungeonPassSchema>;
export type ContentPassParsed = z.infer<typeof contentPassSchema>;
export type SeamsPassParsed = z.infer<typeof seamsPassSchema>;
export type KeysPassParsed = z.infer<typeof keysPassSchema>;

export type DungeonPassMatchesEngine = Assignable<DungeonPassParsed, DungeonPassResponse>;
export type ContentPassMatchesEngine = Assignable<ContentPassParsed, ContentPassResponse>;
export type SeamsPassMatchesEngine = Assignable<SeamsPassParsed, SeamsPassResponse>;
export type KeysPassMatchesEngine = Assignable<KeysPassParsed, KeysPassResponse>;

// The engine reports what a response left out (`contentPassOmissions`) without
// importing this file — it does not depend on the runtime. This is the proof
// that what it reports is what `callForJson`'s `check` consumes, so the two
// cannot drift into needing a translation step nobody wrote.
export type OmissionIsAnIssue = Assignable<Omission, ValidationIssue>;
