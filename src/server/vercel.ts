/**
 * THE FUNCTION VERCEL RUNS.
 *
 * One catch-all: `vercel.json` rewrites every `/api/*` path here, and Hono does
 * the routing from there. A file per route would mean a cold start per route
 * and a copy of the runtime in each bundle.
 *
 * `export default { fetch }` is the Web-standard handler shape, which is what
 * Vercel's Node runtime wants and what Hono already is. That is most of why
 * Hono rather than Express: no adapter, and `src/dev/api-server.ts` runs the same
 * object locally.
 *
 * BUILT BY VITE, not by Vercel's bundler — see `npm run build:api`. The
 * game master's playbook is markdown imported with `?raw`, which Vite understands
 * and esbuild does not, so the API is bundled to plain JavaScript with the
 * prose already inlined before it is ever deployed.
 *
 * WHICH IS WHY THIS FILE IS NOT IN `api/`. That directory holds exactly one
 * thing — the built `index.js` — because Vercel scans it for entrypoints, and a
 * `.ts` sitting beside the bundle is an invitation for it to build the source
 * with the bundler that cannot read `?raw`.
 */

import { createApp } from "./app.ts";

const app = createApp();

export default { fetch: app.fetch };

/**
 * 300 seconds is the Vercel Hobby maximum, and generation is what needs it: the
 * region pass is the longest single call and has run to 50 seconds at size 1.
 * No route holds more than one model call, which is why 300 is enough — see the
 * note at the top of `src/server/app.ts`.
 */
export const config = { maxDuration: 300 };
