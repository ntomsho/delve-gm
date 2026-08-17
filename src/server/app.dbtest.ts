/**
 * THE HANDLERS, OVER HTTP
 * =======================
 *
 * The gap CODING-PLAN §9.8 named and did not close: `ownership.dbtest.ts` covers
 * every statement in `repo.ts`, and `auth.test.ts` covers the gate — but nothing
 * covered the layer BETWEEN them, where a request becomes a status code. The
 * refusals Phase 12 added live exactly there:
 *
 *   - the 409 that names the run a character is already in;
 *   - the 409 that will not delete somebody still down a hole;
 *   - the 400 on an abandon that states no version, and the 409 on a stale one.
 *
 * None of those are `commitTurn`'s business and none of them were tested.
 *
 * WHY THIS IS A `dbtest` AND NOT AN ORDINARY ONE. `createApp()` cannot be built
 * without both an Anthropic key and a database: it configures the transport at
 * construction and every route reads Postgres. Faking either would be testing a
 * fake, and the whole point of these files is that the driver binding is real.
 *
 * A REAL KEY PAIR AND A REAL TOKEN, minted per run and verified through `jose`
 * against a JWKS served from a stubbed `fetch` — the same arrangement
 * `auth.test.ts` uses, for the same reason: a suite that stubbed `requireUser`
 * would be a suite in which every one of these requests arrived pre-authorised,
 * which is not the thing being tested.
 *
 * NOTHING SURVIVES. `ownership.dbtest.ts` wraps each case in a rolled-back
 * transaction; that is not available here, because the handlers open their own
 * connections through `db()` and know nothing about a transaction this file is
 * holding. So the cleanup is the schema's instead: every table Phase 11 built
 * cascades from `auth.users`, so deleting the one test account at the end takes
 * its characters, dungeons, runs, chunks and events with it.
 *
 *   npm run test:db
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import postgres from "postgres";
import type { Hono } from "hono";
import { closeDb, db } from "./db.ts";
import * as repo from "./repo.ts";
import type { AuthEnv } from "./auth.ts";
import { generateOffline, testCharacter } from "../runtime/__fixtures__/offline.ts";
import type { PlayerCharacter } from "../engine/index.ts";

const ISSUER = "https://project.dbtest.supabase.co";

let app: Hono<AuthEnv>;
let token: string;
let owner: string;
let sql: postgres.Sql;
/** A finished world to send people into. Real, because `newRun` reads it. */
const world = generateOffline(1005, 1);

/**
 * TWO DUNGEONS FOR THE WHOLE FILE, made once.
 *
 * A character may hold one run at a time, and every test here mints its own
 * character — so one world is enough for almost all of them, and the second
 * exists only so the double-run refusal can be shown to be about the CHARACTER
 * rather than about the dungeon.
 *
 * Made once rather than per test because the `doc` is the entire world in a
 * jsonb column. Writing half a megabyte thirteen times to prove something about
 * a status code is a slow suite, and it was a flaky one: the driver failed a
 * large insert with `invalid byte sequence for encoding "UTF8": 0x00` on one run
 * in several and never twice in the same place. Two writes instead of thirteen
 * is both the honest amount of setup and the end of that.
 */
let hole: string;
let otherHole: string;

/**
 * The JWKS stub, reinstalled before every test.
 *
 * `beforeEach` rather than `beforeAll` because vitest restores globals between
 * tests, and the gate fetches the key set on a cache miss. Nothing else in this
 * file reaches the network — the handlers under test make no model calls, which
 * is why a dummy Anthropic key is enough.
 */
