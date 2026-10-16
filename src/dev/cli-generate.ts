/**
 * HEADLESS GENERATION
 * ===================
 *
 * Runs the whole pipeline for a seed and dumps the result to JSON. No UI, no
 * browser — this is where the expensive, high-uncertainty part gets iterated on
 * in an environment where a change costs a shell command.
 *
 *   node src/dev/cli-generate.ts --seed 1005 --size 2
 *   node src/dev/cli-generate.ts --seed 1005 --size 2 --dry     # prompts only, no calls
 *   node src/dev/cli-generate.ts --seed 1005 --out out/1005.json
 *   node src/dev/cli-generate.ts --seed 1005 --size 3 --dry --map out/1005.svg
 *
 * `--dry` is the workhorse. It renders every prompt the run would send and
 * exits, so prompt wording can be iterated at zero cost and zero latency.
 *
 * THE KEY. This process reads ANTHROPIC_API_KEY out of .env.local and calls the
 * API directly, because there is no dev server here to proxy through. That is
 * the intended shape: the rule is that the key never reaches the browser, and
 * this is Node.
 *
 * The script is `lib/generate.ts`. This file teaches Node what a `?raw`
 * import is before anything that reaches a prompt is imported — a static
 * import would be resolved first. See `lib/raw-md.ts`.
 */

import { registerRawMarkdown } from "./lib/raw-md.ts";

registerRawMarkdown();
await import("./lib/generate.ts");
