/**
 * THE DATABASE, AS FUNCTIONS
 * ==========================
 *
 * Every statement the server runs, in one place. Handlers above this file ask
 * for things; nothing above this file writes SQL.
 *
 * Two keyspaces, the same split `src/store/persist.ts` has always made: a
 * dungeon is large and written twice — once partial, once complete — and a run
 * is small and written on every turn.
 *
 * THE ONE THING WORTH READING BEFORE THE REST is `commitTurn`. It is the write
 * that has to be correct under two requests at once, and everything it does is
 * one transaction on purpose. See the note above it.
 *
 * Node only.
 */

import type postgres from "postgres";
import { db } from "./db.ts";
import type { GeneratedDungeon, ChunkResult } from "../runtime/generate.ts";
import type { RunState } from "../store/game.ts";
import type { JournalRecord, Sink } from "../runtime/journal.ts";
import type { Stage } from "../runtime/types.ts";
import type { PlayerCharacter } from "../engine/index.ts";

/**
 * A document, on its way into a jsonb column.
 *
 * postgres.js types `sql.json` against its own JSON value union, which nothing
 * declared with an interface satisfies structurally. The cast is here, once and
 * named, rather than at each of the six call sites — everything passed through
 * it is a plain serialisable document and has always been (see the note on
 * `GeneratedDungeon`, which has been going in and out of IndexedDB since
 * Phase 2).
 */
const doc = (sql: postgres.Sql | postgres.TransactionSql, value: unknown) =>
  sql.json(value as never);

/** What a row's `status` says, which is `stage` with the detail thrown away. */
export type RunStatus = "active" | "dead" | "escaped" | "goal_met" | "abandoned";

/**
 * A run's status, from the stage it is standing in.
 *
 * `departed` is deliberately absent: the store resolves it into `escaped` or
 * `goal_met` the moment a commit lands — which ending a departure was depends
 * on world state rather than on what the referee remembered — so it can never
 * be what is persisted. See `endingOf` in store/game.ts.
 */
export function statusOf(stage: Stage): RunStatus {
  if (stage === "dead" || stage === "escaped" || stage === "goal_met") return stage;
  return "active";
}

// ---------------------------------------------------------------------------
// CHARACTERS
// ---------------------------------------------------------------------------

export async function listCharacters(sql: postgres.Sql = db()): Promise<PlayerCharacter[]> {
  const rows = await sql<{ sheet: PlayerCharacter }[]>`
    select sheet from characters order by created_at asc
  `;
  return rows.map((r) => r.sheet);
}

export async function getCharacter(
  id: string,
  sql: postgres.Sql = db()
): Promise<PlayerCharacter | undefined> {
  const [row] = await sql<{ sheet: PlayerCharacter }[]>`
    select sheet from characters where id = ${id}
  `;
  return row?.sheet;
}

/**
 * Insert or replace, keyed on the sheet's own id.
 *
 * The character carries its id — it was made in the browser and has been in a
 * run under that name — so the row takes it rather than minting another.
 */
export async function saveCharacter(
  pc: PlayerCharacter,
  sql: postgres.Sql = db()
): Promise<PlayerCharacter> {
  await sql`
    insert into characters (id, sheet)
    values (${pc.id}, ${doc(sql, pc)})
    on conflict (id) do update set sheet = excluded.sheet, updated_at = now()
  `;
  return pc;
}

