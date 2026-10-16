/**
 * CHARACTERS: the roster, a sheet, and what happened to each of them.
 */

import type postgres from "postgres";
import type { PlayerCharacter } from "../../rules/knave/character.ts";
import { db, doc } from "./connection.ts";
import type { RunStatus } from "./runs.ts";

// ---------------------------------------------------------------------------
// CHARACTERS
// ---------------------------------------------------------------------------

/**
 * What has happened to a character, counted from the runs it happened in.
 *
 * NOT STORED ANYWHERE. The four numbers are exactly the four terminal values of
 * `runs.status`, so there is nothing to record and nothing to keep in step — a
 * stored counter needs a write on every ending, that write can fail
 * independently of the ending it describes, and a counter that disagrees with
 * the rows it summarises is a scoreboard that lies.
 */
export interface CharacterRecord {
  dead: number;
  abandoned: number;
  escaped: number;
  goalMet: number;
}

/** The run a character is currently down in, as the roster needs to name it. */
export interface ActiveRun {
  id: string;
  dungeonId: string;
  dungeonName: string;
  turnCount: number;
}

/**
 * A character, plus everything about them that lives outside their sheet.
 *
 * The sheet is who they are; the record is what has happened to them; the active
 * run is where they are right now. Three lifetimes, and only the first is stored
 * on the character — which is why this shape exists rather than more columns.
 */
export interface CharacterEntry {
  sheet: PlayerCharacter;
  record: CharacterRecord;
  activeRun?: ActiveRun;
}

const NO_RECORD = (): CharacterRecord => ({ dead: 0, abandoned: 0, escaped: 0, goalMet: 0 });

/**
 * The characters screen, in three queries rather than one clever one.
 *
 * Stitched in TypeScript on purpose. The same thing as a single statement is a
 * pair of lateral joins over an aggregate, which is harder to read than the
 * three obvious selects and no faster at this size — a player has a handful of
 * characters, and both supporting queries hit an index whose leading column is
 * the owner.
 *
 * A CHARACTER WITH NO RUNS GETS ZEROES, not an absent record. The screen renders
 * the same row either way, and a caller should never have to ask whether a
 * missing count means none or means unknown.
 */
export async function listRoster(
  owner: string,
  sql: postgres.Sql = db()
): Promise<CharacterEntry[]> {
  const [sheets, counts, active] = await Promise.all([
    sql<{ id: string; sheet: PlayerCharacter }[]>`
      select id, sheet from characters where owner_id = ${owner} order by created_at asc
    `,
    sql<{ characterId: string; status: RunStatus; n: number }[]>`
      select character_id as "characterId", status, count(*)::int as n
        from runs
       where owner_id = ${owner} and character_id is not null and status <> 'active'
       group by character_id, status
    `,
    // The name comes from the dungeon's own document, which is where every other
    // reader of a dungeon's name gets it — see `listDungeons`. `turnCount` is
    // read out of the run's state rather than duplicated into a column, for the
    // same reason the counters are not stored.
    sql<{ characterId: string; id: string; dungeonId: string; dungeonName: string; turnCount: number }[]>`
      select r.character_id                                    as "characterId",
             r.id                                              as "id",
             r.dungeon_id                                      as "dungeonId",
             coalesce(d.doc -> 'pass' ->> 'name', 'Unnamed')   as "dungeonName",
             coalesce((r.state ->> 'turnCount')::int, 0)       as "turnCount"
        from runs r join dungeons d on d.id = r.dungeon_id
       where r.owner_id = ${owner} and r.status = 'active' and r.character_id is not null
    `,
  ]);

  const records = new Map<string, CharacterRecord>();
  for (const row of counts) {
    const record = records.get(row.characterId) ?? NO_RECORD();
    if (row.status === "goal_met") record.goalMet = row.n;
    else if (row.status !== "active") record[row.status] = row.n;
    records.set(row.characterId, record);
  }

  const runs = new Map(active.map((r) => [r.characterId, r]));

  return sheets.map(({ id, sheet }) => {
    const run = runs.get(id);
    return {
      sheet,
      record: records.get(id) ?? NO_RECORD(),
      ...(run
        ? {
            activeRun: {
              id: run.id,
              dungeonId: run.dungeonId,
              dungeonName: run.dungeonName,
              turnCount: run.turnCount,
            },
          }
        : {}),
    };
  });
}

/**
 * The run this character is in, or nothing.
 *
 * Asked before a new run is created and before a character is deleted. NOT the
 * enforcement — the partial unique index is, and a check here could always lose
 * a race with a second request. This is what turns the violation the index
 * raises into an answer that names the run, which is the thing the player needs
 * in order to do anything about it.
 */
