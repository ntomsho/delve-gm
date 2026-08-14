/**
 * THE TURN MACHINE
 * ================
 *
 * What happens between the player pressing return and the screen changing.
 *
 * The machine owns none of the rules and none of the prose. It asks a
 * `Referee` what should happen, hands the answer to the applier, and decides
 * where the game goes next. That division is the whole point: in Phase 3 the
 * referee is a fixture returning canned envelopes, in Phase 4 it is the model,
 * and nothing in this file changes when they swap.
 *
 * Two axes move together here and are easy to confuse. `stage` is what the
 * PLAYER is being told — it opens and closes the input area. `step` is where
 * the REFEREE is in the heuristic — it selects the step file loaded into the
 * next call. See runtime/types.ts.
 *
 * WHAT THIS FILE DECIDES, as against what the referee decides:
 *
 *   - that a refused commit is worth exactly one more ask (§5: no partial
 *     fallback, and a second failure surfaces)
 *   - when a turn has CLOSED, and so when the clock ticks and the exchange is
 *     thrown away
 *   - that the player moving rooms means a room entry, whatever the referee
 *     thought `nextStage` should be
 *
 * Everything else — what happened, what changed, what it reads like — is the
 * referee's, and arrives as prose plus a commit.
 *
 * No React. No llm/client. Runs under vitest against the real store and the
 * real applier.
 */

import {
  checkRoll,
  critEffects,
  rollDamage,
  type DamageResult,
} from "../engine/index.ts";
import type { GeneratedDungeon } from "./generate.ts";
import type { Commit, WorldEvent } from "./diffs/types.ts";
import { acceptsInput, isTerminal, type RollSpec, type Stage, type Step } from "./types.ts";
import type { GameStore, RunState } from "../store/game.ts";
import { needsComposition, theRoom } from "../store/selectors.ts";
import { NO_JOURNAL, type Journal } from "./journal.ts";

// ---------------------------------------------------------------------------
// THE SEAM
// ---------------------------------------------------------------------------

/** A roll the player has already made. The referee reads it; it never rolls. */
export interface RolledOutcome {
  spec: RollSpec;
  /** one die, or two under advantage / disadvantage */
  rolled: number[];
  /** the die that counted */
  kept: number;
  total: number;
  success: boolean;
  nat20: boolean;
  nat1: boolean;
  /** attacks that land and deal damage */
  damage?: DamageResult;
  /** a natural 20 costs the defender's armour a point, a natural 1 the weapon */
  crit: { defenderArmor: boolean; attackerWeapon: boolean };
}

export interface RefereeRequest {
  /** where the heuristic resumes */
  step: Step;
  dungeon: GeneratedDungeon;
  /** the world as it stands, including the open exchange */
  run: RunState;
  /** what the player typed, when this call was triggered by input */
  input?: string;
  /** the roll they just made, when this call is a resolution */
  roll?: RolledOutcome;
  /**
   * Why the last commit was refused. Present only on a retry, and the referee
   * is expected to fix what it said rather than say it again.
   */
  rejections?: string[];
}

export interface RefereeReply {
  /** prose for the player. May be empty when there is nothing to say. */
  narration: string;
  commit: Commit;
}

export type Referee = (req: RefereeRequest) => Promise<RefereeReply>;

export interface TurnMachine {
  /** describe where the player is standing. On start, and after every move. */
  enterRoom(): Promise<void>;
  /** the player has typed something */
  submit(text: string): Promise<void>;
  /** the player has taken the roll on the table */
  roll(): Promise<void>;
  /** after an error: ask again, with the same input */
  retry(): Promise<void>;
}

// ---------------------------------------------------------------------------
// DICE
// ---------------------------------------------------------------------------

/**
 * Resolve a spec with the run's RNG.
 *
 * `spec.dc` is already the number to meet for all three kinds — see the note on
 * RollSpec — so every roll is the one contest, and only an attack that means to
 * hurt goes on to roll damage.
 */
function resolveSpec(rng: { next(): number }, spec: RollSpec): RolledOutcome {
  const outcome = checkRoll(rng, spec.bonus, spec.dc, spec.edge);
  const crit = critEffects(outcome);

  const rolled: RolledOutcome = {
    spec,
    rolled: outcome.rolled,
    kept: outcome.kept,
    total: outcome.total,
    success: outcome.success,
    nat20: outcome.nat20,
    nat1: outcome.nat1,
    crit: { defenderArmor: crit.defenderArmor, attackerWeapon: crit.attackerWeapon },
  };

  if (outcome.success && spec.kind === "attack" && spec.mode !== "stunt" && spec.damage) {
    rolled.damage = rollDamage(rng, spec.damage, crit.extraDamageDice);
  }
  return rolled;
}

