/**
 * DUNGEONS: a world as it is written — partial, then complete — the player's
 * own, the library of everybody else's, a copy taken from it, and the chunks a
 * generation writes along the way.
 */

import type postgres from "postgres";
import type { GeneratedDungeon, ChunkResult } from "../../generation/generate.ts";
import { db, doc } from "./connection.ts";

// ---------------------------------------------------------------------------
// DUNGEONS
// ---------------------------------------------------------------------------

/**
 * A dungeon row.
 *
 * TWO IDS, AND THEY ARE NOT THE SAME THING — the Phase 11 correction. `id`
 * names the ROW and is a meaningless uuid. `dungeonKey` is
 * `dungeon_<seed in base 36>`, derived by the engine
 * (`blueprint.ts:786`), carried inside `doc.id`, and deliberately NOT
 * unique: a seed names a WORLD, and two players may each hold their own copy of
 * one. Phase 10a used the derived name as the primary key, which was fine while
 * there was one copy of each seed and broke the moment there could be two.
 *
 * Everything outside this file addresses a dungeon by the ROW id. `doc.id` is
 * the engine's business and is left exactly as generated.
 */
export interface StoredDungeon {
  id: string;
  dungeonKey: string;
  ownerId: string;
  status: "partial" | "complete";
  doc: GeneratedDungeon;
  /** the `plates` key of its cover; null for a dungeon finished before covers existed */
  cover: string | null;
}

/**
 * What someone who does not own a dungeon may know about it.
 *
 * Never `doc`. The document is the whole world — every room's prose, every
 * creature, where the goal is — so handing it over is handing over the answers
 * to a dungeon they have not walked. This is the shape a browse-and-duplicate
 * screen reads, and it is deliberately the only cross-owner read there is.
 */
export interface DungeonSummary {
  id: string;
  name: string;
  objective: string;
  size: number;
  level: number;
  seed: number;
  status: "partial" | "complete";
  createdAt: string;
  /**
   * The cover's object path in the `plates` bucket, once it is drawn. The API
   * turns it into a URL (`illustrationUrl`) before it leaves the server.
   */
  coverPath?: string | null;
}

/**
 * The structure pass, stored, and the row id it was given.
 *
 * Returns the ROW id, which is what every later request names. The caller must
 * not assume it can reconstruct this from the seed — that assumption is exactly
 * what the key split removed.
 */
