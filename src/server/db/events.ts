/**
 * THE JOURNAL'S ROWS, for a dungeon and for a run.
 *
 * Prompts repeat thousands of words of identical text from call to call, so a
 * block of prompt is stored once by its hash and every event that carried it
 * names the hash instead.
 */

import { createHash } from "node:crypto";
import type postgres from "postgres";
import type { JournalRecord, Sink } from "../../journal/journal.ts";
import { db } from "./connection.ts";

// ---------------------------------------------------------------------------
// PROMPT BLOCKS
// ---------------------------------------------------------------------------

/**
 * THE PLAYBOOK IS STORED ONCE, NOT ONCE PER CALL.
 *
 * A `system` event carries the standing instructions a game master call was made
 * under — `SKILL.md`, the dungeon's fiction, the step files — and `journal.ts`
 * intends to write them once per step per run. On a server that intent does not
 * survive: the "already written" set lives on the journal, the journal is made
 * per session, and a session is made per REQUEST. So every game master call wrote
 * the whole playbook again, and two thirds of a measured run's journal was three
 * copies of the same three blocks.
 *
 * THIS IS THE FIX AND IT IS DELIBERATELY NOT IN THE RUNTIME. `journal.ts` goes
 * on logging whole blocks, because that is right for the file sink and for a
 * browser with no database behind it; what changes is what the SERVER does on
 * the way to a column. Where a thing is stored is a storage question, and
 * the gameplay code stays unaware there is a database at all.
 *
 * See `supabase/migrations/20260818120000_prompt_blocks.sql`.
 */
interface PromptBlock {
  sha: string;
  chars: number;
  text: string;
}

/**
 * A block's name, and the only thing that decides whether two blocks are one.
 *
 * Hashed HERE rather than in Postgres, so the id exists before the statement is
 * composed — which is what lets the blocks and the events that reference them go
 * in as two ordinary inserts instead of a round trip that asks the database what
 * it would call this.
 */
const shaOf = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/**
 * Events on their way to a column, with each `system` block's text replaced by
 * the sha that names it — and the blocks themselves, to be written first.
 *
 * `chars` rides along beside the sha. It is redundant against `prompt_blocks`
 * and worth its twenty bytes: it is what makes the compact form READABLE on its
 * own, so a journal pulled straight out of the table still says how much prose
 * each call carried without a join to find out.
 *
 * Everything that is not a `system` event passes through untouched. The other
 * repeated payloads — a `generation` prompt, the `dungeon` baseline — are real
 * duplication too and are left alone on purpose: they are one write per dungeon
 * rather than one per turn, so they do not grow with play, and each would want
 * its own decision about what "the same" means.
 */
function dehydrate(events: readonly JournalRecord[]): {
  payloads: string[];
  blocks: PromptBlock[];
} {
  const blocks = new Map<string, PromptBlock>();

  const payloads = events.map((e) => {
    if (e.kind !== "system") return JSON.stringify(e);

    // `cache_control` and anything else on a block is carried across as it
    // stands — only `text` is lifted out. A block that comes back must be the
    // block that went in, or `journal.jsonl` stops being evidence.
    const slim = e.blocks.map(({ text, ...rest }) => {
      const sha = shaOf(text);
      if (!blocks.has(sha)) blocks.set(sha, { sha, chars: text.length, text });
      return { ...rest, sha, chars: text.length };
    });

    return JSON.stringify({ ...e, blocks: slim });
  });

  return { payloads, blocks: [...blocks.values()] };
}

/**
 * The blocks an event batch referred to, inserted before the events that refer
 * to them.
 *
 * `on conflict do nothing` is the normal case rather than the exception — after
 * the first run in the life of the database, almost every block written here is
 * already there. The insert is still worth making: deciding whether to would
 * cost the round trip it saves.
 */
async function saveBlocks(
  sql: postgres.Sql | postgres.TransactionSql,
  blocks: readonly PromptBlock[]
): Promise<void> {
  if (blocks.length === 0) return;
  await sql`
    insert into prompt_blocks (sha, chars, text)
    select s.sha, s.chars, s.text
      from unnest(${blocks.map((b) => b.sha)}::text[],
                  ${blocks.map((b) => b.chars)}::int[],
                  ${blocks.map((b) => b.text)}::text[])
        as s(sha, chars, text)
    on conflict (sha) do nothing
  `;
}

// ---------------------------------------------------------------------------

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

  // BLOCKS FIRST, and no transaction around the pair. If the second statement
  // fails, the blocks are orphaned — content-addressed, deduplicated, and a few
  // kB that the next write of the same text reuses. The other order would leave
  // an event naming a block that is not there, which is a journal that has
  // silently lost a prompt. Cheap wrong way round, expensive right way round.
  const { payloads, blocks } = dehydrate(events);
  await saveBlocks(sql, blocks);

  await sql`
    insert into dungeon_events (dungeon_id, seq, at, kind, payload)
    select ${dungeonId}::uuid, s.seq, s.at::timestamptz, s.kind, s.payload::jsonb
      from unnest(${events.map((e) => e.seq)}::int[],
                  ${events.map((e) => e.at)}::text[],
                  ${events.map((e) => e.kind)}::text[],
                  ${payloads}::text[])
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
  // WHOLE, as it was sent. The compact form is what the column holds and what
  // the Supabase SQL editor sees; every reader that goes through this file gets
  // the playbook put back, so `journal.jsonl` is byte-identical to one exported
  // before the blocks were split out. See `rehydrate_blocks` in the migration.
  const rows = await sql<{ payload: JournalRecord }[]>`
    select rehydrate_blocks(payload) as payload
      from dungeon_events where dungeon_id = ${dungeonId} order by seq asc
  `;
  return rows.map((r) => r.payload);
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
      select rehydrate_blocks(payload) as payload
        from journal_events where run_id = ${runId} order by seq asc
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

/**
 * Events in one statement rather than one per event.
 *
 * `unnest` over four parallel arrays, because a turn writes a dozen events and
 * a round trip each would be a dozen round trips inside a transaction holding a
 * pooled connection. The casts are explicit so nothing depends on the driver
 * inferring a type for an empty array.
 */
export async function insertEvents(
  tx: postgres.TransactionSql,
  runId: string,
  events: readonly JournalRecord[]
): Promise<void> {
  if (events.length === 0) return;

  const seqs = events.map((e) => e.seq);
  const ats = events.map((e) => e.at);
  const kinds = events.map((e) => e.kind);

  // Inside the caller's transaction, so a turn that loses the compare-and-swap
  // takes its blocks down with it rather than leaving them behind. That is the
  // opposite of `appendDungeonEvents`, which has no transaction to join — the
  // difference is that there IS one here, not that orphans matter more.
  const { payloads, blocks } = dehydrate(events);
  await saveBlocks(tx, blocks);

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
