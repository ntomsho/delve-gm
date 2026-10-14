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
 */

import { readFileSync, writeFileSync } from "node:fs";
import { render } from "../journal/render.ts";
import type { JournalRecord } from "../journal/journal.ts";

/**
 * One line of the file, as an event — or `undefined` for a line that is not one.
 *
 * The CSV unwrapping is a strip and an unescape rather than a parser because the
 * field it has to handle is a single jsonb value: `payload::text` never contains
 * a raw newline, so a record is always a line and a line is always a record.
 * Anything wider than that wants a real CSV reader, and anything that wide is
 * not this file's input.
 */
function parse(line: string): JournalRecord | undefined {
  const t = line.trim();
  if (t === "") return undefined;

  const json = t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1).replaceAll('""', '"') : t;

  try {
    const value: unknown = JSON.parse(json);
    // The `payload` header, a stray column name, a `--` comment pasted along
    // with the results: anything that parses but is not an event is not an
    // error, it is the shape of a file somebody exported by hand.
    if (typeof value !== "object" || value === null || !("kind" in value)) return undefined;
    return value as JournalRecord;
  } catch {
    return undefined;
  }
}

function main(argv: string[]): void {
  const flag = argv.indexOf("--out");
  // Resolved to `undefined` when the flag is absent rather than left as
  // `argv[-1 + 1]`, which is the source filename and would make the one-argument
  // form — the common one — swallow its own input and print the usage line.
  const out = flag === -1 ? undefined : argv[flag + 1];
  const source = argv.find((a) => !a.startsWith("--") && a !== out);

  if (!source) {
    console.error("usage: node src/dev/cli-transcript.ts <journal.jsonl|csv> [--out file.md]");
    process.exit(2);
  }

  const lines = readFileSync(source, "utf8").split("\n");
  const events = lines.map(parse).filter((e): e is JournalRecord => e !== undefined);

  if (events.length === 0) {
    console.error(`no journal events in ${source} — is it the right download?`);
    process.exit(1);
  }

  const text = events
    .map(render)
    .filter((t): t is string => t !== undefined)
    .join("\n");

  if (out) {
    writeFileSync(out, text, "utf8");
    console.error(`${events.length} events → ${out}`);
  } else {
    process.stdout.write(text);
  }
}

main(process.argv.slice(2));
