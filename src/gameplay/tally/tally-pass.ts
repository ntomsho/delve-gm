/**
 * TALLY PASS  (once, at the end of a run)
 * =======================================
 *
 * What the run was worth.
 *
 * WHY IT IS ONE CALL AT THE END rather than a judgement made in the turn. Risk
 * is the thing being priced, and risk is only legible afterwards: the fight that
 * looked deadly and cost four hit points was not deadly, and the door that
 * looked routine took three failed saves and a broken arm. A game master asked
 * mid-turn how dangerous the thing it is currently narrating is has neither the
 * outcome nor the comparison, and every answer it gives is an answer about
 * atmosphere. Asked at the end, with the whole ledger in front of it, it is
 * being asked a question it can actually answer.
 *
 * It also takes the XP call OFF THE GAME MASTER ENTIRELY, which is worth as much as
 * the accuracy: nothing in a turn has to think about scoring, so nothing in a
 * turn is tempted to narrate toward it.
 *
 * THE MODEL RATES; CODE PRICES. The response carries one of three WORDS per
 * accomplishment and no numbers at all — Knave's 50 / 100 / 200 live here, in
 * `XP_FOR_RISK`, and are applied by `applyTally`. That is the same rule the rest
 * of the pipeline runs on and it matters more here than anywhere: a model asked
 * for a number will drift, and a run's reward would drift with it.
 *
 * A RUN THAT ENDS IN DEATH DOES NOT TALLY. The ledger is still written — for the
 * journal and for the record — but there is no call and no award. See
 * `shouldTally`.
 */

import { CHALLENGE_LABEL, type Challenge, type ChallengeKind } from "../../generation/content/challenges.ts";

// ---------------------------------------------------------------------------
// KNAVE'S NUMBERS
// ---------------------------------------------------------------------------

/**
 * What an accomplishment is worth, by how dangerous it turned out to be.
 *
 * Knave's own table. The only numbers in this file, and the only ones the tally
 * produces -- see the header on why the model never sees them.
 */
export const XP_FOR_RISK: Record<Risk, number> = {
  low: 50,
  moderate: 100,
  high: 200,
};

/**
 * A level's worth.
 *
 * LEVELLING IS NOT DONE HERE and is deliberately a separate session. The
 * arithmetic is worth writing down while it is in front of us: about thirty
 * challenges in a size 5 dungeon, most of them moderate, is roughly 3000 XP --
 * three levels for one dungeon against this track. Either the track moves or the
 * rating does, and which is a design question rather than a coding one.
 */
export const XP_PER_LEVEL = 1000;

export type Risk = "low" | "moderate" | "high";

export const isRisk = (s: string): s is Risk => s === "low" || s === "moderate" || s === "high";

// ---------------------------------------------------------------------------
// PAYLOAD
// ---------------------------------------------------------------------------

/** One thing the player did, as the ledger recorded it. */
export interface TallyAttempt {
  turn: number;
  action: string;
  roll?: { kind: string; total: number; success: boolean };
  damageTaken?: number;
}

/** One accomplishment, with everything that went into it. */
export interface TallyItem {
  challengeId: string;
  /** what kind of thing it was, in words */
  about: string;
  kind: ChallengeKind;
  /** the rolled fact it was about */
  property: string;
  /**
   * How it was settled. `bypassed` is the inferred case -- the player met it,
   * never resolved it outright, and went on to accomplish something afterwards.
   * Worth the same as any other way past, which is the point.
   */
  how: "slain" | "cleared" | "found" | "disabled" | "completed" | "bypassed";
  metTurn?: number;
  resolvedTurn?: number;
  attempts: TallyAttempt[];
}

export interface TallyPayload {
  dungeonContext: string;
  /** how the run ended, in words the rater should weigh */
  outcome: string;
  /** the character's level, which is what "dangerous" is relative to */
  level: number;
  /** hit points at the end, out of maximum */
  hp: { current: number; max: number };
  turns: number;
  items: TallyItem[];
  instructions: string;
  responseSchema: string;
}

/** What the tally reads out of the run. Narrower than the whole run state. */
export interface TallySource {
  ledger: readonly {
    challengeId: string;
    kind: ChallengeKind;
    metTurn?: number;
    resolvedTurn?: number;
    resolution?: "slain" | "cleared" | "found" | "disabled" | "completed";
    actions: readonly TallyAttempt[];
  }[];
}

