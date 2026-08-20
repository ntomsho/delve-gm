/**
 * THE REFEREE, WITH A MODEL BEHIND IT
 * ===================================
 *
 * The other implementation of `Referee`. The stub answers from a keyword table;
 * this one asks the model. Nothing in `turn.ts` changes between them, which was
 * the point of the seam.
 *
 * A TURN IS A CONVERSATION, NOT A QUESTION. The generation passes ask once and
 * validate once. A turn goes: the referee reads the room, asks the dice for
 * everything it needs in one batch, reads what came back, writes the outcome,
 * and commits. So this file owns a loop, and the loop's stopping rules are the
 * interesting part:
 *
 *   - `tool_choice: auto`, and NOT `any`. Forcing a tool call is the obvious
 *     way to guarantee the turn commits, and it was the first thing tried. It
 *     costs the narration: a forced call suppresses the prose that would have
 *     come before it, and on the first live run an information action came back
 *     as a bare commit — 81 output tokens, nothing for the player to read. The
 *     prose is the product. So the model is left free to write, and a turn that
 *     ends without committing is asked again rather than prevented.
 *   - A commit that fails validation is handed back as a tool ERROR, in the
 *     same conversation, with the reasons. That is a correction, not a retry:
 *     the model still has everything it just wrote.
 *   - On the last permitted round the dice are taken off the table and
 *     `commit_state` is forced, so a referee that keeps rolling gets closed out
 *     rather than looping until the budget is gone.
 *
 * WHAT IT DOES NOT DO. It does not apply anything, does not decide what a turn
 * means, and does not know what stage the game is in beyond what it is told.
 * The commit goes back to the machine, the machine hands it to the applier, and
 * the applier is the thing that says no.
 *
 * The one number this file produces that did not come from the model is every
 * number: the dice are rolled here, from the run's seeded RNG. The model reads
 * results it did not choose.
 */

import { dcFromDefense, ORDINARY_DC, pcArmorDefense } from "../engine/index.ts";
import { renderOutcomes, rollBatch } from "./dice.ts";
import { assemble } from "./prompts/assemble.ts";
import {
  callWithTools,
  toolFor,
  toolResults,
  type Message,
  type ToolDefinition,
  type ToolUse,
  type Usage,
} from "./llm/client.ts";
import { ResponseFormatError, validate } from "./llm/json.ts";
import {
  commitSchema,
  rollBatchSchema,
  type CommitParsed,
  type RollBatchParsed,
} from "./llm/schemas.ts";
import { modelFor, type Task } from "./llm/models.ts";
import { PLAYER_ID, type Commit } from "./diffs/types.ts";
import type { RollSpec } from "./types.ts";
import type { Referee, RefereeReply, RefereeRequest } from "./turn.ts";
import type { GameStore } from "../store/game.ts";
import { NO_JOURNAL, type Journal } from "./journal.ts";

// ---------------------------------------------------------------------------
// THE TOOLS
// ---------------------------------------------------------------------------

const COMMIT_TOOL: ToolDefinition = toolFor(
  "commit_state",
  "End your turn. Carries the words the player reads (`post`), where the game goes next, how long " +
    "the action took (`timeSpent`, which decides who else got to move), and " +
    "what changed. Exactly one call per turn, always — even a turn that changes nothing commits, " +
    "to say what the player's input area should be waiting on. Call this LAST. Anything you " +
    "write outside this call is your own working-out and is never shown to anyone.",
  commitSchema
);

const ROLL_TOOL: ToolDefinition = toolFor(
  "roll",
  "Roll dice. Takes a LIST and answers all of it at once, so ask for everything the turn " +
    "might need in one call — creature attacks, morale, a trap going off — and discard what " +
    "you end up not using. Going back for a second batch costs a whole extra exchange. The " +
    "player's own roll never comes through here; it was already made for you.",
  rollBatchSchema
);

// ---------------------------------------------------------------------------
// NORMALISING WHAT COMES BACK
// ---------------------------------------------------------------------------

