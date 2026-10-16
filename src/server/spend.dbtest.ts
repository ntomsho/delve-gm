/**
 * THE LEDGER, AGAINST REAL ROWS
 * =============================
 *
 * `spend.test.ts` pins the rule. This pins what only a database can show: that
 * a call made inside a request lands as a row charged to the right user and run,
 * that a request which then fails still leaves its row (the money was spent),
 * and that the ceiling refuses the next call once today's sum is at it.
 *
 * Through a small Hono app with the real `spendContext` mounted, rather than
 * `createApp`: the routes that spend money all call a model, and this file
 * makes no model calls. The meter is handed the usage a response would carry.
 *
 * NOTHING SURVIVES. `record` writes through `db()`, outside any transaction
 * this file could roll back, so every row is the test account's and both are
 * deleted at the end. The ledger's `user_id` is `on delete set null`, so the
 * rows go first.
 *
 *   npm run test:db
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type postgres from "postgres";
import { closeDb, db } from "./db/connection.ts";
import type { AuthEnv } from "./auth.ts";
import { recordImage, spendContext, spendMeter, spentToday } from "./spend.ts";
import { textCost } from "../llm/cost.ts";
import { MODELS } from "../llm/models.ts";

let sql: postgres.Sql;
let user: string;
const run = "11111111-2222-4333-8444-555555555555";
const usage = { inputTokens: 1200, outputTokens: 300, cacheWriteTokens: 0, cacheReadTokens: 4000 };
const model = MODELS["turn-loop"];

/** An app that does what a paid route does: spend, then maybe fail. */
function appThat(work: () => Promise<void>): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  app.use("/api/*", async (c, next) => {
    c.set("user", { id: user, guest: false });
    await next();
  });
  app.use("/api/*", spendContext);
  app.post("/api/runs/:id/turn", async (c) => {
    await work();
    return c.json({ ok: true });
  });
  app.onError((err, c) => (err instanceof HTTPException ? err.getResponse() : c.json({ error: err.message }, 500)));
  return app;
}

const rows = () => sql<{ task: string; run_id: string | null; cost_usd: string; images: number; cache_read_tokens: number }[]>`
  select task, run_id, cost_usd::text, images, cache_read_tokens from spend where user_id = ${user} order by id
`;

beforeAll(async () => {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set. Run with `npm run test:db`.");
  sql = db();
  const [row] = await sql<{ id: string }[]>`
    insert into auth.users (id, instance_id, aud, role, email)
    values (gen_random_uuid(), '00000000-0000-0000-0000-000000000000',
            'authenticated', 'authenticated', ${`spend-${Date.now()}@example.test`})
    returning id
  `;
  user = row.id;
});

afterEach(async () => {
  delete process.env.DAILY_BUDGET_USD;
  delete process.env.DAILY_CEILING_USD;
  await sql`delete from spend where user_id = ${user}`;
});

afterAll(async () => {
  if (sql && user) {
    await sql`delete from spend where user_id = ${user}`;
    await sql`delete from auth.users where id = ${user}`;
  }
  await closeDb();
});

describe("the ledger", () => {
  it("charges a call to the user and the run the request is about", async () => {
    const before = await spentToday();
    const res = await appThat(() => spendMeter.after({ task: "turn-loop", model, usage })).request(
      `/api/runs/${run}/turn`,
      { method: "POST" }
    );
    expect(res.status).toBe(200);

    const [row] = await rows();
    expect(row).toMatchObject({ task: "turn-loop", run_id: run, images: 0, cache_read_tokens: 4000 });
    expect(Number(row.cost_usd)).toBeCloseTo(textCost(model, usage), 6);
    expect(await spentToday()).toBeGreaterThanOrEqual(before + textCost(model, usage) - 1e-6);
  });

  it("keeps the row of a request that failed after paying", async () => {
    const res = await appThat(async () => {
      await recordImage("illustration", "gpt-image-2");
      throw new Error("the turn fell over after the picture was bought");
    }).request(`/api/runs/${run}/turn`, { method: "POST" });
    expect(res.status).toBe(500);
    expect(await rows()).toMatchObject([{ task: "illustration", images: 1, run_id: run }]);
  });

  it("refuses the next call once today is at the ceiling", async () => {
    // Anything spent today at all is over a ceiling this small; this file's own row guarantees some.
    await appThat(() => spendMeter.after({ task: "turn-loop", model, usage })).request(`/api/runs/${run}/turn`, {
      method: "POST",
    });
    process.env.DAILY_BUDGET_USD = "0.000001";
    process.env.DAILY_CEILING_USD = "0.000001";

    const res = await appThat(() => spendMeter.before({ task: "turn-loop", model })).request(`/api/runs/${run}/turn`, {
      method: "POST",
    });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toMatch(/spent its budget for today/);
  });
});
