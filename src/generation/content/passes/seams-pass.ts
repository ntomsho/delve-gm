/**
 * SEAMS PASS  (once, after every chunk has landed)
 * ================================================
 *
 * The ways between regions. One call, and usually a short one -- two connectors
 * per chunk boundary, six or eight in a large dungeon.
 *
 * WHY IT IS NOT PART OF THE CONTENT PASS. A connector is one entity joining two
 * rooms, and it cannot be written honestly by somebody who has only seen one of
 * them: what it physically is depends on both ends, and which end of a stair is
 * the top is a fact about the pair. Within a chunk that is free -- six rooms are
 * named in a single response, so the writer has both. Across a chunk boundary it
 * is not: every chunk payload is built before any of them is applied, which is
 * what lets the chunks run in parallel, so at the moment a chunk is written the
 * room on the other side of its border has no name and no base.
 *
 * Before this pass existed, both chunks wrote those connectors -- each blind to
 * the other's room -- and the later apply silently overwrote the earlier one. The
 * name the player read was whichever chunk happened to have the higher number.
 *
 * So the chunks skip them (see `ownsConnector`) and they arrive here instead,
 * after the serial applies, with both rooms written and in front of the model.
 */

import { CONNECTOR_HEIGHT, CONNECTOR_NAMING, fill, SEAMS_PASS_SCHEMA, SEAMS_PASS_TEMPLATE } from "../../../prompts/loader.ts";
import type { ConnectorResponse } from "./content-pass/response.ts";
import type { Omission } from "../types.ts";
import type { EntityPassResult } from "../../../shared/world/entities.ts";
import { isSurfaceExit, properName } from "../../../shared/world/entities.ts";
import type { StockedDungeon } from "../types.ts";

// ===========================================================================
// PAYLOAD
// ===========================================================================

/** One end of a seam, as the chunk that owned it left it. */
export interface SeamRoomBrief {
  id: string;
  name: string;
  /** the room's standing description, written by its chunk */
  base: string;
}

export interface SeamBrief {
  /** the connector entity's id, which is also its ref in the response */
  ref: string;
  a: SeamRoomBrief;
  b: SeamRoomBrief;
  gated: boolean;
  hidden: boolean;
}

export interface SeamsPassPayload {
  dungeonContext: string;
  seams: SeamBrief[];
  instructions: string;
  responseSchema: string;
}

/**
 * Every way through that crosses a chunk boundary.
 *
 * The surface exit is not one: it joins a room to daylight, so there is no
 * second room to wait for and the entrance room's own chunk writes it.
 */
export function buildSeamsPassPayload(
  sd: StockedDungeon,
  ep: EntityPassResult,
  dungeonContext: string
): SeamsPassPayload {
  const chunkOf = new Map(sd.rooms.map((r) => [r.roomId, r.chunk]));
  const roomById = new Map(ep.rooms.map((r) => [r.id, r]));

  const brief = (id: string): SeamRoomBrief => {
    const room = roomById.get(id);
    return { id, name: room?.name ?? "", base: room?.base ?? "" };
  };

  const seams: SeamBrief[] = [];
  for (const c of ep.connectors) {
    if (isSurfaceExit(c) || c.endpointB === null) continue;
    if (chunkOf.get(c.endpointA) === chunkOf.get(c.endpointB)) continue;
    seams.push({
      ref: c.id,
      a: brief(c.endpointA),
      b: brief(c.endpointB),
      gated: c.conditional !== undefined,
      hidden: c.isHidden === true,
    });
  }

  return {
    dungeonContext,
    seams,
    instructions: SEAMS_PASS_INSTRUCTIONS,
    responseSchema: SEAMS_PASS_SCHEMA,
  };
}

// ===========================================================================
// RESPONSE
// ===========================================================================

/** Same shape a chunk returns for a connector -- one job, one schema. */
export interface SeamsPassResponse {
  connectors: ConnectorResponse[];
}

// ===========================================================================
// RENDER
// ===========================================================================

