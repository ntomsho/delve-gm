/**
 * A JOURNAL YOU ALREADY HAVE, MADE READABLE
 * =========================================
 *
 *   node src/dev/cli-transcript.ts out/pulled.csv
 *   node src/dev/cli-transcript.ts out/pulled.csv --out out/run.md
 *
 * THE ONE THING THE SUPABASE DASHBOARD CANNOT DO. Everything else about reading
 * a tester's run is a query: the runs, the journal, the whole dungeon and every
 * entity in it are rows, the SQL editor runs as a privileged role so it sees
 * every account's, and CSV download does the rest. A TRANSCRIPT is not a row —
 * it is `journal/render.ts`, two hundred lines of TypeScript that know what a
 * commit and a morale check and a far-side connector are — so it is the only
 * part that has to be a program.
 *
 * NO DATABASE ACCESS, DELIBERATELY. It reads a file you already downloaded. That
 * keeps the credential out of the loop entirely: there is no connection string
 * to hold, nothing to point at the wrong project, and no path by which running
 * the wrong argument writes to anything.
 *
 * IT EATS WHAT THE DASHBOARD GIVES YOU. A CSV export of `select payload from
 * journal_events ...` is one JSON object per line with CSV quoting around it and
 * a `payload` header on top; a journal off disk (`journal-fs.ts`) is the same
 * objects with no quoting and no header. Both go in without a flag, because
 * having to say which is a thing to get wrong at the point you are already
 * annoyed about something else.
 *
 * SYSTEM EVENTS ARE NOT MISSED. `render` has never printed them — the playbook
 * is not part of the story — so a journal pulled in its compact form, with the
 * prompt blocks left as hashes, produces exactly the same transcript as one with
 * every block spelled out.
 *
 * The script is `lib/transcript.ts`. This file teaches Node what a `?raw`
 * import is before anything that reaches a prompt is imported — a static
 * import would be resolved first. See `lib/raw-md.ts`.
 */

import { registerRawMarkdown } from "./lib/raw-md.ts";

registerRawMarkdown();
await import("./lib/transcript.ts");
