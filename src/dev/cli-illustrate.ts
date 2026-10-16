/**
 * ROOM ILLUSTRATION SPIKE — ROUND 1
 * ==========================
 *
 *   node src/dev/cli-illustrate.ts --dry               # bind, guides, Haiku, prompts; no images
 *   node src/dev/cli-illustrate.ts                     # everything, images included
 *   node src/dev/cli-illustrate.ts --only I3,E2 --setups gpt2-low
 *   node src/dev/cli-illustrate.ts --force             # redo images already on disk
 *   node src/dev/cli-illustrate.ts --style sparse --only I4,E1 --modes gpt2-low=marks,klein-4b=plain+none
 *
 * --style picks one of STYLES below in place of ILLUSTRATION_STYLE, and draws into
 * out/illustrate-<style>/ so its sheet sits beside round 1's. The room words
 * are copied from round 1's cache when they are there, so a style trial
 * changes the style and nothing else.
 *
 * Draws the subjects in `illustration-subjects.ts` through every model setup below
 * and writes a contact sheet to out/illustrate/index.html: per subject, the
 * guide images, the condensed words, the prompts, and a grid of setups x guide
 * modes, each image shown converted to 1-bit with the page's buttons over it.
 *
 * KEYS. ANTHROPIC_API_KEY for the condensing calls and FAL_KEY for the images,
 * from the environment or .env.local. This is a Node script, which is where a
 * key is allowed to be; nothing here reaches a browser.
 *
 * CACHED ON DISK. Haiku answers and finished images are kept under
 * out/illustrate/<subject>/ and reused, so a rerun after a failure only pays
 * for what is missing. --force redraws images; delete visual.json to re-ask.
 *
 * COSTS ARE ESTIMATES from fal's listed prices as of 2026-10-13, per illustration at
 * 1536x1024. fal's own billing is the truth.
 *
 * The script is `lib/illustrate.ts`. This file teaches Node what a `?raw`
 * import is before anything that reaches a prompt is imported — a static
 * import would be resolved first. See `lib/raw-md.ts`.
 */

import { registerRawMarkdown } from "./lib/raw-md.ts";

registerRawMarkdown();
await import("./lib/illustrate.ts");
