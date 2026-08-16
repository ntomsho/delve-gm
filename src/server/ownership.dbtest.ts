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
import type { GeneratedDungeon } from "../runtime/generate.ts";
import type { RunState } from "../store/game.ts";
import type { PlayerCharacter } from "../engine/index.ts";

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

      expect((await repo.listCharacters(a, tx)).map((c) => c.name)).toEqual(["Alice"]);
      expect(await repo.listCharacters(b, tx)).toEqual([]);
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
      // The trigger ran, and a new account brings its own key until somebody
      // makes them a guest of ours.
      expect(row?.tier).toBe("byok");
    });
  });
});
