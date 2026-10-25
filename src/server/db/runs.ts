/**
 * RUNS: one character's way down one dungeon, its lock, and the write that
 * has to be right.
 */

import type postgres from "postgres";
import type { RunState } from "../../gameplay/state/store.ts";
import type { JournalRecord } from "../../journal/journal.ts";
import type { Stage } from "../../shared/types/turn.ts";
import { db, doc } from "./connection.ts";
import { carriedOut } from "./characters.ts";
import { insertEvents } from "./events.ts";

/** What a row's `status` says, which is `stage` with the detail thrown away. */
export type RunStatus = "active" | "dead" | "escaped" | "goal_met" | "abandoned";

/**
 * A run's status, from the stage it is standing in.
 *
 * `departed` is deliberately absent: the store resolves it into `escaped` or
 * `goal_met` the moment a commit lands — which ending a departure was depends
 * on world state rather than on what the game master remembered — so it can never
 * be what is persisted. See `endingOf` in gameplay/state/store.ts.
 */
export function statusOf(stage: Stage): RunStatus {
  if (stage === "dead" || stage === "escaped" || stage === "goal_met") return stage;
  if (stage === "abandoned") return "abandoned";
  return "active";
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
 * THERE IS NO OTHER READ PATH to a run's state. A run is two private things at
 * once — our log when something goes wrong, and the player's save file — and
 * neither wants an audience. Someone else's run 404s exactly as a missing one
 * does. The one cross-owner read, `recentArrivals`, takes only which rooms
 * were walked into, never the state.
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

/** Where one recent run has been, and nothing else about it. */
export interface RunArrivals {
  dungeonId: string;
  currentRoomId: string;
  arrivedVia?: string;
  /** the run's arrivals, oldest first: the shape `illustrationEntryFor` reads */
  log: { kind: "arrival"; roomId: string; via?: string }[];
}

/**
 * The rooms the most recently played runs walked into, across every owner, for
 * the landing page's pictures (`server/illustrations/showcase.ts`).
 *
 * THE ONLY CROSS-OWNER READ OF A RUN, and it takes room ids and the doors used,
 * cut out of the log in SQL: no prose, no character, no owner. Only runs in a
 * complete dungeon, which is the set the library already shows everybody.
 */
export async function recentArrivals(limit: number, sql: postgres.Sql = db()): Promise<RunArrivals[]> {
  const rows = await sql<(Omit<RunArrivals, "arrivedVia"> & { arrivedVia: string | null })[]>`
    select r.dungeon_id                  as "dungeonId",
           r.state ->> 'currentRoomId'   as "currentRoomId",
           r.state ->> 'arrivedVia'      as "arrivedVia",
           coalesce((
             select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
                      'kind', 'arrival', 'roomId', e ->> 'roomId', 'via', e ->> 'via')))
               from jsonb_array_elements(r.state -> 'log') e
              where e ->> 'kind' = 'arrival' and e ->> 'roomId' is not null
           ), '[]'::jsonb)               as log
      from runs r
      join dungeons d on d.id = r.dungeon_id and d.status = 'complete'
     order by r.updated_at desc
     limit ${limit}
  `;
  return rows.map(({ arrivedVia, ...r }) => (arrivedVia ? { ...r, arrivedVia } : r));
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
 * turns a duplicate away BEFORE it spends a whole game master conversation — two to
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
   * is to look the run up AS THE CALLER, find nothing, and throw "no such run"
   * as a 500. A refusal is not an internal
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
      // The tally is on the state being written in this same transaction, so
      // the XP and the ending can never disagree about whether the run happened.
      const pc = carriedOut(input.state.pc, input.state.tally?.total ?? 0);
      await tx`
        update characters set sheet = ${doc(tx, pc)}, updated_at = now()
         where id = ${pc.id} and owner_id = ${input.owner}
      `;
    }

    return { ok: true as const, version: rows[0].version };
  }) as Promise<CommitResult>;
}
