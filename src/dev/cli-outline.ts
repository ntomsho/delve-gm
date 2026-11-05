/**
 * MEASURE THE OUTLINE PASS
 * ========================
 *
 * Runs the outline, repair and polish calls alone, across writer and reviewer
 * models, and writes each seed's outlines side by side to read.
 *
 *   node src/dev/cli-outline.ts --dry                  # prompts only, no calls
 *   node src/dev/cli-outline.ts                        # 3 seeds, Haiku writes and reviews
 *   node src/dev/cli-outline.ts --compare              # 3 seeds x 4 pairings of models
 *   node src/dev/cli-outline.ts --seeds 1005 --out out/one
 *
 * This file teaches Node what a `?raw` import is before anything that reaches a
 * prompt is imported. See `lib/raw-md.ts`.
 */

import { registerRawMarkdown } from "./lib/raw-md.ts";

registerRawMarkdown();
await import("./lib/outline.ts");
