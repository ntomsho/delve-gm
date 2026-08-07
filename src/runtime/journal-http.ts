/**
 * The journal, from the browser.
 *
 * A page cannot write a file, so the events go to the dev server, which appends
 * them — the same arrangement as the API key: the client posts, the dev server
 * does the thing only it can do. See the `journal` plugin in vite.config.ts.
 *
 * Batched, because a turn produces a dozen events and a request each would be
 * silly; serialised through one promise chain, because two overlapping appends
 * would interleave lines; and flushed on the way out with `sendBeacon`, because
 * the last thing that happened before you closed the tab is usually the thing
 * you wanted to read.
 *
 * Failures are swallowed after one warning. A journal that cannot write is a
 * lost log, not a lost game.
 */

import type { JournalRecord, Sink } from "./journal.ts";

/** Long enough to collect a turn's worth, short enough to tail the file. */
const LINGER_MS = 250;

export function httpSink(runId: string, url = "/api/journal"): Sink {
  const queue: JournalRecord[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let chain: Promise<unknown> = Promise.resolve();
  let warned = false;

  const send = (events: JournalRecord[]) => {
    chain = chain
      .then(() =>
        fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ runId, events }),
        })
      )
      .catch((e) => {
        if (!warned) {
          warned = true;
          console.warn("[journal] the dev server did not take the events:", e);
        }
      });
  };

  const flush = () => {
    timer = undefined;
    if (queue.length > 0) send(queue.splice(0, queue.length));
  };

  // The tail of the run. `sendBeacon` survives the page going away, which a
  // fetch started at the same moment does not.
  if (typeof window !== "undefined") {
    window.addEventListener("pagehide", () => {
      if (queue.length === 0) return;
      const events = queue.splice(0, queue.length);
      const body = JSON.stringify({ runId, events });
      navigator.sendBeacon?.(url, new Blob([body], { type: "application/json" }));
    });
  }

  return {
    write(record) {
      queue.push(record);
      // The dungeon is one enormous event and the run is unusable without it;
      // everything else can wait for the timer.
      if (record.kind === "dungeon" || record.kind === "error") flush();
      else if (timer === undefined) timer = setTimeout(flush, LINGER_MS);
    },
  };
}
