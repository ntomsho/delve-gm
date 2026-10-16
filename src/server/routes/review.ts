/**
 * REVIEW: a run's journal, raw or rendered as a transcript.
 */

import type { Hono } from "hono";
import { currentUser, type AuthEnv } from "../auth.ts";
import { render } from "../../journal/render.ts";
import * as repo from "../db/repo.ts";
import { mustGetRun } from "./lookup.ts";

export function reviewRoutes(app: Hono<AuthEnv>): void {
  app.get("/api/runs/:id/journal.jsonl", async (c) => {
    const run = await mustGetRun(c.req.param("id"), currentUser(c).id);
    const events = await repo.readJournal(run.id, run.dungeonId);
    return c.text(events.map((e) => JSON.stringify(e)).join("\n"), 200, {
      "content-type": "application/x-ndjson; charset=utf-8",
    });
  });

  app.get("/api/runs/:id/transcript.md", async (c) => {
    const run = await mustGetRun(c.req.param("id"), currentUser(c).id);
    const events = await repo.readJournal(run.id, run.dungeonId);
    // The same renderer the file sink has always used, so a transcript pulled
    // out of the database reads exactly like one pulled off disk.
    const text = events.map(render).filter((t) => t !== undefined).join("\n");
    return c.text(text, 200, { "content-type": "text/markdown; charset=utf-8" });
  });
}
