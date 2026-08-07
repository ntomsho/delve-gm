import { appendFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { render } from "./src/runtime/journal-render.ts";
import type { JournalRecord } from "./src/runtime/journal.ts";

/**
 * THE JOURNAL ENDPOINT.
 *
 * A page cannot write a file. The client posts batches of events here and this
 * appends them to `out/runs/<runId>/`, which is the same division of labour as
 * the API proxy below: the browser does what a browser can do, and the dev
 * server does the rest.
 *
 * Dev only, by construction — it lives in `configureServer` and does not exist
 * in a build.
 */
function journal(): Plugin {
  return {
    name: "dungeon-journal",
    configureServer(server) {
      server.middlewares.use("/api/journal", (req, res, next) => {
        if (req.method !== "POST") return next();

        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
          try {
            const { runId, events } = JSON.parse(body) as {
              runId: string;
              events: JournalRecord[];
            };

            // The run id becomes a directory name, so it is checked against a
            // SHAPE rather than filtered: stripping separators out of
            // "../../etc/evil" leaves "....etcevil", which stays inside the
            // directory but is a dot-file nobody asked for. A run id looks like
            // `2026-08-06T18-22-31-seed1005` and anything else is refused.
            if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(runId) || runId.includes("..")) {
              res.statusCode = 400;
              return res.end("bad run id");
            }
            if (!Array.isArray(events) || events.length === 0) {
              res.statusCode = 400;
              return res.end("no events");
            }

            const dir = resolve(process.cwd(), "out/runs", runId);
            mkdirSync(dir, { recursive: true });

            appendFileSync(
              join(dir, "journal.jsonl"),
              `${events.map((e) => JSON.stringify(e)).join("\n")}\n`,
              "utf8"
            );

            const text = events
              .map(render)
              .filter((x): x is string => x !== undefined)
              .join("\n");
            if (text !== "") appendFileSync(join(dir, "transcript.md"), `${text}\n`, "utf8");

            res.statusCode = 204;
            res.end();
          } catch (e) {
            server.config.logger.warn(`[journal] could not write: ${e}`);
            res.statusCode = 500;
            res.end();
          }
        });
      });
    },
  };
}

/**
 * THE API KEY NEVER REACHES THE BROWSER.
 *
 * `loadEnv(mode, cwd, "")` — note the empty prefix — reads every key out of
 * .env.local, including un-prefixed ones. That is what lets this config see
 * ANTHROPIC_API_KEY. It is NOT what exposes it: Vite only inlines `VITE_`-
 * prefixed variables into client code, and the key deliberately is not one.
 *
 * The key is attached to the outbound request by the proxy below, which runs
 * in the dev server process. The client calls `/api/anthropic/...` and has no
 * way to read the header it will be given. That keeps the client's call shape
 * identical to what a real backend would serve later.
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const apiKey = env.ANTHROPIC_API_KEY;

  return {
    plugins: [react(), tailwindcss(), journal()],

    server: {
      proxy: {
        "/api/anthropic": {
          target: "https://api.anthropic.com",
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api\/anthropic/, ""),
          configure: (proxy) => {
            proxy.on("proxyReq", (proxyReq) => {
              if (apiKey) proxyReq.setHeader("x-api-key", apiKey);
              proxyReq.setHeader("anthropic-version", "2023-06-01");
              // The request originates here, not in a page, so the browser
              // escape hatch is neither needed nor wanted.
              proxyReq.removeHeader("origin");
              proxyReq.removeHeader("referer");
            });
          },
        },
      },
    },

    test: {
      // Engine and runtime are framework-free and must stay runnable headless.
      // A jsdom project arrives with the first UI test, not before.
      environment: "node",
      include: ["src/**/*.test.ts"],
    },
  };
});
