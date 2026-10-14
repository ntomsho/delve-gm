/**
 * ONE PLAYER CANNOT REACH ANOTHER'S ANYTHING
 * ==========================================
 *
 * The test Phase 11 exists for, and the first one in this project to run the
 * TypeScript in `repo.ts` against a real Postgres. CODING-PLAN §7.6 has been
 * carrying "the SQL is verified, the driver binding is not" since 10a; this is
 * that gap closed, for the statements that now decide who may read what.
 *
 * EVERY TEST RUNS INSIDE A TRANSACTION THAT IS ALWAYS ROLLED BACK. Nothing here
 * survives, including the two `auth.users` rows each test invents to own things.
 * That is also why the users are made directly rather than through the admin
 * API: a real sign-up would outlive the test.
 *
 * WHAT IS BEING ASSERTED, in one sentence: ownership is in the WHERE clause, so
 * another player's row is indistinguishable from one that does not exist. Not
 * "the handler checks" — the query cannot see it in the first place.
 *
 *   npm run test:db
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import * as repo from "./repo.ts";
import type { GeneratedDungeon } from "../../generation/generate.ts";
import type { RunState } from "../../gameplay/state/store.ts";
import type { PlayerCharacter } from "../../rules/knave/character.ts";

let sql: postgres.Sql;

beforeAll(() => {
  const url = process.env.DATABASE_URL;
  if (!url) {
    // Thrown, not skipped. See the note in `vite.db.config.ts`.
    throw new Error("DATABASE_URL is not set. Run with `npm run test:db`.");
  }
  sql = postgres(url, { prepare: false, connect_timeout: 10, max: 2, onnotice: () => {} });
});

afterAll(async () => {
  await sql?.end({ timeout: 5 });
});

/**
 * A transaction object that answers to `begin`.
 *
 * `commitTurn` opens a transaction of its own — correctly, since in production
 * it is the outermost thing running — and postgres.js puts `begin` on an `Sql`
 * but `savepoint` on a `TransactionSql`. So inside this suite's enclosing
 * rollback, `begin` is routed to `savepoint`, which is the same thing one level
 * down. The alternative was to have the production code know it might be nested,
 * which is a test shaping the thing it tests.
 */
function nestable(tx: postgres.TransactionSql): postgres.Sql {
  return new Proxy(tx, {
    get(target, prop, receiver) {
      if (prop === "begin") return (fn: unknown) => target.savepoint(fn as never);
      return Reflect.get(target, prop, receiver);
    },
  }) as unknown as postgres.Sql;
}

/** A rolled-back transaction, handed to the body as an `Sql`. */
async function inRollback(body: (tx: postgres.Sql) => Promise<void>): Promise<void> {
  const ROLLBACK = Symbol("rollback");
  try {
    await sql.begin(async (tx) => {
      await body(nestable(tx));
      // The only way out of postgres.js's `begin` without committing.
      throw ROLLBACK;
    });
  } catch (e) {
    if (e !== ROLLBACK) throw e;
  }
}

/**
 * An account, made directly.
 *
 * `auth.users` is Supabase's table and most of its columns carry defaults; id
 * and email are what the app cares about. Inserting here also fires
 * `on_auth_user_created`, so the profile row is covered by the same statement —
 * see the profiles test at the bottom.
 */
async function makeUser(tx: postgres.Sql, label: string): Promise<string> {
  const [row] = await tx<{ id: string }[]>`
    insert into auth.users (id, instance_id, aud, role, email)
    values (gen_random_uuid(), '00000000-0000-0000-0000-000000000000',
            'authenticated', 'authenticated', ${`${label}-${Date.now()}@example.test`})
    returning id
  `;
  return row.id;
}

const character = (id: string, name: string) =>
  ({ id, name, level: 1, abilities: {}, hp: { current: 6, max: 6 } }) as unknown as PlayerCharacter;

const dungeon = (seed: number) =>
  ({
    id: `dungeon_${seed.toString(36)}`,
    size: 1,
    level: 1,
    seeds: { dungeonSeed: seed },
    pass: { name: "The Test Hole", goal: { summary: "leave" } },
  }) as unknown as GeneratedDungeon;

const runState = () => ({ stage: "awaiting_action", turnCount: 0, log: [] }) as unknown as RunState;

// ---------------------------------------------------------------------------

describe("characters", () => {
  it("are listed only to the player who owns them", async () => {
    await inRollback(async (tx) => {
      const a = await makeUser(tx, "a");
      const b = await makeUser(tx, "b");

      await repo.saveCharacter(character("pc-a", "Alice"), a, tx);

      // Through `listRoster`, which is the only listing read since Phase 12 —
      // this assertion should be made against the query the API actually runs.
      expect((await repo.listRoster(a, tx)).map((e) => e.sheet.name)).toEqual(["Alice"]);
      expect(await repo.listRoster(b, tx)).toEqual([]);
    });
  });

  it("are invisible by id to anyone else", async () => {
    await inRollback(async (tx) => {
      const a = await makeUser(tx, "a");
      const b = await makeUser(tx, "b");
      await repo.saveCharacter(character("pc-a", "Alice"), a, tx);

      expect(await repo.getCharacter("pc-a", a, tx)).toBeDefined();
      expect(await repo.getCharacter("pc-a", b, tx)).toBeUndefined();
    });
  });

  it("cannot be deleted by anyone else", async () => {
    await inRollback(async (tx) => {
      const a = await makeUser(tx, "a");
      const b = await makeUser(tx, "b");
      await repo.saveCharacter(character("pc-a", "Alice"), a, tx);

      expect(await repo.deleteCharacter("pc-a", b, tx)).toBe(false);
      expect(await repo.getCharacter("pc-a", a, tx)).toBeDefined();

      expect(await repo.deleteCharacter("pc-a", a, tx)).toBe(true);
    });
  });

  /**
   * THE UPSERT IS THE ONE WAY A WRITE CAN LEAK. `on conflict do update` would
   * happily overwrite a row it does not own, because the conflict is on the id
   * alone — so the update branch carries the owner too.
   */
  it("cannot be overwritten by posting a sheet carrying someone else's id", async () => {
    await inRollback(async (tx) => {
      const a = await makeUser(tx, "a");
      const b = await makeUser(tx, "b");
      await repo.saveCharacter(character("pc-a", "Alice"), a, tx);

      await expect(repo.saveCharacter(character("pc-a", "Stolen"), b, tx)).rejects.toThrow(
        /not yours/
      );
      expect((await repo.getCharacter("pc-a", a, tx))?.name).toBe("Alice");
    });
  });
});