export async function insertPartialDungeon(
  gd: GeneratedDungeon,
  owner: string,
  sql: postgres.Sql = db()
): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into dungeons (dungeon_key, owner_id, seed, size, level, status, doc)
    values (${gd.id}, ${owner}, ${gd.seeds.dungeonSeed}, ${gd.size}, ${gd.level},
            'partial', ${doc(sql, gd)})
    returning id
  `;
  return row.id;
}

/**
 * This player's unfinished dungeon from these dice, if they have one.
 *
 * What makes "try seed N again" reuse a failed writing rather than start a
 * second one, which would also count against the day's allowance a second
 * time. Copies are never partial, but the filter says so anyway.
 */
export async function findUnfinishedDungeon(
  owner: string,
  dice: { seed: number; size: number; level: number },
  sql: postgres.Sql = db()
): Promise<StoredDungeon | undefined> {
  const [row] = await sql<StoredDungeon[]>`
    select id, dungeon_key as "dungeonKey", owner_id as "ownerId", status, doc, cover
      from dungeons
     where owner_id = ${owner} and status = 'partial' and copied_from is null
       and seed = ${dice.seed} and size = ${dice.size} and level = ${dice.level}
     order by created_at desc
     limit 1
  `;
  return row;
}

/**
 * A dungeon, in full, for the player who owns it.
 *
 * OWNER IN THE WHERE CLAUSE, not an `if` after the read: someone else's dungeon
 * is indistinguishable from one that does not exist, so the API never confirms
 * that a row it will not serve is there.
 */
export async function getDungeon(
  id: string,
  owner: string,
  sql: postgres.Sql = db()
): Promise<StoredDungeon | undefined> {
  const [row] = await sql<StoredDungeon[]>`
    select id, dungeon_key as "dungeonKey", owner_id as "ownerId", status, doc, cover
      from dungeons where id = ${id} and owner_id = ${owner}
  `;
  return row;
}

/** The player's own worlds, newest first. Summaries — nobody needs six `doc`s. */
export async function listDungeons(
  owner: string,
  sql: postgres.Sql = db()
): Promise<DungeonSummary[]> {
  return sql<DungeonSummary[]>`
    select id,
           coalesce(doc -> 'pass' ->> 'name', 'Unnamed')            as name,
           coalesce(doc -> 'pass' -> 'goal' ->> 'summary', '')      as objective,
           size, level, seed, d.status,
           d.created_at as "createdAt",
           p.path as "coverPath"
      from dungeons d
      left join plates p on p.key = d.cover and p.status = 'ready'
     where owner_id = ${owner}
     order by d.created_at desc
  `;
}

/**
 * The finished world, written over the partial.
 *
 * `where status = 'partial'` so a second `finish` — a retried request, a client
 * that fired twice — cannot overwrite a complete dungeon with one built from
 * responses that may since have been added to. Returns whether it was this call
 * that completed it.
 *
 * Takes the ROW id explicitly, because `gd.id` is the engine's derived name and
 * is no longer the key. Passing `gd` alone would compile and address the wrong
 * column forever.
 */
export async function completeDungeon(
  id: string,
  gd: GeneratedDungeon,
  owner: string,
  sql: postgres.Sql = db()
): Promise<boolean> {
  const rows = await sql`
    update dungeons
       set doc = ${doc(sql, gd)}, status = 'complete', updated_at = now()
     where id = ${id} and owner_id = ${owner} and status = 'partial'
    returning id
  `;
  return rows.length > 0;
}

/**
 * A BATCH OF THE LIBRARY, and the place to carry on from.
 *
 * `cursor` IS OPAQUE AND IS THE SERVER'S. It is handed out and handed back
 * unread — the same reasoning `commitTurn` gives for a version being an integer:
 * a client that can compose a cursor can compose a flattering one, and there is
 * no value here more favourable than another only because nothing outside this
 * file knows what is in it. Absent means the end of the shelf.
 */
export interface LibraryPage {
  dungeons: DungeonSummary[];
  cursor?: string;
}

/** How many worlds a batch is, and the most one request may ask for. */
const LIBRARY_BATCH = 12;
const LIBRARY_MAX = 48;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A cursor, or nothing — and **validated here rather than by Postgres**.
 *
 * 🔴 THIS IS A REFUSAL, NOT TIDINESS. A cursor arrives from a query string, so
 * it is whatever a caller typed. Handed on unchecked, `?cursor=x|y` binds `x` to
 * a `timestamptz` parameter and **the driver throws while serialising it**
 * (`RangeError: Invalid time value`, inside postgres.js, before the statement is
 * sent) — which the API renders as a 500. A malformed page token is not an
 * internal error; it is a caller saying nothing legible, and the honest answer
 * is the front of the shelf. Found by `ownership.dbtest.ts`.
 *
 * Split on the FIRST separator: a `timestamptz::text` holds no `|` and a uuid
 * holds none, so anything with a different shape is not a cursor this file made.
 */
function readCursor(cursor?: string): { at: string; id: string } | undefined {
  if (!cursor) return undefined;
  const cut = cursor.indexOf("|");
  if (cut <= 0) return undefined;

  const at = cursor.slice(0, cut);
  const id = cursor.slice(cut + 1);
  if (!UUID.test(id) || Number.isNaN(Date.parse(at))) return undefined;
  return { at, id };
}

/**
 * EVERY COMPLETE WORLD SOMEBODY ELSE MADE, newest first, a batch at a time.
 *
 * The second of the two cross-owner reads, and it obeys the same rule as
 * `duplicateDungeon`: what crosses the line is a SUMMARY. Never `doc`, which is
 * every answer in the world — browsing must not be a way to read a dungeon you
 * have not walked. `DungeonSummary` has been the shape of that promise since
 * Phase 11 with nothing to serve it; this is what it was for.
 *
 * NO MAKER ATTRIBUTION, deliberately. The only name this project holds for an
 * account is `profiles.email`, and a browse screen that printed it would be a
 * way to enumerate the invite list. A world is offered on what it is, not on
 * whose it was.
 *
 * KEYSET AND NOT OFFSET. A batch boundary has to survive a dungeon being written
 * while the player is scrolling: `offset 12` after an insert shows row 12 twice
 * and never shows row 13. `(created_at, id) < (…)` is anchored to the last row
 * actually seen, so an insert above the cursor changes nothing below it. The id
 * is in the comparison because `created_at` is the transaction clock and two
 * rows can share it exactly — see the migration.
 *
 * THE CURSOR IS BUILT IN SQL, not from the row in TypeScript. `timestamptz` is a
 * `Date` by the time the driver is done with it, and formatting one back to
 * something Postgres reads identically is a round trip through two libraries'
 * opinions about microseconds. `created_at::text` round-trips with itself.
 */
export async function listLibrary(
  viewer: string,
  opts: { cursor?: string; limit?: number } = {},
  sql: postgres.Sql = db()
): Promise<LibraryPage> {
  // A stated limit is clamped; an unstated or unreadable one is the default.
  // Not `|| LIBRARY_BATCH` as a NaN guard, which also swallows a stated 0 and
  // turns the smallest possible ask into the largest — found by the dbtest.
  const asked = Math.trunc(Number(opts.limit));
  const limit = Number.isFinite(asked) ? Math.min(Math.max(asked, 1), LIBRARY_MAX) : LIBRARY_BATCH;

  const at = readCursor(opts.cursor);

  // One more than asked for, which is how the end of the shelf is known without
  // a second `count(*)` over the whole table.
  const rows = await sql<(DungeonSummary & { cursor: string })[]>`
    select id,
           coalesce(doc -> 'pass' ->> 'name', 'Unnamed')            as name,
           coalesce(doc -> 'pass' -> 'goal' ->> 'summary', '')      as objective,
           size, level, seed, d.status,
           d.created_at                                            as "createdAt",
           d.created_at::text || '|' || d.id::text                 as "cursor",
           p.path                                                  as "coverPath"
      from dungeons d
      left join plates p on p.key = d.cover and p.status = 'ready'
     where d.status = 'complete'
       and owner_id <> ${viewer}
       ${
         at
           ? /*
              * 🔴 `::text::timestamptz` AND NOT `::timestamptz`, AND THE EXTRA
              * CAST IS LOAD-BEARING.
              *
              * With the direct cast the server describes this parameter as
              * `timestamptz`, so postgres.js serialises the string through its
              * Date encoder — and a JS `Date` holds MILLISECONDS. A cursor of
              * `…:22.123456+00` is bound as `…:22.123+00`, which is strictly
              * LESS than the row it was taken from, so `<` skips every row
              * sharing that microsecond. The page silently loses rows, and it
              * loses exactly the ones a `created_at` tie put at the break —
              * the case this keyset was designed around.
              *
              * Casting to `text` first makes the parameter a text parameter,
              * which postgres.js passes through untouched, and Postgres does
              * the conversion itself. `created_at::text` round-trips with
              * `text::timestamptz` exactly. Found by `ownership.dbtest.ts`.
              */
             sql`and (d.created_at, d.id) < (${at.at}::text::timestamptz, ${at.id}::text::uuid)`
           : sql``
       }
     order by d.created_at desc, d.id desc
     limit ${limit + 1}
  `;

  const more = rows.length > limit;
  const page = rows.slice(0, limit);
  return {
    // The cursor is stripped: it is this function's bookkeeping, and the last
    // row's is the only one anybody needs.
    dungeons: page.map(({ cursor: _cursor, ...summary }) => summary),
    ...(more && page.length > 0 ? { cursor: page[page.length - 1]!.cursor } : {}),
  };
}

/**
 * TAKE A COPY OF A WORLD — the one statement in this file that reads a row
 * without asking whose it is.
 *
 * Every other read here puts the owner in the `where`, and that rule is not
 * being bent: what this reads cross-owner is the ROW, and what it does with it
 * is write a new one belonging to the caller. Nothing about the source is ever
 * returned. A dungeon is the one thing another player may see (§8.1), and this
 * is the whole of what "see" means — a copy of your own, not a look at theirs.
 *
 * WHAT COMES ACROSS, and what does not:
 *
 *   - the row and its `doc`, under a fresh uuid. The `doc` keeps its own
 *     engine-derived `id` untouched, exactly as `insertPartialDungeon` leaves
 *     it: that is the name of the WORLD and both copies are that world.
 *   - `dungeon_events`, because a run's journal is generation followed by play
 *     (`readJournal`) and a copy without them yields a transcript that starts
 *     mid-air. It is also where the `kind: "dungeon"` baseline lives, which is
 *     what `journal/render.ts` prints when someone wants to judge the writing.
 *   - NOT `generation_chunks`. Only `finish` reads those, a complete dungeon
 *     never finishes again, and they are the unapplied raw responses — the
 *     largest thing in the schema and the least use to anybody holding the
 *     applied world.
 *
 * COMPLETE ONLY. Half a world is not worth copying, and `finish` on the copy
 * would have no chunks to finish from.
 *
 * `undefined` means no such complete dungeon — one answer for "not there" and
 * "still being written", because a caller who may not have it either way should
 * not learn which.
 */
export async function duplicateDungeon(
  sourceId: string,
  owner: string,
  sql: postgres.Sql = db()
): Promise<{ id: string; already: boolean } | undefined> {
  return sql.begin(async (tx) => {
    const [source] = await tx<{ id: string }[]>`
      select id from dungeons where id = ${sourceId} and status = 'complete'
    `;
    if (!source) return undefined;

    // THE SECOND CLICK. Matched on the source row and not on `dungeon_key`,
    // which would answer a different question: a seed fixes the structure and
    // the stocking, but the prose is model output, so "you already have a
    // seed-4201 dungeon" is not an answer to "may I have THAT one". See the
    // migration.
    const [mine] = await tx<{ id: string }[]>`
      select id from dungeons where owner_id = ${owner} and copied_from = ${sourceId}
    `;
    if (mine) return { id: mine.id, already: true };

    const [copy] = await tx<{ id: string }[]>`
      insert into dungeons (dungeon_key, owner_id, seed, size, level, status, doc, copied_from, cover)
      select dungeon_key, ${owner}, seed, size, level, status, doc, id, cover
        from dungeons where id = ${sourceId}
      returning id
    `;

    // One statement, in the same transaction as the row. A copy that exists
    // without its journal is a dungeon whose transcript begins after it was
    // built, and there would be nothing to tell you that had happened.
    await tx`
      insert into dungeon_events (dungeon_id, seq, at, kind, payload)
      select ${copy.id}::uuid, seq, at, kind, payload
        from dungeon_events where dungeon_id = ${sourceId}
    `;

    return { id: copy.id, already: false };
  }) as Promise<{ id: string; already: boolean } | undefined>;
}

// ---------------------------------------------------------------------------
// GENERATION CHUNKS
// ---------------------------------------------------------------------------

/**
 * One region's answer, unapplied.
 *
 * `on conflict do nothing` rather than `do update`: the regions are called in
 * parallel from separate requests, and a chunk that arrives twice is a retry of
 * a call whose answer already landed. Keeping the first is what makes the
 * request idempotent — and it has to be, because the client fires N of these
 * and any one of them can be retried by anything between here and the browser.
 */
export async function saveChunk(
  dungeonId: string,
  result: ChunkResult,
  sql: postgres.Sql = db()
): Promise<void> {
  await sql`
    insert into generation_chunks (dungeon_id, chunk, response)
    values (${dungeonId}, ${result.chunk}, ${doc(sql, result)})
    on conflict (dungeon_id, chunk) do nothing
  `;
}

export async function listChunks(
  dungeonId: string,
  sql: postgres.Sql = db()
): Promise<ChunkResult[]> {
  const rows = await sql<{ response: ChunkResult }[]>`
    select response from generation_chunks
     where dungeon_id = ${dungeonId}
     order by chunk asc
  `;
  return rows.map((r) => r.response);
}
