/**
 * ROOM ILLUSTRATIONS AND COVERS — the claim, the cache, the redraw and the
 * failure path, against an in-memory `assets` table and a fake model. No
 * database, no network, no spend.
 */

import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { generateOffline } from "../../fixtures/offline.ts";
import {
  coverDescription,
  illustrationDoor,
  illustrationSpots,
  illustrationTags,
  roomIllustration,
} from "../../illustrations/room-illustration.ts";
import type { AssetRef } from "../db/repo.ts";
import { inkPng } from "./image.ts";
import { memoryStore } from "./memory-store.ts";
import {
  assetPath,
  ILLUSTRATION_CLAIM_STALE_MS,
  ILLUSTRATION_MAX_ATTEMPTS,
  serveCover,
  serveIllustration,
  type IllustrationWork,
} from "./serve.ts";

const d = generateOffline(1005, 1);
const roomId = d.graph.rooms.map((r) => r.entityId).find((id) => illustrationDoor(d, id) !== undefined)!;
const door = illustrationDoor(d, roomId)!;
const dungeon = { artRoot: "root-1", doc: d };

const picture = () =>
  sharp({ create: { width: 30, height: 20, channels: 3, background: "#ffffff" } })
    .composite([{ input: Buffer.from('<svg width="30" height="20"><rect x="5" y="5" width="10" height="10"/></svg>') }])
    .png()
    .toBuffer();

function fakeWork(opts: { fail?: boolean } = {}) {
  const calls = { setting: 0, visual: 0, draw: 0, scenes: [] as string[], prompts: [] as string[], uploads: [] as string[] };
  const work: IllustrationWork = {
    references: 4,
    async setting() {
      calls.setting++;
      return "Dressed grey stone, dim.";
    },
    async visual() {
      calls.visual++;
      return { room: "A plain stone room.", looks: {} };
    },
    async draw(prompt) {
      calls.draw++;
      calls.prompts.push(prompt);
      if (opts.fail) throw new Error("the model said no");
      return picture();
    },
    async scene(description) {
      calls.scenes.push(description);
      return "A ruined tower on a bare hill.";
    },
    async drawScene(prompt) {
      calls.draw++;
      calls.prompts.push(prompt);
      if (opts.fail) throw new Error("the model said no");
      return picture();
    },
    async upload(path) {
      calls.uploads.push(path);
    },
    urlOf: (path) => `https://cdn.example/illustrations/${path}`,
  };
  return { work, calls };
}

const room: AssetRef = { artRoot: "root-1", kind: "room", subject: roomId };