export async function activeRunFor(
  characterId: string,
  owner: string,
  sql: postgres.Sql = db()
): Promise<{ id: string; dungeonId: string } | undefined> {
  const [row] = await sql<{ id: string; dungeonId: string }[]>`
    select id, dungeon_id as "dungeonId" from runs
     where owner_id = ${owner} and character_id = ${characterId} and status = 'active'
  `;
  return row;
}

export async function getCharacter(
  id: string,
  owner: string,
  sql: postgres.Sql = db()
): Promise<PlayerCharacter | undefined> {
  const [row] = await sql<{ sheet: PlayerCharacter }[]>`
    select sheet from characters where id = ${id} and owner_id = ${owner}
  `;
  return row?.sheet;
}

/**
 * Insert or replace, keyed on the sheet's own id.
 *
 * The character carries its id — it was made in the browser and has been in a
 * run under that name — so the row takes it rather than minting another.
 *
 * `and owner_id = ${owner}` ON THE UPDATE BRANCH is what stops one player
 * overwriting another's sheet by posting a character carrying their id. Without
 * it the `on conflict` would happily update a row it does not own, which is the
 * one way an upsert can leak where a plain insert cannot. An attempt to do so
 * now updates nothing and reports it, rather than silently succeeding.
 */
export async function saveCharacter(
  pc: PlayerCharacter,
  owner: string,
  sql: postgres.Sql = db()
): Promise<PlayerCharacter> {
  const rows = await sql`
    insert into characters (id, owner_id, sheet)
    values (${pc.id}, ${owner}, ${doc(sql, pc)})
    on conflict (id) do update
       set sheet = excluded.sheet, updated_at = now()
     where characters.owner_id = ${owner}
    returning id
  `;
  if (rows.length === 0) throw new Error(`not yours to save: ${pc.id}`);
  return pc;
}

/**
 * WHAT A CHARACTER BRINGS BACK UP.
 *
 * Called only when a run ended with the player alive and out — `escaped` or
 * `goal_met`. The run's own `pc` has been diverging from the sheet since the
 * first turn (gear picked up, coin spent, armour worn down) and on a successful
 * ending it becomes the sheet. Same id, so the Phase 11 upsert lands on the same
 * row.
 *
 * DEATH AND ABANDONMENT WRITE NOTHING, which is how "the character as they were
 * before the run" is achieved: nothing touches `characters.sheet` during a run,
 * so the stored sheet is still the pre-run one and there is no snapshot to take
 * and no restore to perform. The only trace either leaves is a row in `runs`,
 * which is what the counters read.
 *
 * THE RUN'S XP LANDS HERE TOO, and for the same reason the gear does: this is
 * the one function that turns a run's character into the roster's character, so
 * it is the one place a survivor's earnings can be added without a second write
 * that could fail on its own. A death or an abandonment never calls it, which is
 * exactly the rule — `shouldTally` refuses to score either, so there would be
 * nothing to add even if it did.
 *
 * HIT POINTS RETURN TO MAX, and that is a decision rather than a consequence.
 * There is no downtime, no rest and no healing outside a run, so a character who
 * surfaces at 1/15 can only die next time — which quietly turns "escaped alive"
 * into a delayed death and makes the ending worthless.
 *
 * ── IF WOUNDS SHOULD CARRY, THIS IS THE WHOLE CHANGE ───────────────────────
 *
 * The line below is the only thing standing between a survivor and the hit
 * points they climbed out on. To keep the damage:
 *
 *     return pc;                       // and delete the spread above
 *
 * That is the code. What it needs BESIDE it is the reason this was not done in
 * the first place — some way back to full, or the ending stops meaning
 * anything. Any one of these would do, cheapest first:
 *
 *   - a flat heal between runs that is less than everything (half the missing,
 *     a die, a point per level), so a bad run costs the next one something
 *     without ending it;
 *   - rest as a real action with a real cost — rations, a light clock, a
 *     wandering-monster roll — which is where Knave already points and which
 *     `turnCount` was put in `RunState` for (BUILD-PLAN §6, Phase 2);
 *   - healing bought in the shop, which is the other half of Phase 5's
 *     equipment step and is still open (CODING-PLAN §3.6).
 *
 * Whichever one lands, this function is where it goes, and `ownership.dbtest.ts`
 * — "keeps what they carried, and heals them, when they got out alive" — is the
 * test that has to change with it.
 * ───────────────────────────────────────────────────────────────────────────
 */
export function carriedOut(pc: PlayerCharacter, earned = 0): PlayerCharacter {
  return { ...pc, hp: { ...pc.hp, current: pc.hp.max }, xp: (pc.xp ?? 0) + earned };
}

export async function deleteCharacter(
  id: string,
  owner: string,
  sql: postgres.Sql = db()
): Promise<boolean> {
  const rows = await sql`
    delete from characters where id = ${id} and owner_id = ${owner} returning id
  `;
  return rows.length > 0;
}
