/**
 * WHAT THE DAY HAS COST, AND WHEN TO STOP
 * =======================================
 *
 * ROADMAP, *Running it for strangers*. The allowance (`allowance.ts`) shares a
 * day out between accounts, but a guest account costs one click, so it cannot
 * bound the bill. This does.
 *
 * THE LEDGER. Every paid call is a row in `spend`: each Anthropic response
 * (through the meter `llm/client.ts` is handed in `app.ts`) and each image fal
 * draws (`recordImage`, from the illustration and sprite workers). The cost is
 * worked out in code (`llm/cost.ts`) and written with the row.
 *
 * TWO LINES, both in dollars, both on the allowance's UTC day:
 *
 *   - THE BUDGET gates STARTING things: writing a dungeon, starting a run, and
 *     drawing a picture nobody has drawn. A run already under way carries on,
 *     and a stored picture is still served.
 *   - THE CEILING, at or above the budget, gates EVERY paid call, checked in
 *     the meter before each one is sent. Turns stop there.
 *
 * `unlimited` accounts (the author) are exempt from the budget and NOT from the
 * ceiling. Both are $5 by default and set by `DAILY_BUDGET_USD` and
 * `DAILY_CEILING_USD`; on Vercel a change takes a redeploy.
 *
 * KNOWN OVERSHOOT, ACCEPTED. The check is a sum read before the call and the
 * row is written after it, so calls already in flight when the line is crossed
 * all land. That is a few cents: one turn, or one dungeon's parallel regions.
 *
 * WHO A CALL BELONGS TO is carried through the request in an
 * `AsyncLocalStorage`, set by `spendContext` after the sign-in gate. It follows
 * the request's async work wherever it goes, including the illustration drawing
 * a turn hands to `waitUntil`, so the meter needs no parameters threaded
 * through the game to know whose call it is.
 *
 * Node only.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type postgres from "postgres";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import { db } from "./db/connection.ts";
import { currentUser, type AuthEnv, type AuthUser } from "./auth.ts";
import { imageCost, textCost } from "../llm/cost.ts";
import type { Meter, Usage } from "../llm/client.ts";
import type { ImageModel } from "../llm/models.ts";

/** The default for both lines, in US dollars a day. */
export const DEFAULT_DAILY_USD = 5;

/** The sentence a player reads when the day's money is gone. */
export const CLOSED =
  "Delve GM has spent its budget for today. It opens again at midnight UTC.";

// ---------------------------------------------------------------------------
// THE RULE
// ---------------------------------------------------------------------------

export interface Limits {
  budget: number;
  ceiling: number;
}

/**
 * The two lines, from the environment. A value that is missing or is not a
 * positive number is the default, and a ceiling below the budget is raised to
 * it: a ceiling under the budget would stop turns while still letting runs start.
 */
export function limitsFrom(env: Record<string, string | undefined>): Limits {
  const read = (v: string | undefined) => {
    const n = Number(v);
    return v !== undefined && v.trim() !== "" && Number.isFinite(n) && n > 0 ? n : DEFAULT_DAILY_USD;
  };
  const budget = read(env.DAILY_BUDGET_USD);
  return { budget, ceiling: Math.max(budget, read(env.DAILY_CEILING_USD)) };
}

export interface Gate {
  /** May write a dungeon, start a run, or draw a new picture. */
  mayStart: boolean;
  /** May make a paid call at all. */
  mayCall: boolean;
}

/** The rule, without the database, so it can be tested without one. */
export function gateFor(input: { spent: number; limits: Limits; unlimited: boolean }): Gate {
  const mayCall = input.spent < input.limits.ceiling;
  return { mayCall, mayStart: mayCall && (input.unlimited || input.spent < input.limits.budget) };
}

// ---------------------------------------------------------------------------
// WHOSE CALL IT IS
// ---------------------------------------------------------------------------

interface Payer {
  user: AuthUser;
  runId?: string;
  dungeonId?: string;
  /** Read once per request, on the first gate that needs it. */
  unlimited?: Promise<boolean>;
}

const payer = new AsyncLocalStorage<Payer>();

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const RUN_PATH = new RegExp(`^/api/runs/(${UUID})(?:/|$)`, "i");
const DUNGEON_PATH = new RegExp(`^/api/dungeons/(${UUID})(?:/|$)`, "i");

