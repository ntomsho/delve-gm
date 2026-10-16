/**
 * DUNGEON PASS  (once, up front)
 * ==============================
 *
 * The first call, and the only one that sees the whole dungeon at once. It
 * turns the rolled genome -- purpose, ruination, inhabitants, goal seed -- into
 * the standing fiction every later pass writes against:
 *
 *   theme      the sensory register: material, light, sound, smell
 *   history    what it was, what happened, who is here now
 *   goal       ONE objective resolved out of the reward/mission pair
 *   opening    what the player reads before the first room
 *   groups     the shared base for each rolled inhabitant group
 *
 * INHABITANT BASES ARE WRITTEN HERE. A group is a dungeon-level thing: it can
 * be placed in several rooms across several chunks, and every instance shares
 * one identity. Writing it once, here, is what keeps chunks from each inventing
 * their own version of the same population -- and who lives here belongs in the
 * dungeon's fiction anyway, not in whichever room happens to hold them.
 *
 * Wanderer groups are NOT written here. They do not exist yet (stocking rolls
 * them), they are filler drawn when the rolled inhabitants are already placed,
 * and they are explicitly not part of the resident population. The content pass
 * writes theirs, in the one chunk each appears in.
 */

import {
  rollSheet,
  type DungeonBlueprintSeed,
  type Size,
} from "../blueprint.ts";
import { properName } from "../../../shared/world/entities.ts";
import type { GroupTemplate } from "../../../shared/world/entities.ts";
import { DUNGEON_PASS_INSTRUCTIONS, DUNGEON_PASS_SCHEMA } from "../../../prompts/loader.ts";

// ===========================================================================
// PAYLOAD
// ===========================================================================

export interface DungeonPassPayload {
  /** the full rolled genome as text; group ids appear inline, in brackets */
  rollSheet: string;
  /** every id in bp.inhabitants -- the exact set the response must cover */
  groupIds: string[];
  size: Size;
  level: number;
  instructions: string;
  responseSchema: string;
}

export function buildDungeonPassPayload(bp: DungeonBlueprintSeed): DungeonPassPayload {
  return {
    rollSheet: rollSheet(bp),
    groupIds: bp.inhabitants.map((g) => g.id),
    size: bp.size,
    level: bp.level ?? 1,
    instructions: DUNGEON_PASS_INSTRUCTIONS,
    responseSchema: DUNGEON_PASS_SCHEMA,
  };
}

// ===========================================================================
// RESPONSE
// ===========================================================================

export interface DungeonPassGroup {
  /** must match one of payload.groupIds exactly */
  id: string;
  /** what these are called, plural: "the Ashen Choir", "fen-seals" */
  name: string;
  /** their standing identity, shared by every instance anywhere in the dungeon */
  base: string;
}

export interface DungeonPassResponse {
  name: string;
  theme: string;
  history: string;
  goal: {
    /** one line, shown to the player as their objective */
    summary: string;
    /** what actually satisfies it, for the game master */
    spec: string;
  };
  /** what the player reads before the first room */
  openingProse: string;
  groups: DungeonPassGroup[];
}

// ===========================================================================
// RENDER
// ===========================================================================

export function renderDungeonPassPrompt(p: DungeonPassPayload): string {
  const L: string[] = [];
  L.push(p.instructions, "");
  L.push(p.rollSheet, "");
  L.push(`=== GROUPS YOU MUST WRITE (${p.groupIds.length}) ===`);
  L.push(
    "One name + base for each id below, exactly these ids and no others. They are",
    "the groups printed above; the id is in brackets on each group's header line."
  );
  for (const id of p.groupIds) L.push(`  ${id}`);
  L.push("");
  L.push("=== RESPONSE FORMAT ===", p.responseSchema);
  return L.join("\n");
}

// ===========================================================================
// INSTRUCTIONS + SCHEMA
// ===========================================================================

// ===========================================================================
// APPLY
// ===========================================================================

export interface DungeonPassResult {
  /**
   * The standing fiction as one string. Consumed by the content pass and, at
   * runtime, as the cached static prefix on every game master call.
   *
   * Built ONCE, here, from bp.inhabitants alone. Nothing appends to it and no
   * later pass regenerates it -- wanderer bases land in registry.groups as
   * chunks complete, and anything that re-derived this string from the registry
   * would start presenting corridor filler as the dungeon's population.
   */
  dungeonContext: string;
  /** blueprintId -> shared identity; merged into ep.registry.groups */
  groups: Record<string, GroupTemplate>;
  pass: DungeonPassResponse;
}

export class DungeonPassError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DungeonPassError";
  }
}

export function applyDungeonPass(
  res: DungeonPassResponse,
  payload: DungeonPassPayload
): DungeonPassResult {
  // A group with no base is creatures with no resolvable identity -- a hard
  // failure, not a degradation. Check before anything is built on it.
  const expected = new Set(payload.groupIds);
  const got = new Set(res.groups.map((g) => g.id));
  const missing = [...expected].filter((id) => !got.has(id));
  const unknown = [...got].filter((id) => !expected.has(id));
  if (missing.length || unknown.length) {
    throw new DungeonPassError(
      [
        missing.length ? `no base returned for group(s): ${missing.join(", ")}` : "",
        unknown.length ? `base returned for unknown group(s): ${unknown.join(", ")}` : "",
      ]
        .filter(Boolean)
        .join("; ")
    );
  }
  const blank = res.groups.filter((g) => !g.base?.trim() || !g.name?.trim());
  if (blank.length) {
    throw new DungeonPassError(`empty name or base for group(s): ${blank.map((g) => g.id).join(", ")}`);
  }

  const groups: Record<string, GroupTemplate> = {};
  // A group's name IS a creature's display name — `resolveName` falls through
  // to it for every instance that has no name of its own — so it is capitalised
  // on the same rule as everything else the player reads. See `properName`.
  for (const g of res.groups) groups[g.id] = { id: g.id, name: properName(g.name), base: g.base };

  return { dungeonContext: renderDungeonContext(res), groups, pass: res };
}

/** The standing fiction, as the later passes read it. */
export function renderDungeonContext(res: DungeonPassResponse): string {
  const L: string[] = [];
  L.push(`THE DUNGEON: ${res.name}`, "");
  L.push("THEME", res.theme, "");
  L.push("HISTORY", res.history, "");
  L.push("WHO LIVES HERE");
  for (const g of res.groups) L.push(`  ${g.name} -- ${g.base}`);
  L.push("");
  L.push("THE PLAYER'S GOAL", `  ${res.goal.summary}`, `  Satisfied by: ${res.goal.spec}`);
  return L.join("\n");
}
