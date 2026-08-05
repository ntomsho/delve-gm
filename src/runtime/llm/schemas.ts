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

const statDeviations = z.object({
  damage: z.string().optional(),
  armorDefense: z.number().int().optional(),
  morale: z.number().int().optional(),
  modifiers: z
    .record(
      z.enum(["str", "dex", "con", "int", "wis", "cha", "attack"]),
      z.number().int()
    )
    .optional(),
});

const writtenEntity = z.object({ ref: nonEmpty, name: nonEmpty, base: nonEmpty });

const promotedDetail = z.object({
  text: nonEmpty,
  name: nonEmpty,
  base: nonEmpty,
  hidden: z.boolean().optional(),
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
  promotions: z.array(promotedDetail).optional(),
  connectors: z.array(connectorResponse).optional(),
  encounters: z.array(encounterResponse).optional(),
  goal: z
    .object({
      entityType: z.enum(["Item", "RoomFeature", "Creature"]),
      name: nonEmpty,
      base: nonEmpty,
    })
    .optional(),
});

export const contentPassSchema = z.object({ rooms: z.array(roomResponse).min(1) });

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

type Assignable<A extends B, B> = [A, B];

export type DungeonPassMatchesEngine = Assignable<DungeonPassParsed, DungeonPassResponse>;
export type ContentPassMatchesEngine = Assignable<ContentPassParsed, ContentPassResponse>;

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
