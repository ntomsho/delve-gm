/**
 * THE TURN MACHINE
 * ================
 *
 * What happens between the player pressing return and the screen changing.
 *
 * The machine owns none of the rules and none of the prose. It asks a
 * `Game master` what should happen, hands the answer to the applier, and decides
 * where the game goes next. That division is the whole point: in Phase 3 the
 * game master is a fixture returning canned envelopes, in Phase 4 it is the model,
 * and nothing in this file changes when they swap.
 *
 * Two axes move together here and are easy to confuse. `stage` is what the
 * PLAYER is being told — it opens and closes the input area. `step` is where
 * the GAME MASTER is in the heuristic — it selects the step file loaded into the
 * next call. See shared/types/turn.ts.
 *
 * WHAT THIS FILE DECIDES, as against what the game master decides:
 *
 *   - that a refused commit is worth exactly one more ask (§5: no partial
 *     fallback, and a second failure surfaces)
 *   - when a turn has CLOSED, and so when the clock ticks and the exchange is
 *     thrown away
 *   - that the player moving rooms means a room entry, whatever the game master
 *     thought `nextStage` should be
 *
 * Everything else — what happened, what changed, what it reads like — is the
 * game master's, and arrives as prose plus a commit.
 *
 * No React. No llm/client. Runs under vitest against the real store and the
 * real applier.
 */

import { checkRoll, critEffects, rollDamage } from "../rules/knave/rolls.ts";
import { armorDefense as pcArmorDefense } from "../rules/knave/character.ts";
import type { GeneratedDungeon } from "../generation/generate.ts";
import type { Commit, WorldEvent } from "../shared/types/commit.ts";
import {
  acceptsInput,
  isTerminal,
  type PendingRequest,
  type RolledOutcome,
  type RollSpec,
  type Stage,
  type Step,
} from "../shared/types/turn.ts";
import type { GameStore, RunState } from "./state/store.ts";
import { needsComposition, theRoom } from "./view/selectors.ts";
import { NO_JOURNAL, type Journal } from "../journal/journal.ts";
import { characterEffects, describeEffects, describeFoeRolls, foeRolls } from "./mechanics/effects.ts";
import type { DiceOutcome } from "../rules/knave/roll-tool.ts";

// ---------------------------------------------------------------------------
// THE SEAM
// ---------------------------------------------------------------------------

/**
 * A roll the player has already made — now defined beside `RollSpec` in
 * `types.ts`, and re-exported here because four files import it from this one
 * and the type did not change.
 */
export type { RolledOutcome } from "../shared/types/turn.ts";

export interface GameMasterRequest {
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
   * Why the last commit was refused. Present only on a retry, and the game master
   * is expected to fix what it said rather than say it again.
   */
  rejections?: string[];
}

export interface GameMasterReply {
  /** prose for the player. May be empty when there is nothing to say. */
  narration: string;
  commit: Commit;
  /**
   * Every die the game master threw for itself this turn — creature attacks,
   * damage, morale. The machine shows the player the ones that hurt them; see
   * `foeRolls`.
   */
  rolls?: DiceOutcome[];
}

export type GameMaster = (req: GameMasterRequest) => Promise<GameMasterReply>;

