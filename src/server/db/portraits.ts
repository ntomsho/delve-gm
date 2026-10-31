/**
 * PORTRAITS: pictures of a player's characters, one row each, owned. See the
 * `portraits` migration and `src/server/illustrations/portraits.ts`.
 */

import type postgres from "postgres";
import { db } from "./connection.ts";

/**
 * A `pending` drawing this old is taken to be a request that died. It stops
 * counting against the day's cap, so a crash does not cost the player a draw.
 */
export const PORTRAIT_PENDING_STALE_S = 180;

export interface PortraitRow {
  id: string;
  source: "drawn" | "uploaded";
  status: "pending" | "ready" | "failed";
  path: string | null;
  thumbPath: string | null;
}

/**
 * Take one of today's drawings: insert a `pending` row, unless the account has
 * already drawn `limit` today. `null` is no limit. True when this request may draw.
 *
 * The count and the insert are one statement. Two clicks in the same instant
 * can still both count before either is inserted; that is one extra drawing
 * for somebody racing their own account, which the spend ceiling covers — the
 * race `allowance.ts` accepts for runs.
 */
export async function claimPortrait(
  id: string,
  owner: string,
  limit: number | null,
  sql: postgres.Sql = db()
): Promise<boolean> {
  const rows = await sql`
    insert into portraits (id, owner_id, source, status)
    select ${id}, ${owner}, 'drawn', 'pending'
     where ${limit}::int is null
        or (select count(*) from portraits p
             where p.owner_id = ${owner} and ${countsSql(sql)}) < ${limit}::int
    returning id
  `;
  return rows.length > 0;
}

/** The condition a row counts against the day's cap under, for `p`. */
function countsSql(sql: postgres.Sql) {
  return sql`
    p.source = 'drawn'
    and p.created_at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc'
    and (p.status = 'ready'
         or (p.status = 'pending' and p.updated_at > now() - make_interval(secs => ${PORTRAIT_PENDING_STALE_S})))
  `;
}

/** Drawings that count against today's cap. Read by `allowanceOf`. */
export async function portraitsDrawnToday(owner: string, sql: postgres.Sql = db()): Promise<number> {
  const [row] = await sql<{ n: number }[]>`
    select count(*)::int as n from portraits p where p.owner_id = ${owner} and ${countsSql(sql)}
  `;
  return row?.n ?? 0;
}

export async function finishPortrait(id: string, path: string, thumbPath: string, sql: postgres.Sql = db()): Promise<void> {
  await sql`
    update portraits set status = 'ready', path = ${path}, thumb_path = ${thumbPath}, updated_at = now()
     where id = ${id}
  `;
}

export async function failPortrait(id: string, error: string, sql: postgres.Sql = db()): Promise<void> {
  await sql`update portraits set status = 'failed', error = ${error.slice(0, 2000)}, updated_at = now() where id = ${id}`;
}

/** An uploaded picture, already stored: ready from the start, and never counted. */
export async function insertUploadedPortrait(
  id: string,
  owner: string,
  path: string,
  thumbPath: string,
  sql: postgres.Sql = db()
): Promise<void> {
  await sql`
    insert into portraits (id, owner_id, source, status, path, thumb_path)
    values (${id}, ${owner}, 'uploaded', 'ready', ${path}, ${thumbPath})
  `;
}

/** One of this account's portraits, or undefined when it is not theirs. */
export async function getPortrait(id: string, owner: string, sql: postgres.Sql = db()): Promise<PortraitRow | undefined> {
  // Not a uuid is not theirs, rather than a database error.
  if (!/^[0-9a-f-]{36}$/i.test(id)) return undefined;
  const [row] = await sql<PortraitRow[]>`
    select id, source, status, path, thumb_path as "thumbPath"
      from portraits where id = ${id} and owner_id = ${owner}
  `;
  return row;
}
