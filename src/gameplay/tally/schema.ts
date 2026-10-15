/**
 * ZOD FOR THE TALLY PASS, and the proof that it matches `TallyResponse`.
 */

import { z } from "zod";
import type { TallyResponse } from "./tally-pass.ts";
import { nonEmpty, type Assignable } from "../../shared/utils/schema.ts";

// ---------------------------------------------------------------------------
// TALLY PASS
// ---------------------------------------------------------------------------
// What a finished run was worth. THREE WORDS AND NO NUMBERS — Knave's 50/100/200
// live in `XP_FOR_RISK` and are applied by `applyTally`, so a model that drifts
// cannot drift a run's reward with it.

const tallyRating = z.object({
  challengeId: nonEmpty,
  risk: z.enum(["low", "moderate", "high"]),
  why: nonEmpty,
});

export const tallyPassSchema = z.object({ ratings: z.array(tallyRating) });

export type TallyPassParsed = z.infer<typeof tallyPassSchema>;
export type TallyPassMatchesEngine = Assignable<TallyPassParsed, TallyResponse>;
