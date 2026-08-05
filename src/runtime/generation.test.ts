import { describe, expect, it } from "vitest";
import {
  applyContentPass,
  applyDungeonPass,
  buildContentPassPayload,
  buildDungeonPassPayload,
  DungeonPassError,
  generateBlueprint,
  generateBlueprintSeed,
  renderContentPassPrompt,
  renderDungeonPassPrompt,
  resolveBase,
  Rng,
  runEntitiesPass,
  stockDungeon,
  type ContentPassPayload,
  type ContentPassResponse,
  type DungeonPassResponse,
  type Size,
} from "../engine/index.ts";
import { validateWritten, type GeneratedDungeon } from "./generate.ts";
import { chunksFor, deriveSeeds } from "./seeds.ts";
import { contentPassSchema, dungeonPassSchema } from "./llm/schemas.ts";
import { extractJson, ResponseFormatError, validate } from "./llm/json.ts";

// ===========================================================================
// AN OFFLINE PIPELINE
// ===========================================================================
// Everything except the two model calls is deterministic, so the whole shape of
// generation can be exercised for free by standing in for the model. The fakes
// answer exactly what the payload asked for — which is also the bar a real
// response has to clear.

function fakeDungeonPass(groupIds: string[]): DungeonPassResponse {
  return {
    name: "The Sunken Mint",
    theme: "Wet limestone, green light through flooded shafts, a constant drip.",
    history: "A coin works drowned by the river it was built to exploit.",
    goal: { summary: "Recover the master die.", spec: "The player carries the master die out through the entrance." },
    openingProse: "The stair goes down into standing water.",
    groups: groupIds.map((id, i) => ({
      id,
      name: `Group ${i + 1} Folk`,
      base: `A standing description of group ${i + 1}, true of every one of them.`,
    })),
  };
}

/** Answer a content-pass payload point for point, the way the schema demands. */
function fakeContentPass(p: ContentPassPayload): ContentPassResponse {
  return {
    rooms: p.rooms.map((r) => ({
      ref: r.ref,
      name: `Room ${r.ref}`,
      base: `A ${r.identity}, ${r.tension}, at ${r.depth} depth.`,
      entities: r.entities.map((e) => ({ ref: e.ref, name: `${e.kind} thing`, base: `A written ${e.kind}.` })),
      connectors: r.connectors.map((c) => ({
        ref: c.ref,
        name: c.gated ? "Barred door" : "Low arch",
        form: c.gated ? "a plank door, barred from the far side" : "a low arch",
        ...(c.gated ? { requirement: "the bar must be lifted from the other side" } : {}),
      })),
      encounters: r.encounters.map((en) => ({
        ref: en.ref,
        ...(en.group
          ? { group: { name: "Rank and file", base: "The mass, written once.", activity: en.activity } }
          : {}),
        ...(en.distinct.length
          ? {
              distinct: en.distinct.map((d) => ({
                kind: d.kind,
                ...(d.member ? { member: d.member } : {}),
                name: d.kind === "elite" ? "The big one" : "A named person",
                base: `A distinct ${d.kind}.`,
                ...(d.isLeader ? { isLeader: true } : {}),
                activity: en.activity,
              })),
            }
          : {}),
      })),
      ...(r.goal ? { goal: { entityType: "Item" as const, name: "The master die", base: "A steel coin die." } } : {}),
    })),
  };
}

function generateOffline(seed: number, size: Size): GeneratedDungeon {
  const seeds = deriveSeeds(seed);
  const blueprint = generateBlueprintSeed(size, seeds.blueprintSeed, 1);
  const { dungeon } = generateBlueprint(seeds.graphSeed, { chunks: chunksFor(size) }, true);
  const stocked = stockDungeon(dungeon, blueprint, { level: 1, seed: seeds.stockSeed });
  const entities = runEntitiesPass(stocked, blueprint, new Rng(stocked.seed));

  const dpPayload = buildDungeonPassPayload(blueprint);
  // Round-trip the fake through zod, so the fakes stay honest about the schema.
  const dp = applyDungeonPass(validate(dungeonPassSchema, fakeDungeonPass(dpPayload.groupIds)), dpPayload);
  Object.assign(entities.registry.groups, dp.groups);

  const chunks = [...new Set(stocked.rooms.map((r) => r.chunk))].sort((a, b) => a - b);
  for (const chunk of chunks) {
    const payload = buildContentPassPayload(stocked, blueprint, entities, chunk, dp.dungeonContext);
    const res = validate(contentPassSchema, fakeContentPass(payload));
    applyContentPass(res, payload, entities, blueprint, stocked, new Rng(stocked.seed + chunk));
  }

  return {
    id: blueprint.id,
    seeds,
    size,
    level: 1,
    dungeonContext: dp.dungeonContext,
    pass: dp.pass,
    blueprint,
    graph: dungeon,
    stocked,
    entities,
    usage: { inputTokens: 0, outputTokens: 0 },
  };
}