type ParsedRollRequest = NonNullable<CommitParsed["rollRequest"]>;

/**
 * The referee's roll request becomes the machine's `RollSpec`.
 *
 * The one thing that actually changes shape: the playbook speaks of a target's
 * DEFENSE and the machine wants the number to MEET, so the conversion happens
 * here, once, through the one function in the codebase that owns the `+1`.
 */
function toRollSpec(r: ParsedRollRequest): RollSpec {
  const dc =
    r.kind === "save"
      ? r.dc ?? ORDINARY_DC
      : r.targetDefense !== undefined
        ? dcFromDefense(r.targetDefense)
        : // Already converted by a referee that gave a bare dc instead. Taken
          // at face value rather than converted twice.
          r.dc!;

  return {
    kind: r.kind,
    ability: r.ability,
    bonus: r.bonus,
    edge: r.edge,
    description: r.description,
    dc,
    ...(r.weapon !== undefined ? { weapon: r.weapon } : {}),
    ...(r.mode !== undefined ? { mode: r.mode } : {}),
    ...(r.advantageUse !== undefined ? { advantageUse: r.advantageUse } : {}),
    ...(r.damage !== undefined ? { damage: r.damage } : {}),
    ...(r.targetId !== undefined ? { targetId: r.targetId } : {}),
  };
}

/**
 * DAMAGE THAT NO DICE PRODUCED.
 *
 * The load-bearing rule of the whole system is that the model never generates a
 * number, and this is where a violation of it actually shows up. Observed on
 * the first live run: the player was offered no roll for climbing down a wet
 * rock face, and the referee simply narrated the fall — the slip, the water,
 * "you are hurt but breathing" — and wrote hit points off the sheet. Every word
 * of it was good. None of it was earned.
 *
 * A turn that takes hit points off ANYTHING must have dice behind it: the
 * player's own roll, which arrives with the request, or a `roll` call made
 * during this turn. Neither means the number was invented, and an invented
 * number is refused before the applier ever sees it — the applier's whitelist
 * cannot catch this, because `hp.current` is perfectly writable and only the
 * provenance is wrong.
 *
 * HEALING IS LEFT ALONE. A written salve that restores what it says it restores
 * is reading a number off the fiction, not inventing one. Damage is the
 * direction that costs the player something they did not agree to risk.
 */
function unearnedDamage(req: RefereeRequest, commit: Commit): string[] {
  const before = new Map<string, number>([[PLAYER_ID, req.run.pc.hp.current]]);
  for (const c of req.run.entities.creatures) before.set(c.id, c.stats.hp);

  const out: string[] = [];
  for (const d of commit.diffs) {
    if (d.path !== "hp.current" && d.path !== "stats.hp") continue;
    if (typeof d.value !== "number") continue;

    const was = before.get(d.entityId);
    if (was === undefined || d.value >= was) continue;

    out.push(
      `[${d.entityId}] loses ${was - d.value} hit points, but no dice were rolled this turn. ` +
        `Damage comes off the \`roll\` tool or off the player's own roll — never off your judgement.`
    );
  }

  if (out.length > 0) {
    out.push(
      `If this action had stakes, that is what the roll is FOR: put it on the table with ` +
        `nextStage "roll_offered" and stop there. The player takes it, and you resolve what it said. ` +
        `If the harm belongs to something other than the player's own attempt — a creature striking ` +
        `back, a fall, a trap — call \`roll\` for it and use what comes back.`
    );
  }
  return out;
}

