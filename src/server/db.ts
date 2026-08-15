/**
 * THE CONNECTION
 * ==============
 *
 * One pool, made once per process, over Supabase's Supavisor pooler.
 *
 * WHY THE POOLER AND NOT THE DATABASE DIRECTLY. Postgres charges real memory
 * for every connection and tops out in the low hundreds; a serverless platform
 * answers a burst of requests by starting a burst of instances, each of which
 * would open its own. Supavisor sits in front and multiplexes them, so a
 * hundred cold starts are a handful of backend connections. Port 6543 is
 * transaction mode — a connection is handed back at the end of each
 * transaction rather than held for the life of the client, which is the mode
 * that matches a request-shaped workload.
 *
 * TRANSACTION MODE FORBIDS PREPARED STATEMENTS. A prepared statement lives on
 * the backend connection, and in transaction mode the next query may land on a
 * different one — so `prepare: false` is not a tuning knob, it is the thing
 * that stops "prepared statement s1 already exists" showing up under load and
 * never in development. postgres.js prepares by default.
 *
 * ONE POOL PER PROCESS, module-level, and that is deliberate — the opposite of
 * the rule the store and the journal follow. Those hold per-run state and a
 * singleton would let two runs see each other. A pool holds no run state at
 * all; it is a socket cache, and making one per request would spend a TCP and
 * TLS handshake on every turn.
 *
 * Node only. Nothing under `src/runtime` or `src/store` may import this.
 */

import postgres from "postgres";

let sql: postgres.Sql | undefined;

/**
 * The connection string, from the environment.
 *
 * Named rather than assembled, because the pooler's host, port and username
 * form are Supabase's to change and a template here would be a thing to get
 * subtly wrong. Supabase dashboard → Project Settings → Database → Connection
 * string → **Transaction pooler**.
 */
function connectionString(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. Copy the TRANSACTION POOLER connection string " +
        "from the Supabase dashboard (Project Settings → Database) into .env.local."
    );
  }
  if (!url.includes(":6543")) {
    // Session mode works and then falls over the first time two requests
    // overlap on a cold platform, which is the worst possible time to find out.
    console.warn(
      "[db] DATABASE_URL is not on port 6543. Serverless wants the transaction pooler."
    );
  }
  return url;
}

export function db(): postgres.Sql {
  return (sql ??= postgres(connectionString(), {
    // See the header: transaction mode hands out a different backend
    // connection per transaction, and a prepared statement belongs to one.
    prepare: false,
    // A request that cannot reach the database should fail while somebody is
    // still waiting on it, not hold an invocation open to its timeout.
    connect_timeout: 10,
    idle_timeout: 20,
    // Each instance serves one request at a time and the pooler is the thing
    // doing the real pooling, so a large local pool buys nothing and costs
    // handshakes.
    max: 4,
    onnotice: () => {},
  }));
}

/** For tests and the CLI: let the process exit without waiting on sockets. */
export async function closeDb(): Promise<void> {
  if (!sql) return;
  const closing = sql;
  sql = undefined;
  await closing.end({ timeout: 5 });
}