export function renderSeamsPassPrompt(p: SeamsPassPayload): string {
  const L: string[] = [];
  L.push(p.instructions, "");
  L.push("=== DUNGEON FICTION (shared context) ===", p.dungeonContext, "");
  L.push(`=== WAYS TO WRITE (${p.seams.length}) ===`, "");

  const oneLine = (s: string) => s.replace(/\s*\n\s*/g, " ");

  for (const s of p.seams) {
    L.push(`--- ${s.ref} ---`);
    L.push(`joins "${s.a.name}" -- ${oneLine(s.a.base)}`);
    L.push(`  to   "${s.b.name}" -- ${oneLine(s.b.base)}`);
    if (s.gated) L.push(`GATED -- also write what blocks it, true from both sides.`);
    if (s.hidden) {
      L.push(
        `CONCEALED -- write it as the thing a person would walk past: a seam, a ` +
          `draught, a panel that rings hollow. Not as a door.`
      );
    }
    L.push("");
  }

  L.push("=== RESPONSE FORMAT ===", p.responseSchema);
  return L.join("\n");
}

// ===========================================================================
// INSTRUCTIONS + SCHEMA
// ===========================================================================

export const SEAMS_PASS_INSTRUCTIONS = fill(SEAMS_PASS_TEMPLATE, {
  connectorNaming: CONNECTOR_NAMING,
  connectorHeight: CONNECTOR_HEIGHT,
});

// ===========================================================================
// COMPLETENESS
// ===========================================================================

/**
 * Every way through that was listed and did not come back.
 *
 * The same hole `contentPassOmissions` closes, in the pass that has always been
 * able to see it: `applySeamsPass` already reports `missing`, but it reports it
 * AFTER applying, when the call is spent and there is no retry left to take.
 * Asked before the response is accepted, the same question buys the retry.
 *
 * A seam that never comes back is the worst-placed gap in the dungeon: it is by
 * definition a way between two regions, so a player meets it while crossing from
 * one to the other, and it has no form for the game master to describe.
 */
export function seamsPassOmissions(payload: SeamsPassPayload, res: SeamsPassResponse): Omission[] {
  const written = new Set((res.connectors ?? []).map((c) => c.ref));
  return payload.seams
    .filter((s) => !written.has(s.ref))
    .map((s) => ({
      path: `connectors.${s.ref}`,
      message: `way through ${s.ref} (${s.a.name} to ${s.b.name}) was listed and is not in the response`,
    }));
}

// ===========================================================================
// APPLY
// ===========================================================================

export interface SeamsApplyResult {
  written: string[];
  /** listed but not returned -- these are left with no form at all */
  missing: string[];
}

/**
 * Write the name and form onto the connector entities.
 *
 * Anything not listed in the payload is ignored rather than applied: a chunk's
 * connectors were written by whoever could see both their rooms, and this pass
 * has no business overwriting them.
 */
export function applySeamsPass(
  res: SeamsPassResponse,
  payload: SeamsPassPayload,
  ep: EntityPassResult
): SeamsApplyResult {
  const listed = new Set(payload.seams.map((s) => s.ref));
  const connectorById = new Map(ep.connectors.map((c) => [c.id, c]));
  const written: string[] = [];

  for (const cr of res.connectors ?? []) {
    if (!listed.has(cr.ref)) continue;
    const conn = connectorById.get(cr.ref);
    if (!conn) continue;
    // A connector is named in the room card's Exits list, beside the ones the
    // content pass named — so it is capitalised on the same rule. See
    // `properName`.
    conn.name = properName(cr.name);
    (conn as { base?: string }).base = cr.form;
    conn.keywords = {};
    // A gated way keeps its placeholder condition when none came back: it must
    // never read as open just because nobody wrote what shuts it.
    if (cr.requirement) conn.conditional = cr.requirement;
    written.push(cr.ref);
  }

  return {
    written,
    missing: [...listed].filter((ref) => !written.includes(ref)),
  };
}
