/**
 * WHAT THE OUTLINE ANSWERS: its shape, the rules code holds it to, how a repair
 * merges in, and the polish edits.
 *
 * References and short prose only. The model never writes a number here, and code
 * places nothing until it passes `outlineViolations`.
 */

import { z } from "zod";
import type { ValidationIssue } from "../../../../llm/validation.ts";
import { nonEmpty } from "../../../../shared/utils/schema.ts";
import type { DungeonPassResponse } from "../dungeon-pass.ts";
import type { OutlineDraft } from "./roll.ts";

// ---------------------------------------------------------------------------
// SHAPE
// ---------------------------------------------------------------------------

const fictionFields = ["theme", "history", "opening", "groupName", "groupBase"] as const;
const keyKinds = ["object", "information"] as const;

/** The `challenge` of a key the goal needs, which answers no rolled challenge. */
export const GOAL_KEY = "goal";

const fictionChange = z.object({
  field: z.enum(fictionFields),
  /** which group, for `groupName` and `groupBase`; otherwise "none" */
  group: nonEmpty,
  text: nonEmpty,
  why: nonEmpty,
});

/** What the model writes where a room has no fiction, card or story feature. */
export const NONE = "none";
const has = (v: string | undefined): v is string => !!v && v !== NONE;

/**
 * NOTHING HERE IS OPTIONAL, because models leave optional fields out: Sonnet 5.5
 * omitted every fiction and card from its first outline. "none" says a room has
 * none, and saying so is the model's decision rather than an oversight.
 *
 * The lists may be empty because a repair comes back through this same schema,
 * carrying only what it replaces. `outlineViolations` is what says a whole outline
 * has everything.
 */
export const outlineSchema = z.object({
  rooms: z.array(
    z.object({
      ref: nonEmpty,
      /** a fiction's ref, or "none" on a passage, which has its identity already */
      fiction: nonEmpty,
      /** a card's ref, or "none" on the entrance and on a room left empty */
      card: nonEmpty,
      story: nonEmpty,
      journey: nonEmpty,
      /** one thing in the room, usually something the player can use, or "none" */
      storyFeature: nonEmpty,
    })
  ),
  ways: z.array(z.object({ ref: nonEmpty, form: nonEmpty })),
  objective: z.object({
    type: z.enum(["Item", "RoomFeature", "Creature"]),
    form: nonEmpty,
    /** a named person who stands in the goal room for it, or "none" */
    person: nonEmpty,
  }),
  clues: z.array(z.object({ card: nonEmpty, pointsAt: nonEmpty })),
  keys: z.array(
    z.object({
      /** a challenge's ref, or "goal" for something the goal needs */
      challenge: nonEmpty,
      kind: z.enum(keyKinds),
      key: nonEmpty,
      /** where it is, by ref */
      room: nonEmpty,
      /** what the player has to do to get it */
      gotBy: nonEmpty,
    })
  ),
  fictionChanges: z.array(fictionChange),
});

export type Outline = z.infer<typeof outlineSchema>;
export type FictionChange = z.infer<typeof fictionChange>;

export const MAX_POLISH_EDITS = 8;

export const polishSchema = z.object({
  edits: z.array(
    z.object({
      op: z.enum([
        "swap_fictions",
        "swap_cards",
        "replace_fiction",
        "rewrite_story",
        "rewrite_journey",
        "set_story_feature",
        "rewrite_way",
        "change_fiction",
        "set_key",
      ]),
      // Every edit fills in all of these, with "none" where one does not apply.
      // Optional fields get left out: Haiku 5.5 put an edit's new text in `why`.
      roomA: nonEmpty,
      roomB: nonEmpty,
      fiction: nonEmpty,
      way: nonEmpty,
      field: z.enum([...fictionFields, NONE]),
      group: nonEmpty,
      challenge: nonEmpty,
      keyKind: z.enum([...keyKinds, NONE]),
      gotBy: nonEmpty,
      text: nonEmpty,
      why: nonEmpty,
    })
  ),
});

