/**
 * THE PROMPTS, AS THE MODEL READS THEM.
 *
 * What the snapshots cannot see: that every file arrives the same on any
 * checkout, that no template reaches a model with a hole in it, and that no
 * markdown in this folder is left unread.
 */

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import * as prompts from "./loader.ts";
import { fill } from "./loader.ts";
import { CONTENT_PASS_INSTRUCTIONS } from "../generation/content/passes/content-pass/prompt.ts";
import { SEAMS_PASS_INSTRUCTIONS } from "../generation/content/passes/seams-pass.ts";

const texts = Object.entries(prompts).filter((e): e is [string, string] => typeof e[1] === "string");

describe("every prompt", () => {
  it("has prompts to check", () => {
    expect(texts.length).toBeGreaterThan(20);
  });

  it.each(texts)("%s is LF throughout and ends on its last word", (_, text) => {
    expect(text).not.toContain("\r");
    expect(text.length).toBeGreaterThan(0);
  });

  // SKILL keeps its final newline; everything `text()` loads does not.
  it.each(texts.filter(([name]) => name !== "SKILL"))("%s has no trailing newline", (_, text) => {
    expect(text.endsWith("\n")).toBe(false);
  });

  it("leaves no slot unfilled", () => {
    for (const filled of [CONTENT_PASS_INSTRUCTIONS, SEAMS_PASS_INSTRUCTIONS]) {
      expect(filled).not.toMatch(/\{\{\w+\}\}/);
    }
  });
});

describe("fill", () => {
  it("puts each value in its slot", () => {
    expect(fill("a {{x}} b {{y}}", { x: "1", y: "2" })).toBe("a 1 b 2");
  });

  it("refuses a slot with no value", () => {
    expect(() => fill("a {{x}}", {})).toThrow(/\{\{x\}\} has no value/);
  });

  it("refuses a value with no slot", () => {
    expect(() => fill("a", { x: "1" })).toThrow(/no slot \{\{x\}\}/);
  });
});

describe("the folder", () => {
  it("has no markdown the loader does not import", () => {
    const here = join(process.cwd(), "src/prompts");
    const walk = (d: string): string[] =>
      readdirSync(d, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(join(d, e.name)) : e.name.endsWith(".md") ? [join(d, e.name)] : []
      );
    const loader = readFileSync(join(here, "loader.ts"), "utf8");
    const unread = walk(here)
      .map((f) => "./" + relative(here, f).replace(/\\/g, "/"))
      .filter((f) => !loader.includes(`"${f}?raw"`));
    expect(unread).toEqual([]);
  });
});