export interface TallyContext {
  dungeonContext: string;
  outcome: string;
  level: number;
  hp: { current: number; max: number };
  turns: number;
  /** challenge ids the bypass inference credited; see `bestedByBypass` */
  bypassed: readonly string[];
}

/**
 * Every accomplishment, and nothing else.
 *
 * A challenge the player met and never got past is NOT here. It is not an
 * accomplishment, it is a thing in the dungeon they walked away from, and
 * listing it would invite the rater to price it out of sympathy.
 *
 * `ENTERING A ROOM IS NOT AN ACCOMPLISHMENT` either, which is why `metTurn`
 * alone never produces an item -- it takes a resolution or the bypass inference.
 */
export function buildTallyPayload(
  src: TallySource,
  challenges: readonly Challenge[],
  ctx: TallyContext
): TallyPayload {
  const byId = new Map(challenges.map((c) => [c.id, c]));
  const bypassed = new Set(ctx.bypassed);

  const items: TallyItem[] = [];
  for (const e of src.ledger) {
    const resolved = e.resolution !== undefined && e.resolvedTurn !== undefined;
    if (!resolved && !bypassed.has(e.challengeId)) continue;
    const c = byId.get(e.challengeId);
    items.push({
      challengeId: e.challengeId,
      about: CHALLENGE_LABEL[e.kind],
      kind: e.kind,
      property: c?.property ?? "",
      how: resolved ? e.resolution! : "bypassed",
      ...(e.metTurn !== undefined ? { metTurn: e.metTurn } : {}),
      ...(e.resolvedTurn !== undefined ? { resolvedTurn: e.resolvedTurn } : {}),
      attempts: [...e.actions],
    });
  }

  return {
    dungeonContext: ctx.dungeonContext,
    outcome: ctx.outcome,
    level: ctx.level,
    hp: ctx.hp,
    turns: ctx.turns,
    items,
    instructions: TALLY_INSTRUCTIONS,
    responseSchema: TALLY_SCHEMA,
  };
}

/**
 * Whether this run gets a tally at all.
 *
 * TWO ENDINGS DO NOT, and for the same reason: nothing came back up. A run that
 * ends in death forfeits it — the one rule in the spec stated without a caveat —
 * and so does a run the player abandoned, which is not an ending in the fiction
 * at all. The character never walked out of anywhere; the player closed the
 * book, and a score for a delve nobody finished is a number attached to nothing.
 *
 * The ledger is still written for both. It is the record of what happened, and
 * what happened is not conditional on it having been paid for.
 *
 * Here rather than at the call site so that every caller gets it: the local
 * session, the server, and the dev CLI.
 */
export function shouldTally(ending: string, items: readonly TallyItem[]): boolean {
  if (ending === "dead" || ending === "abandoned") return false;
  return items.length > 0;
}

// ---------------------------------------------------------------------------
// RESPONSE
// ---------------------------------------------------------------------------

export interface TallyRating {
  challengeId: string;
  risk: Risk;
  /** one line, for the run summary the player reads */
  why: string;
}

export interface TallyResponse {
  ratings: TallyRating[];
}

// ---------------------------------------------------------------------------
// RENDER
// ---------------------------------------------------------------------------

export function renderTallyPrompt(p: TallyPayload): string {
  const L: string[] = [];
  L.push(p.instructions, "");
  L.push("=== THE DUNGEON ===", p.dungeonContext, "");
  L.push("=== THE RUN ===");
  L.push(`ended: ${p.outcome}`);
  L.push(`a level ${p.level} character, ${p.hp.current} of ${p.hp.max} hit points left`);
  L.push(`${p.turns} turns`);
  L.push("");
  L.push(`=== WHAT THEY ACCOMPLISHED (${p.items.length}) ===`, "");

  for (const it of p.items) {
    L.push(`--- ${it.challengeId} ---`);
    L.push(`${it.about}${it.property ? `: "${it.property}"` : ""}`);
    L.push(`how it ended: ${HOW_SAID[it.how]}`);
    if (it.metTurn !== undefined && it.resolvedTurn !== undefined) {
      const spent = it.resolvedTurn - it.metTurn;
      L.push(`met on turn ${it.metTurn}, settled on turn ${it.resolvedTurn} (${spent} turns)`);
    } else if (it.metTurn !== undefined) {
      L.push(`met on turn ${it.metTurn}`);
    }

    if (it.attempts.length === 0) {
      L.push(`no rolls were made against it.`);
    } else {
      L.push(`what they did:`);
      for (const a of it.attempts) {
        const bits = [`turn ${a.turn}`, a.action];
        if (a.roll) bits.push(`${a.roll.kind} ${a.roll.total} — ${a.roll.success ? "success" : "failure"}`);
        if (a.damageTaken) bits.push(`took ${a.damageTaken} damage`);
        L.push(`  - ${bits.join(" · ")}`);
      }
    }
    L.push("");
  }

  L.push("=== RESPONSE FORMAT ===", p.responseSchema);
  return L.join("\n");
}

