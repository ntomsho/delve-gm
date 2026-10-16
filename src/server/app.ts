/**
 * THE API
 * =======
 *
 * One Hono app, mounted as a single catch-all function. This file is the shell:
 * CORS, the sign-in gate and the error handler. The routes are in `routes/`, one
 * file per area; every statement they run is in `db/repo.ts`.
 *
 * TWO RULES SHAPE THIS WHOLE FILE.
 *
 * ONE MODEL CALL PER REQUEST. A Vercel Hobby invocation may run for 300
 * seconds, and generation is N+2 calls. So building a dungeon is three routes —
 * structure, a region at a time, then apply-and-join — and the client fires the
 * middle one N times in parallel. A turn is one request because a turn is one
 * exchange; its worst case is `maxRounds` calls, which fits.
 *
 * THE CLIENT NEVER ASSERTS A RULE. It sends what the player typed and the
 * version it last saw. It does not say which stage it is on: a client that
 * names its own stage can name a flattering one and be handed a roll it never
 * earned. The version is opaque, so there is no value more favourable than
 * another — see `commitTurn`.
 *
 * Node only.
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { requireUser, type AuthEnv } from "./auth.ts";
import { describeFailure } from "../llm/json.ts";
import { configureTransport } from "../llm/client.ts";
import { characterRoutes } from "./routes/characters.ts";
import { dungeonRoutes } from "./routes/dungeons.ts";
import { runRoutes } from "./routes/runs.ts";
import { playRoutes } from "./routes/play.ts";
import { illustrationRoutes } from "./routes/illustrations.ts";
import { reviewRoutes } from "./routes/review.ts";

// ---------------------------------------------------------------------------
// THE APP
// ---------------------------------------------------------------------------

/**
 * WHERE THE MODEL CALLS GO.
 *
 * The API calls Anthropic directly, with the key from the server's environment.
 * This is what keeps the key out of the browser: a browser talks only to this
 * API, and `llm/client.ts` has no default URL, so nothing calls the model
 * until a process with a key says where it is.
 *
 * Once per process. `configureTransport` is module state in the client, which
 * is right for a process that only ever talks to one provider.
 */
function configureAnthropic(): void {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY is not set; the API cannot reach the model.");
  configureTransport({
    baseUrl: "https://api.anthropic.com",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
  });
}

/**
 * Who may call this API from a browser.
 *
 * Was a bare `cors()` — any origin at all — which was survivable while there
 * was nothing behind it worth taking. Now there are accounts, and an open CORS
 * policy means any page the player visits can spend their tokens with their
 * session. `CORS_ORIGINS` exists so a preview deployment or an itch.io embed is
 * an environment variable rather than a redeploy.
 */
function allowedOrigins(): string[] {
  const extra = (process.env.CORS_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  return ["https://aidungeon.vercel.app", "http://localhost:5173", ...extra];
}

export function createApp(): Hono<AuthEnv> {
  configureAnthropic();
  const app = new Hono<AuthEnv>();

  app.use("/api/*", cors({ origin: allowedOrigins(), credentials: true }));

  /**
   * THE GATE. Everything under `/api` needs an account.
   *
   * `/api/health` is the one exception and is registered before this: it is what
   * the twice-weekly Vercel cron hits to stop Supabase pausing the project
   * when idle), a cron holds no session, and it reads and writes nothing.
   *
   * This API spends an Anthropic key, so this is the line that keeps it from
   * being open to anyone.
   */
  app.get("/api/health", (c) => c.json({ ok: true }));
  app.use("/api/*", requireUser);

  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse();
    // `describeFailure` puts the validation complaints into the sentence; a
    // bare "response did not match the expected shape" tells a caller nothing.
    console.error("[api]", err);
    return c.json({ error: describeFailure(err) }, 500);
  });

  characterRoutes(app);
  dungeonRoutes(app);
  runRoutes(app);
  playRoutes(app);
  illustrationRoutes(app);
  reviewRoutes(app);

  return app;
}
