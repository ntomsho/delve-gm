/**
 * THE OUTLINE'S PROMPTS: the draft rendered for the model, one line per thing, so
 * nothing needs looking up elsewhere.
 */

import type { InhabitantGroup } from "../../blueprint.ts";
import type { MonsterSeed, NpcSeed } from "../../../../shared/world/seeds.ts";
import type { ValidationIssue } from "../../../../llm/validation.ts";
import {
  fill,
  OUTLINE_POLISH_TEMPLATE,
  OUTLINE_REPAIR_TEMPLATE,
  OUTLINE_TEMPLATE,
} from "../../../../prompts/loader.ts";
import { CLASSES } from "../../../floorplan/room-size.ts";
import { CHALLENGE_LABEL } from "../../challenges.ts";
import type { DungeonPassResponse } from "../dungeon-pass.ts";
import { MAX_POLISH_EDITS, unusedRefs, type Outline } from "./response.ts";
import type { ContentCard, OutlineDraft, OutlineRoom } from "./roll.ts";

function monsterLine(m: MonsterSeed): string {
  const body = m.animals ? `${m.animals.join(" and ")}-like` : m.humanoidSeed ? `humanoid, ${m.humanoidSeed.result}` : m.silhouette;
  return [
    body,
    ...m.traitsAndAbilities.map((x) => x.result),
    ...m.featuresAndMutations.map((x) => x.result),
    `tactic: ${m.tactic}`,
    `personality: ${m.personality}`,
  ].join("; ");
}

function npcLine(n: NpcSeed): string {
  return [
    `${n.name}${n.isLeader ? " (leader)" : ""}`,
    `${n.origin.kind === "role" ? "role" : "background"}: ${n.origin.result}`,
    `looks: ${n.appearance}`,
    `personality: ${n.personality}`,
    `wants: ${n.goal}`,
  ].join("; ");
}

const GOAL_TIE: Record<string, string> = {
  same: "wants the same thing the player does",
  opposed: "is opposed to the player's goal",
};

/** How a group stands toward the goal, for placing its base. */
function groupLine(g: InhabitantGroup, written: DungeonPassResponse["groups"][number] | undefined, i: number): string {
  const head = `G${i + 1} "${written?.name ?? "unnamed"}": ${written?.base ?? ""}`;
  if (g.kind === "monsters") return `${head}\n   rolled: ${monsterLine(g.monster)}`;
  const goal = GOAL_TIE[g.goalBranch] ?? `has its own goal: ${g.ownGoal}`;
  return `${head}\n   rolled: ${g.faction}; ${g.traits.join("; ")}; ${goal}\n   people: ${g.npcs.map(npcLine).join(" | ")}`;
}

/** The dungeon being built, as the dungeon pass wrote it. The goal has its own section. */
export function renderDungeon(draft: OutlineDraft, pass: DungeonPassResponse): string {
  const groups = draft.blueprint.inhabitants.map((g, i) =>
    groupLine(g, pass.groups.find((w) => w.id === g.id), i)
  );
  return [
    `Name: ${pass.name}`,
    `Theme: ${pass.theme}`,
    `History: ${pass.history}`,
    `Opening, as the player reads it: ${pass.openingProse}`,
    `Who lives here:`,
    ...groups,
  ].join("\n");
}

function renderGoal(pass: DungeonPassResponse): string {
  return `What the player is told: ${pass.goal.summary}\nWhat counts as achieving it: ${pass.goal.spec}`;
}

function roomLine(draft: OutlineDraft, r: OutlineRoom): string {
  const neighbours = r.ways.map((ref) => {
    const w = draft.ways.find((x) => x.ref === ref)!;
    const flags = `${w.connector.gated ? " GATED" : ""}${w.connector.hidden ? " CONCEALED" : ""}`;
    return `${ref} to ${w.a === r.ref ? w.b : w.a}${flags}`;
  });
  return [
    r.ref,
    r.role === "entrance" ? "ENTRANCE (pre-assigned: no card)" : r.role === "goal" ? "GOAL ROOM (pre-assigned)" : "",
    r.passage ? `PASSAGE, already a ${r.identity}${r.detail ? ` (${r.detail})` : ""}` : "",
    r.entranceFeature ? `the way in: ${r.entranceFeature}` : "",
    r.sizeClass ?? "",
    `depth ${r.depth}`,
    r.isDeadEnd ? "dead end" : "",
    neighbours.join(", "),
  ]
    .filter(Boolean)
    .join(" | ");
}