describe("dungeons", () => {
  it("are readable in full only by their maker", async () => {
    await inRollback(async (tx) => {
      const a = await makeUser(tx, "a");
      const b = await makeUser(tx, "b");

      const id = await repo.insertPartialDungeon(dungeon(4201), a, tx);

      expect(await repo.getDungeon(id, a, tx)).toBeDefined();
      expect(await repo.getDungeon(id, b, tx)).toBeUndefined();
    });
  });

  /**
   * THE WHOLE POINT OF THE KEY SPLIT. Under Phase 10a's schema the second of
   * these was a primary-key violation, because the row was named after the seed.
   * A seed names a WORLD; two players may each hold their own copy of one.
   */
  it("lets two players each hold their own copy of one seed", async () => {
    await inRollback(async (tx) => {
      const a = await makeUser(tx, "a");
      const b = await makeUser(tx, "b");

      const forA = await repo.insertPartialDungeon(dungeon(4201), a, tx);
      const forB = await repo.insertPartialDungeon(dungeon(4201), b, tx);

      expect(forA).not.toBe(forB);
      // Same world, different rows — and each sees only their own.
      expect((await repo.getDungeon(forA, a, tx))?.dungeonKey).toBe("dungeon_38p");
      expect((await repo.getDungeon(forB, b, tx))?.dungeonKey).toBe("dungeon_38p");
      expect(await repo.getDungeon(forB, a, tx)).toBeUndefined();
    });
  });

  it("cannot be completed by anyone else", async () => {
    await inRollback(async (tx) => {
      const a = await makeUser(tx, "a");
      const b = await makeUser(tx, "b");
      const id = await repo.insertPartialDungeon(dungeon(4201), a, tx);

      expect(await repo.completeDungeon(id, dungeon(4201), b, tx)).toBe(false);
      expect((await repo.getDungeon(id, a, tx))?.status).toBe("partial");

      expect(await repo.completeDungeon(id, dungeon(4201), a, tx)).toBe(true);
      expect((await repo.getDungeon(id, a, tx))?.status).toBe("complete");
    });
  });

  it("are summarised for their owner without handing over the document", async () => {
    await inRollback(async (tx) => {
      const a = await makeUser(tx, "a");
      const b = await makeUser(tx, "b");
      await repo.insertPartialDungeon(dungeon(4201), a, tx);

      const [only] = await repo.listDungeons(a, tx);
      expect(only.name).toBe("The Test Hole");
      expect(only.objective).toBe("leave");
      expect(only).not.toHaveProperty("doc");

      expect(await repo.listDungeons(b, tx)).toEqual([]);
    });
  });
});

/*
 * PHASE 13b. The second cross-owner read, and the one that runs to many rows.
 *
 * 🔴 EVERY ROW IN A TEST HERE SHARES `created_at` EXACTLY, and that is a gift
 * rather than a nuisance: the column defaults to `now()`, which is the
 * TRANSACTION's clock, and `inRollback` puts each case in one transaction. So
 * the ordering falls entirely to the `id desc` tie-break and every page break
 * lands on a tie — which is the case that would silently drop or repeat a row if
 * the id were not in the keyset comparison. It is exercised on every assertion
 * below rather than in one test written for it.
 *
 * It also means insertion order says NOTHING about the order out, so what is
 * asserted is that the batches partition the shelf: no gaps, no repeats.
 */
