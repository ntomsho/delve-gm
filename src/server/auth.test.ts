/**
 * THE GATE
 * ========
 *
 * What is worth checking here is not that `jose` verifies signatures — it does,
 * and it is not ours. It is that this project's wrapper around it refuses
 * everything it should: a token signed by the wrong key, an expired one, one
 * carrying the wrong audience, one with no subject, and no token at all.
 *
 * A REAL KEY PAIR, GENERATED PER RUN, and a JWKS served from a stubbed `fetch`.
 * That is what lets a signature actually be checked rather than mocked past —
 * a test that stubs `verifyToken` itself would assert nothing about the thing
 * most worth asserting.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";

const ISSUER = "https://project.supabase.co";

let privateKey: CryptoKey;
let strangerKey: CryptoKey;
let jwks: { keys: JWK[] };

beforeAll(async () => {
  const mine = await generateKeyPair("ES256", { extractable: true });
  const stranger = await generateKeyPair("ES256", { extractable: true });
  privateKey = mine.privateKey;
  strangerKey = stranger.privateKey;

  // Only OUR public key is published, so the stranger's signature has no key to
  // verify against — which is exactly the forged-token case.
  jwks = { keys: [{ ...(await exportJWK(mine.publicKey)), kid: "test-key", alg: "ES256", use: "sig" }] };
});

/** A token as Supabase would issue one, with whatever we want changed. */
async function mint(
  claims: { sub?: string; aud?: string; expiresIn?: string } = {},
  key: CryptoKey = privateKey
): Promise<string> {
  let jwt = new SignJWT({})
    .setProtectedHeader({ alg: "ES256", kid: "test-key" })
    .setIssuedAt()
    .setAudience(claims.aud ?? "authenticated")
    .setExpirationTime(claims.expiresIn ?? "1h");
  if (claims.sub !== undefined) jwt = jwt.setSubject(claims.sub);
  return jwt.sign(key);
}

/**
 * A fresh module per test.
 *
 * `auth.ts` caches the key set in module state — right for a server, wrong for
 * a suite that changes what the environment says between cases.
 */
async function freshAuth() {
  vi.resetModules();
  return import("./auth.ts");
}

beforeEach(() => {
  process.env.SUPABASE_URL = ISSUER;
  vi.stubGlobal("fetch", async (url: string) => {
    if (String(url).includes("/.well-known/jwks.json")) {
      return { ok: true, status: 200, json: async () => jwks, headers: new Headers() };
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
});

afterEach(() => vi.unstubAllGlobals());

describe("verifyToken", () => {
  it("accepts a properly signed token and reports its subject", async () => {
    const { verifyToken } = await freshAuth();
    const user = await verifyToken(await mint({ sub: "user-abc" }));
    expect(user).toEqual({ id: "user-abc" });
  });

  it("refuses a token signed by a key it does not know", async () => {
    const { verifyToken } = await freshAuth();
    const forged = await mint({ sub: "user-abc" }, strangerKey);
    await expect(verifyToken(forged)).rejects.toThrow();
  });

  it("refuses an expired token", async () => {
    const { verifyToken } = await freshAuth();
    const stale = await mint({ sub: "user-abc", expiresIn: "-1h" });
    await expect(verifyToken(stale)).rejects.toThrow();
  });

  /**
   * Supabase gives an anonymous sign-in a different audience. The project has
   * them switched off, and this is the line that keeps them out if anybody ever
   * turns them on without reading this file.
   */
  it("refuses a token whose audience is not `authenticated`", async () => {
    const { verifyToken } = await freshAuth();
    const anon = await mint({ sub: "user-abc", aud: "anon" });
    await expect(verifyToken(anon)).rejects.toThrow();
  });

  it("refuses a token carrying no subject, since that is the owner_id", async () => {
    const { verifyToken } = await freshAuth();
    await expect(verifyToken(await mint({}))).rejects.toThrow(/subject/);
  });

  it("says so plainly when SUPABASE_URL is not set", async () => {
    delete process.env.SUPABASE_URL;
    const { verifyToken } = await freshAuth();
    await expect(verifyToken(await mint({ sub: "user-abc" }))).rejects.toThrow(/SUPABASE_URL/);
  });
});

describe("requireUser", () => {
  /** The middleware, exercised through a Hono app rather than by hand. */
  async function appWith(header?: string) {
    const { requireUser, currentUser } = await freshAuth();
    const { Hono } = await import("hono");
    const app = new Hono();
    app.use("/api/*", requireUser);
    app.get("/api/whoami", (c) => c.json({ id: currentUser(c as never).id }));

    return app.request("/api/whoami", {
      headers: header ? { authorization: header } : {},
    });
  }

  it("puts the user on the context for a good token", async () => {
    const res = await appWith(`Bearer ${await mint({ sub: "user-abc" })}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "user-abc" });
  });

  it("401s with no Authorization header at all", async () => {
    expect((await appWith()).status).toBe(401);
  });

  it("401s on a header that is not a bearer token", async () => {
    expect((await appWith("Basic aGVsbG8=")).status).toBe(401);
  });

  it("401s on a forged token", async () => {
    const forged = await mint({ sub: "user-abc" }, strangerKey);
    expect((await appWith(`Bearer ${forged}`)).status).toBe(401);
  });

  /**
   * EVERY REFUSAL READS THE SAME. A caller learns that it is not signed in and
   * nothing else — not whether the token was expired rather than forged, not
   * whether the user exists. Same reasoning as ownership being a 404.
   */
  it("says the same thing however the token was bad", async () => {
    const said = async (h?: string) => (await appWith(h)).text();
    const forged = await said(`Bearer ${await mint({ sub: "a" }, strangerKey)}`);
    const expired = await said(`Bearer ${await mint({ sub: "a", expiresIn: "-1h" })}`);
    const absent = await said();

    expect(forged).toBe("sign in first");
    expect(expired).toBe(forged);
    expect(absent).toBe(forged);
  });

  it("accepts a lower-case `bearer`, which some clients send", async () => {
    const res = await appWith(`bearer ${await mint({ sub: "user-abc" })}`);
    expect(res.status).toBe(200);
  });
});

describe("currentUser", () => {
  it("throws rather than handing back undefined for an owner_id", async () => {
    const { currentUser } = await freshAuth();
    expect(() => currentUser({ get: () => undefined })).toThrow(/requireUser/);
  });
});