const HOW_SAID: Record<TallyItem["how"], string> = {
  slain: "killed",
  cleared: "the way was opened",
  found: "found",
  disabled: "disabled or solved",
  completed: "the objective was completed",
  bypassed:
    "got past without a mark left on the world — talked down, deceived, driven " +
    "off, or slipped by. The game cannot tell which, and all of them are worth the same",
};

// ---------------------------------------------------------------------------
// INSTRUCTIONS + SCHEMA
// ---------------------------------------------------------------------------

const TALLY_INSTRUCTIONS = `You are rating a finished delve, after the fact, with the whole record in front
of you. For each accomplishment below, say how much RISK the player actually
ran in achieving it.

  low        it was never really in doubt. No rolls, or rolls that could not
             have hurt them: reading a journal, opening a door that was merely
             stuck, talking to somebody who was never going to fight.
  moderate   a real chance of it going badly. A fight they were likely to win,
             a save that would have cost them something, a puzzle with a
             penalty for getting it wrong.
  high       it could have killed them, or nearly did. A fight against something
             at or above their weight, a failed save that cost real hit points,
             a hazard that took several attempts and left a mark.

RATE WHAT HAPPENED, NOT WHAT IT SOUNDS LIKE. The evidence is the rolls, the
damage taken, and the number of turns it took. A ghoul described in three
terrifying sentences that died to one attack roll was LOW. A stuck door that
took four failed saves and cost eight hit points was HIGH.

WEIGH IT AGAINST THE CHARACTER. A level 1 character and a level 5 character
running the same fight did not run the same risk.

GETTING PAST SOMETHING WITHOUT FIGHTING IT COUNTS FULLY. Talked down, deceived,
driven off, slipped past — those are solutions, not evasions, and a clever one is
worth as much as a bloody one. Rate the risk it actually carried.

HARD RULES
1. Return exactly the accomplishments listed, each once, with its id exactly as
   given. Do not add one and do not leave one out.
2. Use only the three words. No numbers anywhere in your response — what these
   are worth is not yours to decide and is already settled.
3. "why" is ONE short line, and the player will read it. Say what they did, not
   what you thought of it.`;

const TALLY_SCHEMA = `Return JSON only, no prose outside it:

{
  "ratings": [
    {
      "challengeId": "<exactly as given>",
      "risk": "low" | "moderate" | "high",
      "why": "<one short line the player will read>"
    }
  ]
}`;

// ---------------------------------------------------------------------------
// APPLY
// ---------------------------------------------------------------------------

export interface Award {
  challengeId: string;
  about: string;
  risk: Risk;
  xp: number;
  why: string;
}

export interface RunTally {
  awards: Award[];
  total: number;
  /** accomplishments the response did not rate, and so could not be paid for */
  unrated: string[];
}

/**
 * Price the ratings.
 *
 * ANYTHING NOT ON THE PAYLOAD IS DROPPED, and anything on the payload that came
 * back unrated is reported rather than guessed at. A default rating would be a
 * number nobody chose, which is exactly what keeping numbers out of the response
 * was for.
 */
export function applyTally(res: TallyResponse, payload: TallyPayload): RunTally {
  const listed = new Map(payload.items.map((i) => [i.challengeId, i]));
  const seen = new Set<string>();
  const awards: Award[] = [];

  for (const r of res.ratings ?? []) {
    const item = listed.get(r.challengeId);
    if (!item || seen.has(r.challengeId) || !isRisk(r.risk)) continue;
    seen.add(r.challengeId);
    awards.push({
      challengeId: r.challengeId,
      about: item.about,
      risk: r.risk,
      xp: XP_FOR_RISK[r.risk],
      why: r.why,
    });
  }

  return {
    awards,
    total: awards.reduce((n, a) => n + a.xp, 0),
    unrated: payload.items.filter((i) => !seen.has(i.challengeId)).map((i) => i.challengeId),
  };
}
