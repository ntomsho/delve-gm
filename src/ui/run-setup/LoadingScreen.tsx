/**
 * THE WAIT BEFORE THE GAME
 *
 * Generation is one pure branch and N model calls, and it takes the better part
 * of a minute. The stages are named in `generation/generate.ts` rather than
 * here on purpose — the interface reports what the pipeline says it is doing
 * and has nothing to invent.
 *
 * The one stage with a count is `writing`, because it is the long one and it is
 * the only one where the honest answer to "how much longer" is a number. The
 * others get a marker that says work is happening and does not pretend to know
 * how much is left. Same rule as `Narration`'s indeterminate marker: a progress
 * bar that is guessing is worse than no bar.
 */

import type { GenerationProgress, GenerationStage } from "../../generation/generate.ts";

const ORDER: GenerationStage[] = [
  "layout", "inhabitants", "history", "stocking", "writing", "joining", "keys",
];

const SAYS: Record<GenerationStage, string> = {
  layout: "Cutting the rooms and the ways between them",
  inhabitants: "Deciding who lives here",
  history: "Working out what happened",
  stocking: "Putting things in the rooms",
  writing: "Writing it all down",
  joining: "Hanging the doors between them",
  keys: "Hiding the answers where they can be found",
};

export function LoadingScreen({ progress }: { progress?: GenerationProgress }) {
  const at = progress ? ORDER.indexOf(progress.stage) : -1;

  return (
    <main className="flex h-screen items-center justify-center bg-desk text-ink">
      <div className="w-[380px] border border-rule bg-paper px-8 py-7">
        <h1 className="font-display text-[15px] tracking-[0.02em] text-ink">Building a dungeon</h1>
        <p className="mt-1 font-mono text-[10px] uppercase tracking-[0.14em] text-graphite">
          This happens once, and then not again
        </p>

        <ol className="mt-6 space-y-2.5">
          {ORDER.map((stage, i) => {
            const done = i < at;
            const now = i === at;
            return (
              <li key={stage} className="flex items-baseline gap-3">
                <span
                  className="w-[7px] font-mono text-[11px]"
                  style={{ color: now ? "var(--color-torch)" : "var(--color-pencil)" }}
                  aria-hidden
                >
                  {done ? "·" : now ? "›" : " "}
                </span>
                <span
                  className="font-prose text-[14px] leading-snug"
                  style={{
                    color: now ? "var(--color-ink)" : done ? "var(--color-graphite)" : "var(--color-pencil)",
                  }}
                >
                  {SAYS[stage]}
                  {now && stage === "writing" && progress?.chunksTotal !== undefined && (
                    <span className="ml-2 font-mono text-[11px] text-graphite">
                      {progress.chunksDone ?? 0}/{progress.chunksTotal}
                    </span>
                  )}
                </span>
              </li>
            );
          })}
        </ol>
      </div>
    </main>
  );
}
