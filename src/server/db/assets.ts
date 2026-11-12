/**
 * ASSETS: every stored picture, found by what it shows. See the `assets`
 * migration and ARCHITECTURE §10.3.
 *
 * One row per `(artRoot, kind, subject)`. The row is also the claim: whoever
 * inserts it, or takes over a stale or failed one, draws the picture.
 */

import type postgres from "postgres";
import { db } from "./connection.ts";

export type AssetKind = "room" | "sprite" | "cover";

/** Which picture: the dungeon whose art it is, what kind of thing, and which one. */
export interface AssetRef {
  artRoot: string;
  kind: AssetKind;
  /** a room's id, a creature's sprite id, or '' for the cover */
  subject: string;
}

export interface AssetRow {
  status: "pending" | "ready" | "failed" | "redraw";
  path: string | null;
  draws: number;
  attempts: number;
  meta: Record<string, unknown>;
  /** milliseconds since the row last changed, by the database's clock */
  ageMs: number;
}

export async function getAsset(ref: AssetRef, sql: postgres.Sql = db()): Promise<AssetRow | undefined> {
  const [row] = await sql<AssetRow[]>`
    select status, path, draws, attempts, meta,
           (extract(epoch from now() - updated_at) * 1000)::int as "ageMs"
      from assets where art_root = ${ref.artRoot} and kind = ${ref.kind} and subject = ${ref.subject}
  `;
  return row;
}

/**
 * Take the job of drawing a picture. True when this request is the one to draw it.
 *
 * ONE STATEMENT, so two runs entering the same room in the same instant cannot
 * both win. A new picture is inserted as `pending`. An existing row is taken
 * over when it is marked for a redraw, when it failed with attempts left, or
 * when its `pending` claim is older than `staleMs`: the request that made it
 * died without saying so. A redraw starts its attempts again.
 */
export async function claimAsset(
  ref: AssetRef,
  model: string,
  opts: { staleMs: number; maxAttempts: number },
  sql: postgres.Sql = db()
): Promise<boolean> {
  const rows = await sql`
    insert into assets (art_root, kind, subject, status, model, attempts)
    values (${ref.artRoot}, ${ref.kind}, ${ref.subject}, 'pending', ${model}, 1)
    on conflict (art_root, kind, subject) do update
       set status = 'pending', model = excluded.model, error = null, updated_at = now(),
           attempts = case when assets.status = 'redraw' then 1 else assets.attempts + 1 end
     where assets.status = 'redraw'
        or (assets.status = 'failed' and assets.attempts < ${opts.maxAttempts})
        or (assets.status = 'pending' and assets.updated_at < now() - make_interval(secs => ${opts.staleMs / 1000}))
    returning art_root
  `;
  return rows.length > 0;
}

/** The drawing is stored: point the row at it, with what belongs to it. */
export async function finishAsset(
  ref: AssetRef,
  path: string,
  meta: Record<string, unknown>,
  sql: postgres.Sql = db()
): Promise<void> {
  await sql`
    update assets set status = 'ready', path = ${path}, draws = draws + 1, meta = ${sql.json(meta as postgres.JSONValue)},
                      error = null, updated_at = now()
     where art_root = ${ref.artRoot} and kind = ${ref.kind} and subject = ${ref.subject}
  `;
}

/**
 * The drawing failed. A row that already had a picture — a redraw — goes back
 * to showing it; one that never had one is `failed`, to be tried again while
 * attempts are left.
 */
export async function failAsset(ref: AssetRef, error: string, sql: postgres.Sql = db()): Promise<void> {
  await sql`
    update assets set status = case when path is null then 'failed' else 'ready' end,
                      error = ${error.slice(0, 2000)}, updated_at = now()
     where art_root = ${ref.artRoot} and kind = ${ref.kind} and subject = ${ref.subject}
  `;
}

/** Of these sprites, the drawn ones, keyed `<artRoot>|<subject>`, with their path and meta. */
export async function drawnSprites(
  refs: { artRoot: string; subject: string }[],
  sql: postgres.Sql = db()
): Promise<Map<string, { path: string; meta: Record<string, unknown> }>> {
  if (!refs.length) return new Map();
  const rows = await sql<{ artRoot: string; subject: string; path: string; meta: Record<string, unknown> }[]>`
    select a.art_root as "artRoot", a.subject, a.path, a.meta
      from assets a
      join unnest(${refs.map((r) => r.artRoot)}::uuid[], ${refs.map((r) => r.subject)}::text[]) as t(art_root, subject)
        on a.art_root = t.art_root and a.subject = t.subject
     where a.kind = 'sprite' and a.path is not null
  `;
  return new Map(rows.map((r) => [`${r.artRoot}|${r.subject}`, { path: r.path, meta: r.meta }]));
}

/** A drawn room, picked for the landing page. */
export interface DrawnRoom {
  artRoot: string;
  roomId: string;
  path: string;
  meta: Record<string, unknown>;
  dungeonTitle: string | null;
}

/** Up to `limit` drawn rooms, in random order. */
export async function randomDrawnRooms(limit: number, sql: postgres.Sql = db()): Promise<DrawnRoom[]> {
  return sql<DrawnRoom[]>`
    select a.art_root as "artRoot", a.subject as "roomId", a.path, a.meta,
           d.doc -> 'pass' ->> 'name' as "dungeonTitle"
      from assets a
      left join dungeons d on d.id = a.art_root
     where a.kind = 'room' and a.path is not null
     order by random()
     limit ${limit}
  `;
}

/** Up to `limit` drawn covers, in random order. */
export async function randomDrawnCovers(limit: number, sql: postgres.Sql = db()): Promise<{ path: string; dungeonTitle: string | null }[]> {
  return sql<{ path: string; dungeonTitle: string | null }[]>`
    select a.path, d.doc -> 'pass' ->> 'name' as "dungeonTitle"
      from assets a
      left join dungeons d on d.id = a.art_root
     where a.kind = 'cover' and a.path is not null
     order by random()
     limit ${limit}
  `;
}

/**
 * Mark drawn pictures to be drawn again on their next request (`src/dev/redraw.ts`).
 * Each filter narrows; none given marks every picture. Answers how many were marked.
 */
export async function markForRedraw(
  filter: { kind?: AssetKind; artRoot?: string; subject?: string },
  sql: postgres.Sql = db()
): Promise<number> {
  const rows = await sql`
    update assets set status = 'redraw', updated_at = now()
     where status = 'ready'
       ${filter.kind ? sql`and kind = ${filter.kind}` : sql``}
       ${filter.artRoot ? sql`and art_root = ${filter.artRoot}` : sql``}
       ${filter.subject !== undefined ? sql`and subject = ${filter.subject}` : sql``}
    returning art_root
  `;
  return rows.length;
}
