/**
 * GROUND TRUTH, AS TEXT
 * =====================
 *
 * The character sheet and the current room, rendered fresh for every call. This
 * is the "re-rendered each turn" half of BUILD-PLAN §4.4, and it is the half
 * that matters: the entity `state` fields are the game's long-term memory, and
 * this is how they reach the referee. The transcript only carries the thread of
 * a conversation.
 *
 * TWO RULES SHAPE EVERY LINE HERE.
 *
 * **Ids are quoted, never invented.** Every entity is rendered with its id in
 * brackets, because the applier resolves what the referee writes and a diff
 * naming something that does not exist costs a retry. If it can be addressed,
 * its id is on the page.
 *
 * **The referee sees more than the player.** Concealed things are listed and
 * marked, because the referee has to know what is there to be found; creature
 * defenses are listed, because somebody has to set a difficulty. Neither ever
 * reaches `ui/` — see `RoomViewOptions`, which gates both.
 *
 * Built on the same `roomView` / `characterView` the screen uses, so the player
 * and the referee cannot end up looking at different rooms.
 */

import { exitLabel, type CharacterView, type EntityView, type RoomView } from "../../store/selectors.ts";
import { positionPhrase } from "../../engine/index.ts";
import type { TurnRecord } from "../../store/game.ts";
import type { RolledOutcome } from "../turn.ts";

const ABILITY_ORDER = ["str", "dex", "con", "int", "wis", "cha"] as const;

const sign = (n: number) => (n >= 0 ? `+${n}` : `${n}`);

/** Drop empty lines a conditional field left behind. */
const lines = (xs: (string | undefined)[]): string => xs.filter((x) => x !== undefined).join("\n");

// ---------------------------------------------------------------------------
// THE CHARACTER
// ---------------------------------------------------------------------------

export function renderCharacter(pc: CharacterView): string {
  const abilities = ABILITY_ORDER.map((k) => {
    const a = pc.abilities.find((x) => x.key === k)!;
    return `${k.toUpperCase()} ${sign(a.bonus)} (defense ${a.defense})`;
  }).join(" · ");

  const carried = pc.inventory.length
    ? pc.inventory.map((i) => `- ${renderItemLine(i)}`).join("\n")
    : "- (nothing)";

  const equipped = pc.equipped
    .map((e) => `${e.slot}: ${e.item ? `[${e.item.id}] ${e.item.name}` : "—"}`)
    .join(" · ");

  return lines([
    `## The player character`,
    ``,
    `**${pc.name}** — level ${pc.level}, referred to in diffs as \`player\`.`,
    `Hit points **${pc.hp.current}/${pc.hp.max}**.`,
    abilities,
    `Armour defense ${pc.armorDefense} · melee attack ${sign(pc.meleeBonus)} · ranged attack ${sign(pc.rangedBonus)}`,
    `Inventory slots ${pc.slots.used}/${pc.slots.capacity}${pc.slots.overburdened ? " — OVERBURDENED" : ""}`,
    pc.conditions.length ? `Conditions: ${pc.conditions.join(", ")}` : `Conditions: none`,
    ``,
    `Carrying:`,
    carried,
    ``,
    `Equipped — ${equipped}`,
    ``,
    `Traits: ${Object.entries(pc.traits)
      .map(([k, v]) => `${k} ${v}`)
      .join(", ")}`,
  ]);
}

/** An item's own numbers: what it costs to carry, and how worn it is. */
function itemDetail(i: EntityView): string | undefined {
  const bits = [
    i.slots !== undefined ? `${i.slots} slot${i.slots === 1 ? "" : "s"}` : undefined,
    i.quality ? `quality ${i.quality.current}/${i.quality.original}` : undefined,
  ].filter((x): x is string => x !== undefined);
  return bits.length ? bits.join(", ") : undefined;
}

function renderItemLine(i: EntityView): string {
  const detail = itemDetail(i);
  return `[${i.id}] ${i.name}${detail ? ` — ${detail}` : ""}`;
}