export type Polish = z.infer<typeof polishSchema>;
export type PolishEdit = Polish["edits"][number];

// ---------------------------------------------------------------------------
// THE RULES
// ---------------------------------------------------------------------------

/**
 * Everything wrong with an outline, each naming the parts a repair must replace.
 * Empty means code can use it.
 */
export function outlineViolations(draft: OutlineDraft, o: Outline): ValidationIssue[] {
  const out: ValidationIssue[] = [];
  const bad = (path: string, message: string) => out.push({ path, message });

  const roomOf = new Map(draft.rooms.map((r) => [r.ref, r]));
  const fictionOf = new Map(draft.fictions.map((f) => [f.ref, f]));
  const cardRefs = new Set(draft.cards.map((c) => c.ref));
  const answered = new Map(o.rooms.map((r) => [r.ref, r]));

  // --- every room, once ---
  for (const r of draft.rooms) {
    if (!answered.has(r.ref)) bad(`rooms.${r.ref}`, `room ${r.ref} is missing from the outline`);
  }
  const seenRooms = new Set<string>();
  for (const r of o.rooms) {
    if (!roomOf.has(r.ref)) bad(`rooms.${r.ref}`, `${r.ref} is not a room in this dungeon`);
    if (seenRooms.has(r.ref)) bad(`rooms.${r.ref}`, `room ${r.ref} appears twice`);
    seenRooms.add(r.ref);
  }

  // --- fictions ---
  const usedFiction = new Map<string, string[]>();
  for (const r of o.rooms) {
    const room = roomOf.get(r.ref);
    if (!room || room.passage) continue;
    if (!has(r.fiction)) {
      bad(`rooms.${r.ref}.fiction`, `room ${r.ref} has no fiction`);
      continue;
    }
    const f = fictionOf.get(r.fiction);
    if (!f) {
      bad(`rooms.${r.ref}.fiction`, `${r.fiction} on room ${r.ref} is not a fiction you were given`);
      continue;
    }
    usedFiction.set(r.fiction, [...(usedFiction.get(r.fiction) ?? []), r.ref]);
    if (room.sizeClass && !f.fits.includes(room.sizeClass)) {
      bad(
        `rooms.${r.ref}.fiction`,
        `fiction ${f.ref} (${f.identity}) does not fit room ${r.ref}, which is ${room.sizeClass}`
      );
    }
  }
  for (const [ref, on] of usedFiction) {
    if (on.length > 1) bad(`fictions.${ref}`, `fiction ${ref} is used twice: rooms ${on.join(" and ")}`);
  }
  for (const f of draft.fictions) {
    if (f.mandatory && !usedFiction.has(f.ref)) {
      bad(`fictions.${f.ref}`, `mandatory fiction ${f.ref} (${f.identity}) is not used`);
    }
  }

  // --- cards ---
  const usedCard = new Map<string, string[]>();
  let empty: string[] = [];
  for (const r of o.rooms) {
    const room = roomOf.get(r.ref);
    if (!room) continue;
    if (room.role === "entrance") {
      if (has(r.card)) bad(`rooms.${r.ref}.card`, `the entrance ${r.ref} holds no card; move ${r.card}`);
      continue;
    }
    if (!has(r.card)) {
      if (room.role !== "goal") empty = [...empty, r.ref];
      continue;
    }
    if (!cardRefs.has(r.card)) {
      bad(`rooms.${r.ref}.card`, `${r.card} on room ${r.ref} is not a card you were given`);
      continue;
    }
    usedCard.set(r.card, [...(usedCard.get(r.card) ?? []), r.ref]);
  }
  for (const [ref, on] of usedCard) {
    if (on.length > 1) bad(`cards.${ref}`, `card ${ref} is used twice: rooms ${on.join(" and ")}`);
  }
  for (const c of draft.cards) {
    if (!usedCard.has(c.ref)) bad(`cards.${c.ref}`, `card ${c.ref} is not used`);
  }
  // A card in the goal room leaves one other room empty, and only then.
  const goalHolds = has(answered.get(draft.goalRoom)?.card);
  if (empty.length > (goalHolds ? 1 : 0)) {
    bad(`rooms.${empty[0]}.card`, `rooms ${empty.join(", ")} hold no card; only one room may, and only if the goal room holds one`);
  }

  // --- ways ---
  const wayRefs = new Set(draft.ways.map((w) => w.ref));
  const describedWays = new Set(o.ways.map((w) => w.ref));
  for (const w of draft.ways) {
    if (!describedWays.has(w.ref)) bad(`ways.${w.ref}`, `way ${w.ref} is not described`);
  }
  for (const w of o.ways) {
    if (!wayRefs.has(w.ref)) bad(`ways.${w.ref}`, `${w.ref} is not a way in this dungeon`);
  }

  // --- clues ---
  const clueCards = draft.cards.filter((c) => c.clue);
  const clueOf = new Map(o.clues.map((c) => [c.card, c.pointsAt]));
  for (const c of clueCards) {
    const at = clueOf.get(c.ref);
    if (!at) {
      bad(`clues.${c.ref}`, `clue card ${c.ref} does not say what it points at`);
    } else if (at !== "objective" && !roomOf.has(at) && !cardRefs.has(at)) {
      bad(`clues.${c.ref}`, `clue card ${c.ref} points at ${at}, which is not a room, a card or "objective"`);
    }
  }

  // --- keys ---
  const challengeOf = new Map(draft.challenges.map((c) => [c.ref, c.challenge]));
  const [fewest, most] = draft.keyRange;
  if (o.keys.length < fewest || o.keys.length > most) {
    bad("keys", `plan between ${fewest} and ${most} keys, not ${o.keys.length}`);
  }
  const keyed = new Set<string>();
  for (const k of o.keys) {
    if (!roomOf.has(k.room)) bad("keys", `the key "${k.key}" is in ${k.room}, which is not a room`);
    if (k.challenge === GOAL_KEY) continue;
    const answers = challengeOf.get(k.challenge);
    if (!answers) {
      bad("keys", `${k.challenge} is not a challenge you were given`);
      continue;
    }
    if (keyed.has(k.challenge)) bad("keys", `two keys answer ${k.challenge}`);
    keyed.add(k.challenge);
    // Never behind the thing it opens (ARCHITECTURE section 8.2).
    const way = draft.ways.find((w) => w.connector.id === answers.targetId);
    if (way && roomOf.has(k.room) && !reachableWithout(draft, way.ref).has(k.room)) {
      bad("keys", `the key "${k.key}" in ${k.room} can only be reached through ${way.ref}, the way it opens`);
    }
  }
  const location = draft.challenges.find((c) => c.challenge.kind === "goal-location");
  if (location && !keyed.has(location.ref)) {
    bad("keys", `no key answers where the objective is (${location.ref})`);
  }

  // --- changes to the fiction ---
  const groupRefs = new Set(draft.blueprint.inhabitants.map((_, i) => `G${i + 1}`));
  for (const c of o.fictionChanges) {
    if ((c.field === "groupName" || c.field === "groupBase") && !groupRefs.has(c.group)) {
      bad("fictionChanges", `a change to ${c.field} names no real group: ${c.group}`);
    }
  }

  return out;
}