describe("the library", () => {
  /** `n` finished worlds belonging to `owner`. */
  async function worlds(tx: postgres.Sql, owner: string, n: number): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const id = await repo.insertPartialDungeon(dungeon(4201 + i), owner, tx);
      await repo.completeDungeon(id, dungeon(4201 + i), owner, tx);
      ids.push(id);
    }
    return ids;
  }

  /**
   * 🔴 THE SHELF IS NOT EMPTY AND CANNOT BE MADE SO. This suite rolls back but
   * it runs against the real database, and the author's own dungeons are on it —
   * to a freshly minted test user, every one of them is "somebody else's". A
   * first draft of these tests asserted `toEqual([])` and `toHaveLength(5)` and
   * failed on real data, correctly.
   *
   * So every assertion here is about THIS TEST'S OWN ROWS. That is not a
   * weakening: because `created_at` is the transaction clock, the worlds a test
   * makes are strictly the NEWEST on the shelf, so they are exactly the front of
   * a `created_at desc` ordering and can be read off the first batches by count.
   */
  const ids = (page: { dungeons: { id: string }[] }) => page.dungeons.map((d) => d.id);

  it("shows other players' finished worlds and never the viewer's own", async () => {
    await inRollback(async (tx) => {
      const a = await makeUser(tx, "a");
      const b = await makeUser(tx, "b");
      const theirs = await worlds(tx, a, 3);
      const mine = await worlds(tx, b, 2);

      const page = await repo.listLibrary(b, { limit: 20 }, tx);
      // A's three are at the front, being the newest on the shelf. B's two are
      // nowhere in it at all.
      expect(ids(page).slice(0, 3).sort()).toEqual([...theirs].sort());
      for (const id of mine) expect(ids(page)).not.toContain(id);
    });
  });

  /** Half a world cannot be walked into and is nobody's business but its maker's. */
  it("does not shelve a world that is still being written", async () => {
    await inRollback(async (tx) => {
      const a = await makeUser(tx, "a");
      const b = await makeUser(tx, "b");
      const half = await repo.insertPartialDungeon(dungeon(4201), a, tx);
      const whole = await worlds(tx, a, 1);

      // Both were made in this transaction, so both would be at the front if
      // status were not filtered. Only the finished one is there.
      const page = await repo.listLibrary(b, { limit: 20 }, tx);
      expect(ids(page)).toContain(whole[0]);
      expect(ids(page)).not.toContain(half);
    });
  });

  it("carries a summary and never the document", async () => {
    await inRollback(async (tx) => {
      const a = await makeUser(tx, "a");
      const b = await makeUser(tx, "b");
      await worlds(tx, a, 1);

      const [newest] = (await repo.listLibrary(b, { limit: 1 }, tx)).dungeons;
      expect(newest.name).toBe("The Test Hole");
      expect(newest.objective).toBe("leave");
      expect(newest.status).toBe("complete");
      // `doc` is every answer in the world, and `cursor` is the function's own
      // bookkeeping — neither belongs to a caller.
      expect(newest).not.toHaveProperty("doc");
      expect(newest).not.toHaveProperty("cursor");
      // Nor is the maker named. The only name we hold is an email address.
      expect(Object.keys(newest)).not.toContain("ownerId");
    });
  });

  /**
   * THE WHOLE OF PAGING, and the tie-break is under every break of it — see the
   * note above this describe. Five worlds read three at a time have to come back
   * as three then two with nothing repeated and nothing missed; the sixth row of
   * the second batch belongs to whatever was already on the shelf.
   */
  it("hands out batches that partition the shelf without gaps or repeats", async () => {
    await inRollback(async (tx) => {
      const a = await makeUser(tx, "a");
      const b = await makeUser(tx, "b");
      const all = await worlds(tx, a, 5);

      const first = await repo.listLibrary(b, { limit: 3 }, tx);
      expect(first.dungeons).toHaveLength(3);
      expect(first.cursor).toBeTruthy();

      const second = await repo.listLibrary(b, { limit: 3, cursor: first.cursor! }, tx);

      const seen = [...ids(first), ...ids(second)];
      // Nothing came back twice across the break — which is the failure a tie on
      // `created_at` would cause if the id were not in the keyset comparison.
      expect(new Set(seen).size).toBe(seen.length);
      // And the five are all there, in the first five places.
      expect(seen.slice(0, 5).sort()).toEqual([...all].sort());
    });
  });

  /**
   * The probe row must not leak. `listLibrary` asks for `limit + 1` to learn
   * whether there is more, and the caller must never see the extra one.
   */
  it("returns exactly the batch asked for, however much is behind it", async () => {
    await inRollback(async (tx) => {
      const a = await makeUser(tx, "a");
      const b = await makeUser(tx, "b");
      await worlds(tx, a, 5);

      const page = await repo.listLibrary(b, { limit: 2 }, tx);
      expect(page.dungeons).toHaveLength(2);
      expect(page.cursor).toBeTruthy();
    });
  });

  it("clamps a limit rather than trusting one", async () => {
    await inRollback(async (tx) => {
      const a = await makeUser(tx, "a");
      const b = await makeUser(tx, "b");
      await worlds(tx, a, 4);

      // Nonsense in, a sane batch out — nothing here throws and nothing asks
      // Postgres for `limit -1`.
      expect((await repo.listLibrary(b, { limit: 0 }, tx)).dungeons).toHaveLength(1);
      expect((await repo.listLibrary(b, { limit: -5 }, tx)).dungeons).toHaveLength(1);
      // The ceiling and the default, which bound the answer rather than fix it:
      // what is behind this test's own four rows is whatever is on the shelf.
      expect((await repo.listLibrary(b, { limit: 10_000 }, tx)).dungeons.length).toBeLessThanOrEqual(48);
      expect((await repo.listLibrary(b, { limit: NaN }, tx)).dungeons.length).toBeLessThanOrEqual(12);
      expect((await repo.listLibrary(b, { limit: NaN }, tx)).dungeons.length).toBeGreaterThanOrEqual(4);
    });
  });

  it("reads a cursor that is not one as no cursor at all", async () => {
    await inRollback(async (tx) => {
      const a = await makeUser(tx, "a");
      const b = await makeUser(tx, "b");
      const all = await worlds(tx, a, 2);

      for (const cursor of ["nonsense", "", "|", "not-a-time|not-a-uuid"]) {
        const page = await repo.listLibrary(b, { cursor, limit: 2 }, tx);
        // The front of the shelf, which is this test's own two worlds — rather
        // than a throw, and rather than a page from the middle of nowhere.
        expect(ids(page).sort()).toEqual([...all].sort());
      }
    });
  });
});

