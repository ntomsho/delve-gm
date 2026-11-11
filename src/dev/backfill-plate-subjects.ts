/**
 * ONE-OFF: say what every plate drawn before `plate_subjects` is a picture of.
 *
 *   node --env-file=.env.local src/dev/backfill-plate-subjects.ts [--dry] [--matches rooms.jsonl]
 *
 *   1. covers: every plate a dungeon names as its cover;
 *   2. rooms the current prompt still keys the same: every room of every
 *      complete dungeon, by each door it can be drawn from, with its placement
 *      and name. `--matches` adds rooms found by an older checkout's
 *      `illustrationKey`, one JSON object per line:
 *      { key, dungeonId, roomId, entryId, title };
 *   3. the rest by the picture's shape: rooms are drawn landscape, sprites
 *      portrait. A room found this way has no placement and no name.
 *
 * Only plates with no kind are touched, so running it twice changes nothing.
 */

import { registerRawMarkdown } from "./lib/raw-md.ts";

registerRawMarkdown();

const dry = process.argv.includes("--dry");
const { db } = await import("../server/db/connection.ts");
const { liveIllustrationWork, illustrationKey } = await import("../server/illustrations/serve.ts");
const { illustrationEntries, roomIllustration } = await import("../illustrations/room-illustration.ts");

const work = liveIllustrationWork();
if (!work) throw new Error("illustration worker is not configured (FAL_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)");
const sql = db();

const untagged = async () =>
  new Map(
    (await sql<{ key: string; path: string }[]>`select key, path from plates where kind is null and status = 'ready' and path is not null`).map(
      (r) => [r.key, r.path]
    )
  );

// 1. Covers.
const covers = await sql`
  ${dry ? sql`select key from plates` : sql`update plates set kind = 'cover'`}
   where kind is null and key in (select cover from dungeons where cover is not null) ${dry ? sql`` : sql`returning key`}
`;
console.log(`covers: ${covers.length}`);

// 2. Rooms by today's key.
let rooms = 0;
const left = await untagged();
const ids = await sql<{ id: string }[]>`select id from dungeons where status = 'complete'`;
for (const { id } of ids) {
  const [{ doc: d }] = await sql`select doc from dungeons where id = ${id}`;
  for (const room of d.graph.rooms) {
    const roomId: string = room.entityId;
    for (const entryId of illustrationEntries(d, roomId)) {
      const p = roomIllustration(d, roomId, entryId);
      if (!p) continue;
      const key = illustrationKey(p, d.pass.theme, work.references);
      if (!left.has(key)) continue;
      left.delete(key);
      rooms++;
      console.log(`room: ${p.roomName} (${d.pass.name})`);
      if (!dry) {
        await sql`update plates set kind = 'room', dungeon_id = ${id}, room_id = ${roomId}, entry_id = ${entryId}, title = ${p.roomName}
                   where key = ${key} and kind is null`;
      }
    }
  }
}
const matchesAt = process.argv.indexOf("--matches");
if (matchesAt > 0) {
  const { readFileSync } = await import("node:fs");
  for (const line of readFileSync(process.argv[matchesAt + 1], "utf8").split("\n").filter(Boolean)) {
    const m = JSON.parse(line) as { key: string; dungeonId: string; roomId: string; entryId: string; title: string };
    if (!left.has(m.key)) continue;
    left.delete(m.key);
    rooms++;
    console.log(`room (older key): ${m.title}`);
    if (!dry) {
      await sql`update plates set kind = 'room', dungeon_id = ${m.dungeonId}, room_id = ${m.roomId}, entry_id = ${m.entryId}, title = ${m.title}
                 where key = ${m.key} and kind is null`;
    }
  }
}
console.log(`rooms placed: ${rooms}`);

// 3. The rest by shape: a PNG's width and height are bytes 16–23 of its header.
const shape = { room: 0, sprite: 0, unreadable: 0 };
for (const [key, path] of await untagged()) {
  const res = await fetch(work.urlOf(path), { headers: { range: "bytes=0-31" } });
  const head = Buffer.from(await res.arrayBuffer());
  if (head.length < 24 || head.toString("ascii", 12, 16) !== "IHDR") {
    shape.unreadable++;
    continue;
  }
  const kind = head.readUInt32BE(16) > head.readUInt32BE(20) ? "room" : "sprite";
  shape[kind]++;
  if (!dry) await sql`update plates set kind = ${kind} where key = ${key} and kind is null`;
}
console.log(`by shape: ${JSON.stringify(shape)}`);
await sql.end();
