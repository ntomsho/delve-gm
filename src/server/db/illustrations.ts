/**
 * ILLUSTRATIONS: the drawing jobs and their results, keyed by what was drawn.
 * The table is still called `plates`.
 */

import type postgres from "postgres";
import { db } from "./connection.ts";

// ---------------------------------------------------------------------------
// ILLUSTRATIONS
// ---------------------------------------------------------------------------

export interface IllustrationRow {
  key: string;
  status: "pending" | "ready" | "failed";
  path: string | null;
  attempts: number;
  /** milliseconds since the row last changed, by the database's clock */
  ageMs: number;
}

export async function getIllustration(key: string, sql: postgres.Sql = db()): Promise<IllustrationRow | undefined> {
  const [row] = await sql<IllustrationRow[]>`
    select key, status, path, attempts,
           (extract(epoch from now() - updated_at) * 1000)::int as "ageMs"
      from plates where key = ${key}
  `;
  return row;
}

/**
 * Take the job of drawing an illustration. True when this request is the one to draw it.
 *
 * ONE STATEMENT, so two runs entering the same room in the same instant cannot
 * both win: a new key is inserted as `pending`; an existing one is taken over
 * only when it failed and has attempts left, or when its `pending` claim is
 * older than `staleMs` — the request that made it died without saying so.
 */
export async function claimIllustration(
  key: string,
  model: string,
  opts: { staleMs: number; maxAttempts: number },
  sql: postgres.Sql = db()
): Promise<boolean> {
  const rows = await sql`
    insert into plates (key, status, model, attempts) values (${key}, 'pending', ${model}, 1)
    on conflict (key) do update
       set status = 'pending', model = excluded.model, attempts = plates.attempts + 1,
           error = null, updated_at = now()
     where (plates.status = 'failed' and plates.attempts < ${opts.maxAttempts})
        or (plates.status = 'pending' and plates.updated_at < now() - make_interval(secs => ${opts.staleMs / 1000}))
    returning key
  `;
  return rows.length > 0;
}

export async function finishIllustration(key: string, path: string, sql: postgres.Sql = db()): Promise<void> {
  await sql`update plates set status = 'ready', path = ${path}, updated_at = now() where key = ${key}`;
}

export async function failIllustration(key: string, error: string, sql: postgres.Sql = db()): Promise<void> {
  await sql`update plates set status = 'failed', error = ${error.slice(0, 2000)}, updated_at = now() where key = ${key}`;
}

/** Shared words an illustration is drawn from — see `plate_words`. */
export async function getIllustrationWords(key: string, sql: postgres.Sql = db()): Promise<string | undefined> {
  const [row] = await sql<{ value: string }[]>`select value from plate_words where key = ${key}`;
  return row?.value;
}

/** The first answer is kept: a second illustration racing the first reads the winner's. */
export async function saveIllustrationWords(key: string, value: string, sql: postgres.Sql = db()): Promise<string> {
  await sql`insert into plate_words (key, value) values (${key}, ${value}) on conflict (key) do nothing`;
  return (await getIllustrationWords(key, sql)) ?? value;
}

/**
 * Name the cover a finished dungeon is to have. Written once, at `finish`; a
 * dungeon whose `cover` is null was finished before covers and never gets one.
 */
export async function setDungeonCover(id: string, key: string, sql: postgres.Sql = db()): Promise<void> {
  await sql`update dungeons set cover = ${key} where id = ${id} and cover is null`;
}
