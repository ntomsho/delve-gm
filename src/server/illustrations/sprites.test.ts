/**
 * CREATURE SPRITES — the cut-out, and the claim and cache, against an
 * in-memory `assets` table and a fake model. No database, no network, no spend.
 */

import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { spriteKeyOf } from "../../illustrations/figures.ts";
import { generateOffline } from "../../fixtures/offline.ts";
import { memoryStore } from "./memory-store.ts";
import { cutOut, SPRITE_STORE_H, spriteMasksPng } from "./sprite-image.ts";
import { serveSprite, type SpriteWork } from "./sprites.ts";

/**
 * A figure on white: a thick black ring (its outline, with paper inside), and a
 * speck off to one side that the cut-out should drop.
 */
const drawing = () =>
  sharp({ create: { width: 300, height: 450, channels: 3, background: "#ffffff" } })
    .composite([
      {
        input: Buffer.from(
          '<svg width="300" height="450">' +
            '<rect x="100" y="60" width="100" height="300" fill="none" stroke="#000" stroke-width="8"/>' +
            '<rect x="20" y="20" width="4" height="4" fill="#000"/>' +
            "</svg>"
        ),
      },
    ])
    .png()
    .toBuffer();

describe("cutOut", () => {
  it("keeps the paper inside the outline, drops the background and the speck", async () => {
    const c = await cutOut(await drawing());
    // Trimmed to the ring, stroke included.
    expect(c.w).toBeGreaterThanOrEqual(100);
    expect(c.w).toBeLessThanOrEqual(112);
    expect(c.h).toBeGreaterThanOrEqual(300);
    expect(c.h).toBeLessThanOrEqual(312);
    const mid = Math.floor(c.h / 2) * c.w + Math.floor(c.w / 2);
    expect(c.body[mid]).toBe(1); // paper inside: part of the figure
    expect(c.ink[mid]).toBe(0); // and not ink
    expect(c.ink[Math.floor(c.h / 2) * c.w + 1]).toBe(1); // the outline is ink
  });
});

describe("spriteMasksPng", () => {
  it("body and ink side by side, each half the width, no taller than the stored height", async () => {
    const png = await spriteMasksPng(await cutOut(await drawing()));
    const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    expect(info.width % 2).toBe(0);
    expect(info.height).toBeLessThanOrEqual(SPRITE_STORE_H);
    const half = info.width / 2;
    const alpha = (x: number, y: number) => data[(y * info.width + x) * info.channels + 3];
    const cy = Math.floor(info.height / 2);
    const cx = Math.floor(half / 2);
    expect(alpha(cx, cy)).toBe(255); // body: the paper inside is solid
    expect(alpha(half + cx, cy)).toBe(0); // ink: nothing drawn there
  });
});

function fakeWork(opts: { fail?: boolean } = {}) {
  const calls = { look: 0, draw: 0, prompts: [] as string[], uploads: [] as string[] };
  const work: SpriteWork = {
    references: 9,
    async look() {
      calls.look++;
      return { look: "A stooped figure in a grey robe.", size: "large" };
    },
    async draw(prompt) {
      calls.draw++;
      calls.prompts.push(prompt);
      if (opts.fail) throw new Error("the model said no");
      return drawing();
    },
    async upload(path) {
      calls.uploads.push(path);
    },
    urlOf: (path) => `https://cdn.example/illustrations/${path}`,
  };
  return { work, calls };
}

const d = generateOffline(4201, 1);
const creature = d.entities.creatures[0];
const id = spriteKeyOf(creature);
const dungeon = { artRoot: "root-1", theme: d.pass.theme };

describe("serveSprite", () => {
  it("draws once, with the look in the prompt, then serves the stored sprite and its size", async () => {
    const m = memoryStore();
    const { work, calls } = fakeWork();
    const first = await serveSprite(dungeon, d.entities, id, work, m.store);
    expect(first).toEqual({
      status: "ready",
      url: expect.stringMatching(/^https:\/\/cdn\.example\/illustrations\/sprite\/root-1\/[0-9a-f]{16}-[0-9a-z]+\.png$/),
      size: "large",
    });
    expect(calls.prompts[0]).toContain("A stooped figure in a grey robe.");
    expect(calls.prompts[0]).toContain("The 9 images are style references only");
    expect(m.row({ artRoot: "root-1", kind: "sprite", subject: id })!.meta).toEqual({ look: "A stooped figure in a grey robe.", size: "large" });

    const again = await serveSprite(dungeon, d.entities, id, work, m.store);
    expect(again).toEqual(first);
    expect(calls).toMatchObject({ look: 1, draw: 1 });
    expect(calls.uploads).toHaveLength(1);
  });

  it("is one sprite for every run of the dungeon, each starting from its own copy of the entities", async () => {
    const m = memoryStore();
    const { work, calls } = fakeWork();
    await serveSprite(dungeon, d.entities, id, work, m.store);
    // Another run starts from its own copy of the dungeon's entities (`newRun`).
    await serveSprite(dungeon, structuredClone(d.entities), id, work, m.store);
    expect(calls.draw).toBe(1);
  });

  it("a failed drawing is no sprite, tried again on the next ask", async () => {
    const m = memoryStore();
    const { work, calls } = fakeWork({ fail: true });
    expect(await serveSprite(dungeon, d.entities, id, work, m.store)).toEqual({ status: "none" });
    expect(await serveSprite(dungeon, d.entities, id, work, m.store)).toEqual({ status: "none" });
    expect(calls.draw).toBe(2);
  });

  it("a key no creature carries is none, and nothing is drawn", async () => {
    const m = memoryStore();
    const { work, calls } = fakeWork();
    expect(await serveSprite(dungeon, d.entities, "no-such-kind", work, m.store)).toEqual({ status: "none" });
    expect(calls.draw).toBe(0);
  });
});
