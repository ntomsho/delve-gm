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
