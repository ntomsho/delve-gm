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
  if (stage === "abandoned") return "abandoned";
  return "active";
}

/** The endings a character's record counts. `active` is not one of them. */
export const ENDED: readonly RunStatus[] = ["dead", "abandoned", "escaped", "goal_met"];

// ---------------------------------------------------------------------------
// CHARACTERS
// ---------------------------------------------------------------------------

/**
 * What has happened to a character, counted from the runs it happened in.
 *
 * NOT STORED ANYWHERE. The four numbers are exactly the four terminal values of
 * `runs.status`, so there is nothing to record and nothing to keep in step — a
 * stored counter needs a write on every ending, that write can fail
 * independently of the ending it describes, and a counter that disagrees with
 * the rows it summarises is a scoreboard that lies.
 */
export interface CharacterRecord {
  dead: number;
  abandoned: number;
  escaped: number;
  goalMet: number;
}

/** The run a character is currently down in, as the roster needs to name it. */
export interface ActiveRun {
  id: string;
  dungeonId: string;
  dungeonName: string;
  turnCount: number;
}

/**
 * A character, plus everything about them that lives outside their sheet.
 *
 * The sheet is who they are; the record is what has happened to them; the active
 * run is where they are right now. Three lifetimes, and only the first is stored
 * on the character — which is why this shape exists rather than more columns.
 */
export interface CharacterEntry {
  sheet: PlayerCharacter;
  record: CharacterRecord;
  activeRun?: ActiveRun;
}

const NO_RECORD = (): CharacterRecord => ({ dead: 0, abandoned: 0, escaped: 0, goalMet: 0 });

/**
 * The characters screen, in three queries rather than one clever one.
 *
 * Stitched in TypeScript on purpose. The same thing as a single statement is a
 * pair of lateral joins over an aggregate, which is harder to read than the
 * three obvious selects and no faster at this size — a player has a handful of
 * characters, and both supporting queries hit an index whose leading column is
 * the owner.
 *
 * A CHARACTER WITH NO RUNS GETS ZEROES, not an absent record. The screen renders
 * the same row either way, and a caller should never have to ask whether a
 * missing count means none or means unknown.
 */
export async function listRoster(
  owner: string,
  sql: postgres.Sql = db()
): Promise<CharacterEntry[]> {
  const [sheets, counts, active] = await Promise.all([
    sql<{ id: string; sheet: PlayerCharacter }[]>`
      select id, sheet from characters where owner_id = ${owner} order by created_at asc
    `,
    sql<{ characterId: string; status: RunStatus; n: number }[]>`
      select character_id as "characterId", status, count(*)::int as n
        from runs
       where owner_id = ${owner} and character_id is not null and status <> 'active'
       group by character_id, status
    `,
    // The name comes from the dungeon's own document, which is where every other
    // reader of a dungeon's name gets it — see `listDungeons`. `turnCount` is
    // read out of the run's state rather than duplicated into a column, for the
    // same reason the counters are not stored.
    sql<{ characterId: string; id: string; dungeonId: string; dungeonName: string; turnCount: number }[]>`
      select r.character_id                                    as "characterId",
             r.id                                              as "id",
             r.dungeon_id                                      as "dungeonId",
             coalesce(d.doc -> 'pass' ->> 'name', 'Unnamed')   as "dungeonName",
             coalesce((r.state ->> 'turnCount')::int, 0)       as "turnCount"
        from runs r join dungeons d on d.id = r.dungeon_id
       where r.owner_id = ${owner} and r.status = 'active' and r.character_id is not null
    `,
  ]);

  const records = new Map<string, CharacterRecord>();
  for (const row of counts) {
    const record = records.get(row.characterId) ?? NO_RECORD();
    if (row.status === "goal_met") record.goalMet = row.n;
    else if (row.status !== "active") record[row.status] = row.n;
    records.set(row.characterId, record);
  }

  const runs = new Map(active.map((r) => [r.characterId, r]));

  return sheets.map(({ id, sheet }) => {
    const run = runs.get(id);
    return {
      sheet,
      record: records.get(id) ?? NO_RECORD(),
      ...(run
        ? {
            activeRun: {
              id: run.id,
              dungeonId: run.dungeonId,
              dungeonName: run.dungeonName,
              turnCount: run.turnCount,
            },
          }
        : {}),
    };
  });
}

/**
 * The run this character is in, or nothing.
 *
 * Asked before a new run is created and before a character is deleted. NOT the
 * enforcement — the partial unique index is, and a check here could always lose
 * a race with a second request. This is what turns the violation the index
 * raises into an answer that names the run, which is the thing the player needs
 * in order to do anything about it.
 */