// ===========================================================================
// DUNGEON PASS
// ===========================================================================

describe("dungeon pass", () => {
  const bp = generateBlueprintSeed(3, 1005, 1);
  const payload = buildDungeonPassPayload(bp);

  it("asks for exactly the inhabitant group ids", () => {
    expect(payload.groupIds).toEqual(bp.inhabitants.map((g) => g.id));
    expect(payload.groupIds.length).toBeGreaterThan(0);
  });

  it("puts every group id in the prompt", () => {
    const prompt = renderDungeonPassPrompt(payload);
    for (const id of payload.groupIds) expect(prompt).toContain(id);
  });

  it("accepts a response covering every group", () => {
    const r = applyDungeonPass(fakeDungeonPass(payload.groupIds), payload);
    expect(Object.keys(r.groups).sort()).toEqual([...payload.groupIds].sort());
  });

  it("refuses a response missing a group", () => {
    const res = fakeDungeonPass(payload.groupIds);
    res.groups.pop();
    expect(() => applyDungeonPass(res, payload)).toThrow(DungeonPassError);
    expect(() => applyDungeonPass(res, payload)).toThrow(/no base returned/);
  });

  it("refuses a response inventing a group", () => {
    const res = fakeDungeonPass(payload.groupIds);
    res.groups.push({ id: "not-a-real-group", name: "Ghosts", base: "..." });
    expect(() => applyDungeonPass(res, payload)).toThrow(/unknown group/);
  });

  it("refuses an empty base", () => {
    const res = fakeDungeonPass(payload.groupIds);
    res.groups[0].base = "   ";
    expect(() => applyDungeonPass(res, payload)).toThrow(/empty name or base/);
  });
});

// ===========================================================================
// THE STANDING FICTION
// ===========================================================================

describe("dungeonContext", () => {
  const gd = generateOffline(1005, 2);

  it("names every inhabitant group", () => {
    for (const g of gd.blueprint.inhabitants) {
      expect(gd.dungeonContext).toContain(gd.entities.registry.groups[g.id].name!);
    }
  });

  it("carries the theme, the history, and the goal", () => {
    expect(gd.dungeonContext).toContain(gd.pass.theme);
    expect(gd.dungeonContext).toContain(gd.pass.history);
    expect(gd.dungeonContext).toContain(gd.pass.goal.summary);
    expect(gd.dungeonContext).toContain(gd.pass.goal.spec);
  });

  it("mentions no wanderer group — they are filler, not the population", () => {
    expect(gd.stocked.wandererGroups.length).toBeGreaterThan(0);
    for (const w of gd.stocked.wandererGroups) {
      expect(gd.dungeonContext).not.toContain(w.id);
      const name = gd.entities.registry.groups[w.id]?.name;
      if (name) expect(gd.dungeonContext).not.toContain(name);
    }
  });
});

// ===========================================================================
// GROUP BASES
// ===========================================================================