/*
 * PHASE 13a. The one read in `repo.ts` that does not ask whose row it is — and
 * the rule is not being bent, because what it does with the row is write a NEW
 * one belonging to the caller. Nothing about the source is ever returned.
 */
describe("taking a copy of a world", () => {
  /** A complete dungeon of A's, with a generation journal against it. */
  async function worldOf(tx: postgres.Sql, owner: string, seed = 4201): Promise<string> {
    const id = await repo.insertPartialDungeon(dungeon(seed), owner, tx);
    await repo.completeDungeon(id, dungeon(seed), owner, tx);
    await repo.appendDungeonEvents(
      id,
      [
        { seq: 1, at: new Date().toISOString(), kind: "generation" },
        { seq: 2, at: new Date().toISOString(), kind: "dungeon" },
      ] as never,
      tx
    );
    return id;
  }

  it("gives the copy to whoever asked, and leaves the original alone", async () => {
    await inRollback(async (tx) => {
      const a = await makeUser(tx, "a");
      const b = await makeUser(tx, "b");
      const source = await worldOf(tx, a);

      const made = await repo.duplicateDungeon(source, b, tx);
      expect(made).toMatchObject({ already: false });

      // B has a whole world of their own, doc and all.
      expect((await repo.getDungeon(made!.id, b, tx))?.doc).toBeDefined();
      // And A still has theirs, untouched and still invisible to B.
      expect(await repo.getDungeon(source, a, tx)).toBeDefined();
      expect(await repo.getDungeon(source, b, tx)).toBeUndefined();
      expect(made!.id).not.toBe(source);
    });
  });

  /**
   * THE JOURNAL COMES ACROSS. A run's transcript is generation followed by play
   * (`readJournal`), so a copy without these is a world whose record begins
   * after it was built — and nothing would tell you that had happened.
   */
  it("brings the generation journal with it", async () => {
    await inRollback(async (tx) => {
      const a = await makeUser(tx, "a");
      const b = await makeUser(tx, "b");
      const source = await worldOf(tx, a);

      const made = await repo.duplicateDungeon(source, b, tx);
      const events = await repo.readDungeonEvents(made!.id, tx);
      expect(events.map((e) => e.kind)).toEqual(["generation", "dungeon"]);
      // And the copy's own sequence carries on from them rather than colliding.
      expect(await repo.lastDungeonSeq(made!.id, tx)).toBe(2);
    });
  });

  /**
   * THE SECOND CLICK. Matched on the SOURCE and not on `dungeon_key`: a seed
   * fixes the structure and the stocking, but the prose is model output, so
   * "you already have a seed-4201 dungeon" is not an answer to "may I have THAT
   * one". The copy that already exists is handed back rather than a second
   * half-megabyte row being minted.
   */
  it("hands back the copy already made rather than making another", async () => {
    await inRollback(async (tx) => {
      const a = await makeUser(tx, "a");
      const b = await makeUser(tx, "b");
      const source = await worldOf(tx, a);

      const first = await repo.duplicateDungeon(source, b, tx);
      const second = await repo.duplicateDungeon(source, b, tx);

      expect(second).toEqual({ id: first!.id, already: true });
      expect(await repo.listDungeons(b, tx)).toHaveLength(1);
    });
  });

  it("does not mistake a world of the same seed for the one being asked for", async () => {
    await inRollback(async (tx) => {
      const a = await makeUser(tx, "a");
      const b = await makeUser(tx, "b");
      // B rolled seed 4201 themselves. A's seed-4201 world is a DIFFERENT
      // world — same skeleton, different writing — and B may still have it.
      await worldOf(tx, b);
      const source = await worldOf(tx, a);

      expect(await repo.duplicateDungeon(source, b, tx)).toMatchObject({ already: false });
      expect(await repo.listDungeons(b, tx)).toHaveLength(2);
    });
  });

  /** Half a world is not worth copying, and the copy would have no chunks to
   *  finish from. "Not there" and "not finished" are one answer. */
  it("refuses a dungeon that is still being written", async () => {
    await inRollback(async (tx) => {
      const a = await makeUser(tx, "a");
      const b = await makeUser(tx, "b");
      const partial = await repo.insertPartialDungeon(dungeon(4201), a, tx);

      expect(await repo.duplicateDungeon(partial, b, tx)).toBeUndefined();
      expect(await repo.listDungeons(b, tx)).toEqual([]);
    });
  });

  it("answers nothing for a dungeon that does not exist", async () => {
    await inRollback(async (tx) => {
      const b = await makeUser(tx, "b");
      const nowhere = "00000000-0000-0000-0000-000000000000";
      expect(await repo.duplicateDungeon(nowhere, b, tx)).toBeUndefined();
    });
  });

  /**
   * A copy is a world in its own right, so a run can be played in it — which is
   * the whole reason the endpoint exists. `getDungeon` under the new owner is
   * what `POST /api/runs` calls, and it has to find a complete world.
   */
  it("produces a world its new owner can actually walk into", async () => {
    await inRollback(async (tx) => {
      const a = await makeUser(tx, "a");
      const b = await makeUser(tx, "b");
      const source = await worldOf(tx, a);
      const made = await repo.duplicateDungeon(source, b, tx);

      const stored = await repo.getDungeon(made!.id, b, tx);
      expect(stored?.status).toBe("complete");
      // The document keeps the engine's own derived name: it is the name of the
      // WORLD, and both copies are that world.
      expect(stored?.dungeonKey).toBe("dungeon_38p");
      expect(stored?.doc.id).toBe("dungeon_38p");
    });
  });
});

