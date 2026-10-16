/**
 * The journal, written straight to disk. Node only — the CLI, the live check,
 * and any test that wants a run it can read afterwards.
 *
 * Synchronous appends on purpose. The writes are small and a few per turn, the
 * ordering is guaranteed without a queue, and a run that ends by throwing still
 * has everything up to the throw on disk — which is exactly the run you most
 * want to read.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { render } from "../../journal/render.ts";
import type { JournalRecord, Sink } from "../../journal/journal.ts";

/**
 * Where a run's journal goes, given the id it is being kept under. Gitignored,
 * alongside the generation dumps.
 *
 * Takes the id rather than the seed because a session chooses its id once, at
 * `begin`, and `runId` is stamped with the time — asking for it twice would
 * name two directories.
 */
export function dirFor(runId: string, root = "out/runs"): string {
  return resolve(process.cwd(), root, runId);
}

export function fileSink(dir: string): Sink {
  mkdirSync(dir, { recursive: true });
  const journal = join(dir, "journal.jsonl");
  const transcript = join(dir, "transcript.md");

  return {
    write(record: JournalRecord) {
      appendFileSync(journal, `${JSON.stringify(record)}\n`, "utf8");
      const text = render(record);
      if (text !== undefined) appendFileSync(transcript, `${text}\n`, "utf8");
    },
  };
}
