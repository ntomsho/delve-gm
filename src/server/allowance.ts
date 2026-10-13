/**
 * HOW MUCH ONE PERSON MAY SPEND IN A DAY
 * ======================================
 *
 * Layer 3 of *Paying for strangers* in BUILD-PLAN: a cap per account, so that one
 * person in a burst of visitors cannot use the day up. It is NOT what bounds the
 * bill — a guest account costs one click, so a determined script simply makes
 * more of them. The budget ceiling (layer 2) is what bounds the bill; this only
 * shares out what the ceiling allows.
 *
 * WHAT IS COUNTED IS RUNS STARTED, read straight off `runs`. No counter table:
 * `runs` already knows who started what and when, so there is nothing to keep in
 * step. Deleting a character does not refund one — `runs.character_id` goes to
 * null, the run row stays — and an abandoned run counts, because the dungeon it
 * was played in was paid for whether or not anyone finished it.
 *
 * GENERATION IS GATED BY THE SAME COUNT, not counted itself. A dungeon may be
 * written only while the account still has a run left today, because a dungeon
 * is written in order to be played and a player with no run left cannot play it.
 * And it may only be size 1 (`MAX_GENERATED_SIZE`) for now: a bigger world is
 * more writing calls and, more to the point, a longer and dearer run.
 *
 * THE DAY IS UTC. One clock for everybody, the same one the budget ceiling will
 * use, and the reset time is sent to the client rather than computed there.
 *
 * `unlimited` (the author, and whoever they choose) is exempt from all of it —
 * the count, the generation gate and the size cap. It will not be exempt from
 * the ceiling when that exists.
 *
 * KNOWN RACE, ACCEPTED. Two runs started in the same instant can both be
 * counted before either is written, and both go through. That is one extra run
 * for somebody racing their own account, which the ceiling covers.
 *
 * Node only.
 */

import type postgres from "postgres";
import { db } from "./db.ts";
import type { AuthUser } from "./auth.ts";

/** Runs a guest may start per UTC day. */
export const GUEST_RUNS_PER_DAY = 1;
/** Runs a signed-in (Google) account may start per UTC day. */
export const MEMBER_RUNS_PER_DAY = 3;
/** The largest dungeon anyone but an `unlimited` account may generate. */
export const MAX_GENERATED_SIZE = 1;

export type Tier = "member" | "unlimited";

/**
 * What the interface is told, and what the gates decide on.
 *
 * Mirrored in `src/store/allowance.ts`.
 */
export interface Allowance {
  guest: boolean;
  unlimited: boolean;
  /** Runs started since midnight UTC. */
  used: number;
  /** Runs allowed per day. `null` for unlimited. */
  limit: number | null;
  /** Runs still available today. `null` for unlimited. */
  left: number | null;
  /** The largest size this account may generate. */
  maxSize: number;
  /** ISO timestamp of the next midnight UTC, when `used` goes back to 0. */
  resetsAt: string;
}

/** The next midnight UTC after `now`. */
export function nextUtcMidnight(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
}

/** The rule, without the database, so it can be tested without one. */
export function allowanceFor(input: {
  guest: boolean;
  tier: Tier;
  used: number;
  now: Date;
}): Allowance {
  const resetsAt = nextUtcMidnight(input.now).toISOString();
  if (input.tier === "unlimited") {
    return {
      guest: input.guest,
      unlimited: true,
      used: input.used,
      limit: null,
      left: null,
      maxSize: 5,
      resetsAt,
    };
  }
  const limit = input.guest ? GUEST_RUNS_PER_DAY : MEMBER_RUNS_PER_DAY;
  return {
    guest: input.guest,
    unlimited: false,
    used: input.used,
    limit,
    left: Math.max(0, limit - input.used),
    maxSize: MAX_GENERATED_SIZE,
    resetsAt,
  };
}

/** True when the account may start another run (or write another dungeon) today. */
export function hasRunLeft(a: Allowance): boolean {
  return a.left === null || a.left > 0;
}

/**
 * The sentence a refused player reads. Said by the server so that the copy is in
 * one place, and so a refusal the interface did not predict still reads well.
 */
export function refusal(a: Allowance): string {
  const runs = a.limit === 1 ? "run" : "runs";
  const more = a.guest ? ` Sign in with Google for ${MEMBER_RUNS_PER_DAY} a day.` : "";
  return `That is your ${a.limit} ${runs} for today. More at midnight UTC.${more}`;
}

/**
 * Read the tier and today's count in one round trip.
 *
 * A missing profile is a member. `handle_new_user` makes one for every account,
 * so this only matters in the instant between an account existing and its
 * trigger committing — and the safe reading of "we do not know" is the limited
 * one.
 *
 * The day boundary is computed in Postgres, against the same clock that stamped
 * `runs.created_at`, so the server and the database cannot disagree about which
 * day a run belongs to.
 */
export async function allowanceOf(
  user: AuthUser,
  sql: postgres.Sql = db(),
  now: Date = new Date()
): Promise<Allowance> {
  const [row] = await sql<{ tier: Tier | null; used: number }[]>`
    select
      (select tier from profiles where id = ${user.id}) as tier,
      (select count(*)::int from runs
         where owner_id = ${user.id}
           and created_at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc'
      ) as used
  `;
  return allowanceFor({
    guest: user.guest,
    tier: row?.tier === "unlimited" ? "unlimited" : "member",
    used: row?.used ?? 0,
    now,
  });
}
