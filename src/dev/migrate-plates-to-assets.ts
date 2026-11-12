/**
 * ONE-OFF: copy the pictures in the old hash-keyed `plates` store into `assets`.
 *
 *   node --env-file=.env.local src/dev/migrate-plates-to-assets.ts [--dry]
 *
 *   covers   every drawn cover a dungeon names (`dungeons.cover`), under the
 *            dungeon's art root;
 *   rooms    every drawn room a plate says it shows (`plates.room_id`), when it
 *            was drawn from the door `illustrationDoor` now picks — the page
 *            stands creatures by that door, so a picture from another door
 *            would put them on the wrong floor. Haiku's placed buttons come
 *            across from `plate_words`.
 *
 * Left behind, and drawn afresh the next time they are asked for: rooms drawn
 * from another door, rooms no plate could place, and sprites, which no plate
 * says the subject of. Pre-release; nothing is retrofitted.
 *
 * Existing `assets` rows are never touched, so running it twice changes nothing.
 */

import postgres from "postgres";
import type { GeneratedDungeon } from "../generation/generate.ts";
import { illustrationDoor } from "../illustrations/room-illustration.ts";

const dry = process.argv.includes("--dry");
const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");
const sql = postgres(url, { prepare: false, max: 1, onnotice: () => {} });

try {
  const covers = await sql<{ artRoot: string; path: string; model: string | null }[]>`
    select distinct on (coalesce(d.art_root, d.id)) coalesce(d.art_root, d.id) as "artRoot", p.path, p.model
      from dungeons d join plates p on p.key = d.cover
     where p.status = 'ready' and p.path is not null
     order by coalesce(d.art_root, d.id), d.created_at
  `;
  console.log(`covers: ${covers.length}`);

  const plates = await sql<
    { key: string; path: string; model: string | null; dungeonId: string; roomId: string; entryId: string; title: string | null; spots: string | null }[]
  >`
    select p.key, p.path, p.model, p.dungeon_id as "dungeonId", p.room_id as "roomId", p.entry_id as "entryId", p.title,
           w.value as spots
      from plates p left join plate_words w on w.key = 'spots:' || p.key
     where p.kind = 'room' and p.status = 'ready' and p.path is not null and p.room_id is not null
  `;
  const docs = new Map<string, { artRoot: string; doc: GeneratedDungeon }>();
  for (const id of new Set(plates.map((p) => p.dungeonId))) {
    const [row] = await sql<{ artRoot: string; doc: GeneratedDungeon }[]>`
      select coalesce(art_root, id) as "artRoot", doc from dungeons where id = ${id}
    `;
    if (row) docs.set(id, row);
  }
  const rooms = plates.flatMap((p) => {
    const d = docs.get(p.dungeonId);
    if (!d) return [];
    const door = illustrationDoor(d.doc, p.roomId);
    if (door !== p.entryId) {
      console.log(`  left: ${p.title ?? p.roomId} (drawn from another door)`);
      return [];
    }
    const spots = p.spots ? (JSON.parse(p.spots) as unknown) : undefined;
    const meta = { entryId: p.entryId, title: p.title ?? "", ...(Array.isArray(spots) ? { spots } : {}) };
    return [{ artRoot: d.artRoot, roomId: p.roomId, path: p.path, model: p.model, meta }];
  });
  console.log(`rooms: ${rooms.length} of ${plates.length} placed`);

  if (!dry) {
    for (const c of covers) {
      await sql`
        insert into assets (art_root, kind, subject, status, path, draws, attempts, model)
        values (${c.artRoot}, 'cover', '', 'ready', ${c.path}, 1, 1, ${c.model})
        on conflict do nothing
      `;
    }
    for (const r of rooms) {
      await sql`
        insert into assets (art_root, kind, subject, status, path, draws, attempts, model, meta)
        values (${r.artRoot}, 'room', ${r.roomId}, 'ready', ${r.path}, 1, 1, ${r.model}, ${sql.json(r.meta)})
        on conflict do nothing
      `;
    }
    console.log("copied");
  }
} finally {
  await sql.end();
}
