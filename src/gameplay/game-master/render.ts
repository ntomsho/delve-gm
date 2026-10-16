/**
 * GROUND TRUTH, AS TEXT
 * =====================
 *
 * The character sheet and the current room, rendered fresh for every call. This
 * is the "re-rendered each turn" half of ARCHITECTURE §5.3, and it is the half
 * that matters: the entity `state` fields are the game's long-term memory, and
 * this is how they reach the game master. The transcript only carries the thread of
 * a conversation.
 *
 * TWO RULES SHAPE EVERY LINE HERE.
 *
 * **Ids are quoted, never invented.** Every entity is rendered with its id in
 * brackets, because the applier resolves what the game master writes and a diff
 * naming something that does not exist costs a retry. If it can be addressed,
 * its id is on the page.
 *
 * **The game master sees more than the player.** Concealed things are listed and
 * marked, because the game master has to know what is there to be found; creature
 * defenses are listed, because somebody has to set a difficulty. Neither ever
 * reaches `ui/` — see `RoomViewOptions`, which gates both.
 *
 * Built on the same `roomView` / `characterView` the screen uses, so the player
 * and the game master cannot end up looking at different rooms.
 */

import type { CharacterView } from "../view/character.ts";
import type { CensusEntry } from "../view/census.ts";
import { exitLabel, type RoomView } from "../view/room.ts";
import type { EntityView } from "../view/entities.ts";
import { positionPhrase } from "../../shared/world/placement.ts";
import type { TurnRecord } from "../state/store.ts";
import type { RolledOutcome } from "../turn.ts";
import type { DrawOffer } from "../mechanics/challenges.ts";
import { signed } from "../../shared/utils/format.ts";

const ABILITY_ORDER = ["str", "dex", "con", "int", "wis", "cha"] as const;


/** Drop empty lines a conditional field left behind. */
const lines = (xs: (string | undefined)[]): string => xs.filter((x) => x !== undefined).join("\n");

// ---------------------------------------------------------------------------
// THE CHARACTER
// ---------------------------------------------------------------------------

