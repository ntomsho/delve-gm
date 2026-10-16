/**
 * ROOM ILLUSTRATION COMPOSITIONS, CHECKED AGAINST THE MAP
 * ================================================
 *
 *   node src/dev/cli-illustration-views.ts                          # offline seed 1005, size 1
 *   node src/dev/cli-illustration-views.ts --offline --seed 42 --size 2
 *   node src/dev/cli-illustration-views.ts --dungeon out/live-4201.json
 *   ... --out out/illustrations/views.html
 *
 * No model calls, no key. For every room and every door into it, one row:
 * the room from above with the viewer's eye and field of view drawn on it, the
 * same room as a perspective wireframe from that eye, and the brief the image
 * prompt would carry. The numbers (E1, F1) are the same thing in all three, so
 * a door the brief calls "in the left wall, close by" can be found on the map
 * and checked.
 *
 * Hidden features and concealed doors are drawn grey on the map and nowhere
 * else, so the filter can be seen working.
 *
 * The script is `lib/illustration-views.ts`. This file teaches Node what a `?raw`
 * import is before anything that reaches a prompt is imported — a static
 * import would be resolved first. See `lib/raw-md.ts`.
 */

import { registerRawMarkdown } from "./lib/raw-md.ts";

registerRawMarkdown();
await import("./lib/illustration-views.ts");
