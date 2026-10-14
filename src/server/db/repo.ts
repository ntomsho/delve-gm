/**
 * THE DATABASE, AS FUNCTIONS
 * ==========================
 *
 * Every statement the server runs, in one place. Handlers above this file ask
 * for things; nothing above this file writes SQL.
 *
 * Two keyspaces, the same split `src/gameplay/state/persist.ts` has always made: a
 * dungeon is large and written twice — once partial, once complete — and a run
 * is small and written on every turn.
 *
 * THE ONE THING WORTH READING BEFORE THE REST is `commitTurn`. It is the write
 * that has to be correct under two requests at once, and everything it does is
 * one transaction on purpose. See the note above it.
 *
 * Node only.
 */

import { createHash } from "node:crypto";
import type postgres from "postgres";
import { db } from "./connection.ts";
import type { GeneratedDungeon, ChunkResult } from "../../generation/generate.ts";
import type { RunState } from "../../gameplay/state/store.ts";
import type { JournalRecord, Sink } from "../../journal/journal.ts";
import type { Stage } from "../../shared/types/turn.ts";
import type { PlayerCharacter } from "../../rules/knave/character.ts";

/**
 * A document, on its way into a jsonb column.
 *
 * postgres.js types `sql.json` against its own JSON value union, which nothing
 * declared with an interface satisfies structurally. The cast is here, once and
 * named, rather than at each of the six call sites — everything passed through
 * it is a plain serialisable document and has always been (see the note on
 * `GeneratedDungeon`, which has been going in and out of IndexedDB since
 * Phase 2).
 */
const doc = (sql: postgres.Sql | postgres.TransactionSql, value: unknown) =>
  sql.json(value as never);

/** What a row's `status` says, which is `stage` with the detail thrown away. */
export type RunStatus = "active" | "dead" | "escaped" | "goal_met" | "abandoned";

/**
 * A run's status, from the stage it is standing in.
 *
 * `departed` is deliberately absent: the store resolves it into `escaped` or
 * `goal_met` the moment a commit lands — which ending a departure was depends
 * on world state rather than on what the game master remembered — so it can never
 * be what is persisted. See `endingOf` in gameplay/state/store.ts.
 */
export function statusOf(stage: Stage): RunStatus {
  if (stage === "dead" || stage === "escaped" || stage === "goal_met") return stage;
  if (stage === "abandoned") return "abandoned";
  return "active";
}

/** The endings a character's record counts. `active` is not one of them. */
export const ENDED: readonly RunStatus[] = ["dead", "abandoned", "escaped", "goal_met"];

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

// ---------------------------------------------------------------------------
// DUNGEONS
// ---------------------------------------------------------------------------

/**
 * A dungeon row.
 *
 * TWO IDS, AND THEY ARE NOT THE SAME THING — the Phase 11 correction. `id`
 * names the ROW and is a meaningless uuid. `dungeonKey` is
 * `dungeon_<seed in base 36>`, derived by the engine
 * (`blueprint.ts:786`), carried inside `doc.id`, and deliberately NOT
 * unique: a seed names a WORLD, and two players may each hold their own copy of
 * one. Phase 10a used the derived name as the primary key, which was fine while
 * there was one copy of each seed and broke the moment there could be two.
 *
 * Everything outside this file addresses a dungeon by the ROW id. `doc.id` is
 * the engine's business and is left exactly as generated.
 */
export interface StoredDungeon {
  id: string;
  dungeonKey: string;
  ownerId: string;
  status: "partial" | "complete";
  doc: GeneratedDungeon;
  /** the `plates` key of its cover; null for a dungeon finished before covers existed */
  cover: string | null;
}

/**
 * What someone who does not own a dungeon may know about it.
 *
 * Never `doc`. The document is the whole world — every room's prose, every
 * creature, where the goal is — so handing it over is handing over the answers
 * to a dungeon they have not walked. This is the shape a browse-and-duplicate
 * screen reads, and it is deliberately the only cross-owner read there is.
 */
export interface DungeonSummary {
  id: string;
  name: string;
  objective: string;
  size: number;
  level: number;
  seed: number;
  status: "partial" | "complete";
  createdAt: string;
  /**
   * The cover's object path in the `plates` bucket, once it is drawn. The API
   * turns it into a URL (`illustrationUrl`) before it leaves the server.
   */
  coverPath?: string | null;
}

/**
 * The structure pass, stored, and the row id it was given.
 *
 * Returns the ROW id, which is what every later request names. The caller must
 * not assume it can reconstruct this from the seed — that assumption is exactly
 * what the key split removed.
 */