/**
 * Which run or dungeon a request is about, read off its path. Read here rather
 * than from the route's parameters because this runs before the router has
 * matched one. `POST /api/dungeons` names no dungeon yet, so its structure call
 * is recorded against the player alone.
 */
export function subjectOf(path: string): { runId?: string; dungeonId?: string } {
  const run = RUN_PATH.exec(path)?.[1];
  if (run) return { runId: run };
  const dungeon = DUNGEON_PATH.exec(path)?.[1];
  return dungeon ? { dungeonId: dungeon } : {};
}

/** Mounted after `requireUser`: everything the request does is paid for by this user. */
export const spendContext = createMiddleware<AuthEnv>(async (c, next) => {
  await payer.run({ user: currentUser(c), ...subjectOf(c.req.path) }, next);
});

// ---------------------------------------------------------------------------
// THE DATABASE
// ---------------------------------------------------------------------------

/** Dollars spent since midnight UTC, by everybody. */
export async function spentToday(sql: postgres.Sql = db()): Promise<number> {
  const [row] = await sql<{ spent: number }[]>`
    select coalesce(sum(cost_usd), 0)::float8 as spent from spend
     where at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc'
  `;
  return row?.spent ?? 0;
}

async function isUnlimited(userId: string, sql: postgres.Sql): Promise<boolean> {
  const [row] = await sql<{ tier: string }[]>`select tier from profiles where id = ${userId}`;
  return row?.tier === "unlimited";
}

/** Today's gate for whoever is asking. Outside a request — nobody — only the ceiling applies. */
export async function gateNow(sql: postgres.Sql = db()): Promise<Gate> {
  const p = payer.getStore();
  const unlimited = p ? (p.unlimited ??= isUnlimited(p.user.id, sql)) : Promise.resolve(false);
  const [spent, u] = await Promise.all([spentToday(sql), unlimited]);
  return gateFor({ spent, limits: limitsFrom(process.env), unlimited: u });
}

/** Whether the asker may start something new. For `GET /api/allowance` and the drawing workers. */
export async function mayStart(): Promise<boolean> {
  return (await gateNow()).mayStart;
}

/** A 503 carrying `CLOSED` as `{ error }`, the shape every refusal the client reads has. */
export function closed(): HTTPException {
  return new HTTPException(503, { res: Response.json({ error: CLOSED }, { status: 503 }) });
}

interface Row {
  task: string;
  model: string;
  usage?: Usage;
  images?: number;
  cost: number;
}

async function record(r: Row, sql: postgres.Sql = db()): Promise<void> {
  const p = payer.getStore();
  const u = r.usage;
  await sql`
    insert into spend (user_id, run_id, dungeon_id, task, model,
                       input_tokens, output_tokens, cache_write_tokens, cache_read_tokens,
                       images, cost_usd)
    values (${p?.user.id ?? null}, ${p?.runId ?? null}, ${p?.dungeonId ?? null}, ${r.task}, ${r.model},
            ${u?.inputTokens ?? 0}, ${u?.outputTokens ?? 0}, ${u?.cacheWriteTokens ?? 0}, ${u?.cacheReadTokens ?? 0},
            ${r.images ?? 0}, ${r.cost})
  `;
}

// ---------------------------------------------------------------------------
// THE TWO WAYS MONEY IS SPENT
// ---------------------------------------------------------------------------

/** The text meter, handed to `configureTransport` in `app.ts`. */
export const spendMeter: Meter = {
  async before() {
    if (!(await gateNow()).mayCall) throw closed();
  },
  async after({ task, model, usage }) {
    await record({ task, model, usage, cost: textCost(model, usage) });
  },
};

/**
 * Before an image call: refused at the ceiling, like a text call. The budget is
 * checked earlier, before the picture is claimed (`mayDraw` on the workers),
 * so that a closed day does not use up one of the picture's attempts.
 */
export async function beforeImage(): Promise<void> {
  if (!(await gateNow()).mayCall) throw closed();
}

/**
 * After an image call that came back. Never throws, for the meter's reason: the
 * picture is bought, and losing the row is better than losing the picture.
 */
export async function recordImage(task: "illustration" | "cover" | "sprite", model: ImageModel): Promise<void> {
  try {
    await record({ task, model, images: 1, cost: imageCost(model) });
  } catch (e) {
    console.warn("[spend] could not record an image; keeping it:", e);
  }
}