describe("group bases", () => {
  const gd = generateOffline(1005, 2);

  it("inhabitant bases come from the dungeon pass and survive every chunk", () => {
    for (const g of gd.blueprint.inhabitants) {
      const tpl = gd.entities.registry.groups[g.id];
      expect(tpl, `no template for ${g.id}`).toBeDefined();
      expect(tpl.base).toMatch(/^A standing description of group/);
    }
  });

  it("wanderer bases are filled in by the content pass", () => {
    const written = gd.stocked.wandererGroups.filter((w) => gd.entities.registry.groups[w.id]?.base);
    expect(written.length).toBeGreaterThan(0);
    for (const w of written) {
      expect(gd.entities.registry.groups[w.id].base).toBe("The mass, written once.");
    }
  });

  it("every creature and hazard resolves a base", () => {
    for (const c of gd.entities.creatures) {
      expect(resolveBase(c, gd.entities.registry), `creature ${c.name || c.id}`).toBeTruthy();
    }
    for (const h of gd.entities.hazards) {
      expect(resolveBase(h, gd.entities.registry), `hazard ${h.name || h.id}`).toBeTruthy();
    }
  });

  it("prefers an inline base over the group's", () => {
    const reg = { creatures: {}, hazards: {}, groups: { g1: { id: "g1", base: "group base" } } };
    const named = { id: "x", name: "Wen", type: "Creature" as const, base: "her own identity", narrative: { blueprintId: "g1" } };
    const anon = { id: "y", name: "Folk", type: "Creature" as const, narrative: { blueprintId: "g1" } };
    expect(resolveBase(named as never, reg as never)).toBe("her own identity");
    expect(resolveBase(anon as never, reg as never)).toBe("group base");
  });
});

// ===========================================================================
// A FULLY WRITTEN DUNGEON
// ===========================================================================

// ===========================================================================
// CONCEALED WAYS  — the one kind of hidden thing generation settles
// ===========================================================================

describe("hidden connectors", () => {
  const seeds = [1005, 4242, 77, 31337, 909];

  it("only ever conceals a way that was going to be special anyway", () => {
    for (const seed of seeds) {
      const gd = generateOffline(seed, 3);
      // Concealment is drawn from the gated set, so the count of ordinary open
      // ways is untouched by the roll.
      const special = gd.stocked.connectors.filter((c) => c.gated || c.hidden);
      expect(special.length).toBeGreaterThan(0);
      expect(special.length).toBeLessThan(gd.stocked.connectors.length);
    }
  });

  it("leaves the goal reachable without finding a single secret", () => {
    // THE progression guarantee, and the only one that matters: a player who
    // never searches anything can still finish the dungeon.
    for (const seed of seeds) {
      const gd = generateOffline(seed, 3);
      const open = new Map<string, string[]>();
      for (const r of gd.stocked.rooms) open.set(r.roomId, []);
      for (const c of gd.stocked.connectors) {
        if (c.hidden) continue;
        open.get(c.a)!.push(c.b);
        open.get(c.b)!.push(c.a);
      }

      const seen = new Set([gd.stocked.entranceRoomId]);
      const queue = [gd.stocked.entranceRoomId];
      while (queue.length) {
        for (const next of open.get(queue.shift()!) ?? []) {
          if (!seen.has(next)) { seen.add(next); queue.push(next); }
        }
      }
      expect(seen.has(gd.stocked.goalRoomId), `seed ${seed}: the goal is behind a secret`).toBe(true);
    }
  });

  it("only ever seals a dead end, which is the deliberate secret room", () => {
    // `canGate` refuses to gate the last way into any room EXCEPT the one the
    // structural pass nominated as secret, and concealment only draws from the
    // gated set. So a room can end up wholly behind a secret door — but only
    // that one, and only if it is a degree-1 cache. That is a reward for
    // searching, not a soft lock.
    for (let seed = 1; seed <= 30; seed++) {
      const gd = generateOffline(seed, 3);
      const degree = new Map<string, number>();
      const open = new Map<string, number>();
      for (const r of gd.stocked.rooms) { degree.set(r.roomId, 0); open.set(r.roomId, 0); }
      for (const c of gd.stocked.connectors) {
        degree.set(c.a, degree.get(c.a)! + 1);
        degree.set(c.b, degree.get(c.b)! + 1);
        if (c.hidden) continue;
        open.set(c.a, open.get(c.a)! + 1);
        open.set(c.b, open.get(c.b)! + 1);
      }

      for (const [id, n] of open) {
        if (n > 0) continue;
        expect(degree.get(id), `seed ${seed}: sealed a room with more than one way in`).toBe(1);
        expect(id, `seed ${seed}: sealed the entrance`).not.toBe(gd.stocked.entranceRoomId);
        expect(id, `seed ${seed}: sealed the goal`).not.toBe(gd.stocked.goalRoomId);
      }
    }
  });

  it("keeps secret passages occasional rather than routine", () => {
    // Across a spread of seeds, concealed ways should be a small minority of
    // all ways. Common secret doors stop being a discovery and become a tax.
    let hidden = 0;
    let total = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const gd = generateOffline(seed, 3);
      total += gd.stocked.connectors.length;
      hidden += gd.stocked.connectors.filter((c) => c.hidden).length;
    }
    const share = hidden / total;
    expect(share).toBeGreaterThan(0);
    expect(share).toBeLessThan(0.12);
  });

  it("carries the flag onto the connector entity", () => {
    const gd = generateOffline(1005, 3);
    const stocked = new Map(gd.stocked.connectors.map((c) => [c.id, c]));
    for (const conn of gd.entities.connectors) {
      expect(conn.isHidden === true).toBe(stocked.get(conn.id)!.hidden);
    }
  });

  it("is the same for the same seed", () => {
    const a = generateOffline(1005, 3).stocked.connectors.map((c) => [c.gated, c.hidden]);
    const b = generateOffline(1005, 3).stocked.connectors.map((c) => [c.gated, c.hidden]);
    expect(a).toEqual(b);
  });
});

