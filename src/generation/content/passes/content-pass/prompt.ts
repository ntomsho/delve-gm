/**
 * THE CONTENT PASS'S PROMPT: a chunk's payload rendered into the call, and the
 * standing instructions the model writes the region against.
 */

import { fixtureMenu } from "../../../floorplan/fixtures.ts";
import { POSITION_WORDS } from "../../../../shared/world/placement.ts";
import type { ContentPassPayload, KW } from "./build.ts";
import { CONNECTOR_HEIGHT, CONNECTOR_NAMING, CONTENT_PASS_TEMPLATE, fill, GOAL_INSTRUCTION } from "../../../../prompts/loader.ts";

// ===========================================================================
// RENDER
// ===========================================================================

const kwLine = (kw: KW) =>
  Object.entries(kw).map(([t, v]) => `${t}=${v}`).join("  |  ") || "--";

export function renderContentPassPrompt(p: ContentPassPayload): string {
  const L: string[] = [];
  L.push(p.instructions, "");
  L.push("=== DUNGEON FICTION (shared context) ===", p.dungeonContext, "");
  L.push(`=== ROOMS TO WRITE (${p.rooms.length}) ===`, "");

  for (const r of p.rooms) {
    L.push(`--- ${r.ref} ---`);
    L.push(`identity: ${r.identity}`);
    if (r.role !== "normal") L.push(`role: ${r.role}`);
    L.push(`depth: ${r.depth}   tension: ${r.tension}${r.isDeadEnd ? "   dead end" : ""}`);
    L.push(`headline: ${r.headline}${r.stacked ? ` + ${r.stacked}` : ""}`);
    L.push(`room keywords: ${kwLine(r.keywords)}`);
    // AS DRAWN. Placed directly under the identity, because the two are read
    // together: the identity says what the place was built as and this says
    // what it came out as, and where they disagree the drawing is the fact.
    if (r.geometry) L.push(`as drawn: ${r.geometry}`);

    for (const e of r.entities) {
      L.push(`entity [${e.ref}] ${e.kind} (${e.entity})${e.hidden ? " HIDDEN" : ""}: ${kwLine(e.keywords)}` + (e.note ? ` -- ${e.note}` : ""));
    }
    for (const d of r.detailCandidates) {
      L.push(`promotable detail [${kwLine(d.keywords)}] -- make it an entity only if a player would act on it`);
    }
    for (const c of r.connectors) {
      const where = c.wall ? ` in ${c.wall}` : "";
      if (c.surface) {
        L.push(
          `connector [${c.ref}] OUT OF THE DUNGEON${where} -- the way the party came in and the ` +
            `only way back to daylight; realise it from [${kwLine(c.surface)}] and say what ` +
            `it physically is. Name it as a thing, not as an exit.`
        );
        continue;
      }
      if (c.seam) {
        L.push(
          `way out [${c.ref}]${where} to ${c.toRef} (${c.toIdentity})${c.gated ? " GATED" : ""}` +
            ` -- WRITTEN ELSEWHERE. It leaves this region, so it is written by a later ` +
            `pass that can see both rooms. Count it among this room's ways out; do not ` +
            `name it, describe it, or return it.`
        );
        continue;
      }
      const flags = `${c.gated ? " GATED" : ""}${c.hidden ? " CONCEALED" : ""}`;
      const asks = [
        c.hidden
          ? "write it as the thing a person would walk past -- a seam, a draught, a panel that rings hollow -- not as a door"
          : "say what it physically is",
        c.gated ? "and what blocks it, from here" : "no barrier",
      ].join("; ");
      // The far side is named so the form can suit it -- a kennel wants a gate,
      // a vault wants a door -- and for no other reason. It must not reach the
      // connector's name; see CONNECTOR_NAMING.
      L.push(`connector [${c.ref}]${where} to ${c.toRef} (${c.toIdentity})${flags} -- ${asks}`);
    }
    for (const en of r.encounters) {
      L.push(`encounter [${en.ref}] ${en.tier}, ${en.affiliation}, currently ${en.activity}, disposition ${en.disposition}`);
      if (en.group) L.push(`    mass: ${en.group.count} x rank-and-file -> ONE consolidated entity, one stat block  [${kwLine(en.group.keywords)}]`);
      for (const d of en.distinct) {
        L.push(`    distinct ${d.kind}${d.member ? ` [${d.member}]` : ""}${d.isLeader ? " (leader)" : ""} -> its own entity  [${kwLine(d.keywords)}]`);
      }
      for (const line of en.template.split("\n")) L.push(`      ${line}`);
    }
    if (r.goal) {
      L.push(`GOAL HERE: reward "${r.goal.reward}" + mission "${r.goal.mission}".`);
      L.push(`  ${GOAL_INSTRUCTION}`);
    }
    if (r.gatedExits.length) L.push(`gated exits: ${r.gatedExits.join(", ")}`);
    if (r.openExits.length) L.push(`open exits: ${r.openExits.join(", ")}`);
    if (r.fixtures) {
      L.push(
        `fixtures: up to ${r.fixtures.cap}, or none` +
          (r.fixtures.corridor ? " -- A PASSAGE: starred kinds only" : "")
      );
    }
    L.push("");
  }

  if (p.borders.length) {
    L.push(`=== BORDER ROOMS -- context only, do NOT write ===`, "");
    for (const b of p.borders) L.push(`${b.ref}: ${b.identity} (${b.headline}) -- ${b.summary}; connects to ${b.connectsTo.join(", ")}`);
    L.push("");
  }

  L.push("=== RESPONSE FORMAT ===", p.responseSchema);
  return L.join("\n");
}

// ===========================================================================
// INSTRUCTIONS + SCHEMA
// ===========================================================================

export const CONTENT_PASS_INSTRUCTIONS = fill(CONTENT_PASS_TEMPLATE, {
  connectorNaming: CONNECTOR_NAMING,
  connectorHeight: CONNECTOR_HEIGHT,
  fixtureMenu: fixtureMenu(),
  positionWords: POSITION_WORDS.join(", "),
  goal: GOAL_INSTRUCTION,
});