export async function deleteCharacter(id: string, sql: postgres.Sql = db()): Promise<boolean> {
  const rows = await sql`delete from characters where id = ${id} returning id`;
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// DUNGEONS
// ---------------------------------------------------------------------------

export interface StoredDungeon {
  id: string;
  status: "partial" | "complete";
  doc: GeneratedDungeon;
}

/**
 * The structure pass, stored.
 *
 * Takes the dungeon's OWN id rather than minting one: `GeneratedDungeon.id` is
 * the blueprint's, every entity in the document refers to the world it belongs
 * to through it, and a second id would be a second name for one thing.
 */
export async function insertPartialDungeon(
  gd: GeneratedDungeon,
  sql: postgres.Sql = db()
): Promise<string> {
  await sql`
    insert into dungeons (id, seed, size, level, status, doc)
    values (${gd.id}, ${gd.seeds.dungeonSeed}, ${gd.size}, ${gd.level},
            'partial', ${doc(sql, gd)})
  `;
  return gd.id;
}

export async function getDungeon(
  id: string,
  sql: postgres.Sql = db()
): Promise<StoredDungeon | undefined> {
  const [row] = await sql<StoredDungeon[]>`
    select id, status, doc from dungeons where id = ${id}
  `;
  return row;
}

/**
 * The finished world, written over the partial.
 *
 * `where status = 'partial'` so a second `finish` — a retried request, a client
 * that fired twice — cannot overwrite a complete dungeon with one built from
 * responses that may since have been added to. Returns whether it was this call
 * that completed it.
 */
export async function completeDungeon(
  gd: GeneratedDungeon,
  sql: postgres.Sql = db()
): Promise<boolean> {
  const rows = await sql`
    update dungeons
       set doc = ${doc(sql, gd)}, status = 'complete', updated_at = now()
     where id = ${gd.id} and status = 'partial'
    returning id
  `;
  return rows.length > 0;
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

/**
 * What generation wrote down, which belongs to the dungeon rather than to any
 * run — see the migration. Written once, read by every run down this dungeon.
 */
export async function appendDungeonEvents(
  dungeonId: string,
  events: readonly JournalRecord[],
  sql: postgres.Sql = db()
): Promise<void> {
  if (events.length === 0) return;
  await sql`
    insert into dungeon_events (dungeon_id, seq, at, kind, payload)
    select ${dungeonId}::text, s.seq, s.at::timestamptz, s.kind, s.payload::jsonb
      from unnest(${events.map((e) => e.seq)}::int[],
                  ${events.map((e) => e.at)}::text[],
                  ${events.map((e) => e.kind)}::text[],
                  ${events.map((e) => JSON.stringify(e))}::text[])
        as s(seq, at, kind, payload)
    on conflict (dungeon_id, seq) do nothing
  `;
}

/**
 * Generation's own sequence, so three requests write one ordered stream rather
 * than three that each start at 1. Same reasoning as `lastSeq`.
 */
export async function lastDungeonSeq(
  dungeonId: string,
  sql: postgres.Sql = db()
): Promise<number> {
  const [row] = await sql<{ seq: number }[]>`
    select coalesce(max(seq), 0)::int as seq from dungeon_events where dungeon_id = ${dungeonId}
  `;
  return row?.seq ?? 0;
}

export async function readDungeonEvents(
  dungeonId: string,
  sql: postgres.Sql = db()
): Promise<JournalRecord[]> {
  const rows = await sql<{ payload: JournalRecord }[]>`
    select payload from dungeon_events where dungeon_id = ${dungeonId} order by seq asc
  `;
  return rows.map((r) => r.payload);
}

// ---------------------------------------------------------------------------
// RUNS
// ---------------------------------------------------------------------------

export interface StoredRun {
  id: string;
  dungeonId: string;
  characterId: string | null;
  state: RunState;
  version: number;
  status: RunStatus;
}

export interface RunSummary {
  id: string;
  dungeonId: string;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
}

export async function createRun(
  input: { dungeonId: string; characterId?: string; state: RunState },
  sql: postgres.Sql = db()
): Promise<StoredRun> {
  const [row] = await sql<{ id: string; version: number }[]>`
    insert into runs (dungeon_id, character_id, state, status)
    values (${input.dungeonId}, ${input.characterId ?? null},
            ${doc(sql, input.state)}, ${statusOf(input.state.stage)})
    returning id, version
  `;
  return {
    id: row.id,
    dungeonId: input.dungeonId,
    characterId: input.characterId ?? null,
    state: input.state,
    version: row.version,
    status: statusOf(input.state.stage),
  };
}

export async function getRun(id: string, sql: postgres.Sql = db()): Promise<StoredRun | undefined> {
  const [row] = await sql<StoredRun[]>`
    select id, dungeon_id as "dungeonId", character_id as "characterId",
           state, version, status
      from runs where id = ${id}
  `;
  return row;
}

export async function listRuns(sql: postgres.Sql = db()): Promise<RunSummary[]> {
  return sql<RunSummary[]>`
    select id, dungeon_id as "dungeonId", status,
           created_at as "createdAt", updated_at as "updatedAt"
      from runs order by created_at desc
  `;
}

// ---------------------------------------------------------------------------
// THE LOCK
// ---------------------------------------------------------------------------

/**
 * Claim a run for the length of a turn.
 *
 * NOT A CORRECTNESS MECHANISM. `commitTurn` below already makes concurrent
 * turns safe by refusing to write against a version that has moved. This only
 * turns a duplicate away BEFORE it spends a whole referee conversation — two to
 * four model calls — on a turn that would be rejected at the write anyway. A
 * double-click should not cost tokens.
 *
 * An expiry rather than a boolean so a function that dies mid-turn — timeout,
 * crash, deploy — does not wedge the run until somebody notices.
 */
export async function lockRun(
  id: string,
  holdSeconds = 300,
  sql: postgres.Sql = db()
): Promise<boolean> {
  const rows = await sql`
    update runs
       set locked_until = now() + make_interval(secs => ${holdSeconds})
     where id = ${id}
       and (locked_until is null or locked_until < now())
    returning id
  `;
  return rows.length > 0;
}

export async function releaseRun(id: string, sql: postgres.Sql = db()): Promise<void> {
  await sql`update runs set locked_until = null where id = ${id}`;
}

// ---------------------------------------------------------------------------
// THE JOURNAL
// ---------------------------------------------------------------------------

/**
 * How many events this run has already written.
 *
 * A session is built fresh per request and its journal counts from whatever it
 * is told — so this is what it is told. Without it the second request into a
 * run numbers its events 1, 2, 3 on top of the first request's and collides on
 * the primary key. See `createJournal`.
 */
export async function lastSeq(runId: string, sql: postgres.Sql = db()): Promise<number> {
  const [row] = await sql<{ seq: number }[]>`
    select coalesce(max(seq), 0)::int as seq from journal_events where run_id = ${runId}
  `;
  return row?.seq ?? 0;
}

/**
 * A run's journal, whole: how its world was built, then how it was played.
 *
 * Two streams concatenated, which is also the order they happened in. They are
 * numbered independently — generation's `seq` belongs to the dungeon, play's to
 * the run — so the pair is renumbered on the way out. Nothing downstream reads
 * `seq` as a key; it reads it as an order, and this is the order.
 */
export async function readJournal(
  runId: string,
  dungeonId: string,
  sql: postgres.Sql = db()
): Promise<JournalRecord[]> {
  const [built, played] = await Promise.all([
    readDungeonEvents(dungeonId, sql),
    sql<{ payload: JournalRecord }[]>`
      select payload from journal_events where run_id = ${runId} order by seq asc
    `.then((rows) => rows.map((r) => r.payload)),
  ]);
  return [...built, ...played].map((e, i) => ({ ...e, seq: i + 1 }));
}

/**
 * A sink that keeps what it is given.
 *
 * The server cannot write events as they happen: they have to land in the same
 * transaction as the state they describe, or a turn that is rejected at the
 * write leaves a journal describing a turn that never happened. So a request's
 * journal collects, and `commitTurn` decides whether any of it is real.
 */
export function collectingSink(): { sink: Sink; events: JournalRecord[] } {
  const events: JournalRecord[] = [];
  return { sink: { write: (r) => events.push(r) }, events };
}

// ---------------------------------------------------------------------------
// THE WRITE THAT HAS TO BE RIGHT
// ---------------------------------------------------------------------------

export type CommitResult =
  | { ok: true; version: number }
  | { ok: false; reason: "stale"; current: StoredRun };

/**
 * A finished turn: the new state, and the events that describe it, together.
 *
 * COMPARE-AND-SWAP. `where version = expected` is what makes two turns at once
 * safe. Both read version N; the first writes N+1; the second finds no row to
 * update and is told so. It covers the slow version of the same thing as well —
 * the second tab that has been open for ten minutes and still has a live Send
 * button, whose turn is not simultaneous with anything but is computed against
 * a world that has moved on.
 *
 * A VERSION AND NOT THE STAGE the client believes it is on. The client never
 * asserts anything about the rules here: an integer is opaque, so there is no
 * value that is more favourable than another, and a client cannot talk its way
 * into a roll by claiming to be at step 4.
 *
 * ONE TRANSACTION, and the journal rows are inside it. A rejected turn must
 * leave nothing at all — otherwise the journal, which is the thing the whole
 * database exists to keep, ends up describing a turn the state does not have.
 *
 * The lock is released here too, and unconditionally: the turn is over whether
 * or not it was accepted.
 */
export async function commitTurn(
  input: {
    runId: string;
    expectedVersion: number;
    state: RunState;
    events: readonly JournalRecord[];
  },
  sql: postgres.Sql = db()
): Promise<CommitResult> {
  return sql.begin(async (tx) => {
    const rows = await tx<{ version: number }[]>`
      update runs
         set state = ${doc(tx, input.state)},
             status = ${statusOf(input.state.stage)},
             version = version + 1,
             locked_until = null,
             updated_at = now()
       where id = ${input.runId} and version = ${input.expectedVersion}
      returning version
    `;

    if (rows.length === 0) {
      // THE LOCK STILL HAS TO COME OFF. The update above releases it, and the
      // update above is the one that did not match — so without this a turn
      // rejected as stale would leave the run held for the length of the lease
      // and every later turn would be told it was busy. Separate statement,
      // same transaction.
      await tx`update runs set locked_until = null where id = ${input.runId}`;

      // Nothing else written, including no events. The caller gets the state as
      // it actually stands so a stale client can re-render rather than error.
      const current = await getRun(input.runId, tx as unknown as postgres.Sql);
      if (!current) throw new Error(`no such run: ${input.runId}`);
      return { ok: false as const, reason: "stale" as const, current };
    }

    await insertEvents(tx, input.runId, input.events);
    return { ok: true as const, version: rows[0].version };
  }) as Promise<CommitResult>;
}

/**
 * Events in one statement rather than one per event.
 *
 * `unnest` over four parallel arrays, because a turn writes a dozen events and
 * a round trip each would be a dozen round trips inside a transaction holding a
 * pooled connection. The casts are explicit so nothing depends on the driver
 * inferring a type for an empty array.
 */
async function insertEvents(
  tx: postgres.TransactionSql,
  runId: string,
  events: readonly JournalRecord[]
): Promise<void> {
  if (events.length === 0) return;

  const seqs = events.map((e) => e.seq);
  const ats = events.map((e) => e.at);
  const kinds = events.map((e) => e.kind);
  const payloads = events.map((e) => JSON.stringify(e));

  await tx`
    insert into journal_events (run_id, seq, at, kind, payload)
    select ${runId}::uuid, s.seq, s.at::timestamptz, s.kind, s.payload::jsonb
      from unnest(${seqs}::int[], ${ats}::text[], ${kinds}::text[], ${payloads}::text[])
        as s(seq, at, kind, payload)
    on conflict (run_id, seq) do nothing
  `;
}

/**
 * The first write of a run's journal — generation, and the room entry.
 *
 * Separate from `commitTurn` because there is no version to swap on yet: the
 * run has only just been created, nothing else can be holding it, and the state
 * that goes with these events was written by `createRun` a moment ago.
 */
export async function appendEvents(
  runId: string,
  events: readonly JournalRecord[],
  sql: postgres.Sql = db()
): Promise<void> {
  if (events.length === 0) return;
  await sql.begin((tx) => insertEvents(tx, runId, events));
}
