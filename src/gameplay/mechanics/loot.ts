/**
 * WHAT THEY CAME BACK WITH
 * ========================
 *
 * Two readings of a finished run that nothing else in the codebase produces:
 * what the player is carrying that they did not go down with, and — when it
 * ended badly — what the last turn looked like.
 *
 * BOTH ARE DERIVED, AND DELIBERATELY. Neither asks the model anything and
 * neither needs a field written at the moment it happened: they read the run
 * exactly as it was saved, so a summary looked at now and the same summary
 * looked at after a reload are the same summary. A `killedBy` written into the
 * commit that killed them would be one more thing the applier has to get right
 * on the one path nobody plays twice.
 *
 * THE RULE ABOUT KEEPING IT lives here as `keepsWhatTheyFound`, and it is the
 * same rule `commitTurn` enforces against the database — walking out alive is
 * what makes the pack yours, and whether the objective came with you does not
 * come into it. Two copies of one rule is one too many; this one is the copy the
 * player is shown, and `repo.ts` names it in the comment beside its own.
 */

import type { GeneratedDungeon } from "../../generation/generate.ts";
import type { RunState } from "../state/store.ts";
import type { Stage } from "../../shared/types/turn.ts";
import { purse, purseItem } from "../../rules/knave/character-creation.ts";
import { type ICreature, type IItem } from "../../shared/world/entities.ts";
import { theRoom } from "../view/selectors.ts";

// ---------------------------------------------------------------------------
// KEEPING IT
// ---------------------------------------------------------------------------

/**
 * Whether this ending lets them keep what they found.
 *
 * ALIVE AND OUT, and nothing else. `goal_met` and `escaped` are both walking out
 * of the dungeon on their own feet and differ only in whether the objective came
 * too — which is worth saying in the prose and worth nothing here.
 *
 * `abandoned` is not an ending in the fiction at all. The character never came
 * up; the player closed the book, and the sheet is exactly as it was before they
 * went down.
 */
export function keepsWhatTheyFound(stage: Stage): boolean {
  return stage === "goal_met" || stage === "escaped";
}

// ---------------------------------------------------------------------------
// THE TAKE
// ---------------------------------------------------------------------------

/** One thing in the pack that was not in it at the start. */
export interface LootLine {
  id: string;
  name: string;
  /** count or measurement with its unit, when it has one — "6 doses" */
  amount?: string;
  /** what it is worth, in copper pennies. Zero for anything nobody would buy. */
  value: number;
}

export interface RunLoot {
  found: LootLine[];
  /**
   * Copper beyond what they went down with.
   *
   * Its own number rather than a line in `found`, because money is not an object
   * — the purse is one item whose amount moves, so a diff of ids would either
   * miss a richer purse entirely or, for a player who went down broke, report
   * the whole purse as a thing they picked up.
   *
   * Never negative. Money spent down there is not a loss to report on a screen
   * about what was gained, and Knave has nothing to spend it on below ground
   * anyway.
   */
  coin: number;
  /** every line plus the coin, in copper */
  total: number;
}

/**
 * What is in the pack that was not in it at the start.
 *
 * THE SNAPSHOT IS THE ANSWER. `newRun` writes down the ids the character walked
 * in with, and everything else in the inventory at the end came from down there
 * — bought is impossible mid-run, and minted-in-play is as found as picked-up.
 *
 * A RUN SAVED BEFORE THE SNAPSHOT EXISTED still gets an answer, from the one
 * other thing that distinguishes a found item: its id is in the generated
 * dungeon. That misses anything the applier minted during play — the keyring on
 * the guard's belt — and is right about everything that was lying in a room. It
 * is a floor under old saves rather than a second implementation, and a run
 * begun after this shipped never reaches it.
 */
export function lootOf(run: RunState, dungeon?: GeneratedDungeon): RunLoot {
  const started = run.startedWith;
  const fromDungeon = new Set((dungeon?.entities.items ?? []).map((i) => i.id));
  const wasFound = (item: IItem): boolean =>
    started ? !started.includes(item.id) : fromDungeon.has(item.id);

  // The purse is never a line. See `coin`.
  const money = purseItem(run.pc);
  const found = run.pc.inventory
    .filter((i) => i.id !== money?.id && wasFound(i))
    .map(
      (i): LootLine => ({
        id: i.id,
        name: i.name,
        ...(i.amount !== undefined ? { amount: i.amount } : {}),
        value: i.value,
      })
    );

  // Unknowable on a run saved before the snapshot, and zero is the honest
  // answer there — better than reporting a whole purse as treasure because
  // nothing recorded that most of it walked in.
  const coin =
    run.startingPurse === undefined ? 0 : Math.max(0, purse(run.pc) - run.startingPurse);

  return {
    found,
    coin,
    total: found.reduce((n, l) => n + l.value, 0) + coin,
  };
}

// ---------------------------------------------------------------------------
// THE LAST TURN
// ---------------------------------------------------------------------------

export interface DeathReport {
  /** the room they died in, with an article — "the Chapel of Rust" */
  where: string;
  /** the turn it happened on */
  turn: number;
  /**
   * What the fatal turn was aimed at, when it was aimed at a creature.
   *
   * NAMED ONLY WHEN THE GAME ACTUALLY KNOWS. The last turn record carries the
   * target of the roll that was thrown, and a roll thrown at a creature on the
   * turn the player's hit points reached zero is as close to a killer as
   * anything written down gets. A turn that threw no dice — a hazard the game master
   * resolved outright — leaves this absent, and the screen says where they died
   * rather than inventing who did it.
   */
  killer?: string;
  /** what they were doing, in their own words, from the last turn record */
  lastAction?: string;
  /**
   * Everything standing in the room at the end.
   *
   * SEPARATE FROM `killer` ON PURPOSE. Nothing in the entity model marks a
   * creature as hostile, so the thing that killed them and the thing that
   * happened to be in the room are not the same claim and must not be rendered
   * as one. This is context for the prose; `killer` is the accusation.
   */
  present: string[];
}

/**
 * How the run ended, for a run that ended in death.
 *
 * `undefined` for every other ending, so a caller can hand it any run and get
 * back exactly what there is to say.
 */
export function causeOfDeath(run: RunState, dungeon?: GeneratedDungeon): DeathReport | undefined {
  if (run.stage !== "dead") return undefined;

  const roomId = run.currentRoomId;
  const room = run.entities.rooms.find((r) => r.id === roomId);
  const last = run.turnRecords[run.turnRecords.length - 1];

  const alive = (c: ICreature): boolean => c.count === undefined || c.count > 0;
  const inTheRoom = run.entities.creatures.filter((c) => c.roomId === roomId && alive(c));
  const target = last?.target
    ? run.entities.creatures.find((c) => c.id === last.target)
    : undefined;

  return {
    where: theRoom(room?.name ?? dungeon?.pass.name ?? "somewhere down there"),
    turn: run.turnCount,
    ...(target ? { killer: describe(target) } : {}),
    ...(last?.action ? { lastAction: last.action } : {}),
    present: inTheRoom.map(describe),
  };
}

/** A creature as a phrase, with its number when there is more than one of it. */
function describe(c: ICreature): string {
  return c.count !== undefined && c.count > 1 ? `${c.name} (${c.count})` : c.name;
}
