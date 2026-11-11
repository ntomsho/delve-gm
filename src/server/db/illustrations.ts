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

/**
 * What a plate is a picture of, written when it is claimed (see the
 * `plate_subjects` migration). The key says only what it was drawn from, and
 * that changes with every prompt; this is how the landing page finds rooms.
 */
export type PlateSubject =
  | { kind: "room"; dungeonId: string; roomId: string; entryId: string; title: string }
  | { kind: "sprite" }
  | { kind: "cover" };

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
  subject?: PlateSubject,
  sql: postgres.Sql = db()
): Promise<boolean> {
  const room = subject?.kind === "room" ? subject : undefined;
  const rows = await sql`
    insert into plates (key, status, model, attempts, kind, dungeon_id, room_id, entry_id, title)
    values (${key}, 'pending', ${model}, 1, ${subject?.kind ?? null}, ${room?.dungeonId ?? null},
            ${room?.roomId ?? null}, ${room?.entryId ?? null}, ${room?.title ?? null})
    on conflict (key) do update
       set status = 'pending', model = excluded.model, attempts = plates.attempts + 1,
           error = null, updated_at = now(),
           kind = coalesce(plates.kind, excluded.kind),
           dungeon_id = coalesce(plates.dungeon_id, excluded.dungeon_id),
           room_id = coalesce(plates.room_id, excluded.room_id),
           entry_id = coalesce(plates.entry_id, excluded.entry_id),
           title = coalesce(plates.title, excluded.title)
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

/** Of these keys, the ones whose picture is drawn, with where it is stored. */
export async function readyIllustrations(keys: string[], sql: postgres.Sql = db()): Promise<Map<string, string>> {
  if (!keys.length) return new Map();
  const rows = await sql<{ key: string; path: string }[]>`
    select key, path from plates where status = 'ready' and path is not null and key in ${sql(keys)}
  `;
  return new Map(rows.map((r) => [r.key, r.path]));
}

/** Of these keys, the shared words kept under each — see `plate_words`. */
export async function illustrationWordsFor(keys: string[], sql: postgres.Sql = db()): Promise<Map<string, string>> {
  if (!keys.length) return new Map();
  const rows = await sql<{ key: string; value: string }[]>`select key, value from plate_words where key in ${sql(keys)}`;
  return new Map(rows.map((r) => [r.key, r.value]));
}

/** A drawn room, picked for the landing page. Placement is null on a room drawn before plates said where. */
export interface RoomPlate {
  key: string;
  path: string;
  title: string | null;
  dungeonId: string | null;
  roomId: string | null;
  entryId: string | null;
  /** the dungeon's name, while that dungeon is still there and complete */
  dungeonTitle: string | null;
}

/** Up to `limit` drawn rooms, in random order. */
export async function randomRoomPlates(limit: number, sql: postgres.Sql = db()): Promise<RoomPlate[]> {
  return sql<RoomPlate[]>`
    select p.key, p.path, p.title, p.dungeon_id as "dungeonId", p.room_id as "roomId", p.entry_id as "entryId",
           d.doc -> 'pass' ->> 'name' as "dungeonTitle"
      from plates p
      left join dungeons d on d.id = p.dungeon_id and d.status = 'complete'
     where p.kind = 'room' and p.status = 'ready' and p.path is not null
     order by random()
     limit ${limit}
  `;
}

/** Up to `limit` drawn covers, each picture once (a copy shares its source's), in random order. */
export async function randomCoverPlates(limit: number, sql: postgres.Sql = db()): Promise<{ path: string; dungeonTitle: string }[]> {
  return sql<{ path: string; dungeonTitle: string }[]>`
    select path, "dungeonTitle" from (
      select distinct on (p.key) p.path, d.doc -> 'pass' ->> 'name' as "dungeonTitle"
        from plates p
        join dungeons d on d.cover = p.key and d.status = 'complete'
       where p.status = 'ready' and p.path is not null
    ) c
     order by random()
     limit ${limit}
  `;
}