export function renderCharacter(pc: CharacterView): string {
  const abilities = ABILITY_ORDER.map((k) => {
    const a = pc.abilities.find((x) => x.key === k)!;
    return `${k.toUpperCase()} ${signed(a.bonus)} (defense ${a.defense})`;
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
    `Armour defense ${pc.armorDefense} · melee attack ${signed(pc.meleeBonus)} · ranged attack ${signed(pc.rangedBonus)}`,
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

/** An item's own numbers: how much is left, what it costs to carry, how worn it is, what it is worth. */
function itemDetail(i: EntityView): string | undefined {
  const bits = [
    // FIRST, because it is the field that runs out. A ration is food because of
    // its name and still there because of this, and the game master spends it by
    // writing the next value down — at nothing, the row goes.
    i.amount,
    i.slots !== undefined ? `${i.slots} slot${i.slots === 1 ? "" : "s"}` : undefined,
    i.quality ? `quality ${i.quality.current}/${i.quality.original}` : undefined,
    i.value ? `worth ${i.value} cp` : undefined,
    // Everything the `consult` roll and the suggestion rule need: what it is
    // about, and the count to pass back in.
    i.book
      ? i.book.exhausted
        ? `a book on ${i.book.subject || "no stated subject"} — READ OUT, nothing left in it`
        : `a book on ${i.book.subject || "no stated subject"} — book.uses ${i.book.uses}`
      : undefined,
  ].filter((x): x is string => x !== undefined);
  return bits.length ? bits.join(", ") : undefined;
}

/**
 * A carried thing, on the sheet.
 *
 * `composed` hangs under the row rather than beside it, and item `base` is not
 * here at all. That is a token decision and it was measured: a `base` averages
 * 453 characters, so ten carried things would be a thousand tokens every turn —
 * larger than the whole creature census, which exists to keep prompts small. `composed` is nearly free by comparison, because the 122 standard
 * equipment templates carry `base: ""` and `mintCommon` falls `composed` back to
 * `base`; carried starting gear renders its name and its amount and nothing
 * else, and a found "Wheel of pale cheese" is exactly what the field is for.
 */
function renderItemLine(i: EntityView, indent = ""): string {
  const detail = itemDetail(i);
  const head = `[${i.id}] ${i.name}${detail ? ` — ${detail}` : ""}`;
  const described = i.composed?.trim();
  return described
    ? `${head}\n${indent}    ${described.replace(/\s*\n\s*/g, " ")}`
    : head;
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
          ` · armour defense ${e.combat.armorDefense} · attack ${signed(e.combat.attackBonus)}` +
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
  // send the player back to the Laboratory, a game master holding only ids has to
  // guess which one that is, and it guesses wrong. The name is withheld until
  // they have been through, which is also exactly when they can ask for it by
  // name — so what the game master can route to and what the player can say are the
  // same set. `exitLabel` is what the player's panel shows; it is repeated here
  // verbatim so the game master can match their words to it.
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
            // The same words a concealed thing standing in the room carries —
            // see `renderEntity`. Without it a secret door arrived here dressed
            // exactly like an open one, and the room's ways-out list is the
            // thing the game master counts when it writes "three ways lead out".
            x.isHidden
              ? `NOT YET FOUND BY THE PLAYER — do not describe it, do not count it ` +
                `among the ways out, and do not hint at it except through a clue they find`
              : undefined,
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
    // the prose above and this line cannot disagree. It is here so the game master
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
// EVERYTHING ELSE THAT IS ALIVE DOWN HERE
// ---------------------------------------------------------------------------

/**
 * THE CENSUS. Every creature that is not in the room the player is standing in,
 * one line each, on every call.
 *
 * The name is the definition: creatures the player is with are twenty lines up
 * in `renderRoom` already, carrying `base`, `state`, `composed`, `activity`,
 * defenses and hit points. A census line for them would be a second and poorer
 * copy of a thing already on the page.
 *
 * WHAT EACH LINE CARRIES, AND WHY.
 *
 *   the id       so a diff can name it — the rule the whole file is built on
 *   name, count  a count of zero is a group that is gone, and is filtered out
 *   room, name   where it is, and where it can be sent
 *   rooms away   what replaces handing over the graph; see `roomDistances`
 *   WOUNDED      rather than hit points, which are wanted only in front of the
 *                player, where `renderRoom` supplies them
 *   activity     the field this whole thing exists to let the game master rewrite
 *
 * EVERY ROOM IS NAMED, AND UNVISITED ONES ARE MARKED. `renderRoom`'s ways-out
 * list deliberately withholds a far room's name until the player has been
 * through, so that what the game master can route to and what the player can say
 * are the same set. This does not follow that rule, and the departure is the
 * point: the game master is being asked to judge what the CHARACTER plausibly
 * knows, and it cannot make that call from a redacted page. The marker keeps
 * both things true at once — it sees the name, and it sees that the player
 * could not say it.
 *
 * THIS IS GAME-MASTER-ONLY KNOWLEDGE, in the same class as creature defenses and
 * concealed things (see the head of this file). It is the one thing the runtime
 * hands over that the character does not have.
 */
export function renderOtherRoomCreatures(census: CensusEntry[]): string {
  if (census.length === 0) {
    return lines([
      `### Every other creature in this dungeon`,
      ``,
      `- (none — everything alive down here is in the room with them)`,
    ]);
  }

  return lines([
    `### Every other creature in this dungeon`,
    ``,
    `Not in the room with the player. Yours to change — their \`state\`, their`,
    `\`activity\`, where they are heading — and NOT to describe or narrate: the`,
    `player is not there to see any of it.`,
    ``,
    ...census.map((c) => {
      const where = [
        `in [${c.roomId}] "${c.roomName}"`,
        c.roomsAway === undefined
          ? `NO WAY LEADS THERE from where the player stands`
          : `${c.roomsAway} room${c.roomsAway === 1 ? "" : "s"} away`,
        c.wounded ? `WOUNDED` : undefined,
        c.roomVisited ? undefined : `THE PLAYER HAS NOT BEEN HERE`,
      ].filter((x): x is string => x !== undefined);

      const head = `- [${c.id}] ${c.name}${c.count > 1 ? ` ×${c.count}` : ""} — ${where.join(" · ")}`;
      return c.activity ? `${head}\n  doing: ${c.activity.replace(/\s*\n\s*/g, " ")}` : head;
    }),
  ]);
}

// ---------------------------------------------------------------------------
// THE DICE, AND WHAT HAPPENED BEFORE
// ---------------------------------------------------------------------------

/**
 * The player's own roll, as the step-5 input.
 *
 * The DC is on the page. The game master set it and is the one deciding what the
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
    `d20 ${dice} ${signed(o.spec.bonus)} = **${o.total}** against ${o.spec.dc} — **${o.success ? "SUCCESS" : "FAILURE"}**`,
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
 * Completed turns, as structure rather than prose — ARCHITECTURE §5.3. The paragraphs are
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

// ---------------------------------------------------------------------------
// WHAT THIS DUNGEON STILL HAS TO GIVE
// ---------------------------------------------------------------------------

/**
 * The reserve, as a menu.
 *
 * The dungeon places about four keys before play and holds the rest back,
 * because a key written into a room before anyone walked in cannot be about
 * what the player turned out to be doing. This is that reserve: the game master
 * picks one when the fiction offers a place to put it, and the applier refuses
 * anything not on this list.
 *
 * THE FACTS ARE QUOTED EXACTLY and must be handed over exactly, because the
 * same wording is what gets written onto the thing the fact is about — see
 * `recordFact`. What the game master invents is the OBJECT and the moment, never
 * the fact.
 *
 * Trimmed in code before it gets here, nearest first. See `offerDraws`.
 */
export function renderDraws(offers: DrawOffer[]): string {
  if (offers.length === 0) return "";
  return lines([
    `## What this dungeon still has to give`,
    ``,
    `Any ONE of these may be handed over this turn, through \`draw\`, IF the`,
    `player has earned it: found in the rubble they were digging through, given`,
    `by the thing they talked down, carried by the thing they killed. Something`,
    `that simply appears in a room they already searched is a broken promise.`,
    `Most turns should take none of them.`,
    ``,
    `Quote the fact EXACTLY as written. Invent the object and the moment; never`,
    `the fact.`,
    ``,
    ...offers.map((o) => {
      const where = o.here ? "HERE, in this room" : "elsewhere in the dungeon";
      const how = o.kind === "object" ? "an object they can carry" : "something they are told";
      return `- [${o.challengeId}] ${o.about}, ${where} — as ${how}
  the fact: "${o.fact}"`;
    }),
  ]);
}

/**
 * Facts the player has already been told, so the game master stops offering them.
 *
 * Short by construction: it is what a run has actually learned, and a long run
 * learns a dozen things.
 */
export function renderKnown(known: KnownFact[]): string {
  if (known.length === 0) return "";
  return lines([
    `## What the player has worked out`,
    ``,
    `Already written onto the things themselves, and true from here on.`,
    ``,
    ...known.map((k) => `- ${k.about}: "${k.fact}"`),
  ]);
}

export interface KnownFact {
  about: string;
  fact: string;
}
