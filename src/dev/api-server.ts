/**
 * THE API, AS A LOCAL PROCESS
 * ===========================
 *
 *   node src/dev/api-server.ts            # listens on 8787
 *   PORT=9000 node src/dev/api-server.ts
 *
 * The SAME Hono app that deploys — the only difference is what is listening in
 * front of it, `@hono/node-server` here and Vercel's runtime there. That is the
 * whole reason for choosing Hono: local development exercises production code
 * rather than a parallel implementation that can drift from it.
 *
 * The Vite dev server proxies `/api` here, so the browser still sees one origin
 * and nothing in the client knows the difference.
 *
 * TWO SECRETS, both from `.env.local`, both read in Node and neither reaching a
 * browser: `ANTHROPIC_API_KEY` and `DATABASE_URL`. This file loads that file
 * itself because nothing else will — Vite used to, and Vite is no longer in
 * this path.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { serve } from "@hono/node-server";
import { registerRawMarkdown } from "./lib/raw-md.ts";

// BEFORE the app is imported. The game master's playbook is markdown loaded with
// Vite's `?raw`, which plain `node` does not understand — see raw-md.ts — and a
// static import of the app would be hoisted above this line.
registerRawMarkdown();

/**
 * `.env.local`, parsed plainly.
 *
 * No dotenv dependency for six lines, and deliberately non-destructive: a value
 * already in the environment wins, so `DATABASE_URL=... node …` overrides the
 * file without editing it.
 */
function loadEnvLocal(): void {
  let text: string;
  try {
    text = readFileSync(resolve(process.cwd(), ".env.local"), "utf8");
  } catch {
    console.warn("[dev] no .env.local; expecting ANTHROPIC_API_KEY and DATABASE_URL in the environment");
    return;
  }

  for (const line of text.split("\n")) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    const [, name, raw] = m;
    if (process.env[name] !== undefined) continue;
    process.env[name] = raw.replace(/^["']|["']$/g, "");
  }
}

loadEnvLocal();

const { createApp } = await import("../server/app.ts");
const { closeDb } = await import("../server/db/connection.ts");

const port = Number(process.env.PORT ?? 8787);
const server = serve({ fetch: createApp().fetch, port }, (info) => {
  console.log(`api listening on http://localhost:${info.port}`);
});

// Ctrl-C should not leave the pooler holding connections for their idle
// timeout, which on a restart loop adds up.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => void closeDb().then(() => process.exit(0)));
  });
}