export interface TurnMachine {
  /** describe where the player is standing. On start, and after every move. */
  enterRoom(): Promise<void>;
  /** the player has typed something */
  submit(text: string): Promise<void>;
  /** the player has taken the roll on the table: `throwDice`, then `resolve` */
  roll(): Promise<void>;
  /**
   * The first half of `roll`: the dice, from the run's RNG, onto the log — and
   * nothing else. Leaves the run `resolving` with the outcome in `pending`.
   *
   * SPLIT SO THE PLAYER SEES THE DICE BEFORE THE PROSE. Over the wire `roll`
   * was one request that held the result until the game master had written about
   * it — ten seconds of a spinner over a number the server already knew. The
   * server now answers this half on its own, the screen shows the die, and
   * `resolve` is a second request.
   */
  throwDice(): void;
  /** The second half of `roll`: the game master writes what the dice said. */
  resolve(): Promise<void>;
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

/** The last thing the player typed in the exchange still open, if any. */
function lastTyped(run: RunState): string | undefined {
  return run.transcript.findLast((e) => e.role === "player")?.text;
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

export function createTurnMachine(gameMaster: GameMaster, deps: TurnDeps): TurnMachine {
  const { store, journal = NO_JOURNAL } = deps;
  const state = () => store.getState();
  const run = (): RunState | undefined => state().run;

  /**
   * Every stage the MACHINE sets goes through here, so the journal sees them
   * all without five scattered log calls. The ones the game master sets arrive via
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
  async function ask(req: GameMasterRequest, entering = false): Promise<void> {
    const before = req.run;
    let reply: GameMasterReply;

    try {
      reply = await gameMaster(req);
    } catch (e) {
      fail(before.step, e);
      return;
    }

    let result = state().commit(reply.commit);
    logCommit(journal, reply.commit, result, false, state().lastEvents);

    // One more ask, with the reasons in front of it. Beyond that the turn is
    // unfinishable and the software says so rather than the game master.
    if (!result.ok) {
      try {
        reply = await gameMaster({ ...req, rejections: result.reasons });
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

    // The ask landed, so there is nothing left to repeat. Cleared here rather
    // than at the end of the function because a move chains a room entry below,
    // and that pass sets a pending request of its own that must survive.
    state().setPending(undefined);

    // THE PLAYER MOVED, so this turn says nothing.
    //
    // A game master resolving a move writes the leaving and, told not to, the
    // arriving too — three paragraphs of a room it was never handed, invented
    // whole, immediately before the room-entry pass describes the real one. The
    // player reads two incompatible accounts of the same place, and the second
    // is the one that is true. Instructions did not hold; this cannot fail.
    //
    // What it costs is the prose of the crossing itself. That is a fair price:
    // arrival is the moment worth writing, the entry pass is the one with the
    // room in front of it, and it is about to run.
    const moved = !entering && after.currentRoomId !== before.currentRoomId;

    // THE DICE THAT HURT THEM, ahead of the prose that tells it. Rolled by the
    // game master while it wrote, so they land with the narration rather than
    // before it — but above it, so the hit is read before the wound is. Only
    // on a turn that cost hit points: see `foeRolls` for why.
    const foe = foeRolls(
      reply.rolls ?? [],
      pcArmorDefense(before.pc),
      after.pc.hp.current < before.pc.hp.current
    );
    if (foe.length > 0) {
      const text = describeFoeRolls(foe);
      journal.log({ kind: "foe", text });
      state().pushLog({ kind: "foe", text, foe });
    }

    if (!moved && reply.narration.trim() !== "") {
      journal.log({
        kind: "narration",
        text: reply.narration,
        arrival: entering,
        ...(entering ? { roomId: before.currentRoomId } : {}),
      });
      state().pushLog({
        kind: entering ? "arrival" : "game-master",
        text: reply.narration,
        ...(entering ? { roomId: before.currentRoomId } : {}),
        ...(entering && before.arrivedVia ? { via: before.arrivedVia } : {}),
      });
      state().pushTranscript({ role: "game-master", text: reply.narration });
    }

    // WHAT IT COST THEM, as a record under the prose. Off the sheet before and
    // after rather than the diffs, so damage the dice did and items the applier
    // destroyed on its own are in it too — see `effects.ts`. Written on a move
    // as well: a fall on the way through is still a fall.
    const effects = characterEffects(before.pc, after.pc, state().lastEvents);
    if (effects.length > 0) {
      const text = describeEffects(effects);
      journal.log({ kind: "effects", text });
      state().pushLog({ kind: "effects", text, effects });
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
    // machine rather than kept from the game master: the discarded paragraphs are
    // the ones that had the room wrong, and a turn record is read back as fact.
    // Naming the destination here is also the record that a game master routing
    // "go back the way I came" needs, and did not have.
    // A walk that ended short says so, in the applier's words: they set out for
    // one room and are standing in another, and the next turn has to read that
    // as what happened rather than as a game master losing track of them.
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
      // WHAT THEY WERE DOING, in their own words. A turn closed by a roll has
      // no input of its own — the words were typed a call or two earlier and
      // are still in the open exchange — so it used to be recorded as
      // "(continued)", which is what a death on a roll then reported as the
      // last thing they tried. The latest line they typed is the action.
      const action = req.input ?? lastTyped(req.run) ?? "(continued)";
      journal.log({
        kind: "turn",
        turn: after.turnCount + 1,
        action,
        outcome,
        diffs: reply.commit.diffs.length,
      });
      state().recordTurn({
        action,
        ...(req.roll
          ? { roll: { kind: req.roll.spec.kind, total: req.roll.total, success: req.roll.success } }
          : {}),
        ...(req.roll?.spec.targetId ? { target: req.roll.spec.targetId } : {}),
        outcome,
        diffsApplied: reply.commit.diffs.length,
      });
    }

    // The player moved. That outranks whatever stage the game master asked for —
    // somewhere new has to be described before it can be acted in — and it is
    // the only route to `room_entry` during play.
    if (moved && !isTerminal(after.stage)) {
      await enterRoom();
    }
  }

  /**
   * The turn cannot be finished. Keep the world exactly as it was, put the game
   * into the one stage where the software rather than the game master is talking,
   * and leave the player's draft alone so a retry costs them nothing.
   *
   * Nothing is written to `callLog` here: the machine does not know what model
   * answered or what it cost. Whoever implements the `Game master` does, and logs.
   */
  function fail(step: Step, e: unknown): void {
    const message = e instanceof Error ? e.message : String(e);
    console.warn("[turn] the game master could not finish:", e);
    journal.log({ kind: "error", where: `turn:${step}`, message });
    const from = run()?.stage;
    state().setStage("error", step);
    journal.log({ kind: "stage", ...(from ? { from } : {}), to: "error", step });
  }

  /**
   * The last thing asked, so `retry` can ask it again after an error.
   *
   * IN THE RUN STATE, not in this closure. A machine is built per request on the
   * server and thrown away with the response, so a closure variable was empty
   * every time it mattered — see `PendingRequest`. Written immediately before
   * each ask and cleared by the one that lands.
   */
  const remember = (pending: PendingRequest) => state().setPending(pending);

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
      state().pushLog({
        kind: "arrival",
        text: shown,
        roomId: r.currentRoomId,
        ...(r.arrivedVia ? { via: r.arrivedVia } : {}),
      });
      // Onto the game master's side of the exchange as well, exactly as a written
      // arrival lands there — the next call should not be able to tell which
      // kind of entry it followed.
      state().pushTranscript({ role: "game-master", text: shown });
      state().showRoom(r.currentRoomId);
      setStage("awaiting_action", "1-target");
      return;
    }

    setStage("room_entry", "room-entry");
    remember({ step: "room-entry", entering: true });
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
    remember({ input: text, step, entering: false });
    await ask({ step, dungeon, run: run()!, input: text });
  }

