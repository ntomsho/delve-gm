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

import { CONNECTOR_HEIGHT, CONNECTOR_NAMING, type ConnectorResponse } from "./dungeon-content-pass.ts";
import type { EntityPassResult } from "./dungeon-entities-pass.ts";
import { isSurfaceExit } from "./dungeon-entities.ts";
import type { StockedDungeon } from "./dungeon-rooms-loop.ts";

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

const SEAMS_PASS_INSTRUCTIONS = `You are writing the ways through between regions of a dungeon whose rooms are
already written. Each one below is a single way through joining two rooms, and
both of those rooms are quoted with the description that has already been
committed to. Nothing else about the dungeon is yours to change.

FOR EACH WAY THROUGH
- name: what the thing physically is. ${CONNECTOR_NAMING}
- form: what it IS, in a sentence or two -- a door, a stair, a crawl, a flooded
  culvert, a rent in the floor. Make it suit BOTH rooms it joins: you can see
  both, which is the whole reason these were held back until now. A vault wants a
  door; a kennel wants a gate; two rooms at different depths in the water want
  something that explains the difference.
  ${CONNECTOR_HEIGHT}
- requirement: GATED ways only -- what stands in the way. Phrase it so it reads
  correctly from either side, since a player can meet it from either. Do not
  invent the key.

HARD RULES
1. Return exactly the ways listed, each once, with its ref exactly as given. Do
   not add one, and do not leave one out: a way with no form is a way the game
   cannot describe when a player walks up to it.
2. Do not contradict either room's description. They are written and committed.
3. Do not describe the rooms. You are writing what is BETWEEN them.
4. Write prose, not notes.`;

const SEAMS_PASS_SCHEMA = `Return JSON only, no prose outside it:

{
  "connectors": [
    {
      "ref": "<exactly as given>",
      "name": "<what it is, naming neither room>",
      "form": "<what it physically is; which room is above, where it changes level>",
      "requirement": "<gated only: what blocks it>"
    }
  ]
}`;

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
    conn.name = cr.name;
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