describe("runs", () => {
  /** A run belonging to A, and a second account that should never see it. */
  async function twoPlayersOneRun(tx: postgres.Sql) {
    const a = await makeUser(tx, "a");
    const b = await makeUser(tx, "b");
    const dungeonId = await repo.insertPartialDungeon(dungeon(4201), a, tx);
    const run = await repo.createRun({ dungeonId, state: runState(), owner: a }, tx);
    return { a, b, run };
  }

  it("are invisible to anyone but their owner", async () => {
    await inRollback(async (tx) => {
      const { a, b, run } = await twoPlayersOneRun(tx);

      expect(await repo.getRun(run.id, a, tx)).toBeDefined();
      expect(await repo.getRun(run.id, b, tx)).toBeUndefined();
      expect(await repo.listRuns(b, tx)).toEqual([]);
      expect((await repo.listRuns(a, tx)).map((r) => r.id)).toEqual([run.id]);
    });
  });

  it("cannot be locked by anyone else", async () => {
    await inRollback(async (tx) => {
      const { a, b, run } = await twoPlayersOneRun(tx);

      expect(await repo.lockRun(run.id, b, 300, tx)).toBe(false);
      // Still free, because B's attempt did not take it.
      expect(await repo.lockRun(run.id, a, 300, tx)).toBe(true);
    });
  });

  /**
   * THE LAST DOOR. The run was already read under an owner filter before a turn
   * was played, so reaching the write with someone else's run means a handler
   * forgot a check — and this is where it still gets refused.
   */
  it("cannot be written by anyone else, even at the right version", async () => {
    await inRollback(async (tx) => {
      const { a, b, run } = await twoPlayersOneRun(tx);

      const stolen = await repo.commitTurn(
        {
          runId: run.id,
          owner: b,
          expectedVersion: run.version,
          state: { ...runState(), turnCount: 99 } as RunState,
          events: [],
        },
        tx
      );

      expect(stolen.ok).toBe(false);
      // `gone`, not `stale`: the run did not move on under B, it was never
      // theirs. A `stale` here would tell them it exists.
      expect(stolen.ok === false && stolen.reason).toBe("gone");
      // A's run is untouched — same version, same state.
      const after = await repo.getRun(run.id, a, tx);
      expect(after?.version).toBe(run.version);
      expect(after?.state.turnCount).toBe(0);
    });
  });

  it("accept their owner's turn and move the version on", async () => {
    await inRollback(async (tx) => {
      const { a, run } = await twoPlayersOneRun(tx);

      const ok = await repo.commitTurn(
        {
          runId: run.id,
          owner: a,
          expectedVersion: run.version,
          state: { ...runState(), turnCount: 1 } as RunState,
          events: [],
        },
        tx
      );

      expect(ok.ok).toBe(true);
      expect((await repo.getRun(run.id, a, tx))?.version).toBe(run.version + 1);
    });
  });
});

describe("profiles", () => {
  it("appear on their own when an account is created", async () => {
    await inRollback(async (tx) => {
      const a = await makeUser(tx, "a");
      const [row] = await tx<{ tier: string }[]>`select tier from profiles where id = ${a}`;
      // The trigger ran, and a new account is an ordinary limited member until
      // the author makes it otherwise.
      expect(row?.tier).toBe("member");
    });
  });
});

// ---------------------------------------------------------------------------
// PHASE 12 — ONE RUN AT A TIME, AND WHAT A RUN LEAVES BEHIND
// ---------------------------------------------------------------------------

/**
 * The lock, the scoreboard and the write-back are the same bet: `runs` already
 * knows everything, so nothing new is recorded and nothing can drift. These are
 * the tests that hold it — a lock living in an index has to be exercised against
 * a real index, and a counter that is a `group by` against real rows.
 */

/** A run ended at `stage`, with `pc` as the sheet it ended holding. */
async function endRun(
  tx: postgres.Sql,
  owner: string,
  run: { id: string; version: number },
  stage: string,
  pc: PlayerCharacter,
  /** what the run was worth, when it was worth anything — see `carriedOut` */
  tally?: { total: number }
) {
  return repo.commitTurn(
    {
      runId: run.id,
      owner,
      expectedVersion: run.version,
      state: { ...runState(), stage, pc, ...(tally ? { tally } : {}) } as never,
      events: [],
    },
    tx
  );
}

