/**
 * BUILDING THE API
 * ================
 *
 * The API is bundled by Vite rather than by the host's own bundler, for one
 * reason: the referee's playbook is markdown imported with `?raw`
 * (`prompts/loader.ts`). Vite understands that and esbuild — which is what
 * Vercel's Node runtime bundles with — does not. Building here inlines the
 * prose into plain JavaScript, so what gets deployed has no `?raw` left in it
 * and no host has to be taught anything.
 *
 * `dev/raw-md.ts` solves the same problem the other way, for `node` running the
 * TypeScript directly. Both exist because both cases are real: the CLI runs
 * from source, and the deployment runs from a bundle.
 *
 *   npm run build:api    → api/index.js  (from src/server/vercel.ts)
 *
 * SSR mode, so Node builtins and `postgres` are treated as external rather than
 * bundled in. `noExternal` is deliberately empty: everything from node_modules
 * stays a require, which keeps the function small and lets the platform's own
 * Node resolve them.
 */

import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  build: {
    ssr: resolve(import.meta.dirname, "src/server/vercel.ts"),
    outDir: "api",
    emptyOutDir: false,
    target: "node22",
    minify: false,
    rollupOptions: {
      output: { entryFileNames: "index.js", format: "esm" },
    },
  },
  ssr: {
    // Bundle nothing from node_modules; the platform has them.
    noExternal: [],
    target: "node",
  },
});