/** The dice, as a line in the scrollback. Terms of the bet, never the DC. */
function describeRoll(o: RolledOutcome): string {
  const sign = o.spec.bonus >= 0 ? "+" : "";
  const dice = o.rolled.length > 1 ? `[${o.rolled.join(", ")}] keep ${o.kept}` : `${o.kept}`;
  const edge = o.spec.edge === "none" ? "" : ` (${o.spec.edge})`;
  const damage = o.damage ? ` · ${o.damage.expr} → ${o.damage.total}` : "";
  const crit = o.nat20 ? " · CRITICAL" : o.nat1 ? " · FUMBLE" : "";

  return (
    `${o.spec.ability.toUpperCase()} ${o.spec.kind}${edge}: ` +
    `${dice} ${sign}${o.spec.bonus} = ${o.total} — ` +
    `${o.success ? "success" : "failure"}${crit}${damage}`
  );
}

// ---------------------------------------------------------------------------
// THE MACHINE
// ---------------------------------------------------------------------------

/** Stages a turn ends on. Reaching one closes the exchange. */
const CLOSING_STAGES: readonly Stage[] = ["awaiting_action", "dead", "goal_met"];

/**
 * The commit, and what the applier made of it.
 *
 * Both halves in one record, because reading them apart is useless: a diff that
 * was proposed and a diff that was applied look identical, and the whole
 * question when a turn goes wrong is which of the two happened. `lastEvents`
 * carries the consequences the applier performed that nobody asked for — an
 * item destroyed at zero quality, armour that fell off because it became
 * illegal — and those belong with it.
 */
function logCommit(
  journal: Journal,
  commit: Commit,
  result: { ok: boolean; reasons: string[] },
  retry: boolean,
  events: WorldEvent[]
): void {
  journal.log({
    kind: "commit",
    commit,
    ok: result.ok,
    ...(result.ok ? {} : { reasons: result.reasons }),
    ...(result.ok && events.length > 0 ? { events } : {}),
    ...(retry ? { retry } : {}),
  });
}

/**
 * The store, declared by what this file uses of it. Structural on purpose: the
 * turn machine never imports zustand, and a test can hand it any object with a
 * `getState`.
 */
type Store = { getState(): GameStore };

export interface TurnDeps {
  /** the run this machine drives — see `createGameStore` */
  store: Store;
  /** where the run writes itself down. Omitted means it does not. */
  journal?: Journal;
}

/** For the move record. Falls back to the id so a record is never blank. */
const roomName = (r: RunState, id: string): string =>
  theRoom(r.entities.rooms.find((x) => x.id === id)?.name || id);

