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
import { closeDb, db } from "./db/connection.ts";
import * as repo from "./db/repo.ts";
import type { AuthEnv } from "./auth.ts";
import { generateOffline, testCharacter } from "../fixtures/offline.ts";
import type { PlayerCharacter } from "../rules/knave/character.ts";

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
let signingKey: CryptoKey;

/** A token for any account, signed by the key the stubbed JWKS publishes. */
function tokenFor(id: string, guest = false): Promise<string> {
  return new SignJWT(guest ? { is_anonymous: true } : {})
    .setProtectedHeader({ alg: "ES256", kid: "test-key" })
    .setIssuedAt()
    .setSubject(id)
    .setAudience("authenticated")
    .setExpirationTime("1h")
    .sign(signingKey);
}

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
  signingKey = privateKey;
  jwks = { keys: [{ ...(await exportJWK(publicKey)), kid: "test-key", alg: "ES256", use: "sig" }] };
  stubJwks(jwks);

  sql = db();
  owner = await makeUser();
  // UNLIMITED, because this file starts far more than three runs from one
  // account and most of it is not about the allowance. The allowance cases at
  // the bottom make limited accounts of their own.
  await sql`update profiles set tier = 'unlimited' where id = ${owner}`;
  token = await tokenFor(owner);

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
function ask(path: string, init: { method?: string; body?: unknown; as?: string } = {}) {
  return app.request(path, {
    method: init.method ?? "GET",
    headers: { authorization: `Bearer ${init.as ?? token}`, "content-type": "application/json" },
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

/*
 * PHASE 13b. The shelf, over HTTP. `listLibrary` is covered against the database
 * in `ownership.dbtest.ts`; what is left here is the layer where a query string
 * becomes an argument — including the one that would be a routing bug rather
 * than a query one.
 */
describe("browsing the library", () => {
  it("serves other players' worlds and not the caller's own", async () => {
    const stranger = await makeUser();
    const theirs = await aFinishedDungeon(stranger);

    const res = await ask("/api/dungeons/library");
    const body = (await res.json()) as Record<string, any>;

    expect(res.status).toBe(200);
    expect(body.dungeons.map((d: any) => d.id)).toContain(theirs);
    // `hole` and `otherHole` belong to the caller and are on no shelf of theirs.
    expect(body.dungeons.map((d: any) => d.id)).not.toContain(hole);
    expect(body.dungeons[0]).not.toHaveProperty("doc");

    await sql`delete from auth.users where id = ${stranger}`;
  });

  /**
   * THE ROUTING ONE. `library` is a perfectly plausible dungeon id, so this
   * route has to be reachable at all — registered ahead of the `:id` routes.
   * A test that only asked whether the query was right would pass against a
   * server that answered this with "no such dungeon: library".
   */
  it("is not shadowed by the routes that take a dungeon id", async () => {
    const res = await ask("/api/dungeons/library");
    expect(res.status).toBe(200);
    expect(await res.json()).toHaveProperty("dungeons");
  });

  it("pages with the cursor it handed out", async () => {
    const stranger = await makeUser();
    await aFinishedDungeon(stranger);
    await aFinishedDungeon(stranger);

    const first = (await (await ask("/api/dungeons/library?limit=1")).json()) as any;
    expect(first.dungeons).toHaveLength(1);
    expect(first.cursor).toBeTruthy();

    const second = (await (
      await ask(`/api/dungeons/library?limit=1&cursor=${encodeURIComponent(first.cursor)}`)
    ).json()) as any;

    expect(second.dungeons).toHaveLength(1);
    expect(second.dungeons[0].id).not.toBe(first.dungeons[0].id);

    await sql`delete from auth.users where id = ${stranger}`;
  });

  it("needs an account like everything else under /api", async () => {
    expect((await app.request("/api/dungeons/library")).status).toBe(401);
  });
});

/*
 * PHASE 13a. The route that names a dungeon the caller does not own — and what
 * has to be true is that it hands over a copy and never the source. The `doc`
 * is every answer in the world; browsing must not be a way to read one.
 */
describe("taking a copy of another player's world", () => {
  it("makes a world of the caller's own and serves nothing of the original", async () => {
    const stranger = await makeUser();
    const theirs = await aFinishedDungeon(stranger);

    /**
     * A run into a dungeon, by status alone.
     *
     * NOT `sendDown`, which reads the body: `mustGetDungeon` refuses through an
     * `HTTPException`, and Hono renders one as plain text. That is the shape
     * every "not yours / not there" answer in this API has, and it is the one
     * being asserted here.
     */
    const walkInto = async (id: string) =>
      (await ask("/api/runs", { method: "POST", body: { dungeonId: id, character: await aCharacter() } }))
        .status;

    // Before: a stranger's dungeon is a 404 to everything that serves a `doc`.
    expect(await walkInto(theirs)).toBe(404);

    const res = await ask(`/api/dungeons/${theirs}/duplicate`, { method: "POST" });
    const body = (await res.json()) as Record<string, any>;
    expect(res.status).toBe(200);
    expect(body.already).toBe(false);
    expect(body.dungeonId).not.toBe(theirs);
    // The reply is an id and a flag. No name, no objective, no document.
    expect(Object.keys(body).sort()).toEqual(["already", "dungeonId"]);

    // After: the caller can walk into their own copy, and the stranger's row is
    // still a 404 to them.
    expect(await walkInto(body.dungeonId)).toBe(200);
    expect(await walkInto(theirs)).toBe(404);

    await sql`delete from auth.users where id = ${stranger}`;
  });

  it("hands back the copy already taken on a second press", async () => {
    const stranger = await makeUser();
    const theirs = await aFinishedDungeon(stranger);

    const first = (await (await ask(`/api/dungeons/${theirs}/duplicate`, { method: "POST" })).json()) as any;
    const second = (await (await ask(`/api/dungeons/${theirs}/duplicate`, { method: "POST" })).json()) as any;

    expect(second).toEqual({ dungeonId: first.dungeonId, already: true });

    await sql`delete from auth.users where id = ${stranger}`;
  });

  /** "Not there" and "still being written" are one answer, for the same reason
   *  "not there" and "not yours" are everywhere else in this API. */
  it("refuses a half-written world with the same 404 as a missing one", async () => {
    const stranger = await makeUser();
    const partial = await repo.insertPartialDungeon(world, stranger);

    const half = await ask(`/api/dungeons/${partial}/duplicate`, { method: "POST" });
    const missing = await ask(
      `/api/dungeons/00000000-0000-0000-0000-000000000000/duplicate`,
      { method: "POST" }
    );
    expect(half.status).toBe(404);
    expect(missing.status).toBe(404);

    await sql`delete from auth.users where id = ${stranger}`;
  });

  it("needs an account like everything else under /api", async () => {
    const stranger = await makeUser();
    const theirs = await aFinishedDungeon(stranger);

    const res = await app.request(`/api/dungeons/${theirs}/duplicate`, { method: "POST" });
    expect(res.status).toBe(401);

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

/*
 * GUESTS AND ALLOWANCES. Each case makes its own limited accounts, because the
 * file's main account is `unlimited` (see `beforeAll`). No case here reaches the
 * model: every generation request below is refused, or is a retry that hands
 * back a dungeon that already exists.
 *
 * The rule being held: writing a dungeon plus the first run into it is ONE run;
 * any other run is one run.
 */
describe("the daily allowance", () => {
  /** A limited account, a token for it, and a character on it. */
  async function anAccount(guest: boolean) {
    const id = await makeUser();
    const as = await tokenFor(id, guest);
    const pc = { ...testCharacter(), id: `pc-${crypto.randomUUID()}`, name: "Counted" };
    expect((await ask("/api/characters", { method: "POST", body: pc, as })).status).toBe(200);
    return { id, as, pc };
  }
  type Account = Awaited<ReturnType<typeof anAccount>>;

  const allowanceOf = async (a: Account) =>
    (await (await ask("/api/allowance", { as: a.as })).json()) as Record<string, any>;

  /** Start a run and walk away at once, so the next start is not "in a run". */
  async function runOnce(a: Account, dungeonId: string) {
    const res = await ask("/api/runs", {
      method: "POST",
      body: { dungeonId, character: a.pc },
      as: a.as,
    });
    const body = (await res.json()) as Record<string, any>;
    if (res.status === 200) {
      await ask(`/api/runs/${body.run.id}/abandon`, {
        method: "POST",
        body: { version: body.run.version },
        as: a.as,
      });
    }
    return { status: res.status, body };
  }

  const writeNew = (a: Account, size = 1) =>
    ask("/api/dungeons", { method: "POST", body: { seed: 1, size, level: 1 }, as: a.as });

  it("counts writing a dungeon and its first run as one, and refuses a second", async () => {
    const guest = await anAccount(true);
    try {
      expect(await allowanceOf(guest)).toMatchObject({ guest: true, used: 0, limit: 1, left: 1 });

      // Written (here directly, standing in for the three generation requests).
      const mine = await aFinishedDungeon(guest.id);
      expect(await allowanceOf(guest)).toMatchObject({ used: 1, left: 0, unplayed: [mine] });

      // The first run rides on the writing: allowed at 0 left, and still 1 used.
      expect((await runOnce(guest, mine)).status).toBe(200);
      expect(await allowanceOf(guest)).toMatchObject({ used: 1, left: 0, unplayed: [] });

      // A second run down the same dungeon is a run of its own.
      const again = await runOnce(guest, mine);
      expect(again.status).toBe(429);
      expect(again.body.error).toMatch(/Sign in with Google/);

      // And no more writing either.
      expect((await writeNew(guest)).status).toBe(429);
    } finally {
      await sql`delete from auth.users where id = ${guest.id}`;
    }
  });

  it("counts a run into somebody else's world as one", async () => {
    const guest = await anAccount(true);
    const stranger = await makeUser();
    try {
      const theirs = await aFinishedDungeon(stranger);
      const copy = await ask(`/api/dungeons/${theirs}/duplicate`, { method: "POST", as: guest.as });
      const { dungeonId } = (await copy.json()) as { dungeonId: string };

      // Taking the copy is free; going down it is not.
      expect(await allowanceOf(guest)).toMatchObject({ used: 0, unplayed: [] });
      expect((await runOnce(guest, dungeonId)).status).toBe(200);
      expect(await allowanceOf(guest)).toMatchObject({ used: 1, left: 0 });

      expect((await writeNew(guest)).status).toBe(429);
    } finally {
      await sql`delete from auth.users where id in (${guest.id}, ${stranger})`;
    }
  });

  it("gives a member three, and deleting the character refunds nothing", async () => {
    const member = await anAccount(false);
    try {
      const mine = await aFinishedDungeon(member.id); // 1: written, first run rides
      expect((await runOnce(member, mine)).status).toBe(200);
      expect((await runOnce(member, mine)).status).toBe(200); // 2
      expect((await runOnce(member, mine)).status).toBe(200); // 3
      expect((await runOnce(member, mine)).status).toBe(429);

      await ask(`/api/characters/${member.pc.id}`, { method: "DELETE", as: member.as });
      expect(await allowanceOf(member)).toMatchObject({ guest: false, used: 3, limit: 3, left: 0 });
    } finally {
      await sql`delete from auth.users where id = ${member.id}`;
    }
  });

  /**
   * "Try seed N again" after a failed writing. The partial row was counted when
   * it was made; the retry must reuse it rather than make (and count) another,
   * and must not be refused for having used the run it is retrying.
   */
  it("hands a retry back the unfinished dungeon instead of writing a second", async () => {
    const guest = await anAccount(true);
    try {
      const partial = await repo.insertPartialDungeon(world, guest.id);
      expect(await allowanceOf(guest)).toMatchObject({ used: 1, left: 0 });

      const res = await ask("/api/dungeons", {
        method: "POST",
        body: { seed: world.seeds.dungeonSeed, size: world.size, level: world.level },
        as: guest.as,
      });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { dungeonId: string }).dungeonId).toBe(partial);
      expect(await allowanceOf(guest)).toMatchObject({ used: 1 });
    } finally {
      await sql`delete from auth.users where id = ${guest.id}`;
    }
  });

  it("refuses anything bigger than size 1 before it costs a model call", async () => {
    const member = await anAccount(false);
    try {
      const res = await writeNew(member, 2);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toMatch(/size 1/);
    } finally {
      await sql`delete from auth.users where id = ${member.id}`;
    }
  });

  it("does not limit an unlimited account", async () => {
    const mine = await (await ask("/api/allowance")).json();
    expect(mine).toMatchObject({ unlimited: true, limit: null, left: null });
  });
});