// ---------------------------------------------------------------------------
// THE ROOM
// ---------------------------------------------------------------------------

/**
 * How a thing stands with the player, in three words.
 *
 * The distinction the room-entry step turns on: never encountered means both
 * fields are yours to write; stale means the state moved while they were
 * elsewhere and only the description is owed.
 */
function standing(e: { composed?: string; state?: string; needUpdate: boolean }): string {
  if (e.composed === undefined && e.state === undefined) return "NEVER ENCOUNTERED";
  if (e.needUpdate || e.composed === undefined) return "DESCRIPTION STALE";
  return "described, unchanged";
}

function renderEntity(e: EntityView, indent = ""): string {
  const head: string[] = [`[${e.id}] ${e.name} — ${e.kind}`];
  if (e.count !== undefined && e.count > 1) head.push(`×${e.count}`);
  if (e.hp) head.push(`hp ${e.hp.current}/${e.hp.max}`);
  if (e.isHidden) head.push("NOT YET FOUND BY THE PLAYER");

  // Where it stands, in the words the content pass chose and the map drew to.
  // On the head line rather than in a field of its own, because it is part of
  // identifying the thing — "the altar at the far end" is how a player refers
  // to it when there are two altars.
  if (e.position) head.push(positionPhrase(e.position));

  const out = [`${indent}- ${head.join(" · ")} (${standing(e)})`];
  const field = (label: string, value?: string) =>
    value === undefined || value.trim() === ""
      ? undefined
      : `${indent}    ${label}: ${value.replace(/\s*\n\s*/g, " ")}`;

  out.push(
    ...[
      field("base", e.base),
      field("state", e.state),
      field("composed", e.composed),
      e.activity ? `${indent}    doing: ${e.activity}` : undefined,
      e.combat
        ? `${indent}    defenses ${ABILITY_ORDER.map((a) => `${a} ${e.combat!.defenses[a]}`).join(" ")}` +
          ` · armour defense ${e.combat.armorDefense} · attack ${sign(e.combat.attackBonus)}` +
          ` · damage ${e.combat.damage} · morale ${e.combat.morale}`
        : undefined,
      itemDetail(e) ? `${indent}    ${itemDetail(e)}` : undefined,
    ].filter((x): x is string => x !== undefined && x.trim() !== "")
  );

  for (const child of e.contains) out.push(renderEntity(child, `${indent}  `));
  return out.join("\n");
}

export function renderRoom(room: RoomView): string {
  const contents = room.contents.length
    ? room.contents.map((c) => renderEntity(c)).join("\n")
    : "- (nothing in it)";

  // The destination is NAMED, not just id'd. A bare uuid is unusable: asked to
  // send the player back to the Laboratory, a referee holding only ids has to
  // guess which one that is, and it guesses wrong. The name is withheld until
  // they have been through, which is also exactly when they can ask for it by
  // name — so what the referee can route to and what the player can say are the
  // same set. `exitLabel` is what the player's panel shows; it is repeated here
  // verbatim so the referee can match their words to it.
  const exits = room.exits.length
    ? room.exits
        .map((x) => {
          const bits = [
            x.form ? x.form.replace(/\s*\n\s*/g, " ") : undefined,
            x.wall ? `in ${x.wall}` : undefined,
            // In the same order and with the same mark the player's panel gives
            // it — "the way you came" is a thing they will say, and it has to
            // resolve to the same door for both of you. Not on the surface exit,
            // whose own line already says it in more words.
            x.cameFrom && !x.surface ? `THE WAY THEY CAME IN` : undefined,
            x.blocked ? `BLOCKED: ${x.requirement ?? "something is in the way"}` : undefined,
            x.surface
              ? `LEADS OUT OF THE DUNGEON — the way they came in, and the way home. ` +
                `Walking through it ENDS THE RUN: commit nextStage "departed"`
              : x.toKnown
                ? `leads to [${x.toRoomId}] ${x.toRoomName}, which they have been to`
                : `leads to [${x.toRoomId}], somewhere they have not been`,
          ].filter(Boolean);
          return `- [${x.connectorId}] "${exitLabel(x)}" — ${bits.join(" · ")}`;
        })
        .join("\n")
    : "- (no way out of this room)";

  return lines([
    `## The room the player is standing in`,
    ``,
    `[${room.id}] **${room.name}** (${standing(room)})`,
    room.base ? `base: ${room.base.replace(/\s*\n\s*/g, " ")}` : undefined,
    room.state ? `state: ${room.state.replace(/\s*\n\s*/g, " ")}` : undefined,
    // Labelled where it is read, not just in the playbook. This is the field
    // the player has actually seen, and the one a contradiction gets measured
    // against — so it says so, next to the text.
    room.composed
      ? `composed — THE PLAYER HAS READ THIS; it binds you: ${room.composed.replace(/\s*\n\s*/g, " ")}`
      : undefined,
    // AS DRAWN, and it is the map the player is looking at.
    //
    // The same sentence the content pass was given when it wrote this room, so
    // the prose above and this line cannot disagree. It is here so the referee
    // can say where in the room something happens and have the map corroborate
    // it — the half of the loop the fixtures are the other half of.
    room.geometry
      ? lines([
          ``,
          `### As drawn on the map`,
          room.geometry,
          `The compass here is the MAP's, not the party's: north is north wherever they are ` +
            `facing. Say "the north wall"; never "on your left", which you have no way to know.`,
        ])
      : undefined,
    ``,
    `### In it`,
    contents,
    ``,
    `### Ways out`,
    exits,
  ]);
}