/** Every room reachable from the entrance without passing one way. */
function reachableWithout(draft: OutlineDraft, wayRef: string): Set<string> {
  const seen = new Set([draft.entrance]);
  const queue = [draft.entrance];
  for (let at = queue.shift(); at !== undefined; at = queue.shift()) {
    for (const w of draft.ways) {
      if (w.ref === wayRef) continue;
      const next = w.a === at ? w.b : w.b === at ? w.a : undefined;
      if (next !== undefined && !seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return seen;
}

const REF = /\b(?:room_\d+|[CFKWG]\d+)\b/;

/**
 * Refs written into prose. They mean nothing to whoever writes the room from this,
 * and may get copied into what the player reads. Asked of a written outline only: it
 * is not worth throwing a whole polish away for one.
 */
export function refLeaks(o: Outline): ValidationIssue[] {
  const out: ValidationIssue[] = [];
  const check = (where: string, text: string) => {
    const hit = text.match(REF)?.[0];
    if (hit) out.push({ path: where, message: `${where} says "${hit}"; call it what it is, not by its ref` });
  };
  for (const r of o.rooms) {
    check(`the story of room ${r.ref}`, r.story);
    check(`the journey of room ${r.ref}`, r.journey);
    check(`the story feature of room ${r.ref}`, r.storyFeature);
  }
  for (const w of o.ways) check(`way ${w.ref}`, w.form);
  for (const k of o.keys) {
    check(`the key for ${k.challenge}`, k.key);
    check(`how to get the key for ${k.challenge}`, k.gotBy);
  }
  return out;
}

/**
 * What sends a polish back: too many edits, or new wording that calls a room by its
 * ref. The outline going in has passed `refLeaks`, so any it finds came from these edits.
 * Edits that do not apply are not judged here: `polishOutline` drops those whole.
 */
export function polishIssues(outline: Outline, polish: Polish): ValidationIssue[] {
  if (polish.edits.length > MAX_POLISH_EDITS) {
    return [{ path: "edits", message: `at most ${MAX_POLISH_EDITS} edits, not ${polish.edits.length}` }];
  }
  const applied = applyPolish(outline, polish.edits);
  return applied ? refLeaks(applied) : [];
}

/** A change to the fiction may tighten a field. Below this share, it has lost most of it. */
const FICTION_KEEPS = 0.6;

/**
 * A change that guts what it changes. It returns the field's whole new text, and one
 * outline replaced a 2,100-character opening with its last 500 characters, which would
 * have deleted the player's briefing, goal included.
 */
export function fictionShrinks(draft: OutlineDraft, pass: DungeonPassResponse, o: Outline): ValidationIssue[] {
  const out: ValidationIssue[] = [];
  const groupIds = draft.blueprint.inhabitants.map((g) => g.id);
  for (const c of o.fictionChanges) {
    const group = pass.groups.find((g) => g.id === groupIds[Number(c.group.slice(1)) - 1]);
    const was =
      c.field === "theme"
        ? pass.theme
        : c.field === "history"
          ? pass.history
          : c.field === "opening"
            ? pass.openingProse
            : c.field === "groupBase"
              ? group?.base
              : undefined;
    if (was && c.text.length < was.length * FICTION_KEEPS) {
      out.push({
        path: "fictionChanges",
        message: `your change to ${c.field} keeps only part of it; return its whole new text, with everything that should stay`,
      });
    }
  }
  return out;
}

/** What a repair can still reach for, because no room holds it yet. */
export function unusedRefs(draft: OutlineDraft, o: Outline): { fictions: string[]; cards: string[] } {
  const fictions = new Set(o.rooms.map((r) => r.fiction));
  const cards = new Set(o.rooms.map((r) => r.card));
  return {
    fictions: draft.fictions.filter((f) => !fictions.has(f.ref)).map((f) => f.ref),
    cards: draft.cards.filter((c) => !cards.has(c.ref)).map((c) => c.ref),
  };
}

// ---------------------------------------------------------------------------
// REPAIR
// ---------------------------------------------------------------------------

function mergeBy<T>(whole: readonly T[], patch: readonly T[], key: (t: T) => string): T[] {
  const incoming = new Map(patch.map((p) => [key(p), p]));
  const kept = whole.map((w) => incoming.get(key(w)) ?? w);
  const had = new Set(whole.map(key));
  return [...kept, ...patch.filter((p) => !had.has(key(p)))];
}

/** The outline with a repair's replacements put in. What it does not name stands. */
export function mergeOutline(whole: Outline, patch: Outline): Outline {
  return {
    rooms: mergeBy(whole.rooms, patch.rooms, (r) => r.ref),
    ways: mergeBy(whole.ways, patch.ways, (w) => w.ref),
    objective: patch.objective,
    clues: mergeBy(whole.clues, patch.clues, (c) => c.card),
    // Whole, or a repair could never take a key away.
    keys: patch.keys.length > 0 ? patch.keys : whole.keys,
    // By field, or a change sent back for repair could never be put right.
    fictionChanges: mergeBy(whole.fictionChanges, patch.fictionChanges, (c) => `${c.field}:${c.group}`),
  };
}

// ---------------------------------------------------------------------------
// POLISH
// ---------------------------------------------------------------------------

/**
 * The outline with a reviewer's edits applied, or undefined if an edit does not
 * make sense. The result still has to pass `outlineViolations`; a polish that
 * fails either test is thrown away whole and the draft stands.
 */
export function applyPolish(o: Outline, edits: readonly PolishEdit[]): Outline | undefined {
  const rooms = o.rooms.map((r) => ({ ...r }));
  const ways = o.ways.map((w) => ({ ...w }));
  const fictionChanges = [...o.fictionChanges];
  const keys = [...o.keys];
  const room = (ref: string | undefined) => rooms.find((r) => r.ref === ref);

  for (const e of edits) {
    const a = room(e.roomA);
    const b = room(e.roomB);
    switch (e.op) {
      case "swap_fictions": {
        if (!a || !b) return undefined;
        [a.fiction, b.fiction] = [b.fiction, a.fiction];
        break;
      }
      case "swap_cards": {
        if (!a || !b) return undefined;
        [a.card, b.card] = [b.card, a.card];
        break;
      }
      case "replace_fiction":
        if (!a || !has(e.fiction)) return undefined;
        a.fiction = e.fiction;
        break;
      case "rewrite_story":
        if (!a || !has(e.text)) return undefined;
        a.story = e.text;
        break;
      case "rewrite_journey":
        if (!a || !has(e.text)) return undefined;
        a.journey = e.text;
        break;
      case "set_story_feature":
        if (!a || !has(e.text)) return undefined;
        a.storyFeature = e.text;
        break;
      case "rewrite_way": {
        const w = ways.find((x) => x.ref === e.way);
        if (!w || !has(e.text)) return undefined;
        w.form = e.text;
        break;
      }
      case "change_fiction":
        if (e.field === NONE || !has(e.text)) return undefined;
        {
          const change = { field: e.field, group: e.group, text: e.text, why: e.why };
          const held = fictionChanges.findIndex((c) => c.field === e.field && c.group === e.group);
          if (held >= 0) fictionChanges[held] = change;
          else fictionChanges.push(change);
        }
        break;
      case "set_key": {
        if (e.keyKind === NONE || !has(e.challenge) || !has(e.text) || !has(e.gotBy) || !has(e.roomA)) return undefined;
        const key = { challenge: e.challenge, kind: e.keyKind, key: e.text, room: e.roomA, gotBy: e.gotBy };
        // A challenge has one key; the goal can need several.
        const held = e.challenge === GOAL_KEY ? -1 : keys.findIndex((k) => k.challenge === e.challenge);
        if (held >= 0) keys[held] = key;
        else keys.push(key);
        break;
      }
    }
  }
  return { ...o, rooms, ways, keys, fictionChanges };
}

// ---------------------------------------------------------------------------
// THE FICTION, AS CHANGED
// ---------------------------------------------------------------------------

/**
 * The dungeon pass's answer with an outline's changes applied, later ones winning.
 * The goal is not among the fields: its summary and spec are locked once written.
 */
export function changedFiction(
  pass: DungeonPassResponse,
  groupIds: readonly string[],
  changes: readonly FictionChange[]
): DungeonPassResponse {
  const next: DungeonPassResponse = { ...pass, groups: pass.groups.map((g) => ({ ...g })) };
  for (const c of changes) {
    const id = has(c.group) ? groupIds[Number(c.group.slice(1)) - 1] : undefined;
    const group = next.groups.find((g) => g.id === id);
    if (c.field === "theme") next.theme = c.text;
    else if (c.field === "history") next.history = c.text;
    else if (c.field === "opening") next.openingProse = c.text;
    else if (c.field === "groupName" && group) group.name = c.text;
    else if (c.field === "groupBase" && group) group.base = c.text;
  }
  return next;
}
