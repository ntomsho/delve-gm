/**
 * WHO IS ASKING
 * =============
 *
 * One middleware, one job: turn an `Authorization: Bearer <jwt>` header into a
 * user id on the context, or refuse the request. Nothing below this file reads a
 * header, and nothing above it trusts anything the client said about itself.
 *
 * THE TOKEN IS VERIFIED LOCALLY, NOT ASKED ABOUT. Supabase offers
 * `GET /auth/v1/user` for this, which is a network round trip on every single
 * request — on a turn that is fine and on the twelve parallel chunk requests of
 * a size-5 generation it is twelve. The project signs with ASYMMETRIC ES256
 * keys, so verification is a signature check against the public JWKS and needs
 * no secret at all: there is no `SUPABASE_JWT_SECRET` to leak, rotate, or
 * forget to set in an environment.
 *
 * `createRemoteJWKSet` caches the key set and refetches only when it sees a
 * `kid` it does not know, which is what makes key rotation a non-event. The set
 * is module state, deliberately, for the same reason the pool in `db.ts` is: it
 * holds no per-user state, and one per request would spend a fetch on every
 * turn.
 *
 * WHAT A FAILURE LOOKS LIKE. Every rejection is a bare 401 with the same short
 * message. A caller learns that it is not signed in and nothing else — not
 * whether the token was expired rather than forged, not whether the user exists.
 * That is also why ownership lives in the WHERE clause in `repo.ts` and a
 * stranger's run is a 404: the API does not confirm the existence of things you
 * may not have.
 *
 * Node only.
 */

import { createRemoteJWKSet, jwtVerify } from "jose";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";

/**
 * The signed-in user, as the rest of the server sees them.
 *
 * `id` is the `sub` claim, which is the `auth.users` primary key and therefore
 * the value in every `owner_id` column. There is deliberately nothing else on
 * here yet — no tier, no email — because nothing in Phase 11 reads them and a
 * field nobody reads is a field that goes stale. Phase 12's BYOK/VIP split is
 * where `tier` arrives, from `profiles` rather than from the token.
 */
export interface AuthUser {
  id: string;
}

/** Hono's context, taught what `c.get("user")` holds. */
export type AuthEnv = { Variables: { user: AuthUser } };

let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;

/**
 * Where the public keys live.
 *
 * Derived from the project URL rather than named separately: they are the same
 * project and two environment variables that must agree is one that can
 * disagree.
 */
function keySet(): ReturnType<typeof createRemoteJWKSet> {
  if (jwks) return jwks;

  const url = process.env.SUPABASE_URL;
  if (!url) {
    throw new Error(
      "SUPABASE_URL is not set, so no token can be verified. It is the project " +
        "URL from the Supabase dashboard (Project Settings → API)."
    );
  }
  return (jwks = createRemoteJWKSet(new URL(`${url.replace(/\/$/, "")}/auth/v1/.well-known/jwks.json`)));
}

/**
 * Verify a bearer token and hand back who it belongs to.
 *
 * Exported so tests can exercise verification without standing up an app, and
 * so the failure is one function rather than one per caller.
 */
export async function verifyToken(token: string): Promise<AuthUser> {
  // `audience` is Supabase's own constant for a signed-in user; an anonymous
  // token carries a different one, so this is also what keeps anonymous
  // sign-ins out for as long as the project has them switched off.
  const { payload } = await jwtVerify(token, keySet(), { audience: "authenticated" });

  if (typeof payload.sub !== "string" || payload.sub === "") {
    throw new Error("token carries no subject");
  }
  return { id: payload.sub };
}

const UNAUTHORIZED = "sign in first";

/**
 * The gate. Everything under `/api` except `/api/health` goes through it.
 *
 * `health` is exempt because it is what the Vercel cron hits twice a week to
 * keep Supabase from pausing the project (CODING-PLAN §7.8), and a cron has no
 * account. It reads nothing and writes nothing.
 */
export const requireUser = createMiddleware<AuthEnv>(async (c, next) => {
  const header = c.req.header("authorization") ?? "";
  const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";

  if (token === "") throw new HTTPException(401, { message: UNAUTHORIZED });

  let user: AuthUser;
  try {
    user = await verifyToken(token);
  } catch {
    // Expired, forged, wrong audience, unknown key — all one answer. See the
    // header: a caller learns that it is not signed in and nothing more.
    throw new HTTPException(401, { message: UNAUTHORIZED });
  }

  c.set("user", user);
  await next();
});

/**
 * The current user, for a handler that has been through `requireUser`.
 *
 * A getter rather than `c.get("user")` at each site so that the one place which
 * would break if the middleware were ever detached is this function, and it
 * says so out loud rather than handing a handler `undefined` to write into an
 * `owner_id` column.
 */
export function currentUser(c: { get: (k: "user") => AuthUser | undefined }): AuthUser {
  const user = c.get("user");
  if (!user) throw new Error("no user on the context — is `requireUser` mounted on this route?");
  return user;
}
