/**
 * THE END-OF-RUN TALLY
 * ====================
 *
 * One model call, made once, when a run ends alive. Everything about WHAT it
 * asks and what the answers are worth lives in `dungeon-tally-pass.ts`; this is
 * the part that talks to the model and writes the result down.
 *
 * IT NEVER THROWS INTO THE ENDING. A run that has just ended is over whether or
 * not the tally comes back, and a player looking at the "you got out" screen must
 * not instead be looking at an error because a scoring call timed out. So a
 * failed tally is logged and the run keeps its ledger; it can be asked for again.
 */

import {
  applyTally,
  buildTallyPayload,
  renderTallyPrompt,
  shouldTally,
  type Challenge,
  type RunTally,
  type TallyContext,
} from "../engine/index.ts";
import { bestedByBypass, type ChallengeState } from "./challenges.ts";
import { callForJson, type Usage } from "./llm/client.ts";
import { tallyPassSchema } from "./llm/schemas.ts";
import { NO_JOURNAL, type Journal } from "./journal.ts";
import type { Stage } from "./types.ts";

export interface TallyRequest {
  challengeState: ChallengeState;
  challenges: readonly Challenge[];
  dungeonContext: string;
  /** the stage the run ended on — `dead` does not tally */
  ending: Stage;
  level: number;
  hp: { current: number; max: number };
  turns: number;
  journal?: Journal;
  signal?: AbortSignal;
}

export interface TallyResult {
  tally: RunTally;
  usage: Usage;
}

/**
 * How the run ended, in the words the rater should weigh.
 *
 * The stage names are the game's vocabulary rather than English, and "escaped"
 * in particular reads as a near miss when it means the player walked out alive
 * without the thing they came for. Said properly here rather than left for the
 * model to interpret.
 */
const ENDING_SAID: Partial<Record<Stage, string>> = {
  goal_met: "they walked out alive with what they came for",
  escaped: "they walked out alive, without what they came for",
  abandoned: "the player left the run rather than the dungeon",
  dead: "they died down there",
};

/**
 * Rate a finished run.
 *
 * Returns `undefined` when there is nothing to rate — a death, or a run that
 * accomplished nothing — and that is a normal answer rather than a failure. See
 * `shouldTally`.
 */
export async function tallyRun(req: TallyRequest): Promise<TallyResult | undefined> {
  const journal = req.journal ?? NO_JOURNAL;

  const ctx: TallyContext = {
    dungeonContext: req.dungeonContext,
    outcome: ENDING_SAID[req.ending] ?? `the run ended (${req.ending})`,
    level: req.level,
    hp: req.hp,
    turns: req.turns,
    // The one inference in the whole system, made here at the end where it is
    // two timestamps compared rather than a judgement made under pressure.
    bypassed: bestedByBypass(req.challengeState),
  };

  const payload = buildTallyPayload(req.challengeState, req.challenges, ctx);
  if (!shouldTally(req.ending, payload.items)) return undefined;

  const prompt = renderTallyPrompt(payload);
  const { value, usage } = await callForJson({
    task: "tally-pass",
    schema: tallyPassSchema,
    toolName: "rate_the_delve",
    toolDescription: "Rate how much risk the player actually ran in each thing they accomplished.",
    messages: [{ role: "user", content: prompt }],
    ...(req.signal ? { signal: req.signal } : {}),
  });

  journal.log({ kind: "generation", pass: "tally-pass", prompt, response: value, usage });
  return { tally: applyTally(value, payload), usage };
}