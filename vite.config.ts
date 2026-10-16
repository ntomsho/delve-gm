import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

/**
 * VITE SERVES THE CLIENT AND NOTHING ELSE. The model key, the journal and the
 * database all belong to the API (`src/server/`), which runs beside this one in
 * development. Vite proxies `/api` to it, so the browser sees a single origin
 * in development exactly as it will in production. `npm run dev` starts both
 * (the API under `node --watch`, so it restarts when the server changes);
 * `npm run dev:web` is this one alone.
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
     * framework-free by rule, and `src/ui/app/screens.test.ts` renders through
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
            setupFiles: ["src/ui/test-utils/jsdom-setup.ts"],
          },
        },
      ],
    },
  };
});