function stubJwks(jwks: { keys: JWK[] }): void {
  vi.stubGlobal("fetch", async (url: string) => {
    if (String(url).includes("/.well-known/jwks.json")) {
      return { ok: true, status: 200, json: async () => jwks, headers: new Headers() };
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
}

let jwks: { keys: JWK[] };

beforeAll(async () => {
  if (!process.env.DATABASE_URL) {
    // Thrown, not skipped. See the note in `vite.db.config.ts`.
    throw new Error("DATABASE_URL is not set. Run with `npm run test:db`.");
  }

  process.env.SUPABASE_URL = ISSUER;
  // Never used — no route below calls the model — but `createApp` refuses to be
  // built without one, and rightly: a server that cannot reach the referee
  // should say so at startup rather than on the first turn.
  process.env.ANTHROPIC_API_KEY ??= "sk-ant-not-a-real-key-for-tests";

  const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
  jwks = { keys: [{ ...(await exportJWK(publicKey)), kid: "test-key", alg: "ES256", use: "sig" }] };
  stubJwks(jwks);

  sql = db();
  owner = await makeUser();
  token = await new SignJWT({})
    .setProtectedHeader({ alg: "ES256", kid: "test-key" })
    .setIssuedAt()
    .setSubject(owner)
    .setAudience("authenticated")
    .setExpirationTime("1h")
    .sign(privateKey);

  // Imported here rather than at the top: `createApp` reads the environment at
  // construction, and the two variables above have only just been set.
  app = (await import("./app.ts")).createApp();

  hole = await aFinishedDungeon();
  otherHole = await aFinishedDungeon();
});

beforeEach(() => stubJwks(jwks));

afterAll(async () => {
  // One statement, and it takes everything: characters, dungeons, runs, chunks
  // and both event tables all cascade from the account that owns them.
  if (sql && owner) await sql`delete from auth.users where id = ${owner}`;
  vi.unstubAllGlobals();
  await closeDb();
});

async function makeUser(): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into auth.users (id, instance_id, aud, role, email)
    values (gen_random_uuid(), '00000000-0000-0000-0000-000000000000',
            'authenticated', 'authenticated', ${`handlers-${Date.now()}@example.test`})
    returning id
  `;
  return row.id;
}

/** A signed-in request. Every call below goes through the real gate. */
function ask(path: string, init: { method?: string; body?: unknown } = {}) {
  return app.request(path, {
    method: init.method ?? "GET",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
}

/** A finished dungeon of the player's own, ready to be walked into. */
async function aFinishedDungeon(owned = owner): Promise<string> {
  const id = await repo.insertPartialDungeon(world, owned);
  await repo.completeDungeon(id, world, owned);
  return id;
}

/** A character on the roster, with an id nothing else in this file shares. */
async function aCharacter(name = "Testy"): Promise<PlayerCharacter> {
  const pc = { ...testCharacter(), id: `pc-${crypto.randomUUID()}`, name };
  const saved = await ask("/api/characters", { method: "POST", body: pc });
  expect(saved.status).toBe(200);
  return pc;
}

/** Send them down, and hand back the run the API made. */
async function sendDown(pc: PlayerCharacter, dungeonId: string) {
  const res = await ask("/api/runs", { method: "POST", body: { dungeonId, character: pc } });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

// ---------------------------------------------------------------------------

describe("starting a run", () => {
  it("sends a free character down and answers with the run and the world", async () => {
    const pc = await aCharacter();
    const { status, body } = await sendDown(pc, hole);

    expect(status).toBe(200);
    expect(body.run.id).toBeTruthy();
    expect(body.run.state.stage).toBe("room_entry");
    expect(body.dungeon.id).toBe(world.id);
  });

  /**
   * THE REFUSAL PHASE 12 IS BUILT AROUND, and the reason the check sits in the
   * handler at all: the partial unique index is what actually holds the rule,
   * but a constraint violation tells the player nothing they can act on. This
   * names the run so the interface can offer to resume it.
   */
  it("refuses a second run for a character already in one, and names it", async () => {
    const pc = await aCharacter();
    const first = await sendDown(pc, hole);
    expect(first.status).toBe(200);

    // A DIFFERENT dungeon, so nothing but the character can be what refuses it.
    const second = await sendDown(pc, otherHole);

    expect(second.status).toBe(409);
    expect(second.body.error).toBe("in a run");
    expect(second.body.runId).toBe(first.body.run.id);
  });

  it("will not send anyone into a dungeon that is still being written", async () => {
    const pc = await aCharacter();
    const partial = await repo.insertPartialDungeon(world, owner);

    const res = await ask("/api/runs", {
      method: "POST",
      body: { dungeonId: partial, character: pc },
    });
    expect(res.status).toBe(409);
  });

  it("does not confirm that another player's dungeon exists", async () => {
    const pc = await aCharacter();
    const stranger = await makeUser();
    const theirs = await aFinishedDungeon(stranger);

    const res = await ask("/api/runs", {
      method: "POST",
      body: { dungeonId: theirs, character: pc },
    });
    // 404 and not 403 — "not yours" and "not there" are one answer.
    expect(res.status).toBe(404);

    await sql`delete from auth.users where id = ${stranger}`;
  });
});

describe("abandoning a run", () => {
  async function aRunInProgress() {
    const pc = await aCharacter();
    const { body } = await sendDown(pc, hole);
    return { pc, id: body.run.id as string, version: body.run.version as number };
  }

  it("ends it, and says so at a version the client can carry on from", async () => {
    const { id, version } = await aRunInProgress();

    const res = await ask(`/api/runs/${id}/abandon`, { method: "POST", body: { version } });
    const body = (await res.json()) as Record<string, any>;

    expect(res.status).toBe(200);
    expect(body.state.stage).toBe("abandoned");
    expect(body.version).toBe(version + 1);

    // And the row agrees, which is what frees the character.
    expect((await repo.getRun(id, owner))?.status).toBe("abandoned");
  });

  /**
   * THE CLIENT NEVER ASSERTS A RULE — it says which version it answers, and
   * nothing else. A request that names none is not a request this API can
   * safely accept, whatever else is true of it.
   */
  it("refuses one that does not say which version it answers", async () => {
    const { id } = await aRunInProgress();

    expect((await ask(`/api/runs/${id}/abandon`, { method: "POST", body: {} })).status).toBe(400);
    expect(
      (await ask(`/api/runs/${id}/abandon`, { method: "POST", body: { version: "latest" } })).status
    ).toBe(400);

    // Nothing happened, either time.
    expect((await repo.getRun(id, owner))?.status).toBe("active");
  });

  it("refuses a stale version and hands back what is actually true", async () => {
    const { id, version } = await aRunInProgress();

    const res = await ask(`/api/runs/${id}/abandon`, { method: "POST", body: { version: version + 7 } });
    const body = (await res.json()) as Record<string, any>;

    expect(res.status).toBe(409);
    expect(body.error).toBe("stale");
    expect(body.current.version).toBe(version);
    expect((await repo.getRun(id, owner))?.status).toBe("active");
  });

  it("refuses to end a run twice", async () => {
    const { id, version } = await aRunInProgress();
    expect((await ask(`/api/runs/${id}/abandon`, { method: "POST", body: { version } })).status).toBe(200);

    const again = await ask(`/api/runs/${id}/abandon`, { method: "POST", body: { version: version + 1 } });
    expect(again.status).toBe(409);
  });

  it("does not confirm that another player's run exists", async () => {
    const stranger = await makeUser();
    const theirs = await aFinishedDungeon(stranger);
    const run = await repo.createRun({ dungeonId: theirs, state: newRunState(), owner: stranger });

    const res = await ask(`/api/runs/${run.id}/abandon`, {
      method: "POST",
      body: { version: run.version },
    });
    expect(res.status).toBe(404);
    expect((await repo.getRun(run.id, stranger))?.status).toBe("active");

    await sql`delete from auth.users where id = ${stranger}`;
  });

  /** The state a run starts in, without going through the handler to get it. */
  function newRunState() {
    return { stage: "awaiting_action", turnCount: 0, log: [] } as never;
  }

  it("frees the character to go somewhere else", async () => {
    const { pc, id, version } = await aRunInProgress();
    await ask(`/api/runs/${id}/abandon`, { method: "POST", body: { version } });

    const again = await sendDown(pc, otherHole);
    expect(again.status).toBe(200);
  });
});

describe("deleting a character", () => {
  /**
   * The foreign key is `on delete set null`, so without this check the delete
   * would succeed and leave an active run belonging to nobody — a save file with
   * no way to reach it and no way to end it, holding a lock against a character
   * that no longer exists.
   */
  it("is refused while they are still down there, and says what to do", async () => {
    const pc = await aCharacter();
    const { body } = await sendDown(pc, hole);

    const res = await ask(`/api/characters/${pc.id}`, { method: "DELETE" });
    const said = (await res.json()) as Record<string, any>;

    expect(res.status).toBe(409);
    expect(said.error).toContain("abandon it first");
    expect(said.runId).toBe(body.run.id);

    // Still there, which is the point of a refusal.
    expect(await repo.getCharacter(pc.id, owner)).toBeDefined();
  });

  it("goes through once the run is over", async () => {
    const pc = await aCharacter();
    const { body } = await sendDown(pc, hole);
    await ask(`/api/runs/${body.run.id}/abandon`, {
      method: "POST",
      body: { version: body.run.version },
    });

    const res = await ask(`/api/characters/${pc.id}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true });
  });
});

describe("the roster", () => {
  it("serves the person, where they are, and what has happened to them", async () => {
    const pc = await aCharacter("Scoreboard");
    const { body } = await sendDown(pc, hole);

    const inRun = (await (await ask("/api/characters")).json()) as any[];
    const mine = inRun.find((e) => e.sheet.id === pc.id);
    expect(mine.sheet.name).toBe("Scoreboard");
    expect(mine.record).toEqual({ dead: 0, abandoned: 0, escaped: 0, goalMet: 0 });
    expect(mine.activeRun).toMatchObject({ id: body.run.id, dungeonName: world.pass.name });

    await ask(`/api/runs/${body.run.id}/abandon`, {
      method: "POST",
      body: { version: body.run.version },
    });

    const after = (await (await ask("/api/characters")).json()) as any[];
    const now = after.find((e) => e.sheet.id === pc.id);
    expect(now.record).toEqual({ dead: 0, abandoned: 1, escaped: 0, goalMet: 0 });
    expect(now.activeRun).toBeUndefined();
  });
});