describe("serveIllustration", () => {
  it("draws once, then serves the stored illustration to every later ask", async () => {
    const m = memoryStore();
    const { work, calls } = fakeWork();
    const first = await serveIllustration(dungeon, roomId, work, m.store);
    expect(first.status).toBe("ready");
    expect(await serveIllustration(dungeon, roomId, work, m.store)).toEqual(first);
    expect(calls.draw).toBe(1);
    expect(calls.uploads).toHaveLength(1);
    expect(calls.uploads[0]).toMatch(new RegExp(`^room/root-1/[0-9a-f]{16}-[0-9a-z]+\\.png$`));
    expect(calls.prompts[0]).toContain("Dressed grey stone, dim.");
    expect(calls.prompts[0]).toContain("4 images are style references");
  });

  it("keeps the door it was drawn from and the room's name with the picture", async () => {
    const m = memoryStore();
    await serveIllustration(dungeon, roomId, fakeWork().work, m.store);
    expect(m.row(room)!.meta).toMatchObject({ entryId: door, title: roomIllustration(d, roomId, door)!.roomName });
  });

  it("is one picture for every copy of the dungeon, whatever its row id", async () => {
    const m = memoryStore();
    const { work, calls } = fakeWork();
    await serveIllustration(dungeon, roomId, work, m.store);
    await serveIllustration({ artRoot: "root-1", doc: structuredClone(d) }, roomId, work, m.store);
    expect(calls.draw).toBe(1);
  });

  it("does not draw again because the code changed: only a redraw mark does", async () => {
    const m = memoryStore();
    const { work, calls } = fakeWork();
    const first = await serveIllustration(dungeon, roomId, work, m.store);
    work.references = 9; // a different prompt from here on
    expect(await serveIllustration(dungeon, roomId, work, m.store)).toEqual(first);
    expect(calls.draw).toBe(1);

    m.markForRedraw(room);
    const second = await serveIllustration(dungeon, roomId, work, m.store);
    expect(calls.draw).toBe(2);
    expect(second.status === "ready" && first.status === "ready" && second.url).not.toBe(first.status === "ready" && first.url);
    expect(calls.prompts[1]).toContain("9 images are style references");
  });

  it("keeps the old picture when a redraw fails", async () => {
    const m = memoryStore();
    const first = await serveIllustration(dungeon, roomId, fakeWork().work, m.store);
    m.markForRedraw(room);
    const { work, calls } = fakeWork({ fail: true });
    expect(await serveIllustration(dungeon, roomId, work, m.store)).toEqual(first);
    expect(await serveIllustration(dungeon, roomId, work, m.store)).toEqual(first);
    expect(calls.draw).toBe(1);
  });

  it("keeps showing the old picture on a day the budget is spent", async () => {
    const m = memoryStore();
    const first = await serveIllustration(dungeon, roomId, fakeWork().work, m.store);
    m.markForRedraw(room);
    const { work, calls } = fakeWork();
    work.mayDraw = async () => false;
    expect(await serveIllustration(dungeon, roomId, work, m.store)).toEqual(first);
    expect(calls.draw).toBe(0);
  });

  it("carries a button at each of the guide's tags, and one for every door and object out of the picture", async () => {
    const m = memoryStore();
    const got = await serveIllustration(dungeon, roomId, fakeWork().work, m.store);
    const spots = got.status === "ready" ? got.spots ?? [] : [];
    const p = roomIllustration(d, roomId, door)!;
    const tags = illustrationTags(p);
    const tagged = p.hotspots.filter((h) => h.status === "shown" && tags.has(h.id));
    expect(spots.filter((s) => s.how === "shown")).toEqual(
      tagged.flatMap((h) => h.points.map((q) => ({ id: h.id, how: "shown", x: q.x, y: q.y })))
    );
    expect(tagged.length).toBeGreaterThan(0);
    const objects = new Set([...p.exits, p.entry].map((x) => x.id));
    p.features.forEach((f) => f.presence === "object" && objects.add(f.id));
    const unseen = p.hotspots.filter((h) => h.status !== "shown" && objects.has(h.id));
    expect(spots.filter((s) => s.how !== "shown").map((s) => s.id).sort()).toEqual(unseen.map((h) => h.id).sort());
  });

  it("serves the buttons Haiku placed on a fresh picture, kept with it for every later ask", async () => {
    const m = memoryStore();
    const { work, calls } = fakeWork();
    let placeCalls = 0;
    work.place = async (_p, spots) => {
      placeCalls++;
      return spots.map((s) => (s.how === "shown" ? { ...s, x: 0.123, y: 0.456 } : s));
    };
    const first = await serveIllustration(dungeon, roomId, work, m.store);
    const shown = first.status === "ready" ? (first.spots ?? []).filter((s) => s.how === "shown") : [];
    expect(shown.length).toBeGreaterThan(0);
    expect(shown.every((s) => s.how === "shown" && s.x === 0.123 && s.y === 0.456)).toBe(true);
    expect(await serveIllustration(dungeon, roomId, work, m.store)).toEqual(first);
    expect(calls.draw).toBe(1);
    expect(placeCalls).toBe(1);
  });

  it("keeps the geometry's buttons, and the picture, when placing them fails", async () => {
    const m = memoryStore();
    const { work } = fakeWork();
    work.place = async () => {
      throw new Error("no");
    };
    const got = await serveIllustration(dungeon, roomId, work, m.store);
    expect(got.status === "ready" && got.spots).toEqual(illustrationSpots(roomIllustration(d, roomId, door)!));
    expect(m.row(room)!.meta.spots).toBeUndefined();
  });

  it("asks for the setting line once per dungeon", async () => {
    const m = memoryStore();
    const { work, calls } = fakeWork();
    for (const id of d.graph.rooms.map((r) => r.entityId)) await serveIllustration(dungeon, id, work, m.store);
    expect(calls.visual).toBeGreaterThan(1);
    expect(calls.setting).toBe(1);
  });

  it("answers pending while another request holds a fresh claim, and takes over a stale one", async () => {
    const m = memoryStore();
    await m.store.claimAsset(room, "x", { staleMs: ILLUSTRATION_CLAIM_STALE_MS, maxAttempts: ILLUSTRATION_MAX_ATTEMPTS });
    const { work, calls } = fakeWork();
    expect(await serveIllustration(dungeon, roomId, work, m.store)).toEqual({ status: "pending" });
    m.tick(ILLUSTRATION_CLAIM_STALE_MS + 1);
    expect((await serveIllustration(dungeon, roomId, work, m.store)).status).toBe("ready");
    expect(calls.draw).toBe(1);
  });

  it("is a missing picture on failure, retried until the attempts run out", async () => {
    const m = memoryStore();
    const { work, calls } = fakeWork({ fail: true });
    for (let i = 0; i < ILLUSTRATION_MAX_ATTEMPTS + 2; i++) {
      expect(await serveIllustration(dungeon, roomId, work, m.store)).toEqual({ status: "none" });
    }
    expect(calls.draw).toBe(ILLUSTRATION_MAX_ATTEMPTS);
  });
});

describe("assetPath", () => {
  it("names a new file for every drawing, under the kind and the dungeon's art", () => {
    expect(assetPath(room, 1)).not.toBe(assetPath(room, 2));
    expect(assetPath(room, 1).startsWith("room/root-1/")).toBe(true);
    expect(assetPath({ ...room, subject: "other" }, 1)).not.toBe(assetPath(room, 1));
  });
});

describe("serveCover", () => {
  it("is drawn from the opening and the way in, once", async () => {
    const m = memoryStore();
    const { work, calls } = fakeWork();
    const first = await serveCover(dungeon, work, m.store);
    expect(first.status === "ready" && first.url).toMatch(/^https:\/\/cdn\.example\/illustrations\/cover\/root-1\//);
    expect(await serveCover(dungeon, work, m.store)).toEqual(first);
    expect(calls.draw).toBe(1);
    expect(calls.scenes[0]).toContain(d.pass.openingProse);
    expect(calls.scenes[0]).toMatch(/THE WAY IN: .+/);
    expect(calls.prompts[0]).toContain("A ruined tower on a bare hill.");
  });

  it("describes the surface way into the first room", () => {
    const way = d.entities.connectors.find((c) => c.endpointB === null && c.endpointA === d.stocked.entranceRoomId)!;
    expect(coverDescription(d)).toContain(`THE WAY IN: ${way.name}.`);
  });
});

describe("inkPng", () => {
  it("keeps the ink black and opaque and makes the paper transparent", async () => {
    const { data, info } = await sharp(await inkPng(await picture())).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const px = (x: number, y: number) => [...data.subarray((y * info.width + x) * 4, (y * info.width + x) * 4 + 4)];
    expect(px(10, 10)).toEqual([0, 0, 0, 255]);
    expect(px(1, 1)[3]).toBe(0);
  });
});
