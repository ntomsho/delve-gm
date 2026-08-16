/**
 * WHO IS PLAYING
 * ==============
 *
 * The browser half of Phase 11. It holds a Supabase session, hands out the
 * access token, and is the ONLY place in the client that attaches one.
 *
 * THE ANON KEY BELONGS IN THE BROWSER, and that is not a hole in the standing
 * rule. CLAUDE.md says the API key lives in `.env.local` and never reaches the
 * client — that rule is about the ANTHROPIC key, it is still true, and this
 * changes nothing about it: the model is reached only by the server. The
 * publishable Supabase key is a different kind of thing, designed to ship inside
 * a page. It identifies the project and grants nothing on its own — every table
 * has RLS on with owner-only policies, so a stranger holding it reads their own
 * rows, of which they have none.
 *
 * ONE FETCH WRAPPER, USED BY EVERYTHING. `store/characters.ts` and
 * `runtime/remote-session.ts` both called bare `fetch` before this, in four
 * places. Four places to attach a header is four places to forget, and the one
 * that got forgotten would fail as a 401 in a corner nobody exercises. So
 * `authedFetch` is the door and neither module knows a token exists.
 *
 * GOOGLE IS THE ONLY WAY IN, deliberately: one provider, one button, and no
 * password reset flow, email deliverability problem or credential store to own.
 */

import { createClient, type Session, type SupabaseClient } from "@supabase/supabase-js";

let cached: SupabaseClient | undefined;

/**
 * The Supabase client, MADE ON FIRST USE AND NOT AT IMPORT.
 *
 * Laziness is load-bearing, not tidiness. `?offline` and `?stub` are played
 * entirely in the browser and need no account, no project and no keys — and
 * `App.tsx` imports this module either way, through `store/characters.ts`. A
 * client constructed at module scope threw "supabaseUrl is required" the moment
 * anything imported the app without a `.env.local`, which took `App.test.tsx`
 * down with it. Nothing local should have to own a Supabase project to run.
 */
export function client(): SupabaseClient {
  if (cached) return cached;

  const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
  const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
  if (!url || !key) {
    // Loud and specific. A missing key otherwise produces a sign-in button that
    // silently does nothing, which is among the worst things to debug from a
    // screenshot.
    throw new Error(
      "VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY are not set. " +
        "Copy .env.local.example to .env.local and fill them in."
    );
  }

  return (cached = createClient(url, key, {
    auth: {
      // The session survives a reload, and the library refreshes it before it
      // expires — which is what stops a long session dying mid-run.
      persistSession: true,
      autoRefreshToken: true,
      // The OAuth redirect comes back with the session in the URL fragment.
      detectSessionInUrl: true,
    },
  }));
}

/** Who is signed in, as the interface needs them. */
export interface Account {
  id: string;
  email?: string;
  name?: string;
  avatar?: string;
}

export function accountOf(session: Session | null): Account | undefined {
  if (!session) return undefined;
  const meta = session.user.user_metadata ?? {};
  return {
    id: session.user.id,
    email: session.user.email,
    name: (meta.full_name ?? meta.name) as string | undefined,
    avatar: (meta.avatar_url ?? meta.picture) as string | undefined,
  };
}

/**
 * Send the player to Google.
 *
 * `redirectTo` is this page, so they come back where they were rather than at
 * whatever the project's Site URL happens to be — which matters in development,
 * where the Site URL is production.
 */
export async function signIn(): Promise<void> {
  const { error } = await client().auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: window.location.origin },
  });
  if (error) throw error;
}

export async function signOut(): Promise<void> {
  await client().auth.signOut();
}

/**
 * Follow the session.
 *
 * Wrapped rather than exposing the client, so `App.tsx` never touches
 * `supabase.auth` directly and this module stays the only thing that knows what
 * the session is made of. Fires once with the stored session on subscribe.
 */
export function onAuthChange(cb: (account: Account | undefined) => void): () => void {
  const { data } = client().auth.onAuthStateChange((_event, session) => cb(accountOf(session)));
  return () => data.subscription.unsubscribe();
}

/**
 * The current access token, refreshed if it is close to expiring.
 *
 * `getSession` is what does the refreshing, so this is called per request
 * rather than cached — a token cached at sign-in is a token that expires in the
 * middle of a two-hour run.
 */
export async function accessToken(): Promise<string | undefined> {
  const { data } = await client().auth.getSession();
  return data.session?.access_token;
}

/** Thrown when a request needs an account and there is not one. */
export class NotSignedIn extends Error {
  constructor() {
    super("sign in first");
    this.name = "NotSignedIn";
  }
}

/**
 * `fetch`, with the player's token on it.
 *
 * THE ONLY PLACE A TOKEN IS ATTACHED. If a 401 comes back the session is
 * finished — expired past refreshing, or revoked — so the local one is cleared,
 * which drops the app back to the sign-in screen through the auth listener
 * rather than leaving it staring at a failed request it cannot explain.
 */
export async function authedFetch(
  input: RequestInfo | URL,
  init: RequestInit = {}
): Promise<Response> {
  const token = await accessToken();
  if (!token) throw new NotSignedIn();

  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);

  const res = await fetch(input, { ...init, headers });

  if (res.status === 401) {
    await client().auth.signOut();
    throw new NotSignedIn();
  }
  return res;
}
