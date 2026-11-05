import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { applyContentPass } from "./content/passes/content-pass/apply.ts";
import { renderContentPassPrompt } from "./content/passes/content-pass/prompt.ts";
import {
  askForRooms,
  contentPassOmissions,
  mergeRooms,
  type ContentPassResponse,
} from "./content/passes/content-pass/response.ts";
import {
  buildContentPassPayload,
  type ContentPassPayload,
} from "./content/passes/content-pass/build.ts";
import {
  applyDungeonPass,
  buildDungeonPassPayload,
  DungeonPassError,
  renderDungeonPassPrompt,
  type DungeonPassResponse,
} from "./content/passes/dungeon-pass.ts";
import {
  applyKeysPass,
  buildKeysPassPayload,
  keysPassOmissions,
  renderKeysPassPrompt,
  type KeysPassPayload,
  type KeysPassResponse,
} from "./content/passes/keys-pass.ts";
import { blockPlanValid, roomSizes, type BlockPlan } from "./floorplan/blockplan.ts";
import { generateBlueprint } from "./floorplan/graph.ts";
import { generateBlueprintSeed, type Size } from "./content/blueprint.ts";
import { Rng } from "../shared/utils/rng.ts";
import { isSurfaceExit, resolveBase } from "../shared/world/entities.ts";
import { runEntitiesPass } from "./content/entities-pass.ts";
import { siteRooms } from "./floorplan/geometry.ts";
import { stockDungeon } from "./content/stock/stock.ts";
import {
  contentFrom,
  finishGeneration,
  generateContent,
  generateStep,
  generateStructure,
  validateWritten,
  type GeneratedDungeon,
} from "./generate.ts";
import { deriveSeeds, shapeFor } from "./seeds.ts";
import {
  contentPassSchema,
  dungeonPassSchema,
  dungeonPassToolSchema,
  fromDungeonPassTool,
  toDungeonPassTool,
  keysPassSchema,
} from "./content/passes/schemas.ts";
import { ResponseFormatError, validate } from "../llm/json.ts";
import { callForJson, configureTransport, type FailedAttempt } from "../llm/client.ts";

// The model client has no default URL. The stubbed `fetch` below answers any.
configureTransport({ baseUrl: "https://model.test" });

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

