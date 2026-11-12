/**
 * ILLUSTRATION WORDS: text a model wrote that many pictures share, kept so it
 * is written once. Today that is the setting line, one per dungeon theme
 * (`settingKey`). The table is still called `plate_words`.
 *
 * Pictures themselves, and what belongs to one picture, are in `assets.ts`.
 */

import type postgres from "postgres";
import { db } from "./connection.ts";

/** Shared words an illustration is drawn from — see `plate_words`. */
export async function getIllustrationWords(key: string, sql: postgres.Sql = db()): Promise<string | undefined> {
  const [row] = await sql<{ value: string }[]>`select value from plate_words where key = ${key}`;
  return row?.value;
}

/** The first answer is kept: a second illustration racing the first reads the winner's. */
export async function saveIllustrationWords(key: string, value: string, sql: postgres.Sql = db()): Promise<string> {
  await sql`insert into plate_words (key, value) values (${key}, ${value}) on conflict (key) do nothing`;
  return (await getIllustrationWords(key, sql)) ?? value;
}
