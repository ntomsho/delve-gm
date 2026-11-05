/**
 * THE OUTLINE'S MODEL CALLS: write one, with narrow repair, then review it.
 *
 * A polish that fails is thrown away whole and the draft stands, so a bad review
 * can't cost a dungeon. A draft that can't be repaired fails the generation, because
 * a pass never produces partial content.
 */

import { callForJson, type FailedAttempt, type Usage } from "../../../../llm/client.ts";
import type { DungeonPassResponse } from "../dungeon-pass.ts";
import {
  renderOutlinePrompt,
  renderOutlineRepair,
  renderPolishPrompt,
} from "./prompt.ts";
import {
  applyPolish,
  MAX_POLISH_EDITS,
  mergeOutline,
  outlineSchema,
  outlineViolations,
  polishSchema,
  refLeaks,
  type Outline,
  type PolishEdit,
} from "./response.ts";
import type { OutlineDraft } from "./roll.ts";

export interface OutlineCallOptions {
  /** overrides the task's model, to compare them */
  model?: string;
  signal?: AbortSignal;
  onAttemptFailed?: (report: FailedAttempt) => void;
}

export interface WrittenOutline {
  outline: Outline;
  usage: Usage;
  /** how many calls it took; more than 1 means a retry or a repair */
  attempts: number;
}

export async function writeOutline(
  draft: OutlineDraft,
  pass: DungeonPassResponse,
  opts: OutlineCallOptions = {}
): Promise<WrittenOutline> {
  // `ask` is only told what is missing; what is still unused comes off the answer.
  let latest: Outline | undefined;
  const { value, usage, attempts } = await callForJson({
    task: "outline",
    schema: outlineSchema,
    toolName: "write_outline",
    toolDescription: "Record the plan for this dungeon: what goes in each room, and why.",
    messages: [{ role: "user", content: renderOutlinePrompt(draft, pass) }],
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
    ...(opts.onAttemptFailed ? { onAttemptFailed: opts.onAttemptFailed } : {}),
    check: (o) => {
      latest = o;
      return [...outlineViolations(draft, o), ...refLeaks(o)];
    },
    repair: {
      ask: (missing) => renderOutlineRepair(draft, latest!, missing),
      merge: mergeOutline,
    },
  });
  return { outline: value, usage, attempts };
}

export interface PolishedOutline {
  /** the polished outline if it held up, otherwise the draft */
  outline: Outline;
  /** every edit the reviewer proposed */
  proposed: PolishEdit[];
  /** whether they were kept. All or none. */
  kept: boolean;
  /** why they were thrown away */
  rolledBack?: string;
  usage: Usage;
}

export async function polishOutline(
  draft: OutlineDraft,
  pass: DungeonPassResponse,
  outline: Outline,
  opts: OutlineCallOptions = {}
): Promise<PolishedOutline> {
  const { value, usage } = await callForJson({
    task: "outline-polish",
    schema: polishSchema,
    toolName: "propose_edits",
    toolDescription: "List the edits that would clearly make this outline better. An empty list is a real answer.",
    messages: [{ role: "user", content: renderPolishPrompt(draft, pass, outline) }],
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
    ...(opts.onAttemptFailed ? { onAttemptFailed: opts.onAttemptFailed } : {}),
    check: (p) =>
      p.edits.length > MAX_POLISH_EDITS
        ? [{ path: "edits", message: `at most ${MAX_POLISH_EDITS} edits, not ${p.edits.length}` }]
        : [],
  });

  const proposed = value.edits;
  const applied = applyPolish(outline, proposed);
  if (!applied) {
    return { outline, proposed, kept: false, rolledBack: "an edit named something that does not exist", usage };
  }
  const violations = outlineViolations(draft, applied);
  if (violations.length > 0) {
    return { outline, proposed, kept: false, rolledBack: violations.map((v) => v.message).join("; "), usage };
  }
  return { outline: applied, proposed, kept: proposed.length > 0, usage };
}
