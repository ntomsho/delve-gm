/**
 * HOW MUCH ONE PERSON MAY SPEND IN A DAY
 * ======================================
 *
 * A cap per account (ROADMAP, *Running it for strangers*), so that one
 * person in a burst of visitors cannot use the day up. It is NOT what bounds the
 * bill — a guest account costs one click, so a determined script simply makes
 * more of them. A budget ceiling, still to build, is what bounds the bill; this only
 * shares out what the ceiling allows.
 *
 * ONE "RUN" IS EITHER OF TWO THINGS, and the author's rule is exactly this:
 *
 *   - writing a dungeon, together with the FIRST run into it. The writing is
 *     what is counted; the run that follows rides on it for free.
 *   - a run into a dungeon somebody already wrote: a copy from the library, or
 *     a second run down one of your own.
 *
 * So `used` = dungeons written today + runs started today that did not ride on
 * a writing. Both read straight off `dungeons` and `runs`; no counter table, so
 * nothing to keep in step. Deleting a character refunds nothing (`runs.
 * character_id` goes to null, the row stays), and an abandoned run counts.
 *
 * A FAILED WRITING IS NOT A SECOND ONE. The partial row it left counts, and
 * "try seed N again" reuses that row instead of making another (see
 * `POST /api/dungeons`), so a retry costs no extra run. A partial that is never
 * retried still counts: the structure call it made was paid for.
 *
 * Writing is size 1 only (`MAX_GENERATED_SIZE`) for now: a bigger world is
 * more writing calls and, more to the point, a longer and dearer run.
 *
 * THE DAY IS UTC. One clock for everybody, the same one the budget ceiling will
 * uses, and the reset time is sent to the client rather than computed there.
 *
 * `unlimited` (the author, and whoever they choose) is exempt from all of it —
 * the count, the generation gate and the size cap. It is not exempt from the
 * spend ceiling (`spend.ts`), which `closed` carries.
 *
 * KNOWN RACE, ACCEPTED. Two runs started in the same instant can both be
 * counted before either is written, and both go through. That is one extra run
 * for somebody racing their own account, which the spend ceiling covers.
 *
 * Node only.
 */

import type postgres from "postgres";
import { db } from "./db/connection.ts";
import type { AuthUser } from "./auth.ts";
import { gateFor, limitsFrom, spentToday } from "./spend.ts";

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
 * Mirrored in `src/api-client/allowance.ts`.
 */
export interface Allowance {
  guest: boolean;
  unlimited: boolean;
  /** Dungeons written plus runs that did not ride on one, since midnight UTC. */
  used: number;
  /** Runs allowed per day. `null` for unlimited. */
  limit: number | null;
  /** Runs still available today. `null` for unlimited. */
  left: number | null;
  /** The largest size this account may generate. */
  maxSize: number;
  /** ISO timestamp of the next midnight UTC, when `used` goes back to 0. */
  resetsAt: string;
  /**
   * The player's own written dungeons that nobody has run yet. The first run
   * into one of these rides on its writing, so it is free even at 0 left.
   */
  unplayed: string[];
  /**
   * The game has spent its money for today (`spend.ts`): nothing new may
   * start, whatever `left` says. True for an `unlimited` account only at the
   * ceiling.
   */
  closed: boolean;
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
  unplayed?: string[];
  closed?: boolean;
}): Allowance {
  const resetsAt = nextUtcMidnight(input.now).toISOString();
  const unplayed = input.unplayed ?? [];
  const closed = input.closed ?? false;
  if (input.tier === "unlimited") {
    return {
      guest: input.guest,
      unlimited: true,
      used: input.used,
      limit: null,
      left: null,
      maxSize: 5,
      resetsAt,
      unplayed,
      closed,
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
    unplayed,
    closed,
  };
}

/**
 * True when the account may write another dungeon, or start a run that costs one.
 * Not about money: a closed day is `closed`, checked beside this.
 */
export function hasRunLeft(a: Allowance): boolean {
  return a.left === null || a.left > 0;
}

/** True when a run into this dungeon may start: one left, or it rides on a writing. */
export function mayStartRunIn(a: Allowance, dungeonId: string): boolean {
  return hasRunLeft(a) || a.unplayed.includes(dungeonId);
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
 * Read the tier, today's count and the unplayed dungeons in one round trip, and
 * today's spend beside it.
 *
 * A missing profile is a member. `handle_new_user` makes one for every account,
 * so this only matters in the instant between an account existing and its
 * trigger committing — and the safe reading of "we do not know" is the limited
 * one.
 *
 * "Written" is `copied_from is null`: a copy from the library is a dungeon the
 * player did not pay to write. "Rode on a writing" is the earliest run in one
 * of the player's own written dungeons, ever — so a dungeon written at 23:59
 * and played at 00:01 is one run, on the first day.
 *
 * The day boundary is computed in Postgres, against the same clock that stamped
 * `created_at`, so the server and the database cannot disagree about which day
 * a run belongs to.
 */
export async function allowanceOf(
  user: AuthUser,
  sql: postgres.Sql = db(),
  now: Date = new Date()
): Promise<Allowance> {
  const [[row], spent] = await Promise.all([sql<{ tier: Tier | null; used: number; unplayed: string[] | null }[]>`
    with day as (
      select date_trunc('day', now() at time zone 'utc') at time zone 'utc' as start
    ),
    written as (
      select id, created_at from dungeons
       where owner_id = ${user.id} and copied_from is null
    ),
    rode as (
      select distinct on (r.dungeon_id) r.id
        from runs r join written w on w.id = r.dungeon_id
       order by r.dungeon_id, r.created_at, r.id
    )
    select
      (select tier from profiles where id = ${user.id}) as tier,
      (select count(*)::int from written, day where written.created_at >= day.start)
      + (select count(*)::int from runs, day
          where runs.owner_id = ${user.id}
            and runs.created_at >= day.start
            and runs.id not in (select id from rode)) as used,
      (select array_agg(d.id::text) from dungeons d
        where d.owner_id = ${user.id} and d.copied_from is null and d.status = 'complete'
          and not exists (select 1 from runs where runs.dungeon_id = d.id)) as unplayed
  `, spentToday(sql)]);
  const tier = row?.tier === "unlimited" ? "unlimited" : "member";
  const gate = gateFor({ spent, limits: limitsFrom(process.env), unlimited: tier === "unlimited" });
  return allowanceFor({
    guest: user.guest,
    tier,
    used: row?.used ?? 0,
    unplayed: row?.unplayed ?? [],
    now,
    closed: !gate.mayStart,
  });
}