describe("a character in a run", () => {
  async function playerWithCharacter(tx: postgres.Sql, label: string) {
    const owner = await makeUser(tx, label);
    const pc = character(`pc-${label}`, "Testy");
    await repo.saveCharacter(pc, owner, tx);
    return { owner, pc };
  }

  const sendDown = async (tx: postgres.Sql, owner: string, pcId: string, seed: number) => {
    const dungeonId = await repo.insertPartialDungeon(dungeon(seed), owner, tx);
    return repo.createRun({ dungeonId, characterId: pcId, state: runState(), owner }, tx);
  };

  /**
   * THE RULE, and it is the database's rather than a handler's. A check in a
   * handler can lose a race with a second request; a partial unique index
   * cannot.
   */
  it("cannot be sent into a second one", async () => {
    await inRollback(async (tx) => {
      const { owner, pc } = await playerWithCharacter(tx, "a");
      await sendDown(tx, owner, pc.id, 4201);

      await expect(sendDown(tx, owner, pc.id, 9001)).rejects.toThrow();
    });
  });

  it("is free again the moment the run ends, whichever way it ended", async () => {
    for (const stage of ["dead", "escaped", "goal_met", "abandoned"]) {
      await inRollback(async (tx) => {
        const { owner, pc } = await playerWithCharacter(tx, "a");
        const first = await sendDown(tx, owner, pc.id, 4201);

        expect((await endRun(tx, owner, first, stage, pc)).ok).toBe(true);

        // The index holds one row per character, not one per run, so a finished
        // run drops out of it entirely.
        expect((await sendDown(tx, owner, pc.id, 9001)).id).toBeDefined();
      });
    }
  });

  it("is reported by name so the interface can offer the run rather than mention it", async () => {
    await inRollback(async (tx) => {
      const { owner, pc } = await playerWithCharacter(tx, "a");
      const run = await sendDown(tx, owner, pc.id, 4201);

      expect(await repo.activeRunFor(pc.id, owner, tx)).toMatchObject({ id: run.id });
    });
  });

  it("does not lock a character belonging to somebody else", async () => {
    await inRollback(async (tx) => {
      const a = await playerWithCharacter(tx, "a");
      const b = await playerWithCharacter(tx, "b");
      await sendDown(tx, a.owner, a.pc.id, 4201);

      expect(await repo.activeRunFor(b.pc.id, b.owner, tx)).toBeUndefined();
      // And A's run is not merely unrelated to B, it is invisible to them.
      expect(await repo.activeRunFor(a.pc.id, b.owner, tx)).toBeUndefined();
      expect((await sendDown(tx, b.owner, b.pc.id, 4201)).id).toBeDefined();
    });
  });
});

describe("the record on a character", () => {
  async function ranAndEnded(
    tx: postgres.Sql,
    owner: string,
    pc: PlayerCharacter,
    stage: string,
    seed: number
  ) {
    const dungeonId = await repo.insertPartialDungeon(dungeon(seed), owner, tx);
    const run = await repo.createRun(
      { dungeonId, characterId: pc.id, state: runState(), owner },
      tx
    );
    await endRun(tx, owner, run, stage, pc);
  }

  it("counts the four endings and nothing else", async () => {
    await inRollback(async (tx) => {
      const owner = await makeUser(tx, "a");
      const pc = character("pc-a", "Testy");
      await repo.saveCharacter(pc, owner, tx);

      await ranAndEnded(tx, owner, pc, "dead", 1);
      await ranAndEnded(tx, owner, pc, "dead", 2);
      await ranAndEnded(tx, owner, pc, "abandoned", 3);
      await ranAndEnded(tx, owner, pc, "goal_met", 4);
      // And one still going, which is not an ending and must not be counted.
      const live = await repo.insertPartialDungeon(dungeon(5), owner, tx);
      await repo.createRun({ dungeonId: live, characterId: pc.id, state: runState(), owner }, tx);

      const [entry] = await repo.listRoster(owner, tx);
      expect(entry?.record).toEqual({ dead: 2, abandoned: 1, escaped: 0, goalMet: 1 });
      expect(entry?.activeRun).toMatchObject({ dungeonName: "The Test Hole", turnCount: 0 });
    });
  });

  it("counts only the owner's own runs", async () => {
    await inRollback(async (tx) => {
      const a = await makeUser(tx, "a");
      const b = await makeUser(tx, "b");
      const pcA = character("pc-a", "Testy");
      const pcB = character("pc-b", "Testy");
      await repo.saveCharacter(pcA, a, tx);
      await repo.saveCharacter(pcB, b, tx);

      await ranAndEnded(tx, a, pcA, "dead", 1);
      await ranAndEnded(tx, b, pcB, "dead", 2);
      await ranAndEnded(tx, b, pcB, "dead", 3);

      expect((await repo.listRoster(a, tx))[0]?.record.dead).toBe(1);
      expect((await repo.listRoster(b, tx))[0]?.record.dead).toBe(2);
    });
  });

  it("is all zeroes for somebody who has never been anywhere", async () => {
    await inRollback(async (tx) => {
      const owner = await makeUser(tx, "a");
      await repo.saveCharacter(character("pc-a", "Testy"), owner, tx);

      const [entry] = await repo.listRoster(owner, tx);
      expect(entry?.record).toEqual({ dead: 0, abandoned: 0, escaped: 0, goalMet: 0 });
      expect(entry?.activeRun).toBeUndefined();
    });
  });
});