export function createTurnMachine(referee: Referee, deps: TurnDeps): TurnMachine {
  const { store, journal = NO_JOURNAL } = deps;
  const state = () => store.getState();
  const run = (): RunState | undefined => state().run;

  /**
   * Every stage the MACHINE sets goes through here, so the journal sees them
   * all without five scattered log calls. The ones the referee sets arrive via
   * `commit` and are logged there.
   */
  const setStage = (stage: Stage, step: Step) => {
    const from = run()?.stage;
    state().setStage(stage, step);
    journal.log({ kind: "stage", ...(from ? { from } : {}), to: stage, step });
  };

  /**
   * Ask, apply, and work out what that means.
   *
   * `entering` marks the room-entry pass, which must not chain another one: a
   * room-entry commit that somehow moved the player again would otherwise
   * describe rooms forever.
   */
  async function ask(req: RefereeRequest, entering = false): Promise<void> {
    const before = req.run;
    let reply: RefereeReply;

    try {
      reply = await referee(req);
    } catch (e) {
      fail(before.step, e);
      return;
    }

    let result = state().commit(reply.commit);
    logCommit(journal, reply.commit, result, false, state().lastEvents);

    // One more ask, with the reasons in front of it. Beyond that the turn is
    // unfinishable and the software says so rather than the referee.
    if (!result.ok) {
      try {
        reply = await referee({ ...req, rejections: result.reasons });
      } catch (e) {
        fail(before.step, e);
        return;
      }
      result = state().commit(reply.commit);
      logCommit(journal, reply.commit, result, true, state().lastEvents);
      if (!result.ok) {
        fail(before.step, new Error(result.reasons.join("; ")));
        return;
      }
    }

    const after = run();
    if (!after) return;

    // THE PLAYER MOVED, so this turn says nothing.
    //
    // A referee resolving a move writes the leaving and, told not to, the
    // arriving too — three paragraphs of a room it was never handed, invented
    // whole, immediately before the room-entry pass describes the real one. The
    // player reads two incompatible accounts of the same place, and the second
    // is the one that is true. Instructions did not hold; this cannot fail.
    //
    // What it costs is the prose of the crossing itself. That is a fair price:
    // arrival is the moment worth writing, the entry pass is the one with the
    // room in front of it, and it is about to run.
    const moved = !entering && after.currentRoomId !== before.currentRoomId;

    if (!moved && reply.narration.trim() !== "") {
      journal.log({
        kind: "narration",
        text: reply.narration,
        arrival: entering,
        ...(entering ? { roomId: before.currentRoomId } : {}),
      });
      state().pushLog({
        kind: entering ? "arrival" : "referee",
        text: reply.narration,
        ...(entering ? { roomId: before.currentRoomId } : {}),
      });
      state().pushTranscript({ role: "referee", text: reply.narration });
    }

    // THE PANEL CATCHES UP WITH THE PAGE.
    //
    // The move applied several seconds ago; the arrival has only just been
    // written. Between the two, the player was standing in a room the interface
    // could have listed the contents of and the narration had said nothing about
    // — the room card as a spoiler for prose that had not arrived. So the card
    // and the map marker wait here, at the end of the entry pass, where what is
    // on the screen and what has been read are the same thing.
    //
    // Not on the arrival line itself: a re-entry into a room that has not
    // changed owes the player no new prose, writes none, and would leave the
    // panel a room behind for the rest of the run.
    if (entering) state().showRoom(after.currentRoomId);

    // What a move leaves behind for the next turn to read. Written by the
    // machine rather than kept from the referee: the discarded paragraphs are
    // the ones that had the room wrong, and a turn record is read back as fact.
    // Naming the destination here is also the record that a referee routing
    // "go back the way I came" needs, and did not have.
    // A walk that ended short says so, in the applier's words: they set out for
    // one room and are standing in another, and the next turn has to read that
    // as what happened rather than as a referee losing track of them.
    const stopped = state().lastEvents.find((e) => e.kind === "movement-stopped");
    const outcome = moved
      ? `They left ${roomName(before, before.currentRoomId)} and are now in ` +
        `${roomName(after, after.currentRoomId)}.` +
        (stopped ? ` They meant to go further — ${stopped.detail}.` : "")
      : reply.narration;

    // A turn closes when the action is over AND something came of it. A
    // cancelled roll lands back on `awaiting_action` having changed nothing,
    // and dithering is not a turn; a resolution always writes at least the
    // state of what it touched, and death and victory close regardless.
    //
    // A room entry is not a turn either. It is the consequence of one — the
    // move that caused it has already ticked the clock — and counting it would
    // charge the player twice for walking through a door.
    const closed =
      !entering &&
      CLOSING_STAGES.includes(after.stage) &&
      (reply.commit.diffs.length > 0 || isTerminal(after.stage));

    if (closed) {
      journal.log({
        kind: "turn",
        turn: after.turnCount + 1,
        action: req.input ?? "(continued)",
        outcome,
        diffs: reply.commit.diffs.length,
      });
      state().recordTurn({
        action: req.input ?? "(continued)",
        ...(req.roll
          ? { roll: { kind: req.roll.spec.kind, total: req.roll.total, success: req.roll.success } }
          : {}),
        ...(req.roll?.spec.targetId ? { target: req.roll.spec.targetId } : {}),
        outcome,
        diffsApplied: reply.commit.diffs.length,
      });
    }

    // The player moved. That outranks whatever stage the referee asked for —
    // somewhere new has to be described before it can be acted in — and it is
    // the only route to `room_entry` during play.
    if (moved && !isTerminal(after.stage)) {
      await enterRoom();
    }
  }

  /**
   * The turn cannot be finished. Keep the world exactly as it was, put the game
   * into the one stage where the software rather than the referee is talking,
   * and leave the player's draft alone so a retry costs them nothing.
   *
   * Nothing is written to `callLog` here: the machine does not know what model
   * answered or what it cost. Whoever implements the `Referee` does, and logs.
   */
  function fail(step: Step, e: unknown): void {
    const message = e instanceof Error ? e.message : String(e);
    console.warn("[turn] the referee could not finish:", e);
    journal.log({ kind: "error", where: `turn:${step}`, message });
    const from = run()?.stage;
    state().setStage("error", step);
    journal.log({ kind: "stage", ...(from ? { from } : {}), to: "error", step });
  }

  /** The last thing asked, so `retry` can ask it again after an error. */
  let lastRequest: { input?: string; roll?: RolledOutcome; step: Step; entering: boolean } | undefined;

  /**
   * Describe where the player is standing — but only if anything here has
   * changed since they last read it.
   *
   * THE SWEEP DECIDES, AND IT DECIDES BEFORE THE CALL. Nothing owing fresh
   * prose means the room can be re-shown exactly as they last read it: free,
   * instant, and consistent by construction, because a room the player has not
   * affected cannot drift in its retelling.
   *
   * The sweep already existed — inside `assemble`, where it ran after the
   * prompt was built and the call was going out, and the instruction it wrote
   * on an empty result was "nothing here needs new prose, hand the turn
   * straight back". A full-price round trip to be told nothing happened, and
   * in the 2026-08-10 playtest that was 5 of 11 arrivals. (8a A4.)
   */
  async function enterRoom(): Promise<void> {
    const r = run();
    const dungeon = state().dungeon;
    if (!r || !dungeon) return;

    const room = r.entities.rooms.find((x) => x.id === r.currentRoomId);
    const shown = room?.composed;

    // `composed === undefined` puts the room itself in the sweep, so an empty
    // sweep already implies there is something to re-show. Checked anyway: the
    // alternative to being wrong here is an arrival with no prose at all.
    if (shown !== undefined && needsComposition(r).length === 0) {
      journal.log({ kind: "narration", text: shown, arrival: true, roomId: r.currentRoomId });
      state().pushLog({ kind: "arrival", text: shown, roomId: r.currentRoomId });
      // Onto the referee's side of the exchange as well, exactly as a written
      // arrival lands there — the next call should not be able to tell which
      // kind of entry it followed.
      state().pushTranscript({ role: "referee", text: shown });
      state().showRoom(r.currentRoomId);
      setStage("awaiting_action", "1-target");
      return;
    }

    setStage("room_entry", "room-entry");
    lastRequest = { step: "room-entry", entering: true };
    await ask({ step: "room-entry", dungeon, run: run()! }, true);
  }

  async function submit(text: string): Promise<void> {
    const r = run();
    const dungeon = state().dungeon;
    if (!r || !dungeon || !acceptsInput(r.stage) || text.trim() === "") return;

    journal.log({ kind: "player", text });
    state().pushLog({ kind: "player", text });
    state().pushTranscript({ role: "player", text });

    // The heuristic resumes where it left off — mid-clarification, mid-roll
    // negotiation, or at the top for a fresh action.
    const step = r.step;
    setStage("thinking", step);
    lastRequest = { input: text, step, entering: false };
    await ask({ step, dungeon, run: run()!, input: text });
  }

  async function roll(): Promise<void> {
    const r = run();
    const dungeon = state().dungeon;
    if (!r || !dungeon || r.stage !== "roll_offered" || !r.pendingRoll) return;

    setStage("rolling", "4-confirm-roll");

    const rng = state().rng();
    const outcome = resolveSpec(rng, r.pendingRoll);
    state().syncRng(rng);
    journal.log({ kind: "roll", source: "player", outcome, draws: rng.draws });
    state().pushLog({ kind: "roll", text: describeRoll(outcome) });

    // AND INTO THE EXCHANGE, which is the belt to `renderRoll`'s braces.
    //
    // `renderRoll` in the instruction is the authoritative copy and says so;
    // this is one line of record that survives independently of how the
    // instruction is built. When the two were the same channel, a retry that
    // did not render the instruction's roll was a retry with no roll at all.
    state().pushTranscript({ role: "roll", text: describeRoll(outcome) });

    setStage("resolving", "5-resolution");
    lastRequest = { roll: outcome, step: "5-resolution", entering: false };
    await ask({ step: "5-resolution", dungeon, run: run()!, roll: outcome });
  }

  async function retry(): Promise<void> {
    const r = run();
    const dungeon = state().dungeon;
    if (!r || !dungeon || r.stage !== "error" || !lastRequest) return;

    const { input, roll: rolled, step, entering } = lastRequest;
    setStage(entering ? "room_entry" : rolled ? "resolving" : "thinking", step);
    await ask({ step, dungeon, run: run()!, input, roll: rolled }, entering);
  }

  return { enterRoom, submit, roll, retry };
}