export async function activeRunFor(
  characterId: string,
  owner: string,
  sql: postgres.Sql = db()
): Promise<{ id: string; dungeonId: string } | undefined> {
  const [row] = await sql<{ id: string; dungeonId: string }[]>`
    select id, dungeon_id as "dungeonId" from runs
     where owner_id = ${owner} and character_id = ${characterId} and status = 'active'
  `;
  return row;
}

export async function getCharacter(
  id: string,
  owner: string,
  sql: postgres.Sql = db()
): Promise<PlayerCharacter | undefined> {
  const [row] = await sql<{ sheet: PlayerCharacter }[]>`
    select sheet from characters where id = ${id} and owner_id = ${owner}
  `;
  return row?.sheet;
}

/**
 * Insert or replace, keyed on the sheet's own id.
 *
 * The character carries its id — it was made in the browser and has been in a
 * run under that name — so the row takes it rather than minting another.
 *
 * `and owner_id = ${owner}` ON THE UPDATE BRANCH is what stops one player
 * overwriting another's sheet by posting a character carrying their id. Without
 * it the `on conflict` would happily update a row it does not own, which is the
 * one way an upsert can leak where a plain insert cannot. An attempt to do so
 * now updates nothing and reports it, rather than silently succeeding.
 */
export async function saveCharacter(
  pc: PlayerCharacter,
  owner: string,
  sql: postgres.Sql = db()
): Promise<PlayerCharacter> {
  const rows = await sql`
    insert into characters (id, owner_id, sheet)
    values (${pc.id}, ${owner}, ${doc(sql, pc)})
    on conflict (id) do update
       set sheet = excluded.sheet, updated_at = now()
     where characters.owner_id = ${owner}
    returning id
  `;
  if (rows.length === 0) throw new Error(`not yours to save: ${pc.id}`);
  return pc;
}

/**
 * WHAT A CHARACTER BRINGS BACK UP.
 *
 * Called only when a run ended with the player alive and out — `escaped` or
 * `goal_met`. The run's own `pc` has been diverging from the sheet since the
 * first turn (gear picked up, coin spent, armour worn down) and on a successful
 * ending it becomes the sheet. Same id, so the Phase 11 upsert lands on the same
 * row.
 *
 * DEATH AND ABANDONMENT WRITE NOTHING, which is how "the character as they were
 * before the run" is achieved: nothing touches `characters.sheet` during a run,
 * so the stored sheet is still the pre-run one and there is no snapshot to take
 * and no restore to perform. The only trace either leaves is a row in `runs`,
 * which is what the counters read.
 *
 * HIT POINTS RETURN TO MAX, and that is a decision rather than a consequence.
 * There is no downtime, no rest and no healing outside a run, so a character who
 * surfaces at 1/15 can only die next time — which quietly turns "escaped alive"
 * into a delayed death and makes the ending worthless. If wounds should carry,
 * this is the line.
 */
export function carriedOut(pc: PlayerCharacter): PlayerCharacter {
  return { ...pc, hp: { ...pc.hp, current: pc.hp.max } };
}

