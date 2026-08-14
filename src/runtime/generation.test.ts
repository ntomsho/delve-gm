import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyContentPass,
  applyDungeonPass,
  applySeamsPass,
  blockPlanValid,
  buildContentPassPayload,
  buildDungeonPassPayload,
  buildSeamsPassPayload,
  contentPassOmissions,
  seamsPassOmissions,
  DungeonPassError,
  generateBlueprint,
  generateBlueprintSeed,
  isSurfaceExit,
  renderContentPassPrompt,
  renderDungeonPassPrompt,
  renderSeamsPassPrompt,
  resolveBase,
  Rng,
  roomSizes,
  runEntitiesPass,
  siteRooms,
  stockDungeon,
  type BlockPlan,
  type ContentPassPayload,
  type ContentPassResponse,
  type DungeonPassResponse,
  type SeamsPassPayload,
  type SeamsPassResponse,
  type Size,
} from "../engine/index.ts";
import { validateWritten, type GeneratedDungeon } from "./generate.ts";
import { chunksFor, deriveSeeds } from "./seeds.ts";
import { contentPassSchema, dungeonPassSchema, seamsPassSchema } from "./llm/schemas.ts";
import { extractJson, ResponseFormatError, validate } from "./llm/json.ts";
import { callForJson, type FailedAttempt } from "./llm/client.ts";

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

