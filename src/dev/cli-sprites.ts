/**
 * CREATURE SPRITE SPIKE
 * =====================
 *
 *   node src/dev/cli-sprites.ts --dry                    # plan only: who gets a sprite, where they stand
 *   node src/dev/cli-sprites.ts                          # everything, images included
 *   node src/dev/cli-sprites.ts --dungeons out/live-4201.json --setups gpt2-low
 *   node src/dev/cli-sprites.ts --force                  # redraw sprites already on disk
 *   node src/dev/cli-sprites.ts --stage                  # also redraw illustrations with floor reserved for figures
 *   node src/dev/cli-sprites.ts --refs [round]           # style-reference candidates → out/sprite-refs[-round]/
 *
 * Draws a sprite for every creature that gets one, cuts it out in code, and
 * stands it in the illustration of every room it is in. Writes a contact sheet to
 * out/sprites/index.html.
 *
 * WHO GETS A SPRITE (the author's rules, 2026-10-14):
 *   - solos, leaders and named individuals: one each
 *   - a group's nameless members, in every variant: one for the whole group
 *
 * HOW A ROOM'S CREATURES STAND:
 *   - the front row is the leader; or, with no leader, the named creatures side
 *     by side and slightly overlapping; or, with neither, one copy of the group
 *   - the nameless stand behind the front row, up to two on each side
 *   - anything else in the room (an unrelated solo) is a cluster of its own
 *
 * WHERE: a floor point chosen in code and put through `projectToFrame`, the
 * same camera that drew the guide, so the feet land on the floor the illustration was
 * told to draw and the figures behind shrink by the camera's own perspective.
 *
 * ILLUSTRATIONS are the real ones when the bucket has them (fetched by `illustrationKey`),
 * and otherwise drawn here exactly as the server would, without storing them.
 * Since the floor was reserved in the game itself, every illustration drawn now keeps
 * the patch; the illustrations under out/sprites/<dungeon>/illustrations/ that do not were
 * drawn before, and are the spike's "before".
 *
 * CACHED ON DISK under out/sprites/<dungeon id>/, so a rerun pays only for
 * what is missing. Costs are estimates; fal's billing is the truth.
 *
 * The script is `lib/sprites.ts`. This file teaches Node what a `?raw`
 * import is before anything that reaches a prompt is imported — a static
 * import would be resolved first. See `lib/raw-md.ts`.
 */

import { registerRawMarkdown } from "./lib/raw-md.ts";

registerRawMarkdown();
await import("./lib/sprites.ts");
