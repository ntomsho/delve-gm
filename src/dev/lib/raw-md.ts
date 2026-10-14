/**
 * `?raw` IMPORTS, UNDER PLAIN NODE
 * ================================
 *
 * The playbook is markdown — see `prompts/loader.ts` — and is imported as text
 * with Vite's `?raw` suffix. Vite understands that, and so does vitest, which
 * is why prompt assembly has always been testable headlessly.
 *
 * `node` does not. It sees a `.md` extension it has no loader for and refuses
 * the import, which means anything that reaches the game master — the turn machine,
 * a session, a request handler — cannot be run outside a bundler. That was
 * invisible while the only thing that played a turn was a browser tab, and it
 * is the first wall you hit trying to play one from a terminal.
 *
 * So: a module hook that teaches Node the same trick. `registerHooks` is
 * synchronous and in-process, so the entry point calls this and then imports
 * the real work — a static import would be hoisted above the registration and
 * fail on the way in.
 *
 * NOT A BUILD STEP, deliberately. The markdown stays the source of truth and
 * stays readable in the repo; nothing is generated, and nothing can go stale.
 * A bundler that needs the same thing gets it from its own config.
 */

import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";

const SUFFIX = "?raw";

export function registerRawMarkdown(): void {
  registerHooks({
    resolve(specifier, context, next) {
      if (!specifier.endsWith(SUFFIX)) return next(specifier, context);
      // Resolved without the suffix — Node knows how to find the file, it just
      // does not know what to do with it — and then carried back on the url so
      // `load` below can tell this import from an ordinary one.
      const resolved = next(specifier.slice(0, -SUFFIX.length), context);
      return { ...resolved, url: resolved.url + SUFFIX, shortCircuit: true };
    },

    load(url, context, next) {
      if (!url.endsWith(SUFFIX)) return next(url, context);
      const path = fileURLToPath(url.slice(0, -SUFFIX.length));
      return {
        format: "module",
        shortCircuit: true,
        source: `export default ${JSON.stringify(readFileSync(path, "utf8"))};`,
      };
    },
  });
}