/**
 * THE ROLL THAT WAS NEVER OFFERED.
 *
 * A sibling of `unearnedDamage`, and the same shape of failure: the numbers had
 * a provenance, and the player still did not get what they were owed. Observed
 * on a live run — asked whether they could hide inside a forge-stone, the
 * referee worked out a DEX save, wrote "Step 4 — Confirm and roll," and then
 * called `roll` for it. The dice were honest. The player never saw the roll
 * offered, never took it, and read the outcome of an attempt they were not
 * asked to commit to. Two turns in a row.
 *
 * THE PLAYER'S ROLL IS THE ONE PLACE THE GAME HANDS THEM THE DICE. It goes on
 * the table as `roll_offered` with a `rollRequest`, the turn ENDS there, and
 * the interface throws it when they take it. The `roll` tool is for everything
 * else — the creatures, the traps, the falling masonry.
 *
 * HOW ONE IS RECOGNISED. Only the bonus tells them apart: a roll made at one of
 * the player character's own six modifiers, on a turn where no roll of theirs
 * has arrived, is theirs. Two exceptions keep it honest — `morale` and `damage`
 * are never a player's roll whatever the number, and an `attack` aimed at the
 * player's own armour is a creature striking them, not them striking out.
 *
 * A bonus can collide by coincidence: a 2HD creature saving against a shove
 * shares +2 with a player who has it. So the refusal names `actor` as the way
 * out — a roll marked as a creature's or the world's is taken at its word, and
 * a referee that meant it costs itself one round rather than the turn.
 */
function playersOwnDice(req: RefereeRequest, batch: RollBatchParsed): string[] {
  // A roll of theirs already in hand: this turn is resolving it, and whatever
  // else it needs is the world's.
  if (req.roll) return [];

  const pc = req.run.pc;
  const theirs = new Set<number>(Object.values(pc.abilities));
  const armor = pcArmorDefense(pc);

  const out: string[] = [];
  for (const r of batch.rolls) {
    // Never theirs, whatever the numbers: morale and damage belong to something
    // else, and a consultation is the book running dry rather than the player
    // being tested — they carry no bonus into it and cannot fail it.
    if (r.kind === "morale" || r.kind === "damage" || r.kind === "consult") continue;
    if (r.actor !== undefined) continue;
    if (r.bonus === undefined || !theirs.has(r.bonus)) continue;
    if (r.kind === "attack" && r.targetDefense === armor) continue;

    out.push(
      `[${r.id}] is a ${r.kind} at ${r.bonus >= 0 ? "+" : ""}${r.bonus}, which is one of the ` +
        `player character's own bonuses — so this is their roll, and you do not throw it.`
    );
  }

  if (out.length > 0) {
    out.push(
      `Their roll goes on the table and the turn ends there: commit nextStage "roll_offered" ` +
        `and nextStep "4-confirm-roll" with the terms as the \`rollRequest\`. They take it, and it ` +
        `comes back to you at step 5 already made. If one of these is a creature's roll or the ` +
        `world's and only happens to share a bonus with them, mark it \`actor\` and ask again.`
    );
  }
  return out;
}

/**
 * A TURN THAT WOULD REACH THE PLAYER AS A BLANK SCREEN.
 *
 * The other half of moving the post onto the commit (§8a A9). Once loose text
 * is no longer narration, a referee that writes its paragraph outside the tool
 * call has written it to nobody — so the absence has to be caught here, where it
 * can be handed back as a correction inside the same conversation, rather than
 * discovered by the player.
 *
 * TWO TURNS LEGITIMATELY WRITE NO POST, and both are cases where prose would be
 * wasted rather than missing:
 *
 *   - A ROOM ENTRY. The room's own `composed` is the paragraph the player reads
 *     on arrival — `room-entry.md` says so — and asking for it twice would cost
 *     double the output tokens for one paragraph and invite the two copies to
 *     drift. `arrival()` reads it out of the diffs.
 *   - A COMMIT THAT MOVES THE PLAYER. `5-resolution.md` says to write none: the
 *     arrival pass runs the moment this commit lands and it is the one with the
 *     new room in front of it. The machine discards the prose either way, so
 *     requiring it here would be requiring something to throw away.
 */
