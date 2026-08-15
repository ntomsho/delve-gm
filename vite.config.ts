import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

/**
 * VITE SERVES THE CLIENT AND NOTHING ELSE, as of Phase 10.
 *
 * Two shims lived here and are gone, both replaced by a real server:
 *
 *   the journal endpoint  a page cannot write a file, so the client used to
 *                         post batches of events here and this appended them to
 *                         `out/runs/<id>/`. The API writes them to Postgres now,
 *                         and `GET /api/runs/:id/journal.jsonl` reads them back.
 *
 *   the Anthropic proxy   the key was attached to outbound requests here, in
 *                         the dev server process, so the browser never held it.
 *                         The rule has not moved, only the wall: the browser
 *                         now talks only to the API, and the API holds the key.
 *                         See `configureAnthropic` in src/server/app.ts.
 *
 * What is left is a proxy from `/api` to the API running beside this one, so
 * the browser sees a single origin in development exactly as it will in
 * production. Run both: `npm run api` and `npm run dev`.
 */
export default defineConfig(() => {
  const api = process.env.API_URL ?? "http://localhost:8787";

  return {
    plugins: [react(), tailwindcss()],

    server: {
      proxy: {
        // Generation holds a model call open for a minute or more, and the
        // default proxy timeout would cut it off long before the answer lands.
        "/api": { target: api, changeOrigin: true, timeout: 300_000 },
      },
    },

    /**
     * TWO PROJECTS, SPLIT ON THE FILE EXTENSION.
     *
     * `.test.ts` is headless and stays that way: the engine and the runtime are
     * framework-free by rule, and `src/ui/screens.test.ts` renders through
     * `renderToStaticMarkup`, which needs no DOM. `.test.tsx` is the jsdom half,
     * which arrived with the first test that has to CLICK something — a static
     * render executes a component body but never reaches its state, its refs or
     * its event handlers, and `DungeonMap` is mostly those.
     *
     * The extension is the whole of the rule, so a new test lands in the right
     * project by being written in the syntax it needs.
     */
    test: {
      projects: [
        {
          test: {
            name: "node",
            environment: "node",
            include: ["src/**/*.test.ts"],
          },
        },
        {
          test: {
            name: "ui",
            environment: "jsdom",
            include: ["src/**/*.test.tsx"],
            setupFiles: ["src/ui/__fixtures__/jsdom-setup.ts"],
          },
        },
      ],
    },
  };
});