export async function insertPartialDungeon(
  gd: GeneratedDungeon,
  owner: string,
  sql: postgres.Sql = db()
): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into dungeons (dungeon_key, owner_id, seed, size, level, status, doc)
    values (${gd.id}, ${owner}, ${gd.seeds.dungeonSeed}, ${gd.size}, ${gd.level},
            'partial', ${doc(sql, gd)})
    returning id
  `;
  return row.id;
}

/**
 * This player's unfinished dungeon from these dice, if they have one.
 *
 * What makes "try seed N again" reuse a failed writing rather than start a
 * second one, which would also count against the day's allowance a second
 * time. Copies are never partial, but the filter says so anyway.
 */
export async function findUnfinishedDungeon(
  owner: string,
  dice: { seed: number; size: number; level: number },
  sql: postgres.Sql = db()
): Promise<StoredDungeon | undefined> {
  const [row] = await sql<StoredDungeon[]>`
    select id, dungeon_key as "dungeonKey", owner_id as "ownerId", status, doc, cover
      from dungeons
     where owner_id = ${owner} and status = 'partial' and copied_from is null
       and seed = ${dice.seed} and size = ${dice.size} and level = ${dice.level}
     order by created_at desc
     limit 1
  `;
  return row;
}

/**
 * A dungeon, in full, for the player who owns it.
 *
 * OWNER IN THE WHERE CLAUSE, not an `if` after the read: someone else's dungeon
 * is indistinguishable from one that does not exist, so the API never confirms
 * that a row it will not serve is there.
 */
export async function getDungeon(
  id: string,
  owner: string,
  sql: postgres.Sql = db()
): Promise<StoredDungeon | undefined> {
  const [row] = await sql<StoredDungeon[]>`
    select id, dungeon_key as "dungeonKey", owner_id as "ownerId", status, doc, cover
      from dungeons where id = ${id} and owner_id = ${owner}
  `;
  return row;
}

/** The player's own worlds, newest first. Summaries — nobody needs six `doc`s. */
export async function listDungeons(
  owner: string,
  sql: postgres.Sql = db()
): Promise<DungeonSummary[]> {
  return sql<DungeonSummary[]>`
    select id,
           coalesce(doc -> 'pass' ->> 'name', 'Unnamed')            as name,
           coalesce(doc -> 'pass' -> 'goal' ->> 'summary', '')      as objective,
           size, level, seed, d.status,
           d.created_at as "createdAt",
           p.path as "coverPath"
      from dungeons d
      left join plates p on p.key = d.cover and p.status = 'ready'
     where owner_id = ${owner}
     order by d.created_at desc
  `;
}

/**
 * The finished world, written over the partial.
 *
 * `where status = 'partial'` so a second `finish` — a retried request, a client
 * that fired twice — cannot overwrite a complete dungeon with one built from
 * responses that may since have been added to. Returns whether it was this call
 * that completed it.
 *
 * Takes the ROW id explicitly, because `gd.id` is the engine's derived name and
 * is no longer the key. Passing `gd` alone would compile and address the wrong
 * column forever.
 */
export async function completeDungeon(
  id: string,
  gd: GeneratedDungeon,
  owner: string,
  sql: postgres.Sql = db()
): Promise<boolean> {
  const rows = await sql`
    update dungeons
       set doc = ${doc(sql, gd)}, status = 'complete', updated_at = now()
     where id = ${id} and owner_id = ${owner} and status = 'partial'
    returning id
  `;
  return rows.length > 0;
}

/**
 * A BATCH OF THE LIBRARY, and the place to carry on from.
 *
 * `cursor` IS OPAQUE AND IS THE SERVER'S. It is handed out and handed back
 * unread — the same reasoning `commitTurn` gives for a version being an integer:
 * a client that can compose a cursor can compose a flattering one, and there is
 * no value here more favourable than another only because nothing outside this
 * file knows what is in it. Absent means the end of the shelf.
 */
export interface LibraryPage {
  dungeons: DungeonSummary[];
  cursor?: string;
}

/** How many worlds a batch is, and the most one request may ask for. */
const LIBRARY_BATCH = 12;
const LIBRARY_MAX = 48;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A cursor, or nothing — and **validated here rather than by Postgres**.
 *
 * 🔴 THIS IS A REFUSAL, NOT TIDINESS. A cursor arrives from a query string, so
 * it is whatever a caller typed. Handed on unchecked, `?cursor=x|y` binds `x` to
 * a `timestamptz` parameter and **the driver throws while serialising it**
 * (`RangeError: Invalid time value`, inside postgres.js, before the statement is
 * sent) — which the API renders as a 500. A malformed page token is not an
 * internal error; it is a caller saying nothing legible, and the honest answer
 * is the front of the shelf. Found by `ownership.dbtest.ts`.
 *
 * Split on the FIRST separator: a `timestamptz::text` holds no `|` and a uuid
 * holds none, so anything with a different shape is not a cursor this file made.
 */
function readCursor(cursor?: string): { at: string; id: string } | undefined {
  if (!cursor) return undefined;
  const cut = cursor.indexOf("|");
  if (cut <= 0) return undefined;

  const at = cursor.slice(0, cut);
  const id = cursor.slice(cut + 1);
  if (!UUID.test(id) || Number.isNaN(Date.parse(at))) return undefined;
  return { at, id };
}

/**
 * EVERY COMPLETE WORLD SOMEBODY ELSE MADE, newest first, a batch at a time.
 *
 * The second of the two cross-owner reads, and it obeys the same rule as
 * `duplicateDungeon`: what crosses the line is a SUMMARY. Never `doc`, which is
 * every answer in the world — browsing must not be a way to read a dungeon you
 * have not walked. `DungeonSummary` has been the shape of that promise since
 * Phase 11 with nothing to serve it; this is what it was for.
 *
 * NO MAKER ATTRIBUTION, deliberately. The only name this project holds for an
 * account is `profiles.email`, and a browse screen that printed it would be a
 * way to enumerate the invite list. A world is offered on what it is, not on
 * whose it was.
 *
 * KEYSET AND NOT OFFSET. A batch boundary has to survive a dungeon being written
 * while the player is scrolling: `offset 12` after an insert shows row 12 twice
 * and never shows row 13. `(created_at, id) < (…)` is anchored to the last row
 * actually seen, so an insert above the cursor changes nothing below it. The id
 * is in the comparison because `created_at` is the transaction clock and two
 * rows can share it exactly — see the migration.
 *
 * THE CURSOR IS BUILT IN SQL, not from the row in TypeScript. `timestamptz` is a
 * `Date` by the time the driver is done with it, and formatting one back to
 * something Postgres reads identically is a round trip through two libraries'
 * opinions about microseconds. `created_at::text` round-trips with itself.
 */
export async function listLibrary(
  viewer: string,
  opts: { cursor?: string; limit?: number } = {},
  sql: postgres.Sql = db()
): Promise<LibraryPage> {
  // A stated limit is clamped; an unstated or unreadable one is the default.
  // Not `|| LIBRARY_BATCH` as a NaN guard, which also swallows a stated 0 and
  // turns the smallest possible ask into the largest — found by the dbtest.
  const asked = Math.trunc(Number(opts.limit));
  const limit = Number.isFinite(asked) ? Math.min(Math.max(asked, 1), LIBRARY_MAX) : LIBRARY_BATCH;

  const at = readCursor(opts.cursor);

  // One more than asked for, which is how the end of the shelf is known without
  // a second `count(*)` over the whole table.
  const rows = await sql<(DungeonSummary & { cursor: string })[]>`
    select id,
           coalesce(doc -> 'pass' ->> 'name', 'Unnamed')            as name,
           coalesce(doc -> 'pass' -> 'goal' ->> 'summary', '')      as objective,
           size, level, seed, d.status,
           d.created_at                                            as "createdAt",
           d.created_at::text || '|' || d.id::text                 as "cursor",
           p.path                                                  as "coverPath"
      from dungeons d
      left join plates p on p.key = d.cover and p.status = 'ready'
     where d.status = 'complete'
       and owner_id <> ${viewer}
       ${
         at
           ? /*
              * 🔴 `::text::timestamptz` AND NOT `::timestamptz`, AND THE EXTRA
              * CAST IS LOAD-BEARING.
              *
              * With the direct cast the server describes this parameter as
              * `timestamptz`, so postgres.js serialises the string through its
              * Date encoder — and a JS `Date` holds MILLISECONDS. A cursor of
              * `…:22.123456+00` is bound as `…:22.123+00`, which is strictly
              * LESS than the row it was taken from, so `<` skips every row
              * sharing that microsecond. The page silently loses rows, and it
              * loses exactly the ones a `created_at` tie put at the break —
              * the case this keyset was designed around.
              *
              * Casting to `text` first makes the parameter a text parameter,
              * which postgres.js passes through untouched, and Postgres does
              * the conversion itself. `created_at::text` round-trips with
              * `text::timestamptz` exactly. Found by `ownership.dbtest.ts`.
              */
             sql`and (d.created_at, d.id) < (${at.at}::text::timestamptz, ${at.id}::text::uuid)`
           : sql``
       }
     order by d.created_at desc, d.id desc
     limit ${limit + 1}
  `;

  const more = rows.length > limit;
  const page = rows.slice(0, limit);
  return {
    // The cursor is stripped: it is this function's bookkeeping, and the last
    // row's is the only one anybody needs.
    dungeons: page.map(({ cursor: _cursor, ...summary }) => summary),
    ...(more && page.length > 0 ? { cursor: page[page.length - 1]!.cursor } : {}),
  };
}

/**
 * TAKE A COPY OF A WORLD — the one statement in this file that reads a row
 * without asking whose it is.
 *
 * Every other read here puts the owner in the `where`, and that rule is not
 * being bent: what this reads cross-owner is the ROW, and what it does with it
 * is write a new one belonging to the caller. Nothing about the source is ever
 * returned. A dungeon is the one thing another player may see (§8.1), and this
 * is the whole of what "see" means — a copy of your own, not a look at theirs.
 *
 * WHAT COMES ACROSS, and what does not:
 *
 *   - the row and its `doc`, under a fresh uuid. The `doc` keeps its own
 *     engine-derived `id` untouched, exactly as `insertPartialDungeon` leaves
 *     it: that is the name of the WORLD and both copies are that world.
 *   - `dungeon_events`, because a run's journal is generation followed by play
 *     (`readJournal`) and a copy without them yields a transcript that starts
 *     mid-air. It is also where the `kind: "dungeon"` baseline lives, which is
 *     what `journal/render.ts` prints when someone wants to judge the writing.
 *   - NOT `generation_chunks`. Only `finish` reads those, a complete dungeon
 *     never finishes again, and they are the unapplied raw responses — the
 *     largest thing in the schema and the least use to anybody holding the
 *     applied world.
 *
 * COMPLETE ONLY. Half a world is not worth copying, and `finish` on the copy
 * would have no chunks to finish from.
 *
 * `undefined` means no such complete dungeon — one answer for "not there" and
 * "still being written", because a caller who may not have it either way should
 * not learn which.
 */
export async function duplicateDungeon(
  sourceId: string,
  owner: string,
  sql: postgres.Sql = db()
): Promise<{ id: string; already: boolean } | undefined> {
  return sql.begin(async (tx) => {
    const [source] = await tx<{ id: string }[]>`
      select id from dungeons where id = ${sourceId} and status = 'complete'
    `;
    if (!source) return undefined;

    // THE SECOND CLICK. Matched on the source row and not on `dungeon_key`,
    // which would answer a different question: a seed fixes the structure and
    // the stocking, but the prose is model output, so "you already have a
    // seed-4201 dungeon" is not an answer to "may I have THAT one". See the
    // migration.
    const [mine] = await tx<{ id: string }[]>`
      select id from dungeons where owner_id = ${owner} and copied_from = ${sourceId}
    `;
    if (mine) return { id: mine.id, already: true };

    const [copy] = await tx<{ id: string }[]>`
      insert into dungeons (dungeon_key, owner_id, seed, size, level, status, doc, copied_from, cover)
      select dungeon_key, ${owner}, seed, size, level, status, doc, id, cover
        from dungeons where id = ${sourceId}
      returning id
    `;

    // One statement, in the same transaction as the row. A copy that exists
    // without its journal is a dungeon whose transcript begins after it was
    // built, and there would be nothing to tell you that had happened.
    await tx`
      insert into dungeon_events (dungeon_id, seq, at, kind, payload)
      select ${copy.id}::uuid, seq, at, kind, payload
        from dungeon_events where dungeon_id = ${sourceId}
    `;

    return { id: copy.id, already: false };
  }) as Promise<{ id: string; already: boolean } | undefined>;
}

// ---------------------------------------------------------------------------
// GENERATION CHUNKS
// ---------------------------------------------------------------------------

/**
 * One region's answer, unapplied.
 *
 * `on conflict do nothing` rather than `do update`: the regions are called in
 * parallel from separate requests, and a chunk that arrives twice is a retry of
 * a call whose answer already landed. Keeping the first is what makes the
 * request idempotent — and it has to be, because the client fires N of these
 * and any one of them can be retried by anything between here and the browser.
 */
export async function saveChunk(
  dungeonId: string,
  result: ChunkResult,
  sql: postgres.Sql = db()
): Promise<void> {
  await sql`
    insert into generation_chunks (dungeon_id, chunk, response)
    values (${dungeonId}, ${result.chunk}, ${doc(sql, result)})
    on conflict (dungeon_id, chunk) do nothing
  `;
}

export async function listChunks(
  dungeonId: string,
  sql: postgres.Sql = db()
): Promise<ChunkResult[]> {
  const rows = await sql<{ response: ChunkResult }[]>`
    select response from generation_chunks
     where dungeon_id = ${dungeonId}
     order by chunk asc
  `;
  return rows.map((r) => r.response);
}

// ---------------------------------------------------------------------------
// PROMPT BLOCKS
// ---------------------------------------------------------------------------

/**
 * THE PLAYBOOK IS STORED ONCE, NOT ONCE PER CALL.
 *
 * A `system` event carries the standing instructions a game master call was made
 * under — `SKILL.md`, the dungeon's fiction, the step files — and `journal.ts`
 * intends to write them once per step per run. On a server that intent does not
 * survive: the "already written" set lives on the journal, the journal is made
 * per session, and a session is made per REQUEST. So every game master call wrote
 * the whole playbook again, and two thirds of a measured run's journal was three
 * copies of the same three blocks.
 *
 * THIS IS THE FIX AND IT IS DELIBERATELY NOT IN THE RUNTIME. `journal.ts` goes
 * on logging whole blocks, because that is right for the file sink and for a
 * browser with no database behind it; what changes is what the SERVER does on
 * the way to a column. Where a thing is stored is a storage question, and
 * the gameplay code stays unaware there is a database at all.
 *
 * See `supabase/migrations/20260818120000_prompt_blocks.sql`.
 */
interface PromptBlock {
  sha: string;
  chars: number;
  text: string;
}

/**
 * A block's name, and the only thing that decides whether two blocks are one.
 *
 * Hashed HERE rather than in Postgres, so the id exists before the statement is
 * composed — which is what lets the blocks and the events that reference them go
 * in as two ordinary inserts instead of a round trip that asks the database what
 * it would call this.
 */
const shaOf = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/**
 * Events on their way to a column, with each `system` block's text replaced by
 * the sha that names it — and the blocks themselves, to be written first.
 *
 * `chars` rides along beside the sha. It is redundant against `prompt_blocks`
 * and worth its twenty bytes: it is what makes the compact form READABLE on its
 * own, so a journal pulled straight out of the table still says how much prose
 * each call carried without a join to find out.
 *
 * Everything that is not a `system` event passes through untouched. The other
 * repeated payloads — a `generation` prompt, the `dungeon` baseline — are real
 * duplication too and are left alone on purpose: they are one write per dungeon
 * rather than one per turn, so they do not grow with play, and each would want
 * its own decision about what "the same" means.
 */
function dehydrate(events: readonly JournalRecord[]): {
  payloads: string[];
  blocks: PromptBlock[];
} {
  const blocks = new Map<string, PromptBlock>();

  const payloads = events.map((e) => {
    if (e.kind !== "system") return JSON.stringify(e);

    // `cache_control` and anything else on a block is carried across as it
    // stands — only `text` is lifted out. A block that comes back must be the
    // block that went in, or `journal.jsonl` stops being evidence.
    const slim = e.blocks.map(({ text, ...rest }) => {
      const sha = shaOf(text);
      if (!blocks.has(sha)) blocks.set(sha, { sha, chars: text.length, text });
      return { ...rest, sha, chars: text.length };
    });

    return JSON.stringify({ ...e, blocks: slim });
  });

  return { payloads, blocks: [...blocks.values()] };
}

/**
 * The blocks an event batch referred to, inserted before the events that refer
 * to them.
 *
 * `on conflict do nothing` is the normal case rather than the exception — after
 * the first run in the life of the database, almost every block written here is
 * already there. The insert is still worth making: deciding whether to would
 * cost the round trip it saves.
 */
async function saveBlocks(
  sql: postgres.Sql | postgres.TransactionSql,
  blocks: readonly PromptBlock[]
): Promise<void> {
  if (blocks.length === 0) return;
  await sql`
    insert into prompt_blocks (sha, chars, text)
    select s.sha, s.chars, s.text
      from unnest(${blocks.map((b) => b.sha)}::text[],
                  ${blocks.map((b) => b.chars)}::int[],
                  ${blocks.map((b) => b.text)}::text[])
        as s(sha, chars, text)
    on conflict (sha) do nothing
  `;
}

// ---------------------------------------------------------------------------

/**
 * What generation wrote down, which belongs to the dungeon rather than to any
 * run — see the migration. Written once, read by every run down this dungeon.
 */
export async function appendDungeonEvents(
  dungeonId: string,
  events: readonly JournalRecord[],
  sql: postgres.Sql = db()
): Promise<void> {
  if (events.length === 0) return;

  // BLOCKS FIRST, and no transaction around the pair. If the second statement
  // fails, the blocks are orphaned — content-addressed, deduplicated, and a few
  // kB that the next write of the same text reuses. The other order would leave
  // an event naming a block that is not there, which is a journal that has
  // silently lost a prompt. Cheap wrong way round, expensive right way round.
  const { payloads, blocks } = dehydrate(events);
  await saveBlocks(sql, blocks);

  await sql`
    insert into dungeon_events (dungeon_id, seq, at, kind, payload)
    select ${dungeonId}::uuid, s.seq, s.at::timestamptz, s.kind, s.payload::jsonb
      from unnest(${events.map((e) => e.seq)}::int[],
                  ${events.map((e) => e.at)}::text[],
                  ${events.map((e) => e.kind)}::text[],
                  ${payloads}::text[])
        as s(seq, at, kind, payload)
    on conflict (dungeon_id, seq) do nothing
  `;
}

/**
 * Generation's own sequence, so three requests write one ordered stream rather
 * than three that each start at 1. Same reasoning as `lastSeq`.
 */
export async function lastDungeonSeq(
  dungeonId: string,
  sql: postgres.Sql = db()
): Promise<number> {
  const [row] = await sql<{ seq: number }[]>`
    select coalesce(max(seq), 0)::int as seq from dungeon_events where dungeon_id = ${dungeonId}
  `;
  return row?.seq ?? 0;
}

export async function readDungeonEvents(
  dungeonId: string,
  sql: postgres.Sql = db()
): Promise<JournalRecord[]> {
  // WHOLE, as it was sent. The compact form is what the column holds and what
  // the Supabase SQL editor sees; every reader that goes through this file gets
  // the playbook put back, so `journal.jsonl` is byte-identical to one exported
  // before the blocks were split out. See `rehydrate_blocks` in the migration.
  const rows = await sql<{ payload: JournalRecord }[]>`
    select rehydrate_blocks(payload) as payload
      from dungeon_events where dungeon_id = ${dungeonId} order by seq asc
  `;
  return rows.map((r) => r.payload);
}

// ---------------------------------------------------------------------------
// RUNS
// ---------------------------------------------------------------------------

export interface StoredRun {
  id: string;
  dungeonId: string;
  characterId: string | null;
  state: RunState;
  version: number;
  status: RunStatus;
}

export interface RunSummary {
  id: string;
  dungeonId: string;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
}

export async function createRun(
  input: { dungeonId: string; characterId?: string; state: RunState; owner: string },
  sql: postgres.Sql = db()
): Promise<StoredRun> {
  const [row] = await sql<{ id: string; version: number }[]>`
    insert into runs (owner_id, dungeon_id, character_id, state, status)
    values (${input.owner}, ${input.dungeonId}, ${input.characterId ?? null},
            ${doc(sql, input.state)}, ${statusOf(input.state.stage)})
    returning id, version
  `;
  return {
    id: row.id,
    dungeonId: input.dungeonId,
    characterId: input.characterId ?? null,
    state: input.state,
    version: row.version,
    status: statusOf(input.state.stage),
  };
}

/**
 * A run, for the player whose run it is.
 *
 * THERE IS NO OTHER READ PATH. A run is two private things at once — our log
 * when something goes wrong, and the player's save file — and neither wants an
 * audience. Someone else's run 404s exactly as a missing one does.
 */
export async function getRun(
  id: string,
  owner: string,
  sql: postgres.Sql = db()
): Promise<StoredRun | undefined> {
  const [row] = await sql<StoredRun[]>`
    select id, dungeon_id as "dungeonId", character_id as "characterId",
           state, version, status
      from runs where id = ${id} and owner_id = ${owner}
  `;
  return row;
}

export async function listRuns(owner: string, sql: postgres.Sql = db()): Promise<RunSummary[]> {
  return sql<RunSummary[]>`
    select id, dungeon_id as "dungeonId", status,
           created_at as "createdAt", updated_at as "updatedAt"
      from runs where owner_id = ${owner} order by created_at desc
  `;
}

// ---------------------------------------------------------------------------
// THE LOCK
// ---------------------------------------------------------------------------

/**
 * Claim a run for the length of a turn.
 *
 * NOT A CORRECTNESS MECHANISM. `commitTurn` below already makes concurrent
 * turns safe by refusing to write against a version that has moved. This only
 * turns a duplicate away BEFORE it spends a whole game master conversation — two to
 * four model calls — on a turn that would be rejected at the write anyway. A
 * double-click should not cost tokens.
 *
 * An expiry rather than a boolean so a function that dies mid-turn — timeout,
 * crash, deploy — does not wedge the run until somebody notices.
 */
export async function lockRun(
  id: string,
  owner: string,
  holdSeconds = 300,
  sql: postgres.Sql = db()
): Promise<boolean> {
  const rows = await sql`
    update runs
       set locked_until = now() + make_interval(secs => ${holdSeconds})
     where id = ${id} and owner_id = ${owner}
       and (locked_until is null or locked_until < now())
    returning id
  `;
  return rows.length > 0;
}

export async function releaseRun(
  id: string,
  owner: string,
  sql: postgres.Sql = db()
): Promise<void> {
  await sql`update runs set locked_until = null where id = ${id} and owner_id = ${owner}`;
}

// ---------------------------------------------------------------------------
// THE JOURNAL
// ---------------------------------------------------------------------------

/**
 * How many events this run has already written.
 *
 * A session is built fresh per request and its journal counts from whatever it
 * is told — so this is what it is told. Without it the second request into a
 * run numbers its events 1, 2, 3 on top of the first request's and collides on
 * the primary key. See `createJournal`.
 */
export async function lastSeq(runId: string, sql: postgres.Sql = db()): Promise<number> {
  const [row] = await sql<{ seq: number }[]>`
    select coalesce(max(seq), 0)::int as seq from journal_events where run_id = ${runId}
  `;
  return row?.seq ?? 0;
}

/**
 * A run's journal, whole: how its world was built, then how it was played.
 *
 * Two streams concatenated, which is also the order they happened in. They are
 * numbered independently — generation's `seq` belongs to the dungeon, play's to
 * the run — so the pair is renumbered on the way out. Nothing downstream reads
 * `seq` as a key; it reads it as an order, and this is the order.
 */
export async function readJournal(
  runId: string,
  dungeonId: string,
  sql: postgres.Sql = db()
): Promise<JournalRecord[]> {
  const [built, played] = await Promise.all([
    readDungeonEvents(dungeonId, sql),
    sql<{ payload: JournalRecord }[]>`
      select rehydrate_blocks(payload) as payload
        from journal_events where run_id = ${runId} order by seq asc
    `.then((rows) => rows.map((r) => r.payload)),
  ]);
  return [...built, ...played].map((e, i) => ({ ...e, seq: i + 1 }));
}

/**
 * A sink that keeps what it is given.
 *
 * The server cannot write events as they happen: they have to land in the same
 * transaction as the state they describe, or a turn that is rejected at the
 * write leaves a journal describing a turn that never happened. So a request's
 * journal collects, and `commitTurn` decides whether any of it is real.
 */
export function collectingSink(): { sink: Sink; events: JournalRecord[] } {
  const events: JournalRecord[] = [];
  return { sink: { write: (r) => events.push(r) }, events };
}

// ---------------------------------------------------------------------------
// THE WRITE THAT HAS TO BE RIGHT
// ---------------------------------------------------------------------------

export type CommitResult =
  | { ok: true; version: number }
  /** The run moved on. `current` is what it actually says, for re-rendering. */
  | { ok: false; reason: "stale"; current: StoredRun }
  /**
   * The run is not this player's, or is not there at all — one answer, because
   * the API does not confirm the existence of things you may not have.
   *
   * `playTurn` reads the run under an owner filter long before reaching here, so
   * this should be unreachable in practice. It exists because the alternative
   * was what this branch used to do: look the run up AS THE CALLER, find
   * nothing, and throw "no such run" as a 500. A refusal is not an internal
   * error, and the last door in the system should refuse in the shape everything
   * else refuses in. Found by `ownership.dbtest.ts`.
   */
  | { ok: false; reason: "gone" };

/**
 * A finished turn: the new state, and the events that describe it, together.
 *
 * COMPARE-AND-SWAP. `where version = expected` is what makes two turns at once
 * safe. Both read version N; the first writes N+1; the second finds no row to
 * update and is told so. It covers the slow version of the same thing as well —
 * the second tab that has been open for ten minutes and still has a live Send
 * button, whose turn is not simultaneous with anything but is computed against
 * a world that has moved on.
 *
 * A VERSION AND NOT THE STAGE the client believes it is on. The client never
 * asserts anything about the rules here: an integer is opaque, so there is no
 * value that is more favourable than another, and a client cannot talk its way
 * into a roll by claiming to be at step 4.
 *
 * ONE TRANSACTION, and the journal rows are inside it. A rejected turn must
 * leave nothing at all — otherwise the journal, which is the thing the whole
 * database exists to keep, ends up describing a turn the state does not have.
 *
 * The lock is released here too, and unconditionally: the turn is over whether
 * or not it was accepted.
 */
export async function commitTurn(
  input: {
    runId: string;
    owner: string;
    expectedVersion: number;
    state: RunState;
    events: readonly JournalRecord[];
  },
  sql: postgres.Sql = db()
): Promise<CommitResult> {
  return sql.begin(async (tx) => {
    // `and owner_id` is belt AND braces, on purpose. The run was already read
    // under an owner filter before the turn was played, so reaching here with
    // someone else's run means a handler forgot a check — and the write is the
    // last place that can still refuse. A second lock on the same door costs
    // one clause.
    const rows = await tx<{ version: number }[]>`
      update runs
         set state = ${doc(tx, input.state)},
             status = ${statusOf(input.state.stage)},
             version = version + 1,
             locked_until = null,
             updated_at = now()
       where id = ${input.runId} and owner_id = ${input.owner}
         and version = ${input.expectedVersion}
      returning version
    `;

    if (rows.length === 0) {
      // THE LOCK STILL HAS TO COME OFF. The update above releases it, and the
      // update above is the one that did not match — so without this a turn
      // rejected as stale would leave the run held for the length of the lease
      // and every later turn would be told it was busy. Separate statement,
      // same transaction.
      await tx`
        update runs set locked_until = null
         where id = ${input.runId} and owner_id = ${input.owner}
      `;

      // Nothing else written, including no events. The caller gets the state as
      // it actually stands so a stale client can re-render rather than error.
      const current = await getRun(input.runId, input.owner, tx as unknown as postgres.Sql);
      if (!current) return { ok: false as const, reason: "gone" as const };
      return { ok: false as const, reason: "stale" as const, current };
    }

    await insertEvents(tx, input.runId, input.events);

    // THE CHARACTER COMES BACK UP IN THE SAME TRANSACTION AS THE RUN ENDING.
    // A sheet written afterwards, in a second statement, is a sheet that can
    // fail to be written after the run has already been recorded as survived —
    // and the player would have carried nothing out of a run the scoreboard says
    // they won. Either both or neither.
    const ending = statusOf(input.state.stage);
    if (ending === "escaped" || ending === "goal_met") {
      // UPDATE AND NOT UPSERT. `saveCharacter`'s insert branch would recreate a
      // character the player deleted while their run was still going, which is
      // a person walking back out of a grave. If the row is gone this writes
      // nothing, which is the honest answer.
      // The tally is on the state being written in this same transaction, so
      // the XP and the ending can never disagree about whether the run happened.
      const pc = carriedOut(input.state.pc, input.state.tally?.total ?? 0);
      await tx`
        update characters set sheet = ${doc(tx, pc)}, updated_at = now()
         where id = ${pc.id} and owner_id = ${input.owner}
      `;
    }

    return { ok: true as const, version: rows[0].version };
  }) as Promise<CommitResult>;
}

/**
 * Events in one statement rather than one per event.
 *
 * `unnest` over four parallel arrays, because a turn writes a dozen events and
 * a round trip each would be a dozen round trips inside a transaction holding a
 * pooled connection. The casts are explicit so nothing depends on the driver
 * inferring a type for an empty array.
 */
async function insertEvents(
  tx: postgres.TransactionSql,
  runId: string,
  events: readonly JournalRecord[]
): Promise<void> {
  if (events.length === 0) return;

  const seqs = events.map((e) => e.seq);
  const ats = events.map((e) => e.at);
  const kinds = events.map((e) => e.kind);

  // Inside the caller's transaction, so a turn that loses the compare-and-swap
  // takes its blocks down with it rather than leaving them behind. That is the
  // opposite of `appendDungeonEvents`, which has no transaction to join — the
  // difference is that there IS one here, not that orphans matter more.
  const { payloads, blocks } = dehydrate(events);
  await saveBlocks(tx, blocks);

  await tx`
    insert into journal_events (run_id, seq, at, kind, payload)
    select ${runId}::uuid, s.seq, s.at::timestamptz, s.kind, s.payload::jsonb
      from unnest(${seqs}::int[], ${ats}::text[], ${kinds}::text[], ${payloads}::text[])
        as s(seq, at, kind, payload)
    on conflict (run_id, seq) do nothing
  `;
}

/**
 * The first write of a run's journal — generation, and the room entry.
 *
 * Separate from `commitTurn` because there is no version to swap on yet: the
 * run has only just been created, nothing else can be holding it, and the state
 * that goes with these events was written by `createRun` a moment ago.
 */
export async function appendEvents(
  runId: string,
  events: readonly JournalRecord[],
  sql: postgres.Sql = db()
): Promise<void> {
  if (events.length === 0) return;
  await sql.begin((tx) => insertEvents(tx, runId, events));
}

// ---------------------------------------------------------------------------
// ILLUSTRATIONS
// ---------------------------------------------------------------------------

export interface IllustrationRow {
  key: string;
  status: "pending" | "ready" | "failed";
  path: string | null;
  attempts: number;
  /** milliseconds since the row last changed, by the database's clock */
  ageMs: number;
}

export async function getIllustration(key: string, sql: postgres.Sql = db()): Promise<IllustrationRow | undefined> {
  const [row] = await sql<IllustrationRow[]>`
    select key, status, path, attempts,
           (extract(epoch from now() - updated_at) * 1000)::int as "ageMs"
      from plates where key = ${key}
  `;
  return row;
}

/**
 * Take the job of drawing an illustration. True when this request is the one to draw it.
 *
 * ONE STATEMENT, so two runs entering the same room in the same instant cannot
 * both win: a new key is inserted as `pending`; an existing one is taken over
 * only when it failed and has attempts left, or when its `pending` claim is
 * older than `staleMs` — the request that made it died without saying so.
 */
export async function claimIllustration(
  key: string,
  model: string,
  opts: { staleMs: number; maxAttempts: number },
  sql: postgres.Sql = db()
): Promise<boolean> {
  const rows = await sql`
    insert into plates (key, status, model, attempts) values (${key}, 'pending', ${model}, 1)
    on conflict (key) do update
       set status = 'pending', model = excluded.model, attempts = illustrations.attempts + 1,
           error = null, updated_at = now()
     where (illustrations.status = 'failed' and illustrations.attempts < ${opts.maxAttempts})
        or (illustrations.status = 'pending' and illustrations.updated_at < now() - make_interval(secs => ${opts.staleMs / 1000}))
    returning key
  `;
  return rows.length > 0;
}

export async function finishIllustration(key: string, path: string, sql: postgres.Sql = db()): Promise<void> {
  await sql`update plates set status = 'ready', path = ${path}, updated_at = now() where key = ${key}`;
}

export async function failIllustration(key: string, error: string, sql: postgres.Sql = db()): Promise<void> {
  await sql`update plates set status = 'failed', error = ${error.slice(0, 2000)}, updated_at = now() where key = ${key}`;
}

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

/**
 * Name the cover a finished dungeon is to have. Written once, at `finish`; a
 * dungeon whose `cover` is null was finished before covers and never gets one.
 */
export async function setDungeonCover(id: string, key: string, sql: postgres.Sql = db()): Promise<void> {
  await sql`update dungeons set cover = ${key} where id = ${id} and cover is null`;
}