function missingPost(req: RefereeRequest, c: CommitParsed): string[] {
  if (c.post !== undefined) return [];
  if (req.step === "room-entry") return [];
  if (c.diffs.some((d) => d.entityId === PLAYER_ID && d.path === "roomId")) return [];

  return [
    `this commit has no \`post\`, so the turn reaches the player as a blank screen. ` +
      `The post is a field of \`commit_state\` — anything you write outside the tool call is ` +
      `working-out and is never shown. Put the words meant for the player in \`post\` and commit again.`,
  ];
}

/**
 * WHAT A TURN THAT DID NOT HAPPEN COST IN TIME: nothing.
 *
 * Beside `missingPost`, and the same family as the no-diffs rule the applier
 * keeps — a rule about what a STAGE MEANS, so it is checked rather than asked
 * for. A `clarifying` turn is a question back to the player and a `rejected` one
 * is an action turned away; a `roll_offered` turn is the terms going on the
 * table with nobody having touched them yet. None of the three is a turn that
 * happened, so none of them may let a creature cross a room.
 *
 * A ROOM ENTRY IS NOT A TURN EITHER, and it is the case the design did not
 * name. It is the consequence of one — `turn.ts` says so where it decides what
 * closes a turn: "the move that caused it has already ticked the clock, and
 * counting it would charge the player twice for walking through a door."
 * Without this line, walking through a door advances every approaching creature
 * twice for one move.
 *
 * `long` IS A NIGHT'S REST AND THERE IS NO WAY TO SAY SO YET. Rest is Phase 16
 * and arrives as a button, resolved client-side like the player's own d20; until
 * that exists a `long` turn is the referee inventing an hour that nothing in the
 * interface offered. It is on the wire so Phase 16 does not have to reopen the
 * schema, and refused here so it cannot be reached early.
 */
function timeNotSpent(req: RefereeRequest, c: CommitParsed): string[] {
  if (c.timeSpent === "long") {
    return [
      `timeSpent "long" is a night's rest, and there is no way to take one yet — ` +
        `it arrives with the Rest button, not out of an action the player typed. ` +
        `Whatever this was, it took an hour at most: say "short".`,
    ];
  }

  if (c.timeSpent === "instant") return [];

  const why =
    req.step === "room-entry"
      ? `a room entry is not a turn — it is the consequence of the move that caused it, ` +
        `and that move has already been paid for`
      : IDLE_STAGES.includes(c.nextStage)
        ? `a "${c.nextStage}" turn has not happened yet: nothing was resolved and nothing changed`
        : undefined;

  return why === undefined
    ? []
    : [
        `timeSpent is "${c.timeSpent}", but ${why}. No time passes, so nothing anywhere ` +
          `in the dungeon gets to move. Commit timeSpent "instant".`,
      ];
}

/** The three stages that end a turn without one having taken place. */
const IDLE_STAGES: readonly CommitParsed["nextStage"][] = ["clarifying", "rejected", "roll_offered"];

/**
 * The cross-field rules a JSON Schema cannot state.
 *
 * BUILD-PLAN §4.1 wants these caught as schema violations rather than left to
 * confuse the interface — a `roll_offered` with nothing to roll is a game
 * sitting on a Roll button that does nothing. Returned as text because that is
 * what goes back to the model.
 *
 * The "rejections change nothing" rule is NOT here: the applier enforces it,
 * and enforcing it in two places would mean two places to get it wrong.
 */
