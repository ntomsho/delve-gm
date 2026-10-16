/**
 * A ROW, OR A 404, under an owner filter. Shared by every route that names a
 * run or a dungeon.
 */

import { HTTPException } from "hono/http-exception";
import * as repo from "../db/repo.ts";

/**
 * A dungeon, or a 404.
 *
 * OWNERSHIP IS AN ARGUMENT, NOT AN AFTERTHOUGHT. Both of these take the owner
 * and pass it into the `where`, so there is no arrangement of calls in which a
 * handler reads a row first and remembers to check it second. "Not yours" and
 * "not there" are one answer.
 */
export async function mustGetDungeon(id: string, owner: string) {
  const stored = await repo.getDungeon(id, owner);
  if (!stored) throw new HTTPException(404, { message: `no such dungeon: ${id}` });
  return stored;
}

/** A run, or a 404, by the same rule. */
export async function mustGetRun(id: string, owner: string) {
  const run = await repo.getRun(id, owner);
  if (!run) throw new HTTPException(404, { message: `no such run: ${id}` });
  return run;
}
