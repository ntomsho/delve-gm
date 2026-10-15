/**
 * THE PROJECT'S STANDING RULES, ENFORCED
 * ======================================
 *
 * Every rule in CLAUDE.md that a grep can check is checked here, in one place,
 * so the rules and their enforcement can be read side by side.
 *
 * Each scan walks its directories recursively and asserts it found files
 * before asserting anything about them. A scan that silently finds nothing
 * passes while checking nothing — which is what the old engine check would have
 * done the moment the engine grew a subfolder.
 */

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const SRC = join(ROOT, "src");

/** Every .ts/.tsx under `dir`, as a path relative to src/ with forward slashes. */
function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return walk(p);
    return /\.(ts|tsx)$/.test(e.name) ? [relative(SRC, p).replace(/\\/g, "/")] : [];
  });
}

const isTest = (f: string) => /\.(test|dbtest)\.tsx?$/.test(f);
const sources = walk(SRC).filter((f) => !isTest(f));

/** Source with comments removed, so a rule can be explained in prose without tripping it. */
const code = (f: string) =>
  readFileSync(join(SRC, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

// ===========================================================================
// REACT  (CLAUDE.md: nothing outside src/ui/ imports React)
// ===========================================================================

describe("React stays in the UI", () => {
  const outsideUi = sources.filter((f) => !f.startsWith("ui/") && f !== "main.tsx");

  it("has files to check", () => {
    expect(outsideUi.length).toBeGreaterThan(60);
  });

  it.each(outsideUi)("%s", (f) => {
    const c = code(f);
    expect(c, "must not import react").not.toMatch(/from\s+["']react/);
    // Bare `zustand` re-exports `zustand/react`. `zustand/vanilla` is fine.
    expect(c, "must import zustand/vanilla, not zustand").not.toMatch(/from\s+["']zustand["']/);
  });
});

// ===========================================================================
// PURITY  (CLAUDE.md: the domain is environment-free and runs under vitest)
// ===========================================================================

/**
 * The shells are the only places allowed to know where they are running: the
 * UI (a browser), the server (Node on Vercel), the dev CLIs (Node), and the API
 * client (a browser, reading its build-time config). Everything else is the
 * game, and must run anywhere.
 */
const SHELLS = ["ui/", "server/", "dev/", "api-client/"];

describe("the domain is environment-free", () => {
  const domain = sources.filter((f) => f.endsWith(".ts") && !SHELLS.some((s) => f.startsWith(s)));

  it("has files to check", () => {
    expect(domain.length).toBeGreaterThan(50);
  });

  it.each(domain)("%s touches no framework or environment global", (f) => {
    const c = code(f);
    expect(c, "must not import react").not.toMatch(/from\s+["']react/);
    expect(c, "must not read import.meta.env").not.toMatch(/import\.meta\.env/);
    expect(c, "must not touch document").not.toMatch(/\bdocument\.[A-Za-z_$]/);
    expect(c, "must not touch window").not.toMatch(/\bwindow\.[A-Za-z_$]/);
    // `process` at module scope threw in a browser bundle.
    expect(c, "must not touch process").not.toMatch(/\bprocess\.[A-Za-z_$]/);
  });
});

// ===========================================================================
// LAYERS  (src/README.md: each folder imports only from the folders below it)
// ===========================================================================

/**
 * The folders in order, top to bottom. An import may only point at a folder with
 * a higher number. Folders on the same rank may not import each other: the UI
 * runs in a browser and the server in Node, so neither can load the other.
 * `dev/` is rank 0 because a developer CLI may reach into anything.
 */
const RANK: Record<string, number> = {
  dev: 0,
  ui: 1,
  server: 1,
  "api-client": 2,
  fixtures: 3,
  gameplay: 4,
  illustrations: 5,
  journal: 6,
  generation: 7,
  llm: 8,
  prompts: 9,
  rules: 10,
  shared: 11,
};

/**
 * THE KNOWN EXCEPTIONS, each with its reason. Every one is type-only, so none of
 * them loads code, but each is a place where the layering is not yet true.
 *
 * `shared/` names Knave's character sheet and roll results, because the commit
 * a turn produces carries them. Deciding what a ruleset declares, so the shared
 * types can speak through it instead, is the ruleset seam (BUILD-PLAN §3).
 */
const EXCEPTIONS = new Set([
  "shared/types/commit.ts -> rules/knave/character.ts",
  "shared/types/turn.ts -> rules/knave/rolls.ts",
]);

interface Import {
  from: string;
  to: string;
  /** `import type` or `export type`: erased at build, loads nothing */
  typeOnly: boolean;
}

/** Every relative import in a file: static, re-export, and dynamic `import()`. */
function importsOf(f: string): Import[] {
  const src = code(f);
  const out: Import[] = [];
  const add = (spec: string, typeOnly: boolean) => {
    if (!spec.startsWith(".")) return;
    const to = relative(SRC, join(SRC, f, "..", spec.replace(/\?raw$/, ""))).replace(/\\/g, "/");
    out.push({ from: f, to, typeOnly });
  };
  for (const m of src.matchAll(/^\s*(?:import|export)\s+(type\s+)?[^;]*?\s+from\s+"([^"]+)"/gm)) add(m[2], !!m[1]);
  for (const m of src.matchAll(/^\s*import\s+"([^"]+)"/gm)) add(m[1], false);
  for (const m of src.matchAll(/\bimport\(\s*"([^"]+)"\s*\)/g)) add(m[1], false);
  return out;
}

const area = (f: string) => f.split("/")[0];
const allImports = sources.flatMap(importsOf);

describe("layers", () => {
  it("has imports to check", () => {
    expect(allImports.length).toBeGreaterThan(500);
  });

  it("every folder imports only from the folders below it", () => {
    const upward = allImports
      .filter((i) => area(i.from) !== area(i.to) && area(i.from) in RANK && area(i.to) in RANK)
      .filter((i) => RANK[area(i.from)] >= RANK[area(i.to)])
      .map((i) => `${i.from} -> ${i.to}`)
      .filter((edge) => !EXCEPTIONS.has(edge));
    expect(upward).toEqual([]);
  });

  it("lists no exception that has since been fixed", () => {
    const present = new Set(allImports.map((i) => `${i.from} -> ${i.to}`));
    expect([...EXCEPTIONS].filter((e) => !present.has(e))).toEqual([]);
  });

  it("has no cycle of imports that load code", () => {
    const next = new Map<string, string[]>();
    for (const i of allImports) if (!i.typeOnly) next.set(i.from, [...(next.get(i.from) ?? []), i.to]);
    // Depth-first; a file met again while still on the stack closes a cycle.
    const state = new Map<string, "open" | "done">();
    const cycles: string[] = [];
    const visit = (f: string, path: string[]) => {
      if (state.get(f) === "done") return;
      if (state.get(f) === "open") {
        cycles.push([...path.slice(path.indexOf(f)), f].join(" -> "));
        return;
      }
      state.set(f, "open");
      for (const t of next.get(f) ?? []) visit(t, [...path, f]);
      state.set(f, "done");
    };
    for (const f of sources) visit(f, []);
    expect(cycles).toEqual([]);
  });

  /*
   * `import { type A } from "x"` is NOT erased. Under `verbatimModuleSyntax` it
   * compiles to `import {} from "x"`, which still loads and runs x. One of these
   * in App.tsx kept the whole generation pipeline in the browser bundle. A
   * type-only import is written `import type { A }`.
   */
  it.each(walk(SRC))("%s writes type-only imports as `import type`", (f) => {
    const offenders = [...code(f).matchAll(/^\s*import\s+\{([^}]*)\}\s+from\s+"[^"]+"/gm)].filter((m) => {
      const names = m[1].split(",").map((s) => s.trim()).filter(Boolean);
      return names.length > 0 && names.every((n) => n.startsWith("type "));
    });
    expect(offenders.map((m) => m[0].trim())).toEqual([]);
  });
});

// ===========================================================================
// MODEL STRINGS  (CLAUDE.md: they live only in src/llm/models.ts)
// ===========================================================================

describe("model strings", () => {
  it("appear nowhere outside src/llm/models.ts", () => {
    const offenders = walk(SRC)
      .filter((f) => f !== "llm/models.ts" && !isTest(f))
      // Text models by their family prefix; image models by their fal endpoint shape.
      .filter((f) =>
        /["'](claude-[a-z0-9.-]+|fal-ai\/[a-z0-9.\/-]+|openai\/gpt-image[a-z0-9.\/-]*)["']/.test(
          readFileSync(join(SRC, f), "utf8")
        )
      );

    expect(offenders).toEqual([]);
  });
});

// ===========================================================================
// THE SKILL  (every steps/ path SKILL.md names must resolve)
// ===========================================================================

describe("game master skill", () => {
  const root = join(SRC, "prompts/game-master");

  it("every steps/ file SKILL.md references exists", () => {
    const skill = readFileSync(join(root, "SKILL.md"), "utf8");
    const referenced = [...skill.matchAll(/`steps\/([\w-]+\.md)`/g)].map((m) => m[1]);
    expect(referenced.length).toBeGreaterThan(0);

    const present = new Set(readdirSync(join(root, "steps")));
    expect(referenced.filter((f) => !present.has(f))).toEqual([]);
  });

  it("has a step file for every stage that takes a model call", () => {
    const present = readdirSync(join(root, "steps"));
    for (const f of [
      "1-determine-target.md",
      "2-validate-and-classify.md",
      "3-handle-by-type.md",
      "3-information.md",
      "3-standard.md",
      "4-confirm-and-roll.md",
      "5-resolution.md",
      "room-entry.md",
    ]) {
      expect(present, `missing ${f}`).toContain(f);
    }
  });
});