  function throwDice(): void {
    const r = run();
    const dungeon = state().dungeon;
    if (!r || !dungeon || r.stage !== "roll_offered" || !r.pendingRoll) return;

    setStage("rolling", "4-confirm-roll");

    const rng = state().rng();
    const outcome = resolveSpec(rng, r.pendingRoll);
    state().syncRng(rng);
    journal.log({ kind: "roll", source: "player", outcome, draws: rng.draws });
    // The outcome rides along so the screen can draw the dice rather than parse
    // a sentence. It carries the DC inside `spec`; the screen never shows it.
    state().pushLog({ kind: "roll", text: describeRoll(outcome), outcome });

    // AND INTO THE EXCHANGE, which is the belt to `renderRoll`'s braces.
    //
    // `renderRoll` in the instruction is the authoritative copy and says so;
    // this is one line of record that survives independently of how the
    // instruction is built. When the two were the same channel, a retry that
    // did not render the instruction's roll was a retry with no roll at all.
    state().pushTranscript({ role: "roll", text: describeRoll(outcome) });

    setStage("resolving", "5-resolution");
    remember({ roll: outcome, step: "5-resolution", entering: false });
  }

  async function resolve(): Promise<void> {
    const r = run();
    const dungeon = state().dungeon;
    const rolled = r?.pending?.roll;
    if (!r || !dungeon || r.stage !== "resolving" || !rolled) return;
    await ask({ step: "5-resolution", dungeon, run: r, roll: rolled });
  }

  async function roll(): Promise<void> {
    throwDice();
    await resolve();
  }

  async function retry(): Promise<void> {
    const r = run();
    const dungeon = state().dungeon;
    // `resolving` WITH A ROLL IN PENDING is the one busy stage that is ever
    // saved: the dice landed and the request that was to resolve them never
    // did. Retried as the resolution it was waiting on, so the dice the player
    // already saw are the dice that count.
    if (!r || !dungeon || !r.pending) return;
    if (r.stage !== "error" && !(r.stage === "resolving" && r.pending.roll)) return;

    const { input, roll: rolled, step, entering } = r.pending;
    setStage(entering ? "room_entry" : rolled ? "resolving" : "thinking", step);
    await ask({ step, dungeon, run: run()!, input, roll: rolled }, entering);
  }

  return { enterRoom, submit, roll, throwDice, resolve, retry };
}
