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
import { render } from "../runtime/journal-render.ts";
import { runId, type JournalRecord, type Sink } from "../runtime/journal.ts";

/** `out/runs/<timestamp>-seed<n>`. Gitignored, alongside the generation dumps. */
export function runDir(seed: number, root = "out/runs"): string {
  return resolve(process.cwd(), root, runId(seed));
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