describe("validateWritten", () => {
  it.each([1005, 4242, 77])("seed %i produces no problems offline", (seed) => {
    expect(validateWritten(generateOffline(seed, 2))).toEqual([]);
  });

  it("reports a connector left without a physical form", () => {
    const gd = generateOffline(1005, 1);
    delete (gd.entities.connectors[0] as { base?: string }).base;
    expect(validateWritten(gd).map((p) => p.kind)).toContain("unwritten-connector");
  });

  it("reports a creature whose group base never arrived", () => {
    const gd = generateOffline(1005, 1);
    for (const id of Object.keys(gd.entities.registry.groups)) {
      delete gd.entities.registry.groups[id].base;
    }
    expect(validateWritten(gd).map((p) => p.kind)).toContain("missing-base");
  });
});

// ===========================================================================
// RESPONSE HANDLING
// ===========================================================================

describe("json handling", () => {
  it("parses a bare object", () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });

  it("parses a fenced object", () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it("parses an object behind a preamble", () => {
    expect(extractJson('Sure, here you go:\n{"a":1}\nHope that helps!')).toEqual({ a: 1 });
  });

  it("is not fooled by braces inside strings", () => {
    expect(extractJson('{"a":"}{","b":2}')).toEqual({ a: "}{", b: 2 });
  });

  it("raises on an unterminated object", () => {
    expect(() => extractJson('{"a":')).toThrow(ResponseFormatError);
  });

  it("raises on no object at all", () => {
    expect(() => extractJson("I would rather not.")).toThrow(/no JSON object/);
  });

  it("turns validation failures into feedback a retry can use", () => {
    try {
      validate(dungeonPassSchema, { name: "x" });
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ResponseFormatError);
      const err = e as ResponseFormatError;
      expect(err.issues.length).toBeGreaterThan(0);
      expect(err.feedback).toContain("failed validation");
      expect(err.feedback).toContain("theme");
    }
  });
});

// ===========================================================================
// PROMPT SNAPSHOTS  (a prompt change should be a visible diff in review)
// ===========================================================================

/**
 * Ids are deliberately unseeded (G5) — `makeId` is crypto.randomUUID — and they
 * appear all through both prompts: entity refs in the content pass, and group
 * ids in the dungeon pass, since `genMonsterGroup`/`genPeopleGroup` mint theirs
 * from `makeId` too (despite the `<dungeonId>:g<i>` doc comment on those types).
 * Redact them, or a snapshot passes once on the run that writes it and fails on
 * every run after.
 */
const redactIds = (s: string) =>
  s.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<id>");

describe("prompt snapshots", () => {
  const seed = 1005;
  const seeds = deriveSeeds(seed);
  const bp = generateBlueprintSeed(1, seeds.blueprintSeed, 1);

  it("dungeon pass", () => {
    expect(redactIds(renderDungeonPassPrompt(buildDungeonPassPayload(bp)))).toMatchSnapshot();
  });

  it("content pass, chunk 0", () => {
    const { dungeon } = generateBlueprint(seeds.graphSeed, { chunks: 1 }, true);
    const sd = stockDungeon(dungeon, bp, { level: 1, seed: seeds.stockSeed });
    const ep = runEntitiesPass(sd, bp, new Rng(sd.seed));
    expect(
      redactIds(renderContentPassPrompt(buildContentPassPayload(sd, bp, ep, 0, "[dungeon context]")))
    ).toMatchSnapshot();
  });
});