/** Answer a seams payload point for point, naming both rooms in the form. */
function fakeSeamsPass(p: SeamsPassPayload): SeamsPassResponse {
  return {
    connectors: p.seams.map((s) => ({
      ref: s.ref,
      name: "Flooded stair",
      form: `a stair, ${s.a.name} at its head and ${s.b.name} at its foot`,
      ...(s.gated ? { requirement: "silted up; it must be dug clear" } : {}),
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
      // A seam is listed for the count and written by the seams pass; a chunk
      // that answered with one would be writing a room it cannot see.
      connectors: r.connectors.filter((c) => !c.seam).map((c) => ({
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

  // Last, once every room has a name and a base: the ways between the chunks.
  const seams = buildSeamsPassPayload(stocked, entities, dp.dungeonContext);
  if (seams.seams.length > 0) {
    applySeamsPass(validate(seamsPassSchema, fakeSeamsPass(seams)), seams, entities);
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
    blockplan: null,
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
  // 1008 rather than the usual 1005: this block and the next one need a dungeon
  // that actually stocks wanderers, and whether a seed does is a roll like any
  // other. The assertions are otherwise seed-agnostic. It moved from 1007 when
  // corridor designation added a draw to stocking and shifted every roll after
  // it — which is what that comment is here to make cheap to fix.
  const gd = generateOffline(1008, 2);

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
  const gd = generateOffline(1008, 2);

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
// WHO WRITES A WAY THROUGH
// ===========================================================================
// One connector, two rooms, one writer — and the writer has to be able to see
// both rooms. Chunks manage that only inside themselves; everything crossing a
// boundary waits for the seams pass. Before that split, both chunks wrote every
// connector between them, blind to the far room, and the higher chunk number
// silently won.

describe("connector ownership", () => {
  const build = (seed: number, size: Size) => {
    const seeds = deriveSeeds(seed);
    const blueprint = generateBlueprintSeed(size, seeds.blueprintSeed, 1);
    const { dungeon } = generateBlueprint(seeds.graphSeed, { chunks: chunksFor(size) }, true);
    const stocked = stockDungeon(dungeon, blueprint, { level: 1, seed: seeds.stockSeed });
    const entities = runEntitiesPass(stocked, blueprint, new Rng(stocked.seed));
    const chunks = [...new Set(stocked.rooms.map((r) => r.chunk))].sort((a, b) => a - b);
    const payloads = chunks.map((c) =>
      buildContentPassPayload(stocked, blueprint, entities, c, "[fiction]")
    );
    return { stocked, entities, payloads };
  };

  it.each([2, 3, 5] as Size[])("size %i: every connector is written exactly once", (size) => {
    const { stocked, entities, payloads } = build(1005, size);

    const writers = new Map<string, number>();
    for (const p of payloads) {
      for (const r of p.rooms) {
        for (const c of r.connectors) {
          if (c.seam) continue;
          writers.set(c.ref, (writers.get(c.ref) ?? 0) + 1);
        }
      }
    }
    for (const s of buildSeamsPassPayload(stocked, entities, "[fiction]").seams) {
      writers.set(s.ref, (writers.get(s.ref) ?? 0) + 1);
    }

    for (const conn of entities.connectors) {
      expect(writers.get(conn.id), `connector ${conn.id} has no writer`).toBe(1);
    }
  });

  it("hands the chunk boundaries to the seams pass and nobody else", () => {
    const { stocked, entities, payloads } = build(1005, 3);
    const chunkOf = new Map(stocked.rooms.map((r) => [r.roomId, r.chunk]));
    const crossing = entities.connectors.filter(
      (c) => c.endpointB !== null && chunkOf.get(c.endpointA) !== chunkOf.get(c.endpointB)
    );
    expect(crossing.length).toBeGreaterThan(0);

    const seams = new Set(
      buildSeamsPassPayload(stocked, entities, "[fiction]").seams.map((s) => s.ref)
    );
    expect([...crossing].map((c) => c.id).sort()).toEqual([...seams].sort());

    // And no chunk claims one, though each still lists it so its rooms know how
    // many ways out they have.
    for (const p of payloads) {
      for (const r of p.rooms) {
        for (const c of r.connectors) {
          if (seams.has(c.ref)) expect(c.seam).toBe(true);
        }
      }
    }
  });

  it("shows the seams pass both rooms, written", () => {
    const gd = generateOffline(1005, 3);
    const payload = buildSeamsPassPayload(gd.stocked, gd.entities, gd.dungeonContext);
    for (const s of payload.seams) {
      expect(s.a.name).not.toBe("");
      expect(s.b.name).not.toBe("");
      expect(s.a.base).not.toBe("");
      expect(s.b.base).not.toBe("");
    }
    // Which is what lets the form name the upper room — see CONNECTOR_HEIGHT.
    const written = gd.entities.connectors.find((c) => c.id === payload.seams[0].ref)!;
    expect(written.base).toContain(payload.seams[0].a.name);
  });

  it("ignores a chunk that answers with a seam anyway", () => {
    const seeds = deriveSeeds(1005);
    const blueprint = generateBlueprintSeed(2, seeds.blueprintSeed, 1);
    const { dungeon } = generateBlueprint(seeds.graphSeed, { chunks: chunksFor(2) }, true);
    const stocked = stockDungeon(dungeon, blueprint, { level: 1, seed: seeds.stockSeed });
    const entities = runEntitiesPass(stocked, blueprint, new Rng(stocked.seed));

    const payload = buildContentPassPayload(stocked, blueprint, entities, 0, "[fiction]");
    const room = payload.rooms.find((r) => r.connectors.some((c) => c.seam))!;
    const seam = room.connectors.find((c) => c.seam)!;

    const res = fakeContentPass(payload);
    res.rooms
      .find((r) => r.ref === room.ref)!
      .connectors!.push({ ref: seam.ref, name: "Wrong", form: "written by half a writer" });

    applyContentPass(res, payload, entities, blueprint, stocked, new Rng(stocked.seed));
    expect(entities.connectors.find((c) => c.id === seam.ref)!.base).toBeUndefined();
  });

  // 8f. One R2 dungeon held "The Residue", "The Cutlass", "The ledger" and
  // "unmarked ledger" at once, because a name arrives in whatever register the
  // model's sentence was in. Normalised once, at the top of the apply, so a
  // twelfth assignment site cannot miss it.
  it("capitalises every name it was handed, and touches nothing else", () => {
    const seeds = deriveSeeds(1005);
    const blueprint = generateBlueprintSeed(2, seeds.blueprintSeed, 1);
    const { dungeon } = generateBlueprint(seeds.graphSeed, { chunks: chunksFor(2) }, true);
    const stocked = stockDungeon(dungeon, blueprint, { level: 1, seed: seeds.stockSeed });
    const entities = runEntitiesPass(stocked, blueprint, new Rng(stocked.seed));

    const payload = buildContentPassPayload(stocked, blueprint, entities, 0, "[fiction]");
    const res = fakeContentPass(payload);
    // Lower-case it all, the way a model writing mid-sentence does.
    for (const r of res.rooms) {
      r.name = r.name.toLowerCase();
      for (const e of r.entities ?? []) e.name = e.name.toLowerCase();
      for (const c of r.connectors ?? []) c.name = c.name.toLowerCase();
    }
    const written = res.rooms[0];

    applyContentPass(res, payload, entities, blueprint, stocked, new Rng(stocked.seed));

    const room = entities.rooms.find((r) => r.name?.toLowerCase() === written.name)!;
    expect(room.name![0]).toBe(room.name![0].toUpperCase());
    for (const w of written.entities ?? []) {
      const e = [...entities.features, ...entities.items, ...entities.hazards].find((x) => x.id === w.ref);
      if (e?.name) expect(e.name[0]).toBe(e.name[0].toUpperCase());
    }
    // On a copy: the response is what the journal recorded, and a record that
    // disagrees with the call it records is worse than a lower-case name.
    expect(written.name).toBe(written.name.toLowerCase());
  });
});

// ===========================================================================
// A WELL-FORMED ANSWER THAT LEAVES SOMETHING OUT
// ===========================================================================
// The one live defect out of Phase 1, §1.1. A chunk answering five of six
// connectors is valid JSON against a valid schema, so zod passes it, apply
// applies it, and nothing notices until `validateWritten` sweeps at the end —
// after the pass is over and the one retry has gone unspent. These are the
// assertions that the question gets asked while the retry is still there to
// take.

describe("chunk completeness", () => {
  const payloadsOf = (seed: number, size: Size) => {
    const seeds = deriveSeeds(seed);
    const blueprint = generateBlueprintSeed(size, seeds.blueprintSeed, 1);
    const { dungeon } = generateBlueprint(seeds.graphSeed, { chunks: chunksFor(size) }, true);
    const stocked = stockDungeon(dungeon, blueprint, { level: 1, seed: seeds.stockSeed });
    const entities = runEntitiesPass(stocked, blueprint, new Rng(stocked.seed));
    const chunks = [...new Set(stocked.rooms.map((r) => r.chunk))].sort((a, b) => a - b);
    return {
      stocked,
      entities,
      payloads: chunks.map((c) => buildContentPassPayload(stocked, blueprint, entities, c, "[fiction]")),
    };
  };

  const { payloads } = payloadsOf(1005, 3);

  /** The first payload holding the thing this test is about to delete. */
  const holding = (has: (p: ContentPassPayload) => boolean): ContentPassPayload => {
    const p = payloads.find(has);
    // A fixture lookup that returns early when it finds nothing asserts nothing
    // and passes. If a seed reroll ever empties one of these, this is what says
    // so instead of the suite going quietly green.
    expect(p, "no chunk in this dungeon carries what the test needs").toBeDefined();
    return p!;
  };

  it("says nothing about an answer that covered everything", () => {
    // Across every chunk, and the fake is a complete answer by construction —
    // so this is also the assertion that the check does not fire on the shape
    // the pipeline actually produces.
    for (const p of payloads) expect(contentPassOmissions(p, fakeContentPass(p))).toEqual([]);

    // And the payloads really did ask for all four things, so the emptiness
    // above is a pass rather than an absence of anything to check.
    const rooms = payloads.flatMap((p) => p.rooms);
    expect(rooms.flatMap((r) => r.entities).length).toBeGreaterThan(0);
    expect(rooms.flatMap((r) => r.connectors.filter((c) => !c.seam)).length).toBeGreaterThan(0);
    expect(rooms.flatMap((r) => r.encounters).length).toBeGreaterThan(0);
    expect(rooms.filter((r) => r.goal).length).toBe(1);
  });

  it("names a room that never came back", () => {
    const p = payloads[0];
    const res = fakeContentPass(p);
    const dropped = res.rooms.pop()!;

    const out = contentPassOmissions(p, res);
    expect(out).toHaveLength(1);
    expect(out[0].message).toContain(dropped.ref);
    expect(out[0].path).toBe(`rooms.${dropped.ref}`);
  });

  // THE ONE THAT WAS SEEN LIVE: a connector between two rooms in the same
  // chunk, so not a seam, simply left out of an otherwise well-formed response.
  it("names a connector left out of a room that did come back", () => {
    const p = holding((x) => x.rooms.some((r) => r.connectors.some((c) => !c.seam)));
    const room = p.rooms.find((r) => r.connectors.some((c) => !c.seam))!;
    const res = fakeContentPass(p);
    const written = res.rooms.find((r) => r.ref === room.ref)!;
    const dropped = written.connectors!.pop()!;

    const out = contentPassOmissions(p, res);
    expect(out).toHaveLength(1);
    expect(out[0].message).toContain(dropped.ref);
    expect(out[0].path).toBe(`rooms.${room.ref}.connectors`);
  });

  it("says nothing about a seam, which the chunk is told not to write", () => {
    const p = holding((x) => x.rooms.some((r) => r.connectors.some((c) => c.seam)));
    // `fakeContentPass` already omits every seam, so a clean report here is the
    // whole assertion: the check agrees with HARD RULE 1 rather than demanding
    // back the one thing the instructions forbid.
    expect(contentPassOmissions(p, fakeContentPass(p))).toEqual([]);
  });

  it("names a missing entity", () => {
    const p = holding((x) => x.rooms.some((r) => r.entities.length > 0));
    const room = p.rooms.find((r) => r.entities.length > 0)!;
    const res = fakeContentPass(p);
    const dropped = res.rooms.find((r) => r.ref === room.ref)!.entities!.pop()!;

    const out = contentPassOmissions(p, res);
    expect(out).toHaveLength(1);
    expect(out[0].message).toContain(dropped.ref);
  });

  it("names the goal the goal room did not write", () => {
    const p = holding((x) => x.rooms.some((r) => r.goal));
    const room = p.rooms.find((r) => r.goal)!;
    const res = fakeContentPass(p);
    delete res.rooms.find((r) => r.ref === room.ref)!.goal;

    const out = contentPassOmissions(p, res);
    expect(out).toHaveLength(1);
    expect(out[0].path).toBe(`rooms.${room.ref}.goal`);
  });

  // An encounter is up to two entities and each is separately omittable, so
  // each is asked about separately: a response can carry the encounter, write
  // the rank and file, and drop the named leader standing in front of them.
  //
  // Two tests rather than one because an encounter holding BOTH is a roll — a
  // people group needs `undefinedUnderlings` for a mass to sit beside its named
  // members — and pinning the pair to a seed would make this suite depend on
  // stocking's draw order for no gain.
  it("names an encounter that came back without its mass", () => {
    const p = holding((x) => x.rooms.some((r) => r.encounters.some((e) => e.group)));
    const room = p.rooms.find((r) => r.encounters.some((e) => e.group))!;
    const en = room.encounters.find((e) => e.group)!;

    const res = fakeContentPass(p);
    delete res.rooms.find((r) => r.ref === room.ref)!.encounters!.find((e) => e.ref === en.ref)!.group;

    const out = contentPassOmissions(p, res);
    expect(out).toHaveLength(1);
    expect(out[0].path).toBe(`rooms.${room.ref}.encounters.${en.ref}.group`);
  });

  it("names a specimen dropped from an encounter that did come back", () => {
    const p = holding((x) => x.rooms.some((r) => r.encounters.some((e) => e.distinct.length > 0)));
    const room = p.rooms.find((r) => r.encounters.some((e) => e.distinct.length > 0))!;
    const en = room.encounters.find((e) => e.distinct.length > 0)!;

    const res = fakeContentPass(p);
    const written = res.rooms.find((r) => r.ref === room.ref)!.encounters!.find((e) => e.ref === en.ref)!;
    const dropped = written.distinct!.pop()!;

    const out = contentPassOmissions(p, res);
    expect(out).toHaveLength(1);
    expect(out[0].path).toBe(`rooms.${room.ref}.encounters.${en.ref}.distinct`);
    expect(out[0].message).toContain(dropped.kind);
  });

  // Matched on kind AND member, the same join apply makes to find a specimen's
  // keywords — so a specimen returned under a member id nobody asked about has
  // lost its rolls just as surely as one that never came back.
  it("names a specimen returned under a member id that was not asked for", () => {
    const p = holding((x) => x.rooms.some((r) => r.encounters.some((e) => e.distinct.some((d) => d.member))));
    const room = p.rooms.find((r) => r.encounters.some((e) => e.distinct.some((d) => d.member)))!;
    const en = room.encounters.find((e) => e.distinct.some((d) => d.member))!;

    const res = fakeContentPass(p);
    const written = res.rooms.find((r) => r.ref === room.ref)!.encounters!.find((e) => e.ref === en.ref)!;
    written.distinct!.find((d) => d.member)!.member = "somebody-else";

    const out = contentPassOmissions(p, res);
    expect(out).toHaveLength(1);
    expect(out[0].message).toContain("has no entry matching it");
  });

  // The point of asking early. Stubbed at `fetch`, so the real client, the real
  // schema and the real retry policy are all in the path — what this asserts is
  // that an omission is spent as a retry rather than discovered afterwards.
  describe("through the client", () => {
    let queue: unknown[] = [];
    let sent: { messages: { role: string; content: unknown }[] }[] = [];

    beforeEach(() => {
      queue = [];
      sent = [];
      vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
        sent.push(JSON.parse(init.body));
        const next = queue.shift();
        if (next === undefined) {
          return { ok: false, status: 400, statusText: "no canned response left", text: async () => "" };
        }
        return { ok: true, json: async () => next };
      });
    });

    afterEach(() => vi.unstubAllGlobals());

    const answered = (res: ContentPassResponse) => ({
      content: [{ type: "tool_use", id: "t1", name: "write_region", input: res }],
      stop_reason: "tool_use",
      usage: { input_tokens: 100, output_tokens: 40 },
    });

    const p = payloads.find((x) => x.rooms.some((r) => r.connectors.some((c) => !c.seam)))!;
    const short = () => {
      const res = fakeContentPass(p);
      const room = res.rooms.find((r) => (r.connectors ?? []).length > 0)!;
      return { res, dropped: room.connectors!.pop()! };
    };

    const call = () =>
      callForJson({
        task: "content-pass",
        schema: contentPassSchema,
        toolName: "write_region",
        toolDescription: "Name and write every room, entity, connector, and creature group in this region.",
        messages: [{ role: "user", content: "[the chunk payload]" }],
        check: (v) => contentPassOmissions(p, v),
      });

    it("takes the retry, and names the missing ref in it", async () => {
      const { res, dropped } = short();
      queue.push(answered(res), answered(fakeContentPass(p)));

      const { value, attempts } = await call();

      expect(attempts).toBe(2);
      expect(contentPassOmissions(p, value)).toEqual([]);
      // The retry is only productive if the reasons name the way through — 8a
      // A2. Here that means the id of the connector that did not come back.
      expect(JSON.stringify(sent[1].messages)).toContain(dropped.ref);
      expect(sent).toHaveLength(2);
    });

    it("throws rather than applying a chunk that left it out twice", async () => {
      queue.push(answered(short().res), answered(short().res));
      await expect(call()).rejects.toThrow(ResponseFormatError);
      expect(sent).toHaveLength(2);
    });

    // CODING-PLAN §6.7. The `generation` event is written on success, so a pass
    // that never succeeds used to leave nothing but the word "shape" — no pass,
    // no chunk, no field, and no response to look at.
    it("reports every attempt that failed, with what was objected to", async () => {
      const { dropped } = short();
      queue.push(answered(short().res), answered(short().res));

      const reports: FailedAttempt[] = [];
      await expect(
        callForJson({
          task: "content-pass",
          schema: contentPassSchema,
          toolName: "write_region",
          toolDescription: "…",
          messages: [{ role: "user", content: "[the chunk payload]" }],
          check: (v) => contentPassOmissions(p, v),
          onAttemptFailed: (r) => reports.push(r),
        })
      ).rejects.toThrow(ResponseFormatError);

      // Both, not just the last. The same complaint twice is a prompt that
      // cannot be satisfied; two different ones is a model having a bad day,
      // and only having both tells them apart.
      expect(reports.map((r) => [r.attempt, r.willRetry])).toEqual([
        [1, true],
        [2, false],
      ]);
      expect(JSON.stringify(reports[0].issues)).toContain(dropped.ref);
      // The response itself, so the failure can be read rather than guessed at.
      expect(reports[0].raw).toBeTruthy();
    });

    it("does not lose the error when the reporter throws", async () => {
      queue.push(answered(short().res), answered(short().res));
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      await expect(
        callForJson({
          task: "content-pass",
          schema: contentPassSchema,
          toolName: "write_region",
          toolDescription: "…",
          messages: [{ role: "user", content: "[the chunk payload]" }],
          check: (v) => contentPassOmissions(p, v),
          onAttemptFailed: () => {
            throw new Error("the journal is on fire");
          },
        })
      ).rejects.toThrow(ResponseFormatError);

      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
    });
  });

  it("names a way through the seams pass left out", () => {
    const { stocked, entities } = payloadsOf(1005, 3);
    const payload = buildSeamsPassPayload(stocked, entities, "[fiction]");
    expect(payload.seams.length).toBeGreaterThan(0);
    expect(seamsPassOmissions(payload, fakeSeamsPass(payload))).toEqual([]);

    const res = fakeSeamsPass(payload);
    const dropped = res.connectors.pop()!;
    const out = seamsPassOmissions(payload, res);
    expect(out).toHaveLength(1);
    expect(out[0].message).toContain(dropped.ref);
  });
});

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
      // The way OUT of the dungeon is not in the topology pass — it joins a
      // room to nothing, and nothing is not a node.
      if (isSurfaceExit(conn)) continue;
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

  it("seams pass", () => {
    const gd = generateOffline(1005, 2);
    const payload = buildSeamsPassPayload(gd.stocked, gd.entities, "[dungeon context]");
    expect(redactIds(renderSeamsPassPrompt(payload))).toMatchSnapshot();
  });

  // WITH THE DRAWING, because that is what a live run sends. Built the way
  // `generate.ts` builds it — the layout hook inside stocking — so the "as
  // drawn" line, the per-connector wall and the fixture menu are all in the
  // snapshot. A snapshot of the geometry-free payload would pass forever while
  // the prompt the game actually sends drifted underneath it.
  it("content pass, chunk 0", () => {
    const { dungeon } = generateBlueprint(seeds.graphSeed, { chunks: 1 }, true);
    let plan: BlockPlan | null = null;
    const sd = stockDungeon(dungeon, bp, {
      level: 1,
      seed: seeds.stockSeed,
      layout: (rooms) => {
        const corridor = new Set(rooms.filter((r) => r.isCorridor).map((r) => r.index));
        plan = blockPlanValid(dungeon, (i) => corridor.has(i), seeds.layoutSeed);
        return plan ? roomSizes(plan.rooms) : rooms.map(() => undefined);
      },
    });
    const drawn = plan as BlockPlan | null;
    expect(drawn, "seed 1005 at size 1 has always drawn; the snapshot needs it").not.toBeNull();
    const ep = runEntitiesPass(sd, bp, new Rng(sd.seed));
    const corridors = new Set(sd.rooms.filter((r) => r.isCorridor).map((r) => r.index));
    const site = siteRooms(drawn!, dungeon, { isCorridor: (i) => corridors.has(i) });
    expect(
      redactIds(
        renderContentPassPrompt(buildContentPassPayload(sd, bp, ep, 0, "[dungeon context]", site))
      )
    ).toMatchSnapshot();
  });
});
