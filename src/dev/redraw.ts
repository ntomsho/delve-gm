/**
 * REDRAW: mark drawn pictures to be drawn again. Nothing else ever redraws one
 * (ARCHITECTURE §10.3): a prompt or style change reaches only pictures not yet
 * drawn until somebody runs this.
 *
 *   npm run redraw -- --kind room                      every room, everywhere
 *   npm run redraw -- --kind sprite --dungeon <id>     one dungeon's creatures
 *   npm run redraw -- --kind room --dungeon <id> --subject <room id>
 *   npm run redraw -- --kind cover --dungeon <id> --dry
 *
 *   --kind     room | sprite | cover (required, so "everything" is never a typo)
 *   --dungeon  a dungeon's row id; a copy's id means its original's art
 *   --subject  a room's id or a sprite id (`spriteKeyOf`); needs --dungeon
 *   --dry      count what would be marked, and mark nothing
 *
 * A marked picture keeps showing until the next request for it, which draws
 * the new one with whatever code is deployed then; a redraw that fails keeps
 * the old picture. Each one costs what a first drawing does, and counts
 * against the day's budget when it is drawn.
 *
 * Localhost and production share the database, so this marks production's
 * pictures too.
 */

import postgres from "postgres";
import { markForRedraw, type AssetKind } from "../server/db/assets.ts";

const KINDS: AssetKind[] = ["room", "sprite", "cover"];

function arg(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at > 0 ? process.argv[at + 1] : undefined;
}

const kind = arg("kind") as AssetKind | undefined;
const dungeonId = arg("dungeon");
const subject = arg("subject");
const dry = process.argv.includes("--dry");

if (!kind || !KINDS.includes(kind)) throw new Error(`--kind is required: one of ${KINDS.join(", ")}`);
if (subject !== undefined && !dungeonId) throw new Error("--subject needs --dungeon: a room id means nothing on its own");

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set. Run with `npm run redraw`.");
const sql = postgres(url, { prepare: false, max: 1, onnotice: () => {} });

try {
  let artRoot: string | undefined;
  if (dungeonId) {
    const [row] = await sql<{ artRoot: string }[]>`select coalesce(art_root, id) as "artRoot" from dungeons where id = ${dungeonId}`;
    if (!row) throw new Error(`no dungeon ${dungeonId}`);
    artRoot = row.artRoot;
    if (artRoot !== dungeonId) console.log(`${dungeonId} is a copy: marking its original's pictures (${artRoot})`);
  }
  const filter = { kind, ...(artRoot ? { artRoot } : {}), ...(subject !== undefined ? { subject } : {}) };
  if (dry) {
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from assets
       where status = 'ready' and kind = ${kind}
         ${artRoot ? sql`and art_root = ${artRoot}` : sql``}
         ${subject !== undefined ? sql`and subject = ${subject}` : sql``}
    `;
    console.log(`would mark ${n} ${kind} picture(s) for a redraw`);
  } else {
    const n = await markForRedraw(filter, sql);
    console.log(`marked ${n} ${kind} picture(s): each is drawn again the next time it is asked for`);
  }
} finally {
  await sql.end();
}