// ---------------------------------------------------------------------------
// THE DICE, AND WHAT HAPPENED BEFORE
// ---------------------------------------------------------------------------

/**
 * The player's own roll, as the step-5 input.
 *
 * The DC is on the page. The referee set it and is the one deciding what the
 * result means; withholding it here would only invite it to guess whether the
 * roll cleared.
 */
export function renderRoll(o: RolledOutcome): string {
  const dice = o.rolled.length > 1 ? `[${o.rolled.join(", ")}] keeping ${o.kept}` : `${o.kept}`;
  return lines([
    `## The roll the player just took`,
    ``,
    `They attempted: ${o.spec.description}`,
    `${o.spec.kind} on ${o.spec.ability.toUpperCase()}, edge ${o.spec.edge}` +
      (o.spec.targetId ? `, against [${o.spec.targetId}]` : ""),
    `d20 ${dice} ${sign(o.spec.bonus)} = **${o.total}** against ${o.spec.dc} — **${o.success ? "SUCCESS" : "FAILURE"}**`,
    o.nat20 ? `Natural 20: the defender's armour loses a point of currentQuality.` : undefined,
    o.nat1 ? `Natural 1: the attacker's weapon loses a point of currentQuality.` : undefined,
    o.damage
      ? `Damage rolled: ${o.damage.expr} → [${o.damage.rolls.join(", ")}] = **${o.damage.total}**`
      : undefined,
    ``,
    `These are the only numbers you have for this action. Use them; do not restate them differently.`,
  ]);
}

/**
 * Completed turns, as structure rather than prose — §4.4. The paragraphs are
 * gone; what a finished turn owes the next one is a few facts.
 */
export function renderRecords(records: TurnRecord[]): string {
  if (records.length === 0) return "";
  return lines([
    `## Turns already finished`,
    ``,
    ...records.map((r) => {
      const bits = [
        `turn ${r.turn}`,
        `action: ${r.action}`,
        r.target ? `target: [${r.target}]` : undefined,
        r.roll ? `${r.roll.kind} roll ${r.roll.total} — ${r.roll.success ? "success" : "failure"}` : undefined,
        `${r.diffsApplied} change${r.diffsApplied === 1 ? "" : "s"} applied`,
      ].filter(Boolean);
      return `- ${bits.join(" · ")}\n  outcome: ${r.outcome.replace(/\s*\n\s*/g, " ")}`;
    }),
  ]);
}