/** Answer a keys payload point for point, quoting the fact the way the real one must. */
function fakeKeysPass(p: KeysPassPayload): KeysPassResponse {
  return {
    keys: p.keys.map((k) => ({
      ref: k.ref,
      name: "Almoner's daybook",
      base: `A ledger. One line is underscored: "${k.target.fact}".`,
      ...(k.lockRef ? { lockRequirement: "silted up; the daybook says where the sluice is" } : {}),
    })),
    ...(p.goal ? { goalProperties: ["whose name is cut on the underside"] } : {}),
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
  const { dungeon } = generateBlueprint(seeds.graphSeed, shapeFor(size, seeds.graphSeed), true);
  const stocked = stockDungeon(dungeon, blueprint, { level: 1, seed: seeds.stockSeed });
  const entities = runEntitiesPass(stocked, blueprint, new Rng(stocked.seed));

  const dpPayload = buildDungeonPassPayload(blueprint);
  // Round-trip the fake through zod, so the fakes stay honest about the schema.
  const dp = applyDungeonPass(validate(dungeonPassSchema, fakeDungeonPass(dpPayload.groupIds)), dpPayload);
  Object.assign(entities.registry.groups, dp.groups);

  const payload = buildContentPassPayload(stocked, blueprint, entities, dp.dungeonContext);
  const res = validate(contentPassSchema, fakeContentPass(payload));
  applyContentPass(res, payload, entities, blueprint, stocked, new Rng(stocked.seed));

  // Last of all: the keys, which the content pass deliberately left nameless.
  const keys = buildKeysPassPayload(stocked, entities, dp.dungeonContext);
  if (keys.keys.length > 0 || keys.goal) {
    applyKeysPass(validate(keysPassSchema, fakeKeysPass(keys)), keys, stocked, entities);
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
    usage: { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 },
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

describe("what the model answers the dungeon pass with", () => {
  it("has nothing nested to write as a string", () => {
    const flat = Object.values(dungeonPassToolSchema.shape).filter((f) => f instanceof z.ZodObject);
    expect(flat).toEqual([]);
  });

  it("comes back to the shape the rest of the pipeline reads", () => {
    const res = fakeDungeonPass(["g1"]);
    expect(fromDungeonPassTool(toDungeonPassTool(res))).toEqual(res);
  });
});

describe("dungeonContext", () => {
  // 1008 rather than the usual 1005: this block and the next one need a dungeon
  // that actually stocks wanderers, and whether a seed does is a roll like any
  // other. The assertions are otherwise seed-agnostic. It moved from 1007 when
  // corridor designation added a draw to stocking and shifted every roll after
  // it, and back to 1007 when the graph became one region — which is what
  // this comment is here to make cheap to fix.
  const gd = generateOffline(1007, 2);

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
  const gd = generateOffline(1007, 2);

  it("inhabitant bases come from the dungeon pass and survive the content pass", () => {
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
// One connector, two rooms, one writer: the room with the lower graph index.
// The content pass sees every room, so the writer always has both in front of
// it; owning it from one side is what stops it being written twice.

describe("connector ownership", () => {
  const build = (seed: number, size: Size) => {
    const seeds = deriveSeeds(seed);
    const blueprint = generateBlueprintSeed(size, seeds.blueprintSeed, 1);
    const { dungeon } = generateBlueprint(seeds.graphSeed, shapeFor(size, seeds.graphSeed), true);
    const stocked = stockDungeon(dungeon, blueprint, { level: 1, seed: seeds.stockSeed });
    const entities = runEntitiesPass(stocked, blueprint, new Rng(stocked.seed));
    const payloads = [buildContentPassPayload(stocked, blueprint, entities, "[fiction]")];
    return { stocked, entities, payloads };
  };

  it.each([1, 2, 3] as Size[])("size %i: every connector is written exactly once", (size) => {
    const { entities, payloads } = build(1005, size);

    const writers = new Map<string, number>();
    for (const p of payloads) {
      for (const r of p.rooms) {
        for (const c of r.connectors) {
          writers.set(c.ref, (writers.get(c.ref) ?? 0) + 1);
        }
      }
    }

    for (const conn of entities.connectors) {
      expect(writers.get(conn.id), `connector ${conn.id} has no writer`).toBe(1);
    }
  });

  // One playtest-R2 dungeon held "The Residue", "The Cutlass", "The ledger" and
  // "unmarked ledger" at once, because a name arrives in whatever register the
  // model's sentence was in. Normalised once, at the top of the apply, so a
  // twelfth assignment site cannot miss it.
  it("capitalises every name it was handed, and touches nothing else", () => {
    const seeds = deriveSeeds(1005);
    const blueprint = generateBlueprintSeed(2, seeds.blueprintSeed, 1);
    const { dungeon } = generateBlueprint(seeds.graphSeed, shapeFor(2, seeds.graphSeed), true);
    const stocked = stockDungeon(dungeon, blueprint, { level: 1, seed: seeds.stockSeed });
    const entities = runEntitiesPass(stocked, blueprint, new Rng(stocked.seed));

    const payload = buildContentPassPayload(stocked, blueprint, entities, "[fiction]");
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
// An answer writing five of six
// connectors is valid JSON against a valid schema, so zod passes it, apply
// applies it, and nothing notices until `validateWritten` sweeps at the end —
// after the pass is over and the one retry has gone unspent. These are the
// assertions that the question gets asked while the retry is still there to
// take.

describe("content pass completeness", () => {
  const payloadsOf = (seed: number, size: Size) => {
    const seeds = deriveSeeds(seed);
    const blueprint = generateBlueprintSeed(size, seeds.blueprintSeed, 1);
    const { dungeon } = generateBlueprint(seeds.graphSeed, shapeFor(size, seeds.graphSeed), true);
    const stocked = stockDungeon(dungeon, blueprint, { level: 1, seed: seeds.stockSeed });
    const entities = runEntitiesPass(stocked, blueprint, new Rng(stocked.seed));
    return {
      stocked,
      entities,
      payloads: [buildContentPassPayload(stocked, blueprint, entities, "[fiction]")],
    };
  };

  // 1002, not 1005: the specimen cases need an encounter with named members,
  // which is a roll, and 1005 at size 3 does not make one.
  const { payloads } = payloadsOf(1002, 3);

  /** The first payload holding the thing this test is about to delete. */
  const holding = (has: (p: ContentPassPayload) => boolean): ContentPassPayload => {
    const p = payloads.find(has);
    // A fixture lookup that returns early when it finds nothing asserts nothing
    // and passes. If a seed reroll ever empties one of these, this is what says
    // so instead of the suite going quietly green.
    expect(p, "this dungeon carries nothing the test needs").toBeDefined();
    return p!;
  };

  it("says nothing about an answer that covered everything", () => {
    // The fake is a complete answer by construction —
    // so this is also the assertion that the check does not fire on the shape
    // the pipeline actually produces.
    for (const p of payloads) expect(contentPassOmissions(p, fakeContentPass(p))).toEqual([]);

    // And the payloads really did ask for all four things, so the emptiness
    // above is a pass rather than an absence of anything to check.
    const rooms = payloads.flatMap((p) => p.rooms);
    expect(rooms.flatMap((r) => r.entities).length).toBeGreaterThan(0);
    expect(rooms.flatMap((r) => r.connectors).length).toBeGreaterThan(0);
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

  // THE ONE THAT WAS SEEN LIVE: a connector simply left out of an otherwise
  // well-formed response.
  it("names a connector left out of a room that did come back", () => {
    const p = holding((x) => x.rooms.some((r) => r.connectors.length > 0));
    const room = p.rooms.find((r) => r.connectors.length > 0)!;
    const res = fakeContentPass(p);
    const written = res.rooms.find((r) => r.ref === room.ref)!;
    const dropped = written.connectors!.pop()!;

    const out = contentPassOmissions(p, res);
    expect(out).toHaveLength(1);
    expect(out[0].message).toContain(dropped.ref);
    expect(out[0].path).toBe(`rooms.${room.ref}.connectors`);
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
      content: [{ type: "tool_use", id: "t1", name: "write_rooms", input: res }],
      stop_reason: "tool_use",
      usage: { input_tokens: 100, output_tokens: 40 },
    });

    const p = payloads.find((x) => x.rooms.some((r) => r.connectors.length > 0))!;
    const short = () => {
      const res = fakeContentPass(p);
      const room = res.rooms.find((r) => (r.connectors ?? []).length > 0)!;
      return { res, dropped: room.connectors!.pop()! };
    };

    const call = () =>
      callForJson({
        task: "content-pass",
        schema: contentPassSchema,
        toolName: "write_rooms",
        toolDescription: "Name and write every room, entity, connector, and creature group in this region.",
        messages: [{ role: "user", content: "[the content payload]" }],
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

    /**
     * THE RETRY IS A TOOL EXCHANGE, NOT A PARAPHRASE OF ONE.
     *
     * Regression for the failure that killed seed 454434 at size 2 on
     * 2026-08-20. `callForJson` used to build the retry by re-typing the call
     * as prose — `JSON.stringify(call.input).slice(0, 4000)` pushed as an
     * assistant TEXT turn. A content-pass response is ~14 kB, so the model was
     * shown invalid JSON and addressed as though it had written prose; it
     * answered in kind and came back with `rooms` set to a STRING containing
     * the array. The content pass goes out unguaranteed (~35 optionals against
     * a strict budget of 24), so nothing on the wire caught it, and a single
     * missing `ref` on attempt 1 became a dead generation on attempt 2.
     *
     * What this pins is the shape of the second request, because that is the
     * thing that was wrong. The assistant turn is the `tool_use` block as it
     * arrived, whole, and the objection is its `tool_result`.
     */
    it("retries inside the tool exchange, echoing the call whole", async () => {
      const { res, dropped } = short();

      // The fixture writes placeholder prose a few words long; a real room's
      // `base` is a paragraph, and a real answer carries a dozen of them. The
      // old truncation only bit past 4000 characters, so the response has to
      // be the size a real one is for this to be testing anything.
      for (const room of res.rooms) room.base = `${room.base} ${"stone and still water. ".repeat(24)}`;
      expect(JSON.stringify(res).length).toBeGreaterThan(4000);

      queue.push(answered(res), answered(fakeContentPass(p)));

      await call();

      const messages = sent[1].messages as { role: string; content: unknown }[];
      expect(messages).toHaveLength(3);

      // The assistant turn is blocks, not prose — and the tool call inside it
      // is the one that came back, not a summary of it.
      const [assistant, objection] = messages.slice(1);
      expect(assistant.role).toBe("assistant");
      const blocks = assistant.content as { type: string; id: string; input: unknown }[];
      const toolUse = blocks.find((b) => b.type === "tool_use")!;
      expect(toolUse.id).toBe("t1");
      expect(toolUse.input).toEqual(res);

      // Whole — see the padding above. The old truncation cut at 4000
      // characters, so the cut landed mid-string and what went back was not
      // parseable as JSON at all.
      expect(JSON.stringify(toolUse.input).length).toBeGreaterThan(4000);

      // And the complaint is the answer to that call, addressed to it by id.
      const results = objection.content as {
        type: string;
        tool_use_id: string;
        content: string;
        is_error?: boolean;
      }[];
      expect(objection.role).toBe("user");
      expect(results).toHaveLength(1);
      expect(results[0].type).toBe("tool_result");
      expect(results[0].tool_use_id).toBe("t1");
      expect(results[0].is_error).toBe(true);
      expect(results[0].content).toContain(dropped.ref);
      expect(results[0].content).toContain("write_rooms");

      // Nothing in the retry is the response restated as a string. That is the
      // register that taught the model to answer with one.
      expect(messages.some((m) => typeof m.content === "string" && m.content.includes('"ref"')))
        .toBe(false);
    });

    it("throws rather than applying an answer that left it out twice", async () => {
      queue.push(answered(short().res), answered(short().res));
      await expect(call()).rejects.toThrow(ResponseFormatError);
      expect(sent).toHaveLength(2);
    });

    // The `generation` event is written on success, so a pass
    // that never succeeds used to leave nothing but the word "shape" — no pass,
    // no field, and no response to look at.
    it("reports every attempt that failed, with what was objected to", async () => {
      const { dropped } = short();
      queue.push(answered(short().res), answered(short().res));

      const reports: FailedAttempt[] = [];
      await expect(
        callForJson({
          task: "content-pass",
          schema: contentPassSchema,
          toolName: "write_rooms",
          toolDescription: "…",
          messages: [{ role: "user", content: "[the content payload]" }],
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

    // REPAIR INSTEAD OF REDO. Seen live at twelve rooms: the whole retry left
    // something out again. With `repair`, only the room that lost something is
    // asked for, and the rest of the first answer is kept.
    const repairing = () =>
      callForJson({
        task: "content-pass",
        schema: contentPassSchema,
        toolName: "write_rooms",
        toolDescription: "…",
        messages: [{ role: "user", content: "[the content payload]" }],
        check: (v) => contentPassOmissions(p, v),
        repair: { ask: (missing) => askForRooms("write_rooms", missing), merge: mergeRooms },
      });

    /** The ref of the room whose connector `short` dropped. */
    const roomOf = (connectorRef: string) =>
      p.rooms.find((r) => r.connectors.some((c) => c.ref === connectorRef))!.ref;

    it("asks for only the room that lost something, and keeps the rest", async () => {
      const { res, dropped } = short();
      const ref = roomOf(dropped.ref);
      const complete = fakeContentPass(p).rooms.find((r) => r.ref === ref)!;
      queue.push(answered(res), answered({ rooms: [complete] }));

      const { value, attempts } = await repairing();

      expect(attempts).toBe(2);
      expect(contentPassOmissions(p, value)).toEqual([]);
      expect(value.rooms.map((r) => r.ref)).toEqual(res.rooms.map((r) => r.ref));
      // Every other room is the first answer's, untouched.
      for (const r of value.rooms) {
        if (r.ref !== ref) expect(r).toEqual(res.rooms.find((x) => x.ref === r.ref));
      }

      const objection = JSON.stringify(sent[1].messages.at(-1));
      expect(objection).toContain(dropped.ref);
      expect(objection).toContain(`ONLY these rooms: ${ref}`);
    });

    it("gives up after two repairs that still leave it out", async () => {
      const { res, dropped } = short();
      const same = res.rooms.find((r) => r.ref === roomOf(dropped.ref))!;
      queue.push(answered(res), answered({ rooms: [same] }), answered({ rooms: [same] }));

      await expect(repairing()).rejects.toThrow(ResponseFormatError);
      expect(sent).toHaveLength(3);
    });

    it("still redoes a malformed answer whole, because there is nothing to keep", async () => {
      queue.push(answered({ rooms: "not an array" } as never), answered(fakeContentPass(p)));
      const { attempts } = await repairing();
      expect(attempts).toBe(2);
      expect(JSON.stringify(sent[1].messages.at(-1))).toContain("again with the whole input");
    });

    it("does not lose the error when the reporter throws", async () => {
      queue.push(answered(short().res), answered(short().res));
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      await expect(
        callForJson({
          task: "content-pass",
          schema: contentPassSchema,
          toolName: "write_rooms",
          toolDescription: "…",
          messages: [{ role: "user", content: "[the content payload]" }],
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

  it("names a key the keys pass left out", () => {
    const gd = generateOffline(1005, 3);
    const payload = buildKeysPassPayload(gd.stocked, gd.entities, "[fiction]");
    expect(payload.keys.length).toBeGreaterThan(0);
    expect(keysPassOmissions(payload, fakeKeysPass(payload))).toEqual([]);

    const res = fakeKeysPass(payload);
    const dropped = res.keys.pop()!;
    const out = keysPassOmissions(payload, res);
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

  it("keys pass", () => {
    const gd = generateOffline(1005, 2);
    const payload = buildKeysPassPayload(gd.stocked, gd.entities, "[dungeon context]");
    expect(payload.keys.length).toBeGreaterThan(0);
    expect(redactIds(renderKeysPassPrompt(payload))).toMatchSnapshot();
  });

  // WITH THE DRAWING, because that is what a live run sends. Built the way
  // `generate.ts` builds it — the layout hook inside stocking — so the "as
  // drawn" line, the per-connector wall and the fixture menu are all in the
  // snapshot. A snapshot of the geometry-free payload would pass forever while
  // the prompt the game actually sends drifted underneath it.
  it("content pass", () => {
    const { dungeon } = generateBlueprint(seeds.graphSeed, shapeFor(1, seeds.graphSeed), true);
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
        renderContentPassPrompt(buildContentPassPayload(sd, bp, ep, "[dungeon context]", site))
      )
    ).toMatchSnapshot();
  });
});

// ===========================================================================
// THE PIPELINE, SPLIT ACROSS REQUESTS
// ===========================================================================
//
// No Vercel invocation may hold more than one model call, so generation is
// several endpoints rather than one function: structure, then one per step,
// then apply-and-keys. `generateDungeon` composes the same calls, which is what
// keeps the browser and the CLI on one code path.
//
// THE THING THIS ACTUALLY PROVES is that the partial can go through a database
// and come back. The split is worth nothing if a `GeneratedDungeon` that has
// been through `JSON.stringify` writes a different dungeon from the one held in
// memory — object identity inside `entities.registry` is shared, and a round
// trip breaks that sharing. If applying ever depended on it, this is where it
// shows.

describe("generation split across requests", () => {
  const SEED = 1005;
  const SIZE = 2 as Size;

  /** Content-pass answers, keyed by the exact prompt they answer. */
  let answers: Map<string, unknown>;
  /**
   * Whose entities the keys pass is about to read.
   *
   * THE KEYS PROMPT CANNOT BE PRECOMPUTED: it is built after the content pass
   * has been applied, quoting entities that now have names and descriptions.
   * So it is answered live, off whatever `finishGeneration` is writing to.
   */
  let finishing: GeneratedDungeon | undefined;
  let calls: number;

  const toolReply = (name: string, input: unknown) => ({
    content: [{ type: "tool_use", id: `t${calls}`, name, input }],
    stop_reason: "tool_use",
    usage: { input_tokens: 100, output_tokens: 40 },
  });

  const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

  beforeEach(() => {
    answers = new Map();
    finishing = undefined;
    calls = 0;

    vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
      calls++;
      const body = JSON.parse(init.body);
      const prompt = body.messages[0].content as string;
      const tool = body.tools[0].name as string;

      // THE DUNGEON PASS IS ANSWERED OFF THE PROMPT, not from a table. Its
      // payload names the inhabitant groups by id, and ids are `randomUUID` by
      // design (see seeds.ts) — so there is no computing the prompt ahead of
      // the call to key a lookup by. Everything after it addresses a structure
      // that already exists, so those ids are fixed and a table works.
      if (tool === "establish_dungeon") {
        const ids = [...new Set(prompt.match(UUID) ?? [])];
        return { ok: true, json: async () => toolReply(tool, toDungeonPassTool(fakeDungeonPass(ids))) };
      }

      // The keys payload addresses entities that only exist once the content
      // pass has been applied, so it is answered against the partial in hand
      // rather than from the table.
      if (tool === "write_keys") {
        if (!finishing) throw new Error("the keys pass ran with no partial in hand");
        const payload = buildKeysPassPayload(
          finishing.stocked,
          finishing.entities,
          finishing.dungeonContext
        );
        return { ok: true, json: async () => toolReply(tool, fakeKeysPass(payload)) };
      }

      const answer = answers.get(prompt) as { name: string; input: unknown } | undefined;
      if (!answer) {
        return { ok: false, status: 400, statusText: `no canned answer for that ${tool} prompt`, text: async () => "" };
      }
      return { ok: true, json: async () => toolReply(answer.name, answer.input) };
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  /** The content pass, answered against a partial that now exists. */
  function answerTheRest(partial: GeneratedDungeon): void {
    const site = partial.blockplan
      ? siteRooms(partial.blockplan, partial.graph, {
          isCorridor: (i) =>
            partial.stocked.rooms.find((r) => r.index === i)?.isCorridor === true,
        })
      : undefined;

    const payload = buildContentPassPayload(
      partial.stocked,
      partial.blueprint,
      partial.entities,
      partial.dungeonContext,
      site
    );
    answers.set(renderContentPassPrompt(payload), {
      name: "write_rooms",
      input: fakeContentPass(payload),
    });
  }

  /** Finish a partial, with the keys stub pointed at it. */
  async function finish(target: GeneratedDungeon) {
    const content = await generateContent(target);
    finishing = target;
    return finishGeneration(target, content);
  }

  it("writes the same dungeon whether or not the partial went through a database", async () => {
    const partial = await generateStructure({ seed: SEED, size: SIZE, level: 1 });
    answerTheRest(partial);

    // Before either branch runs, and before anything is applied: this is the
    // row the server would have written and read back.
    const roundTripped: GeneratedDungeon = JSON.parse(JSON.stringify(partial));

    const inMemory = await finish(partial);
    const throughTheDb = await finish(roundTripped);

    expect(validateWritten(throughTheDb)).toEqual([]);

    // COMPARED AS THEY WOULD BE STORED, and with ids blanked.
    //
    // Serialised because `JSON.stringify` drops keys whose value is `undefined`
    // — a stocking seed carries several — so the in-memory object has
    // properties the round-tripped one does not, and reading either gives
    // `undefined` regardless. That is not the comparison being weakened: it is
    // the form the server persists and reads back.
    //
    // Ids blanked because applying the content pass CREATES entities — a goal item,
    // among others — and `makeId` is `randomUUID` by design, so two runs of the
    // same work agree on everything except identity. seeds.ts says so, and the
    // determinism tests above take the same view.
    const stored = (gd: GeneratedDungeon) =>
      JSON.parse(
        JSON.stringify(gd.entities).replace(
          /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g,
          "<id>"
        )
      );
    expect(stored(throughTheDb)).toEqual(stored(inMemory));
    expect(throughTheDb.usage).toEqual(inMemory.usage);
  });

  it("hands back each step's answer under its name, for the server to keep", async () => {
    const partial = await generateStructure({ seed: SEED, size: SIZE, level: 1 });
    answerTheRest(partial);

    const saved = await generateStep(partial, "content");
    expect(saved.step).toBe("content");
    expect(contentFrom([saved]).value).toEqual(saved.value);
  });

  it("refuses to finish with a step missing", () => {
    // Discovered here, where it can be retried, rather than as an unwritten
    // entity at the end of a pass nobody can rerun.
    expect(() => contentFrom([])).toThrow(/step content was never run/);
  });
});