export async function deleteCharacter(
  id: string,
  owner: string,
  sql: postgres.Sql = db()
): Promise<boolean> {
  const rows = await sql`
    delete from characters where id = ${id} and owner_id = ${owner} returning id
  `;
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// DUNGEONS
// ---------------------------------------------------------------------------

/**
 * A dungeon row.
 *
 * TWO IDS, AND THEY ARE NOT THE SAME THING — the Phase 11 correction. `id`
 * names the ROW and is a meaningless uuid. `dungeonKey` is
 * `dungeon_<seed in base 36>`, derived by the engine
 * (`dungeon-blueprint.ts:786`), carried inside `doc.id`, and deliberately NOT
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
    select id, dungeon_key as "dungeonKey", owner_id as "ownerId", status, doc
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
           size, level, seed, status,
           created_at as "createdAt"
      from dungeons
     where owner_id = ${owner}
     order by created_at desc
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
    select ${dungeonId}::uuid, s.seq, s.at::timestamptz, s.kind, s.payload::jsonb
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
  input: { dungeonId: string; characterId?: string; state: RunState; owner: string },
  sql: postgres.Sql = db()
): Promise<StoredRun> {
  const [row] = await sql<{ id: string; version: number }[]>`
    insert into runs (owner_id, dungeon_id, character_id, state, status)
    values (${input.owner}, ${input.dungeonId}, ${input.characterId ?? null},
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

/**
 * A run, for the player whose run it is.
 *
 * THERE IS NO OTHER READ PATH. A run is two private things at once — our log
 * when something goes wrong, and the player's save file — and neither wants an
 * audience. Someone else's run 404s exactly as a missing one does.
 */
export async function getRun(
  id: string,
  owner: string,
  sql: postgres.Sql = db()
): Promise<StoredRun | undefined> {
  const [row] = await sql<StoredRun[]>`
    select id, dungeon_id as "dungeonId", character_id as "characterId",
           state, version, status
      from runs where id = ${id} and owner_id = ${owner}
  `;
  return row;
}

export async function listRuns(owner: string, sql: postgres.Sql = db()): Promise<RunSummary[]> {
  return sql<RunSummary[]>`
    select id, dungeon_id as "dungeonId", status,
           created_at as "createdAt", updated_at as "updatedAt"
      from runs where owner_id = ${owner} order by created_at desc
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
  owner: string,
  holdSeconds = 300,
  sql: postgres.Sql = db()
): Promise<boolean> {
  const rows = await sql`
    update runs
       set locked_until = now() + make_interval(secs => ${holdSeconds})
     where id = ${id} and owner_id = ${owner}
       and (locked_until is null or locked_until < now())
    returning id
  `;
  return rows.length > 0;
}

export async function releaseRun(
  id: string,
  owner: string,
  sql: postgres.Sql = db()
): Promise<void> {
  await sql`update runs set locked_until = null where id = ${id} and owner_id = ${owner}`;
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
  /** The run moved on. `current` is what it actually says, for re-rendering. */
  | { ok: false; reason: "stale"; current: StoredRun }
  /**
   * The run is not this player's, or is not there at all — one answer, because
   * the API does not confirm the existence of things you may not have.
   *
   * `playTurn` reads the run under an owner filter long before reaching here, so
   * this should be unreachable in practice. It exists because the alternative
   * was what this branch used to do: look the run up AS THE CALLER, find
   * nothing, and throw "no such run" as a 500. A refusal is not an internal
   * error, and the last door in the system should refuse in the shape everything
   * else refuses in. Found by `ownership.dbtest.ts`.
   */
  | { ok: false; reason: "gone" };

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
    owner: string;
    expectedVersion: number;
    state: RunState;
    events: readonly JournalRecord[];
  },
  sql: postgres.Sql = db()
): Promise<CommitResult> {
  return sql.begin(async (tx) => {
    // `and owner_id` is belt AND braces, on purpose. The run was already read
    // under an owner filter before the turn was played, so reaching here with
    // someone else's run means a handler forgot a check — and the write is the
    // last place that can still refuse. A second lock on the same door costs
    // one clause.
    const rows = await tx<{ version: number }[]>`
      update runs
         set state = ${doc(tx, input.state)},
             status = ${statusOf(input.state.stage)},
             version = version + 1,
             locked_until = null,
             updated_at = now()
       where id = ${input.runId} and owner_id = ${input.owner}
         and version = ${input.expectedVersion}
      returning version
    `;

    if (rows.length === 0) {
      // THE LOCK STILL HAS TO COME OFF. The update above releases it, and the
      // update above is the one that did not match — so without this a turn
      // rejected as stale would leave the run held for the length of the lease
      // and every later turn would be told it was busy. Separate statement,
      // same transaction.
      await tx`
        update runs set locked_until = null
         where id = ${input.runId} and owner_id = ${input.owner}
      `;

      // Nothing else written, including no events. The caller gets the state as
      // it actually stands so a stale client can re-render rather than error.
      const current = await getRun(input.runId, input.owner, tx as unknown as postgres.Sql);
      if (!current) return { ok: false as const, reason: "gone" as const };
      return { ok: false as const, reason: "stale" as const, current };
    }

    await insertEvents(tx, input.runId, input.events);

    // THE CHARACTER COMES BACK UP IN THE SAME TRANSACTION AS THE RUN ENDING.
    // A sheet written afterwards, in a second statement, is a sheet that can
    // fail to be written after the run has already been recorded as survived —
    // and the player would have carried nothing out of a run the scoreboard says
    // they won. Either both or neither.
    const ending = statusOf(input.state.stage);
    if (ending === "escaped" || ending === "goal_met") {
      // UPDATE AND NOT UPSERT. `saveCharacter`'s insert branch would recreate a
      // character the player deleted while their run was still going, which is
      // a person walking back out of a grave. If the row is gone this writes
      // nothing, which is the honest answer.
      const pc = carriedOut(input.state.pc);
      await tx`
        update characters set sheet = ${doc(tx, pc)}, updated_at = now()
         where id = ${pc.id} and owner_id = ${input.owner}
      `;
    }

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