describe("what a character brings back up", () => {
  /** A sheet as rolled, and the same sheet after a run has been hard on it. */
  const rolled = () => character("pc-a", "Testy");
  const wounded = () =>
    ({ ...rolled(), hp: { current: 1, max: 6 }, inventory: ["a jewelled skull"] }) as never;

  async function endWith(tx: postgres.Sql, owner: string, stage: string, earned?: number) {
    const dungeonId = await repo.insertPartialDungeon(dungeon(4201), owner, tx);
    const run = await repo.createRun(
      { dungeonId, characterId: "pc-a", state: runState(), owner },
      tx
    );
    return endRun(tx, owner, run, stage, wounded(), earned === undefined ? undefined : { total: earned });
  }

  it("keeps what they carried, and heals them, when they got out alive", async () => {
    for (const stage of ["escaped", "goal_met"]) {
      await inRollback(async (tx) => {
        const owner = await makeUser(tx, "a");
        await repo.saveCharacter(rolled(), owner, tx);

        expect((await endWith(tx, owner, stage)).ok).toBe(true);

        const sheet = (await repo.getCharacter("pc-a", owner, tx)) as unknown as {
          hp: { current: number };
          inventory: string[];
        };
        expect(sheet.inventory).toEqual(["a jewelled skull"]);
        // There is no downtime and no healing outside a run, so a survivor left
        // at 1/6 could only die next time — see `carriedOut`.
        expect(sheet.hp.current).toBe(6);
      });
    }
  });

  /**
   * THE EXPERIENCE RIDES ON THE SAME WRITE as the gear and the healing, in the
   * same transaction as the run ending. A second statement could fail on its own
   * and leave a run recorded as won by a character who was never paid for it.
   */
  it("adds what the run was worth, when they got out alive", async () => {
    for (const stage of ["escaped", "goal_met"]) {
      await inRollback(async (tx) => {
        const owner = await makeUser(tx, "a");
        await repo.saveCharacter(rolled(), owner, tx);

        expect((await endWith(tx, owner, stage, 350)).ok).toBe(true);

        const sheet = (await repo.getCharacter("pc-a", owner, tx)) as unknown as { xp: number };
        expect(sheet.xp).toBe(350);
      });
    }
  });

  /**
   * The two endings that forfeit it, and they forfeit it by construction rather
   * than by remembering to: `commitTurn` only calls `carriedOut` on a survival,
   * so a tally that somehow reached the state of a dead run would still not be
   * paid. `shouldTally` refuses to produce one in the first place.
   */
  it("pays nothing for a run that ended in death or was walked away from", async () => {
    for (const stage of ["dead", "abandoned"]) {
      await inRollback(async (tx) => {
        const owner = await makeUser(tx, "a");
        await repo.saveCharacter(rolled(), owner, tx);

        expect((await endWith(tx, owner, stage, 350)).ok).toBe(true);
        expect(await repo.getCharacter("pc-a", owner, tx)).toEqual(rolled());
      });
    }
  });

  /**
   * "As they were before the run", achieved by not writing rather than by
   * restoring: nothing touches `characters.sheet` during a run, so the stored
   * sheet IS the pre-run one and there is nothing to put back.
   */
  it("changes nothing at all when they died or walked away", async () => {
    for (const stage of ["dead", "abandoned"]) {
      await inRollback(async (tx) => {
        const owner = await makeUser(tx, "a");
        await repo.saveCharacter(rolled(), owner, tx);

        expect((await endWith(tx, owner, stage)).ok).toBe(true);
        expect(await repo.getCharacter("pc-a", owner, tx)).toEqual(rolled());
      });
    }
  });

  /**
   * The upsert would have recreated a deleted character here, which is a person
   * walking back out of a grave. `commitTurn` uses an UPDATE for exactly this.
   */
  it("does not resurrect a character deleted while the run was still going", async () => {
    await inRollback(async (tx) => {
      const owner = await makeUser(tx, "a");
      await repo.saveCharacter(rolled(), owner, tx);
      const dungeonId = await repo.insertPartialDungeon(dungeon(4201), owner, tx);
      const run = await repo.createRun(
        { dungeonId, characterId: "pc-a", state: runState(), owner },
        tx
      );
      await repo.deleteCharacter("pc-a", owner, tx);

      expect((await endRun(tx, owner, run, "goal_met", wounded())).ok).toBe(true);
      expect(await repo.getCharacter("pc-a", owner, tx)).toBeUndefined();
      expect(await repo.listRoster(owner, tx)).toEqual([]);
    });
  });
});

/**
 * THE PLAYBOOK IS STORED ONCE
 * ===========================
 *
 * A `system` event carries 25–45 kB of standing instructions, and before the
 * blocks were split out it carried them again on every referee call — the
 * journal's own "write this once per run" set lives on a journal object, and the
 * server makes one per REQUEST. Two thirds of a measured run's journal was the
 * same three blocks three times.
 *
 * WHAT THESE ASSERT, in one sentence: the column holds each distinct block once,
 * and a reader still gets back exactly what was written. The second half is the
 * one that matters — a deduplication that loses a byte is not a saving, it is a
 * corrupted record of what a model was told.
 */