function problemsWith(c: CommitParsed): string[] {
  const out: string[] = [];

  if (c.nextStage === "roll_offered" && c.rollRequest === undefined) {
    out.push(`nextStage is "roll_offered" but there is no rollRequest — the player would have nothing to roll.`);
  }
  if (c.nextStage !== "roll_offered" && c.rollRequest !== undefined) {
    out.push(`a rollRequest is only legal when nextStage is "roll_offered"; this one says "${c.nextStage}".`);
  }
  if (c.rollRequest && c.rollRequest.kind !== "save") {
    const r = c.rollRequest;
    if (r.targetDefense === undefined && r.dc === undefined) {
      out.push(`a ${r.kind} rollRequest needs targetDefense — the defense of what is being struck.`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// THE LOOP
// ---------------------------------------------------------------------------

/**
 * The store, declared by what this file uses of it. Structural on purpose, so
 * the referee never imports zustand — see the note atop `store/game.ts`.
 */
type Store = { getState(): GameStore };

export interface ModelRefereeOptions {
  /** the run this referee answers for — see `createGameStore` */
  store: Store;
  /** where the run writes itself down. Omitted means it does not. */
  journal?: Journal;
  /**
   * How many model calls one turn may take. Four is room to narrate, roll,
   * read, and commit, with one spare for a correction — and a hard stop on a
   * referee that would otherwise keep asking for dice.
   */
  maxRounds?: number;
  signal?: AbortSignal;
}

export function createModelReferee(opts: ModelRefereeOptions): Referee {
  const { store, journal = NO_JOURNAL } = opts;
  const maxRounds = opts.maxRounds ?? 4;

  return async function referee(req: RefereeRequest): Promise<RefereeReply> {
    const task: Task = req.step === "room-entry" ? "room-entry" : "turn-loop";
    const prompt = assemble(req);
    journal.logSystem(req.step, prompt.system);
    const messages: Message[] = [...prompt.messages];
    /** whether any dice have been thrown for this turn — see unearnedDamage */
    let rolled = false;

    /*
     * THERE IS NO POST TO ACCUMULATE ANY MORE.
     *
     * There were two variables here — `banked` for what earlier rounds had
     * written and `attempt` for the round in flight — and between them they had
     * to work out, from the text alone, whether a round was CONTINUING the turn
     * or REDOING it. A rolling round continued it; a nudge or a refused commit
     * redid it and had to replace what it wrote rather than add to it. Nothing
     * in the text says which, so the loop guessed from tags and from whether
     * dice had been asked for, and A9 is the case where guessing loses: a
     * referee that changed its mind INSIDE one response wrote two drafts into
     * one block, and no rule about blocks can separate them.
     *
     * The post is a field of the commit now, and there is exactly one commit per
     * turn. Whatever the referee wrote and thought better of never had anywhere
     * to go. See `commitSchema.post`.
     */

    for (let round = 1; round <= maxRounds; round++) {
      // The last round closes the turn: the dice come off the table so that
      // forcing `commit_state` is the only thing left to do.
      const last = round === maxRounds;
      const turn = await call({
        task,
        round,
        system: prompt.system,
        messages,
        tools: last ? [COMMIT_TOOL] : [ROLL_TOOL, COMMIT_TOOL],
        toolChoice: last ? { type: "tool", name: "commit_state" } : { type: "auto" },
        signal: opts.signal,
        step: req.step,
        store,
        journal,
      });

      const rolls = turn.toolUses.filter((t) => t.name === "roll");

      const commit = turn.toolUses.find((t) => t.name === "commit_state");
      if (commit) {
        const read = readCommit(commit, (parsed, c) => [
          ...missingPost(req, parsed),
          ...timeNotSpent(req, parsed),
          // Dice already in hand — the player's, or a batch rolled this turn —
          // mean the numbers have a provenance and nothing needs checking.
          ...(rolled || req.roll ? [] : unearnedDamage(req, c)),
        ]);
        if (typeof read === "string") {
          // Refused before it ever reached the applier. Hand it back inside the
          // same conversation, so the model corrects rather than re-derives.
          messages.push(
            { role: "assistant", content: turn.content },
            toolResults([{ id: commit.id, content: read, isError: true }])
          );
          continue;
        }
        return {
          // The post, or the room's own paragraph on the one turn that writes
          // none. Nothing from the loose text channel: that is working-out now,
          // whatever it looks like.
          narration: read.post ?? arrival(req, read.commit),
          commit: read.commit,
        };
      }

      if (rolls.length > 0) {
        const answers = rolls.map((r) =>
          answerRoll(store, journal, r, (batch) => playersOwnDice(req, batch))
        );

        // A batch that was refused threw nothing, so it buys no provenance —
        // which is the only thing this flag is for now that there is no prose
        // to carry across rounds.
        if (answers.some((a) => a.threw)) rolled = true;

        messages.push(
          { role: "assistant", content: turn.content },
          toolResults(answers.map((a) => a.result))
        );
        continue;
      }

      // Prose and then silence. Not forbidden — see the note on `auto` above —
      // so ask for the commit rather than losing the turn to it.
      messages.push(
        { role: "assistant", content: turn.content },
        {
          role: "user",
          content: `You ended your turn without calling \`commit_state\`. The game is now waiting on a stage nobody set. Call \`commit_state\` and say where the turn leaves the player.`,
        }
      );
    }

    throw new Error(
      `the referee did not commit within ${maxRounds} calls (step ${req.step})`
    );
  };
}

/*
 * THE `<post>` TAGS ARE GONE, and so is everything that read them.
 *
 * They existed because the referee has no private place to think: it is a cheap
 * model with no thinking mode, the heuristic is five steps of genuine
 * deliberation, and every word written outside a tool call went straight onto
 * the screen — two hundred words of "## Step 1 — Determine the target" above the
 * actual paragraph, on the first live run. Tagging the post and hiding the rest
 * fixed that, and could not fix A9: a referee that writes two drafts inside the
 * tags has written two tagged posts, and no rule about markers can tell a draft
 * from the thing it was replaced by.
 *
 * Moving the post into `commit_state` retires the whole question. Loose text is
 * working-out BY DEFINITION now — there is nothing it could be mistaken for —
 * so the marker has no job left. It is still in the response and still in the
 * call log, which is where reading it is useful.
 */

/**
 * WHAT THE PLAYER READS WHEN THEY WALK IN.
 *
 * A room entry that wrote no prose is not a referee that forgot to speak. The
 * room's `composed` IS the paragraph the player reads on arrival — room-entry.md
 * says so in as many words — so a model that writes it into the diff and stops
 * has done the work and simply not repeated itself. Observed on the first live
 * run: a full, good description of the chasm written onto the room, and an
 * empty screen.
 *
 * Asking it to write the same paragraph twice would cost double the output
 * tokens for one paragraph and invite the two copies to drift. So the commit is
 * read for it instead, and the playbook says that is the arrangement.
 *
 * Only on entry, and only when there is nothing else: prose the referee wrote
 * for the player always wins.
 */
function arrival(req: RefereeRequest, commit: Commit): string {
  if (req.step !== "room-entry") return "";
  const here = req.run.currentRoomId;
  const written = commit.diffs.findLast(
    (d) => d.entityId === here && d.path === "composed" && typeof d.value === "string"
  );
  return (written?.value as string | undefined) ?? "";
}

/**
 * Validate a commit, or say what is wrong with it in the model's own terms.
 *
 * `also` is the pair of checks that need the turn's own history — whether any
 * dice were thrown, and which step this is — which this function does not have
 * and should not grow parameters for. It is handed both shapes: the parsed
 * commit, which still carries the `post`, and the normalised one, which is what
 * the applier would see.
 *
 * THE POST COMES BACK BESIDE THE COMMIT rather than on it. `Commit` is what the
 * applier and the store consume, and neither has any business with prose — the
 * post is the referee's answer to the player, and it travels in `RefereeReply`
 * where the machine already expects it.
 */
function readCommit(
  call: ToolUse,
  also: (parsed: CommitParsed, commit: Commit) => string[]
): { commit: Commit; post?: string } | string {
  let parsed: CommitParsed;
  try {
    parsed = validate(commitSchema, call.input);
  } catch (e) {
    if (e instanceof ResponseFormatError) return e.feedback;
    throw e;
  }

  const commit: Commit = {
    nextStage: parsed.nextStage,
    nextStep: parsed.nextStep,
    timeSpent: parsed.timeSpent,
    diffs: parsed.diffs,
    ...(parsed.rollRequest ? { rollRequest: toRollSpec(parsed.rollRequest) } : {}),
    ...(parsed.goalMet ? { goalMet: true } : {}),
    ...(parsed.fictionNote ? { fictionNote: parsed.fictionNote } : {}),
    ...(parsed.draw ? { draw: parsed.draw } : {}),
    ...(parsed.learned && parsed.learned.length > 0 ? { learned: parsed.learned } : {}),
    ...(parsed.coinGrant ? { coinGrant: parsed.coinGrant } : {}),
  };

  const problems = [...problemsWith(parsed), ...also(parsed, commit)];
  if (problems.length > 0) {
    return `That commit was refused and nothing was applied:\n${problems
      .map((p) => `  - ${p}`)
      .join("\n")}\nCall commit_state again with those fixed.`;
  }

  return { commit, ...(parsed.post !== undefined ? { post: parsed.post } : {}) };
}

type RollResult = { id: string; content: string; isError?: boolean };

/**
 * Roll what was asked for, from the run's own stream.
 *
 * `syncRng` immediately after: the draw count is what makes a reload resume
 * mid-stream, and dice that were rolled but not recorded would be rolled again.
 *
 * `threw` is what the caller cannot see from the result alone: a batch that was
 * malformed or refused comes back as an error having touched neither the stream
 * nor the turn, and a turn that has not thrown any dice is still a turn that
 * cannot write damage off its own judgement.
 */
function answerRoll(
  store: Store,
  journal: Journal,
  call: ToolUse,
  guard: (batch: RollBatchParsed) => string[]
): { result: RollResult; threw: boolean } {
  let batch: RollBatchParsed;
  try {
    batch = validate(rollBatchSchema, call.input);
  } catch (e) {
    if (e instanceof ResponseFormatError) {
      return { result: { id: call.id, content: e.feedback, isError: true }, threw: false };
    }
    throw e;
  }

  // Checked before the stream is touched: a refused batch must cost no draws,
  // or the dice the referee is about to ask for properly come out different.
  const refused = guard(batch);
  if (refused.length > 0) {
    return {
      result: {
        id: call.id,
        content: `Nothing was rolled:\n${refused.map((p) => `  - ${p}`).join("\n")}`,
        isError: true,
      },
      threw: false,
    };
  }

  const rng = store.getState().rng();
  const outcomes = rollBatch(rng, batch.rolls);
  store.getState().syncRng(rng);
  journal.log({ kind: "roll", source: "referee", requested: batch.rolls, outcomes, draws: rng.draws });

  return {
    result: {
      id: call.id,
      content: renderOutcomes(outcomes),
      ...(outcomes.some((o) => o.failed) ? { isError: true } : {}),
    },
    threw: true,
  };
}

/**
 * One call, timed and logged.
 *
 * `turn.ts` deliberately does not write to `callLog` — it cannot know what
 * model answered or what it cost. This is where that is known, so this is where
 * it is written, on the way out and on the way down.
 */
async function call(
  args: Parameters<typeof callWithTools>[0] & {
    step: RefereeRequest["step"];
    store: Store;
    journal: Journal;
    round: number;
  }
) {
  const { step, store, journal, round, ...rest } = args;
  const started = Date.now();

  // What was actually sent, minus the system blocks — those are written once
  // per step per run rather than repeated on every call.
  journal.log({ kind: "prompt", step, messages: rest.messages });

  const logCall = (usage: Usage, error?: string) =>
    store.getState().logCall({
      at: started,
      step,
      model: modelFor(rest.task),
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      ms: Date.now() - started,
      ...(error ? { error } : {}),
    });

  try {
    const turn = await callWithTools(rest);
    logCall(turn.usage);
    journal.log({
      kind: "response",
      step,
      round,
      text: turn.text,
      toolUses: turn.toolUses,
      usage: turn.usage,
      ms: Date.now() - started,
    });
    return turn;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    logCall({ inputTokens: 0, outputTokens: 0 }, message);
    journal.log({ kind: "error", where: `referee:${step}`, message });
    throw e;
  }
}
