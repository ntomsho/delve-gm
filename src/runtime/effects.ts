/**
 * WHAT A TURN DID TO THE CHARACTER.
 *
 * Read off the sheet before and after the commit, not off the diffs. Damage
 * reaches the sheet three ways — a diff the referee wrote, a creature's dice,
 * and consequences the applier performs on its own (an item destroyed at zero
 * quality, armour that came off because it became illegal) — and only the
 * before-and-after sees all three. The applier's events are consulted for the
 * one thing a comparison cannot tell: whether an item that is gone was
 * destroyed or merely left the pack.
 *
 * Shown as its own line under the narration (see `EffectsLine`), because prose
 * can bury "your left arm burns" in a sentence about the room and the player
 * reads past it. A number in the margin they cannot read past.
 *
 * Pure, so it is the same in the browser, on the server and in a test.
 */

import type { IItem, PlayerCharacter } from "../engine/index.ts";
import type { WorldEvent } from "./diffs/types.ts";
import type { DiceOutcome } from "./dice.ts";

export type Effect =
  | { kind: "hp"; from: number; to: number; max: number }
  | { kind: "damaged"; itemId: string; name: string; from: number; to: number; of: number }
  | { kind: "destroyed"; itemId: string; name: string }
  | { kind: "lost"; itemId: string; name: string }
  | { kind: "gained"; itemId: string; name: string }
  | { kind: "unequipped"; itemId: string; name: string }
  | { kind: "used"; itemId: string; name: string; from: string; to: string };

/** Whether an effect costs the player something — drawn in the warning colour. */
export function isLoss(e: Effect): boolean {
  switch (e.kind) {
    case "hp":
      return e.to < e.from;
    case "gained":
      return false;
    default:
      return true;
  }
}

const quality = (i: IItem): number | undefined => i.currentQuality ?? i.quality;

export function characterEffects(
  before: PlayerCharacter,
  after: PlayerCharacter,
  events: readonly WorldEvent[] = []
): Effect[] {
  const out: Effect[] = [];

  if (after.hp.current !== before.hp.current) {
    out.push({ kind: "hp", from: before.hp.current, to: after.hp.current, max: after.hp.max });
  }

  const now = new Map(after.inventory.map((i) => [i.id, i]));
  const was = new Map(before.inventory.map((i) => [i.id, i]));
  const destroyed = new Set(events.filter((e) => e.kind === "item-destroyed").map((e) => e.entityId));

  for (const old of before.inventory) {
    const cur = now.get(old.id);
    if (!cur) {
      out.push({ kind: destroyed.has(old.id) ? "destroyed" : "lost", itemId: old.id, name: old.name });
      continue;
    }
    const q0 = quality(old);
    const q1 = quality(cur);
    if (q0 !== undefined && q1 !== undefined && q1 < q0) {
      out.push({ kind: "damaged", itemId: cur.id, name: cur.name, from: q0, to: q1, of: cur.quality ?? q0 });
    }
    if (old.amount !== undefined && cur.amount !== undefined && old.amount !== cur.amount) {
      out.push({ kind: "used", itemId: cur.id, name: cur.name, from: old.amount, to: cur.amount });
    }
  }

  // Off the body but still in the pack. An item that left the pack entirely
  // has already been said above, and saying it twice is noise.
  for (const [slot, id] of Object.entries(before.equipped)) {
    if (!id || after.equipped[slot as keyof typeof after.equipped] === id) continue;
    const item = now.get(id);
    if (item) out.push({ kind: "unequipped", itemId: id, name: item.name });
  }

  for (const cur of after.inventory) {
    if (!was.has(cur.id)) out.push({ kind: "gained", itemId: cur.id, name: cur.name });
  }

  return out;
}

/** The effects as one line of plain text, for the journal and the transcript. */
export function describeEffects(effects: readonly Effect[]): string {
  return effects
    .map((e) => {
      switch (e.kind) {
        case "hp": {
          const d = e.to - e.from;
          return `${d > 0 ? "+" : "−"}${Math.abs(d)} HP (${e.from} → ${e.to})${e.to <= 0 ? ", dead" : ""}`;
        }
        case "damaged":
          return `${e.name} damaged (quality ${e.from} → ${e.to})`;
        case "destroyed":
          return `${e.name} destroyed`;
        case "lost":
          return `lost: ${e.name}`;
        case "gained":
          return `gained: ${e.name}`;
        case "unequipped":
          return `${e.name} came off`;
        case "used":
          return `${e.name}: ${e.from} → ${e.to}`;
      }
    })
    .join(" · ");
}

// ---------------------------------------------------------------------------
// THE DICE THAT HURT THEM
// ---------------------------------------------------------------------------

/** A creature's or the world's roll against the player, as the screen may show it. */
export interface FoeRoll {
  /** from the referee's own id for the roll — "wretched-2-attack" reads "Wretched 2 attack" */
  label: string;
  d20?: NonNullable<DiceOutcome["d20"]>;
  damage?: NonNullable<DiceOutcome["damage"]>;
}

/**
 * WHICH OF THE REFEREE'S DICE THE PLAYER SEES: the ones that hurt them, and only
 * on a turn they were hurt.
 *
 * The referee is told to ask for everything a turn MIGHT need in one batch and
 * discard what it does not use (see the `roll` tool), so a batch can hold a
 * creature attack that never happened in the fiction. Showing every roll would
 * sometimes show a hit with no wound behind it. On a turn where hit points
 * fell, attacks aimed at the player's armour are what did it; a loose damage
 * roll — a fall, a trap — is shown only when no attack landed to explain it.
 *
 * An attack "at the player" is one aimed at their armour defense — the same
 * test `playersOwnDice` uses in `referee.ts` to tell a creature striking them
 * from them striking out.
 */
export function foeRolls(rolls: readonly DiceOutcome[], playerArmor: number, hurt: boolean): FoeRoll[] {
  if (!hurt) return [];
  const label = (id: string) => {
    const words = id.replace(/[-_]+/g, " ").trim();
    return words.charAt(0).toUpperCase() + words.slice(1);
  };

  const attacks = rolls.filter((r) => r.kind === "attack" && r.d20 && r.targetDefense === playerArmor);
  const landed = attacks.some((r) => r.d20!.success);
  const loose = landed ? [] : rolls.filter((r) => r.kind === "damage" && r.damage);

  return [...attacks, ...loose].map((r) => ({
    label: label(r.id),
    ...(r.d20 ? { d20: r.d20 } : {}),
    ...(r.damage ? { damage: r.damage } : {}),
  }));
}

/** One line of plain text, for the journal. Never the number the d20 had to meet. */
export function describeFoeRolls(rolls: readonly FoeRoll[]): string {
  return rolls
    .map((r) => {
      const hit = r.d20 ? ` ${r.d20.total} → ${r.d20.success ? "hit" : "miss"}` : "";
      const dmg = r.damage ? ` · ${r.damage.expr} → ${r.damage.total}` : "";
      return `${r.label}:${hit}${dmg}`;
    })
    .join(" · ");
}