describe("prompt blocks", () => {
  const SKILL = "the playbook, and it is long".repeat(400);
  const CONTEXT = "# This dungeon\n\nA damp hole.";

  /** A `system` event as `logSystem` writes one, with `cache_control` and all. */
  const systemEvent = (seq: number, step: string, tail: string) =>
    ({
      seq,
      at: new Date().toISOString(),
      kind: "system",
      step,
      blocks: [
        { type: "text", text: SKILL },
        { type: "text", text: CONTEXT, cache_control: { type: "ephemeral" } },
        { type: "text", text: tail },
      ],
    }) as never;

  async function aRun(tx: postgres.Sql) {
    const owner = await makeUser(tx, "a");
    const dungeonId = await repo.insertPartialDungeon(dungeon(4201), owner, tx);
    const run = await repo.createRun({ dungeonId, state: runState(), owner }, tx);
    return { owner, dungeonId, run };
  }

  const stored = (tx: postgres.Sql, runId: string) =>
    tx<{ payload: { blocks: { sha: string; chars: number; text?: string }[] } }[]>`
      select payload from journal_events where run_id = ${runId} order by seq asc
    `;

  it("writes the text out of the event and leaves a sha behind", async () => {
    await inRollback(async (tx) => {
      const { run } = await aRun(tx);
      await repo.appendEvents(run.id, [systemEvent(1, "1-target", "step one")], tx);

      const [row] = await stored(tx, run.id);
      expect(row.payload.blocks).toHaveLength(3);
      for (const b of row.payload.blocks) {
        expect(b.text).toBeUndefined();
        expect(b.sha).toMatch(/^[0-9a-f]{64}$/);
      }
      // `chars` rides along so the compact form is readable without a join —
      // "how much prose did this call carry" without going to `prompt_blocks`.
      expect(row.payload.blocks.map((b) => b.chars)).toEqual([
        SKILL.length,
        CONTEXT.length,
        "step one".length,
      ]);
    });
  });

  /**
   * THE ONE THAT WOULD HAVE CAUGHT A SILENT LOSS. Everything else here is about
   * size; this is about the record still being the record.
   */
  it("gives back exactly what was written, cache_control and all", async () => {
    await inRollback(async (tx) => {
      const { dungeonId, run } = await aRun(tx);
      const event = systemEvent(1, "1-target", "step one");
      await repo.appendEvents(run.id, [event], tx);

      const [read] = await repo.readJournal(run.id, dungeonId, tx);
      // `seq` is renumbered on the way out of `readJournal` — it is an order,
      // not a key — so the comparison is of everything else.
      expect({ ...read, seq: 1 }).toEqual(event);
    });
  });

  /**
   * THE SAVING, MEASURED. Three calls under three steps share `SKILL.md` and the
   * dungeon's fiction and differ only in their step files, which is exactly the
   * shape of a real turn.
   */
  it("stores one row per distinct block however many events refer to it", async () => {
    await inRollback(async (tx) => {
      const { run } = await aRun(tx);
      await repo.appendEvents(
        run.id,
        [
          systemEvent(1, "room-entry", "entering a room"),
          systemEvent(2, "1-target", "finding the target"),
          systemEvent(3, "5-resolution", "the dice came back"),
        ],
        tx
      );

      // Nine blocks referred to; five distinct — the playbook and the fiction
      // once each, plus one step file per event.
      const [{ count }] = await tx<{ count: number }[]>`
        select count(distinct b ->> 'sha')::int as count
          from journal_events j, jsonb_array_elements(j.payload -> 'blocks') b
         where j.run_id = ${run.id}
      `;
      expect(count).toBe(5);

      // And the column no longer holds three copies of a 11 kB playbook.
      const [{ bytes }] = await tx<{ bytes: number }[]>`
        select sum(pg_column_size(payload))::int as bytes
          from journal_events where run_id = ${run.id}
      `;
      expect(bytes).toBeLessThan(SKILL.length);
    });
  });

  /**
   * A block written by one run is the same block when another run writes it, and
   * `on conflict do nothing` is what makes the second write free. Content
   * addressing has no owner in it — see the migration.
   */
  it("shares a block between two runs belonging to different players", async () => {
    await inRollback(async (tx) => {
      const first = await aRun(tx);
      const second = await aRun(tx);
      await repo.appendEvents(first.run.id, [systemEvent(1, "1-target", "step one")], tx);
      await repo.appendEvents(second.run.id, [systemEvent(1, "1-target", "step one")], tx);

      const [a] = await stored(tx, first.run.id);
      const [b] = await stored(tx, second.run.id);
      expect(a.payload.blocks[0].sha).toBe(b.payload.blocks[0].sha);

      // Both still read back whole, which is the half that could quietly break.
      const readA = await repo.readJournal(first.run.id, first.dungeonId, tx);
      const readB = await repo.readJournal(second.run.id, second.dungeonId, tx);
      expect((readA[0] as never as { blocks: { text: string }[] }).blocks[0].text).toBe(SKILL);
      expect((readB[0] as never as { blocks: { text: string }[] }).blocks[0].text).toBe(SKILL);
    });
  });

  /** Generation's events go down the same path, and come back up the same way. */
  it("does the same for a dungeon's own journal", async () => {
    await inRollback(async (tx) => {
      const { dungeonId } = await aRun(tx);
      const event = systemEvent(1, "room-entry", "generation asked something");
      await repo.appendDungeonEvents(dungeonId, [event], tx);

      const [read] = await repo.readDungeonEvents(dungeonId, tx);
      expect(read).toEqual(event);
    });
  });

  /**
   * Everything that is not a `system` event is stored as it always was. The
   * other repeated payloads are one write per dungeon rather than one per turn,
   * so they do not grow with play and are deliberately left alone.
   */
  it("leaves every other kind of event untouched", async () => {
    await inRollback(async (tx) => {
      const { dungeonId, run } = await aRun(tx);
      const events = [
        { seq: 1, at: new Date().toISOString(), kind: "player", text: "open the door" },
        { seq: 2, at: new Date().toISOString(), kind: "narration", text: "It gives.", arrival: false },
      ] as never;
      await repo.appendEvents(run.id, events, tx);

      const read = await repo.readJournal(run.id, dungeonId, tx);
      expect(read.map((e) => ({ ...e, seq: 0, at: "" }))).toEqual(
        (events as unknown as Record<string, unknown>[]).map((e) => ({ ...e, seq: 0, at: "" }))
      );
    });
  });
});
