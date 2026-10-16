/**
 * WHAT THE CONTENT PASS ANSWERS: the response's shape, and everything a chunk
 * was asked about and did not write.
 */

import type { Omission } from "../../types.ts";
import type { CreatureStats } from "../../../../shared/world/entities.ts";
import type { ContentPassPayload } from "./build.ts";

// ===========================================================================
// RESPONSE TYPES
// ===========================================================================

/** Stat deviations only. HD/HP come from code; the model layers flavour on top. */
export interface StatDeviations {
  damage?: string;
  armorDefense?: number;
  morale?: number;
  modifiers?: CreatureStats["modifiers"];
}

export interface WrittenEntity {
  ref: string;
  name: string;
  base: string;
  /**
   * One of the position words, saying where in the room it sits.
   *
   * Free text is validated against the vocabulary and anything else falls back
   * to the centre. Optional because a dungeon with no drawing has nowhere to put
   * it — and because a dropped position costs a dot, not a room.
   */
  position?: string;
}

export interface PromotedDetail {
  text: string;
  name: string;
  base: string;
  hidden?: boolean;
  position?: string;
}

/**
 * A drawable thing the model chose to furnish the room with.
 *
 * `kind` and `position` are validated against the menu and the position words;
 * an unrecognised value is dropped and never fatal. HOW MANY there are is not
 * here and never will be — that is rolled from the kind, in code.
 */
export interface FixtureResponse {
  kind: string;
  position: string;
  name: string;
  base: string;
}

export interface ConnectorResponse {
  ref: string;
  name: string;
  /** what the connector physically is: door, stair, corridor, drop, etc. */
  form: string;
  /** what blocks it, gated connectors only */
  requirement?: string;
}

export interface GroupResponse {
  name: string;
  base: string;
  activity: string;
  stats?: StatDeviations;
}

export interface DistinctResponse {
  kind: "elite" | "named";
  member?: string;
  name: string;
  base: string;
  isLeader?: boolean;
  activity: string;
  stats?: StatDeviations;
}

export interface EncounterResponse {
  ref: string;
  group?: GroupResponse;
  distinct?: DistinctResponse[];
}

export interface RoomResponse {
  ref: string;
  name: string;
  base: string;
  entities?: WrittenEntity[];
  fixtures?: FixtureResponse[];
  promotions?: PromotedDetail[];
  connectors?: ConnectorResponse[];
  encounters?: EncounterResponse[];
  goal?: {
    entityType: "Item" | "RoomFeature" | "Creature";
    name: string;
    base: string;
    position?: string;
  };
}

export interface ContentPassResponse {
  rooms: RoomResponse[];
}

// ===========================================================================
// COMPLETENESS
// ===========================================================================

/**
 * EVERYTHING THIS CHUNK WAS ASKED ABOUT AND DID NOT WRITE.
 *
 * A response answering five of six connectors is valid JSON against a valid
 * schema. Zod checks shape, and nothing about the shape says how many connectors
 * there should be -- so the omission passes, the chunk applies, and the gap
 * surfaces only when `validateWritten` sweeps at the end, by which point the pass
 * is over and the one retry has gone unspent. That is how a live run finished
 * with three of ~90 written things unwritten, one of them a connector between two
 * rooms in the same chunk, which no seam could explain.
 *
 * This turns an omission into exactly the zod-shaped failure the retry already
 * knows how to take. It lives here rather than in the schema because only the
 * PAYLOAD knows what was asked for, and the schema never sees the payload.
 *
 * WHAT IS DELIBERATELY NOT CHECKED, all for one reason -- the model chose, so
 * there is nothing it can have left out: fixtures, promoted details, and the
 * seam connectors carried as context, which HARD RULE 1 tells it not to return.
 */
export function contentPassOmissions(
  payload: ContentPassPayload,
  res: ContentPassResponse
): Omission[] {
  const out: Omission[] = [];
  const roomByRef = new Map((res.rooms ?? []).map((r) => [r.ref, r]));

  const absent = (want: readonly string[], got: readonly string[]): string[] => {
    const have = new Set(got);
    return want.filter((ref) => !have.has(ref));
  };

  for (const brief of payload.rooms) {
    const rr = roomByRef.get(brief.ref);
    if (!rr) {
      out.push({
        path: `rooms.${brief.ref}`,
        message: `room ${brief.ref} was listed and is missing from the response entirely`,
      });
      continue;
    }
    const at = `rooms.${brief.ref}`;

    for (const ref of absent(
      brief.entities.map((e) => e.ref),
      (rr.entities ?? []).map((e) => e.ref)
    )) {
      out.push({
        path: `${at}.entities`,
        message: `entity ${ref} was listed and is not in the response; every listed entity must be written exactly once`,
      });
    }

    for (const ref of absent(
      brief.connectors.filter((c) => !c.seam).map((c) => c.ref),
      (rr.connectors ?? []).map((c) => c.ref)
    )) {
      out.push({
        path: `${at}.connectors`,
        message: `connector ${ref} was listed and is not in the response; a way out with no form is one the game cannot describe when a player walks up to it`,
      });
    }

    if (brief.goal && !rr.goal) {
      out.push({
        path: `${at}.goal`,
        message: `this room is the GOAL room and no "goal" was written for it`,
      });
    }

    const written = new Map((rr.encounters ?? []).map((e) => [e.ref, e]));
    for (const en of brief.encounters) {
      const er = written.get(en.ref);
      if (!er) {
        out.push({
          path: `${at}.encounters`,
          message: `encounter ${en.ref} was listed and is not in the response`,
        });
        continue;
      }
      // The mass and the specimens become separate entities, so each is
      // separately omittable: a response can carry the encounter, write the rank
      // and file, and quietly drop the named leader standing in front of them.
      if (en.group && !er.group) {
        out.push({
          path: `${at}.encounters.${en.ref}.group`,
          message: `encounter ${en.ref} lists a group of ${en.group.count} and the response wrote no "group" for it`,
        });
      }
      for (const d of en.distinct) {
        // Matched on kind AND member, which is the same join `applyContentPass`
        // makes to find a specimen's keywords. A specimen returned under a
        // member id that was not asked for loses its rolls as surely as one that
        // never came back at all, so both are worth the retry.
        const found = (er.distinct ?? []).some((x) => x.kind === d.kind && x.member === d.member);
        if (found) continue;
        out.push({
          path: `${at}.encounters.${en.ref}.distinct`,
          message:
            `encounter ${en.ref} lists a distinct ${d.kind}` +
            (d.member ? ` (member ${d.member})` : "") +
            ` and the response has no entry matching it`,
        });
      }
    }
  }

  return out;
}