function cardLine(draft: OutlineDraft, c: ContentCard): string {
  const raises = draft.challenges
    .filter((x) => x.card === c.ref)
    .map((x) => `${x.ref} ${CHALLENGE_LABEL[x.challenge.kind]}: ${x.challenge.property}`);
  const tail = raises.length ? `\n   raises: ${raises.join("; ")}` : "";

  if (c.headline === "special") {
    const s = c.special!;
    const what =
      s.kind === "obstacle"
        ? `obstacle: ${s.subject}, ${s.behaviour}`
        : s.trapTrigger
          ? `trap: set off by ${s.trapTrigger}, ${s.trapEffect}`
          : `hazard: ${s.hazard}`;
    return `${c.ref} special, ${what}${tail}`;
  }
  if (c.headline === "quiet") {
    return c.clue ? `${c.ref} quiet, clue: ${c.clue}. You say what it points at.` : `${c.ref} quiet, nothing here: a breather.`;
  }

  const m = c.mobile!;
  const groupRef = m.groupIndex !== undefined ? `G${m.groupIndex + 1}` : undefined;
  const who = m.isBase
    ? `BASE of ${groupRef}, where this group lives`
    : groupRef
      ? `${m.minion ?? "outpost"} of ${groupRef}`
      : "unaffiliated";
  const what = m.monster ? monsterLine(m.monster) : m.npc ? npcLine(m.npc) : "";
  return `${c.ref} creature, ${who}${what ? `: ${what}` : ""}; ${m.activity}; ${m.disposition}${tail}`;
}

/** The map and the dice: everything the outline chooses among. */
export function renderDraft(draft: OutlineDraft): string {
  const L: string[] = [];
  L.push(`=== ROOMS (${draft.rooms.length}) ===`, ...draft.rooms.map((r) => roomLine(draft, r)), "");
  L.push("=== ROUTES FROM THE ENTRANCE TO THE GOAL ===");
  L.push(...draft.routes.map((route) => route.join(" -> ")), "");
  L.push(`=== ROOM FICTIONS (${draft.fictions.length}) ===`);
  for (const f of draft.fictions) {
    L.push(
      `${f.ref}${f.mandatory ? " MANDATORY" : ""}: ${f.identity}${f.detail ? ` (${f.detail})` : ""}` +
        (f.fits.length < CLASSES.length ? ` | fits only: ${f.fits.join(", ")}` : "")
    );
  }
  L.push("", `=== CARDS (${draft.cards.length}) ===`, ...draft.cards.map((c) => cardLine(draft, c)), "");
  const other = draft.challenges.filter((c) => !c.card);
  L.push("=== OTHER CHALLENGES A KEY COULD ANSWER ===");
  L.push(...other.map((c) => `${c.ref} ${CHALLENGE_LABEL[c.challenge.kind]}: ${c.challenge.property}${wayOf(draft, c.challenge.targetId)}`));
  return L.join("\n");
}

function wayOf(draft: OutlineDraft, connectorId: string): string {
  const w = draft.ways.find((x) => x.connector.id === connectorId);
  return w ? ` (${w.ref})` : "";
}

export function renderOutlinePrompt(draft: OutlineDraft, pass: DungeonPassResponse): string {
  const [fewest, most] = draft.keyRange;
  const head = fill(OUTLINE_TEMPLATE, {
    dungeon: renderDungeon(draft, pass),
    goal: renderGoal(pass),
    goalRoom: draft.goalRoom,
    keyRange: `${fewest} to ${most}`,
  });
  return `${head}\n\n${renderDraft(draft)}`;
}

export function renderOutlineRepair(draft: OutlineDraft, outline: Outline, missing: readonly ValidationIssue[]): string {
  const unused = unusedRefs(draft, outline);
  return fill(OUTLINE_REPAIR_TEMPLATE, {
    violations: missing.map((m) => `- ${m.message}`).join("\n"),
    unused: `Still unused: fictions ${unused.fictions.join(", ") || "none"}; cards ${unused.cards.join(", ") || "none"}.`,
  });
}

export function renderOutlineForReview(o: Outline): string {
  const L: string[] = ["=== THE OUTLINE ==="];
  for (const r of o.rooms) {
    L.push(`${r.ref}: fiction ${r.fiction} | card ${r.card}`);
    L.push(`  story: ${r.story}`, `  journey: ${r.journey}`, `  story feature: ${r.storyFeature}`);
  }
  L.push("Ways:", ...o.ways.map((w) => `  ${w.ref}: ${w.form}`));
  L.push(`Objective: ${o.objective.type}, ${o.objective.form}`);
  if (o.clues.length) L.push("Clues:", ...o.clues.map((c) => `  ${c.card} points at ${c.pointsAt}`));
  L.push("Keys:", ...o.keys.map((k) => `  ${k.challenge}: ${k.key}`));
  if (o.fictionChanges.length) {
    L.push("Changes to the fiction:", ...o.fictionChanges.map((c) => `  ${c.field}${c.group !== "none" ? ` ${c.group}` : ""}: ${c.text} (${c.why})`));
  }
  return L.join("\n");
}

export function renderPolishPrompt(draft: OutlineDraft, pass: DungeonPassResponse, outline: Outline): string {
  const head = fill(OUTLINE_POLISH_TEMPLATE, { maxEdits: String(MAX_POLISH_EDITS) });
  return [
    head,
    "",
    "=== THE DUNGEON ===",
    renderDungeon(draft, pass),
    "",
    "=== THE PLAYER'S GOAL ===",
    renderGoal(pass),
    "",
    renderDraft(draft),
    "",
    renderOutlineForReview(outline),
  ].join("\n");
}
