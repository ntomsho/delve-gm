import { afterEach, describe, expect, it, vi } from "vitest";
import { configureTransport } from "../../../../llm/client.ts";
import { HAIKU, SONNET } from "../../../../llm/models.ts";
import { blockPlanValid, roomSizes } from "../../../floorplan/blockplan.ts";
import { generateBlueprint } from "../../../floorplan/graph.ts";
import { deriveSeeds, shapeFor } from "../../../seeds.ts";
import { generateBlueprintSeed, type Size } from "../../blueprint.ts";
import { sizeAllows } from "../../../floorplan/room-size.ts";
import type { DungeonPassResponse } from "../dungeon-pass.ts";
import { renderOutlineForReview, renderOutlinePrompt, renderOutlineRepair, renderPolishPrompt } from "./prompt.ts";
import {
  applyPolish,
  changedFiction,
  fictionShrinks,
  MAX_POLISH_EDITS,
  mergeOutline,
  outlineSchema,
  outlineViolations,
  polishIssues,
  polishSchema,
  refLeaks,
  type Outline,
  type PolishEdit,
} from "./response.ts";
import { mandatoryFit, rollOutline, type OutlineDraft } from "./roll.ts";
import { polishOutline, writeOutline } from "./run.ts";

configureTransport({ baseUrl: "https://model.test" });

function draftOf(seed: number, size: Size = 1): OutlineDraft {
  const seeds = deriveSeeds(seed);
  const blueprint = generateBlueprintSeed(size, seeds.blueprintSeed, 1);
  const { dungeon } = generateBlueprint(seeds.graphSeed, shapeFor(size, seeds.graphSeed), true);
  return rollOutline(dungeon, blueprint, {
    seed: seeds.stockSeed,
    layout: (rooms) => {
      const corridor = new Set(rooms.filter((r) => r.isCorridor).map((r) => r.index));
      const plan = blockPlanValid(dungeon, (i) => corridor.has(i), seeds.layoutSeed);
      return plan ? roomSizes(plan.rooms) : rooms.map(() => undefined);
    },
  });
}

function passOf(d: OutlineDraft): DungeonPassResponse {
  return {
    name: "The Sunken Mint",
    theme: "Wet limestone.",
    history: "A coin works drowned by the river it was built to exploit.",
    goal: { summary: "Recover the master die.", spec: "The player carries it out." },
    openingProse: "The stair goes down into standing water.",
    groups: d.blueprint.inhabitants.map((g, i) => ({ id: g.id, name: `Group ${i + 1}`, base: "What they are." })),
  };
}

/** A complete outline that breaks no rule: each room takes the first fiction that fits it. */
function validOutline(d: OutlineDraft): Outline {
  const chambers = d.rooms.filter((r) => !r.passage);
  const held = new Map<string, string>();
  // Mandatory first, so they all land; the matching guarantees a way exists.
  const assign = (f: number, seen: Set<string>): boolean => {
    for (const r of chambers) {
      if (seen.has(r.ref)) continue;
      const fic = d.fictions[f]!;
      if (r.sizeClass && !fic.fits.includes(r.sizeClass)) continue;
      seen.add(r.ref);
      const other = held.get(r.ref);
      if (other === undefined || assign(d.fictions.findIndex((x) => x.ref === other), seen)) {
        held.set(r.ref, fic.ref);
        return true;
      }
    }
    return false;
  };
  d.fictions.forEach((f, i) => {
    if (f.mandatory) assign(i, new Set());
  });
  for (const r of chambers) {
    if (held.has(r.ref)) continue;
    const used = new Set(held.values());
    const f = d.fictions.find((x) => !used.has(x.ref) && (!r.sizeClass || x.fits.includes(r.sizeClass)));
    if (f) held.set(r.ref, f.ref);
  }

  const free = d.rooms.filter((r) => r.role === "normal");
  const location = d.challenges.find((c) => c.challenge.kind === "goal-location")!;
  return {
    rooms: d.rooms.map((r) => {
      const at = free.findIndex((x) => x.ref === r.ref);
      const card = at >= 0 ? d.cards[at]?.ref : undefined;
      const fiction = held.get(r.ref);
      return {
        ref: r.ref,
        fiction: fiction ?? "none",
        card: card ?? "none",
        story: "How it came to be.",
        journey: "What it does for the player.",
        storyFeature: "none",
      };
    }),
    ways: d.ways.map((w) => ({ ref: w.ref, form: "a low arch" })),
    objective: { type: "Item", form: "a steel die", person: "none" },
    clues: d.cards.filter((c) => c.clue).map((c) => ({ card: c.ref, pointsAt: "objective" })),
    keys: [{ challenge: location.ref, kind: "object", key: "a torn map", room: d.entrance, gotBy: "Searching the desk." }],
    fictionChanges: [],
  };
}

const SEEDS = [1005, 2024, 1004, 77, 4242];

/** An edit as the model sends one: every field present, "none" where it does not apply. */
const edit = (e: Partial<PolishEdit> & Pick<PolishEdit, "op">): PolishEdit => ({
  roomA: "none",
  roomB: "none",
  fiction: "none",
  way: "none",
  field: "none",
  group: "none",
  challenge: "none",
  keyKind: "none",
  gotBy: "none",
  text: "none",
  why: "It helps.",
  ...e,
});

describe("what code rolls for the outline", () => {
  it.each(SEEDS)("seed %i: one and a half chamber fictions per chamber, the first third of the rooms mandatory", (seed) => {
    const d = draftOf(seed);
    const chambers = d.rooms.filter((r) => !r.passage).length;
    expect(d.fictions).toHaveLength(Math.ceil(1.5 * chambers));

    const mandatory = Math.ceil(d.rooms.length / 3);
    expect(d.fictions.slice(0, mandatory).every((f) => f.mandatory)).toBe(true);
    expect(d.fictions.slice(mandatory).some((f) => f.mandatory)).toBe(false);
    expect(mandatoryFit(d.fictions.filter((f) => f.mandatory), d.rooms)).toBe(true);
  });

  it.each(SEEDS)("seed %i: a passage keeps a rolled identity, and only passages do", (seed) => {
    const d = draftOf(seed);
    for (const r of d.rooms) expect(!!r.identity).toBe(r.passage);
  });

  it.each(SEEDS)("seed %i: neither the entrance nor the goal room is a passage", (seed) => {
    const d = draftOf(seed);
    expect(d.rooms.find((r) => r.ref === d.entrance)!.passage).toBe(false);
    expect(d.rooms.find((r) => r.ref === d.goalRoom)!.passage).toBe(false);
  });

  it.each(SEEDS)("seed %i: a card for every room but the entrance and the goal room", (seed) => {
    const d = draftOf(seed);
    expect(d.cards).toHaveLength(d.rooms.length - 2);
  });

  it.each(SEEDS)("seed %i: a base card for every group, with no room chosen for it", (seed) => {
    const d = draftOf(seed);
    const bases = d.cards.filter((c) => c.mobile?.isBase);
    expect(bases).toHaveLength(d.blueprint.inhabitants.length);
    for (const c of bases) expect(c.mobile!.locationRoomId).toBe(c.ref);
  });

  it("every creature card knows what it is doing and how it stands", () => {
    for (const c of draftOf(1005).cards.filter((x) => x.mobile)) {
      expect(c.mobile!.activity).toBeTruthy();
      expect(c.mobile!.disposition).toBeTruthy();
    }
  });

  it("a key can answer what a card raises, and where the objective is", () => {
    const d = draftOf(1005);
    expect(d.challenges.some((c) => c.card)).toBe(true);
    const location = d.challenges.find((c) => c.challenge.kind === "goal-location")!;
    expect(location.challenge.property).toBe("where the objective lies");
  });

  it("is the same for the same seed, ids aside", () => {
    const strip = (d: OutlineDraft) => JSON.stringify(d.fictions.concat()) + JSON.stringify(d.routes);
    expect(strip(draftOf(1005))).toBe(strip(draftOf(1005)));
  });

  it("only offers a fiction that fits some room", () => {
    const d = draftOf(1005);
    const sizes = d.rooms.filter((r) => !r.passage).map((r) => r.sizeClass!);
    for (const f of d.fictions) expect(sizes.some((s) => sizeAllows(f.identity, s))).toBe(true);
  });
});

describe("the rules an outline answers to", () => {
  const d = draftOf(1005);
  const clean = () => structuredClone(validOutline(d));
  const room = (o: Outline, ref: string) => o.rooms.find((r) => r.ref === ref)!;
  const normal = d.rooms.filter((r) => r.role === "normal").map((r) => r.ref);

  it("has nothing to say about a sound outline", () => {
    expect(outlineViolations(d, clean())).toEqual([]);
  });

  it("names a room left out", () => {
    const o = clean();
    o.rooms = o.rooms.filter((r) => r.ref !== normal[0]);
    expect(outlineViolations(d, o).map((v) => v.message).join()).toContain(`room ${normal[0]} is missing`);
  });

  it("names a fiction used twice, by the rooms using it", () => {
    const o = clean();
    const [a, b] = o.rooms.filter((r) => r.fiction !== "none");
    b!.fiction = a!.fiction;
    const text = outlineViolations(d, o).map((v) => v.message).join();
    expect(text).toContain(`fiction ${a!.fiction} is used twice: rooms ${a!.ref} and ${b!.ref}`);
  });

  it("names a mandatory fiction left out", () => {
    const o = clean();
    const mandatory = d.fictions.find((f) => f.mandatory)!;
    const holder = o.rooms.find((r) => r.fiction === mandatory.ref)!;
    const spare = d.fictions.find((f) => !f.mandatory && !o.rooms.some((r) => r.fiction === f.ref))!;
    holder.fiction = spare.ref;
    expect(outlineViolations(d, o).map((v) => v.message).join()).toContain(`mandatory fiction ${mandatory.ref}`);
  });

  it("refuses a card in the entrance, and names a card left over", () => {
    const o = clean();
    const from = room(o, normal[0]!);
    room(o, d.entrance).card = from.card;
    from.card = "none";
    const text = outlineViolations(d, o).map((v) => v.message).join();
    expect(text).toContain("the entrance");
  });

  it("lets a card go in the goal room, leaving one other room empty", () => {
    const o = clean();
    const from = room(o, normal[0]!);
    room(o, d.goalRoom).card = from.card;
    from.card = "none";
    expect(outlineViolations(d, o)).toEqual([]);
  });

  it("does not let two rooms stand empty", () => {
    const o = clean();
    room(o, normal[0]!).card = "none";
    room(o, normal[1]!).card = "none";
    const text = outlineViolations(d, o).map((v) => v.message).join();
    expect(text).toContain("hold no card");
  });

  it("names a way not described", () => {
    const o = clean();
    const dropped = o.ways.pop()!;
    expect(outlineViolations(d, o).map((v) => v.message).join()).toContain(`way ${dropped.ref} is not described`);
  });

  it("insists a key answers where the objective is", () => {
    const o = clean();
    const other = d.challenges.find((c) => c.challenge.kind !== "goal-location")!;
    o.keys = [{ challenge: other.ref, kind: "object", key: "a note", room: d.entrance, gotBy: "Looking." }];
    expect(outlineViolations(d, o).map((v) => v.message).join()).toContain("where the objective is");
  });

  it("takes as many keys as the goal needs, of either kind", () => {
    const o = clean();
    o.keys = [
      ...o.keys,
      { challenge: "goal", kind: "information", key: "the sealing word", room: normal[0]!, gotBy: "Overhearing the chant." },
      { challenge: "goal", kind: "object", key: "a rubbing", room: normal[1]!, gotBy: "Getting past the smoke." },
    ];
    expect(outlineViolations(d, o)).toEqual([]);
  });

  it("refuses a key in no real room", () => {
    const o = clean();
    o.keys[0]!.room = "room_99";
    expect(outlineViolations(d, o).map((v) => v.message).join()).toContain("not a room");
  });

  it("refuses a key that can only be reached through the way it opens", () => {
    const dd = draftOf(1007);
    const behind = dd.rooms.find((r) => r.isDeadEnd && r.ways.some((ref) => dd.ways.find((w) => w.ref === ref)!.connector.gated))!;
    const way = dd.ways.find((w) => behind.ways.includes(w.ref) && w.connector.gated)!;
    const lock = dd.challenges.find((c) => c.challenge.targetId === way.connector.id)!;
    const o = validOutline(dd);
    o.keys = [...o.keys, { challenge: lock.ref, kind: "object", key: "the key", room: behind.ref, gotBy: "Looking." }];
    expect(outlineViolations(dd, o).map((v) => v.message).join()).toContain("the way it opens");
  });

  it("lets a key sit in the room of its own lock, on the near side", () => {
    const dd = draftOf(1007);
    const way = dd.ways.find((w) => w.connector.gated)!;
    const lock = dd.challenges.find((c) => c.challenge.targetId === way.connector.id)!;
    const near = dd.rooms.find((r) => r.ways.includes(way.ref) && !r.isDeadEnd)!;
    const o = validOutline(dd);
    o.keys = [...o.keys, { challenge: lock.ref, kind: "object", key: "the key", room: near.ref, gotBy: "Hidden behind the loose stone." }];
    expect(outlineViolations(dd, o)).toEqual([]);
  });

  it("finds a ref left in prose, and lets ordinary words alone", () => {
    const o = clean();
    expect(refLeaks(o)).toEqual([]);
    o.rooms[0]!.journey = "The ledger (K11) lies here.";
    o.ways[0]!.form = "a stair; room_1 is higher";
    const text = refLeaks(o).map((v) => v.message).join();
    expect(text).toContain('"K11"');
    expect(text).toContain('"room_1"');
  });

  it("holds the number of keys to the range", () => {
    const o = clean();
    o.keys = [];
    expect(outlineViolations(d, o).map((v) => v.message).join()).toContain("plan between");
  });

  it("refuses a change to a group that does not exist", () => {
    const o = clean();
    o.fictionChanges = [{ field: "groupBase", group: "G9", text: "New.", why: "Because." }];
    expect(outlineViolations(d, o).map((v) => v.message).join()).toContain("no real group");
  });
});

describe("a repair", () => {
  const d = draftOf(1005);

  it("replaces what it names, and leaves the rest", () => {
    const o = validOutline(d);
    const patched = mergeOutline(o, {
      rooms: [{ ...o.rooms[0]!, story: "Rewritten." }],
      objective: o.objective,
      ways: [],
      clues: [],
      keys: [],
      fictionChanges: [],
    });
    expect(patched.rooms[0]!.story).toBe("Rewritten.");
    expect(patched.rooms[1]).toEqual(o.rooms[1]);
    expect(patched.keys).toEqual(o.keys);
    expect(patched.objective).toEqual(o.objective);
  });

  it("can take a key away, because its list replaces the old one whole", () => {
    const o = validOutline(d);
    o.keys = [...o.keys, { challenge: "K1", kind: "information", key: "extra", room: d.entrance, gotBy: "Asking." }];
    const patched = mergeOutline(o, { rooms: [], objective: o.objective, ways: [], clues: [], keys: o.keys.slice(0, 1), fictionChanges: [] });
    expect(patched.keys).toHaveLength(1);
  });

  it("tells the model what is wrong and what it can still reach for", () => {
    const o = validOutline(d);
    const text = renderOutlineRepair(d, o, [{ path: "x", message: "fiction F7 is used twice: rooms C and K" }]);
    expect(text).toContain("fiction F7 is used twice");
    expect(text).toContain("Still unused: fictions");
    // So that placing one does not knock out another.
    for (const f of d.fictions.filter((x) => x.mandatory)) expect(text).toContain(`${f.ref} (${f.identity}) is in room_`);
    expect(text).not.toMatch(/\{\{\w+\}\}/);
  });
});

describe("polish edits", () => {
  const d = draftOf(1005);

  it("swaps two rooms' cards", () => {
    const o = validOutline(d);
    const [a, b] = o.rooms.filter((r) => r.card !== "none");
    const out = applyPolish(o, [edit({ op: "swap_cards", roomA: a!.ref, roomB: b!.ref, why: "Pacing." })])!;
    expect(out.rooms.find((r) => r.ref === a!.ref)!.card).toBe(b!.card);
    expect(outlineViolations(d, out)).toEqual([]);
  });

  it("sends back an edit that calls a room by its ref", () => {
    const o = validOutline(d);
    const roomA = o.rooms[0]!.ref;
    const leak = edit({ op: "rewrite_journey", roomA, text: "The tally in room_4 says when.", why: "Link." });
    expect(polishIssues(o, { edits: [leak] }).map((i) => i.path)).toEqual([`the journey of room ${roomA}`]);
    const clean = edit({ op: "rewrite_journey", roomA, text: "The tally in the store says when.", why: "Link." });
    expect(polishIssues(o, { edits: [clean] })).toEqual([]);
  });

  it("sends back too many edits", () => {
    const o = validOutline(d);
    const one = edit({ op: "rewrite_story", roomA: o.rooms[0]!.ref, text: "New.", why: "Better." });
    expect(polishIssues(o, { edits: Array(MAX_POLISH_EDITS).fill(one) })).toEqual([]);
    expect(polishIssues(o, { edits: Array(MAX_POLISH_EDITS + 1).fill(one) })).toHaveLength(1);
  });

  it("does not touch the outline it was given", () => {
    const o = validOutline(d);
    const before = structuredClone(o);
    applyPolish(o, [edit({ op: "rewrite_story", roomA: o.rooms[0]!.ref, text: "New.", why: "Better." })]);
    expect(o).toEqual(before);
  });

  it("carries a change to the fiction with the rest of them", () => {
    const o = validOutline(d);
    const out = applyPolish(o, [edit({ op: "change_fiction", field: "history", text: "New.", why: "Better." })])!;
    expect(out.fictionChanges).toEqual([{ field: "history", group: "none", text: "New.", why: "Better." }]);
  });

  it("adds a key, and replaces a challenge's key rather than doubling it", () => {
    const o = validOutline(d);
    const held = o.keys[0]!;
    const out = applyPolish(o, [
      edit({ op: "set_key", challenge: "goal", keyKind: "information", text: "the word", roomA: o.rooms[0]!.ref, gotBy: "Asking." }),
      edit({ op: "set_key", challenge: held.challenge, keyKind: "object", text: "a better map", roomA: o.rooms[0]!.ref, gotBy: "Searching." }),
    ])!;
    expect(out.keys).toHaveLength(2);
    expect(out.keys.find((k) => k.challenge === held.challenge)!.key).toBe("a better map");
    expect(out.keys.find((k) => k.challenge === "goal")!.kind).toBe("information");
  });

  it("gives up on an edit with no new text, rather than writing the word none", () => {
    const o = validOutline(d);
    expect(applyPolish(o, [edit({ op: "rewrite_story", roomA: o.rooms[0]!.ref })])).toBeUndefined();
  });

  it("gives up on an edit that names nothing real", () => {
    const o = validOutline(d);
    expect(applyPolish(o, [edit({ op: "swap_cards", roomA: "room_99", roomB: "room_0", why: "?" })])).toBeUndefined();
  });
});

describe("changes to the fiction", () => {
  const d = draftOf(1005);
  const ids = d.blueprint.inhabitants.map((g) => g.id);

  it("applies them, later ones winning", () => {
    const next = changedFiction(passOf(d), ids, [
      { field: "history", group: "none", text: "First.", why: "a" },
      { field: "history", group: "none", text: "Second.", why: "b" },
      { field: "groupName", group: "G1", text: "The Choir", why: "c" },
    ]);
    expect(next.history).toBe("Second.");
    expect(next.groups[0]!.name).toBe("The Choir");
  });

  it("has no way to change the goal", () => {
    expect(outlineSchema.safeParse({ ...validOutline(d), fictionChanges: [{ field: "goal", group: "none", text: "x", why: "y" }] }).success).toBe(false);
    const pass = passOf(d);
    expect(changedFiction(pass, ids, [{ field: "theme", group: "none", text: "New.", why: "a" }]).goal).toEqual(pass.goal);
  });
});

describe("a change that guts the fiction", () => {
  const d = draftOf(1005);
  const pass = passOf(d);
  const long = "Every word of this opening matters to the player reading it. ".repeat(6);
  const withOpening = { ...pass, openingProse: long };
  const change = (text: string) => ({ ...validOutline(d), fictionChanges: [{ field: "opening" as const, group: "none", text, why: "Better." }] });

  it("is refused when it keeps only part of the field", () => {
    expect(fictionShrinks(d, withOpening, change(long.slice(0, 60))).map((v) => v.message).join()).toContain("whole new text");
  });

  it("is allowed when it only tightens the field", () => {
    expect(fictionShrinks(d, withOpening, change(long.slice(0, Math.ceil(long.length * 0.8))))).toEqual([]);
  });

  it("leaves a group's new name alone, which has no length to keep", () => {
    const o = { ...validOutline(d), fictionChanges: [{ field: "groupName" as const, group: "G1", text: "X", why: "Better." }] };
    expect(fictionShrinks(d, pass, o)).toEqual([]);
  });

  it("can be put right by a repair, which replaces it rather than adding to it", () => {
    const merged = mergeOutline(change("Short."), { ...change(long), rooms: [], ways: [], clues: [], keys: [] });
    expect(merged.fictionChanges).toHaveLength(1);
    expect(merged.fictionChanges[0]!.text).toBe(long);
  });

  it("does not put its reason where a reader takes it for part of the text", () => {
    const text = renderOutlineForReview(change("New text."));
    expect(text).toContain("New text.\n    Why this change: Better.");
  });
});

describe("the prompts", () => {
  const d = draftOf(1005);
  const pass = passOf(d);

  it("present the written dungeon first, as what is being built, and then the goal", () => {
    const text = renderOutlinePrompt(d, pass);
    const dungeon = text.indexOf("THE DUNGEON YOU ARE BUILDING");
    const goal = text.indexOf("THE PLAYER'S GOAL");
    expect(dungeon).toBeGreaterThanOrEqual(0);
    expect(goal).toBeGreaterThan(dungeon);
    expect(text).toContain(pass.history);
    expect(text).toContain(pass.goal.spec);
    expect(text).toContain("culmination");
    expect(text).not.toMatch(/\{\{\w+\}\}/);
  });

  it("list every ref the model has to use", () => {
    const text = renderOutlinePrompt(d, pass);
    for (const r of d.rooms) expect(text).toContain(r.ref);
    for (const w of d.ways) expect(text).toContain(w.ref);
    for (const f of d.fictions) expect(text).toContain(`${f.ref}${f.mandatory ? " MANDATORY" : ""}:`);
    for (const c of d.cards) expect(text).toContain(`${c.ref} `);
  });

  it("put the review's questions in front of the reviewer, with the outline", () => {
    const o = validOutline(d);
    const text = renderPolishPrompt(d, pass, o);
    expect(text).toContain("represented in at least");
    expect(text).toContain(o.rooms[0]!.story);
    expect(text).not.toMatch(/\{\{\w+\}\}/);
  });
});

describe("the calls", () => {
  const d = draftOf(1005);
  const pass = passOf(d);
  const reply = (name: string, input: unknown) => ({
    ok: true,
    json: async () => ({
      content: [{ type: "tool_use", id: "t1", name, input }],
      stop_reason: "tool_use",
      usage: { input_tokens: 100, output_tokens: 40 },
    }),
  });

  /** Answers with each reply in turn, and keeps every request and its headers. */
  function stub(...replies: unknown[]) {
    const sent: Array<{ body: Record<string, unknown>; headers: Record<string, string> }> = [];
    vi.stubGlobal("fetch", async (_u: string, init: { body: string; headers: Record<string, string> }) => {
      sent.push({ body: JSON.parse(init.body), headers: init.headers });
      return replies.shift();
    });
    return sent;
  }

  afterEach(() => vi.unstubAllGlobals());

  it("asks with auto, so the model can think, and steers it to the tool", async () => {
    const sent = stub(reply("write_outline", validOutline(d)));
    await writeOutline(d, pass, { model: HAIKU });
    expect(sent[0]!.body.tool_choice).toEqual({ type: "auto", disable_parallel_tool_use: true });
    expect(sent[0]!.body.system).toContain("write_outline");
    expect(sent[0]!.body.output_config).toEqual({ effort: "medium" });
    expect(sent[0]!.body.fallbacks).toBeUndefined();
  });

  it("sends Sonnet 5.5 the refusal fallback", async () => {
    const sent = stub(reply("write_outline", validOutline(d)));
    await writeOutline(d, pass, { model: SONNET });
    expect(sent[0]!.body.model).toBe(SONNET);
    expect(sent[0]!.body.fallbacks).toBe("default");
    expect(sent[0]!.headers["anthropic-beta"]).toBe("server-side-fallback-2026-07-01");
  });

  it("repairs a broken outline by asking only for what is wrong", async () => {
    const good = validOutline(d);
    const broken = { ...good, ways: good.ways.slice(0, -1) };
    const lost = good.ways.at(-1)!;
    const sent = stub(
      reply("write_outline", broken),
      reply("write_outline", { rooms: [], objective: good.objective, ways: [lost], clues: [], keys: [], fictionChanges: [] })
    );
    const out = await writeOutline(d, pass);
    expect(out.attempts).toBe(2);
    // A repair gets to think too: fixing one thing without breaking another takes it.
    expect(sent[1]!.body.tool_choice).toEqual({ type: "auto", disable_parallel_tool_use: true });
    expect(outlineViolations(d, out.outline)).toEqual([]);
    expect(JSON.stringify(sent[1]!.body.messages)).toContain(`way ${lost.ref} is not described`);
  });

  it("forces the call after a malformed answer, with nothing to keep", async () => {
    const sent = stub(reply("write_outline", { rooms: "not a list" }), reply("write_outline", validOutline(d)));
    await writeOutline(d, pass);
    expect(sent[1]!.body.tool_choice).toEqual({ type: "tool", name: "write_outline" });
  });

  it("stays on auto for a repair on Sonnet 5.5, which refuses a forced call", async () => {
    const good = validOutline(d);
    const sent = stub(
      reply("write_outline", { ...good, ways: good.ways.slice(0, -1) }),
      reply("write_outline", { rooms: [], objective: good.objective, ways: [good.ways.at(-1)], clues: [], keys: [], fictionChanges: [] })
    );
    await writeOutline(d, pass, { model: SONNET });
    expect(sent[1]!.body.tool_choice).toEqual({ type: "auto", disable_parallel_tool_use: true });
  });

  it("answers every tool call in a reply, or the next request is refused", async () => {
    const good = validOutline(d);
    const broken = { ...good, ways: good.ways.slice(0, -1) };
    const doubled = {
      ok: true,
      json: async () => ({
        content: [
          { type: "tool_use", id: "a", name: "write_outline", input: broken },
          { type: "tool_use", id: "b", name: "write_outline", input: broken },
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 100, output_tokens: 40 },
      }),
    };
    const sent = stub(
      doubled,
      reply("write_outline", { rooms: [], objective: good.objective, ways: [good.ways.at(-1)], clues: [], keys: [], fictionChanges: [] })
    );
    await writeOutline(d, pass);
    const results = (sent[1]!.body.messages as Array<{ content: unknown }>).at(-1)!.content as Array<{ tool_use_id: string }>;
    expect(results.map((r) => r.tool_use_id).sort()).toEqual(["a", "b"]);
  });

  it("keeps a polish that holds up", async () => {
    const o = validOutline(d);
    stub(reply("propose_edits", { edits: [edit({ op: "rewrite_story", roomA: o.rooms[0]!.ref, text: "Better.", why: "It is." })] }));
    const out = await polishOutline(d, pass, o);
    expect(out.kept).toBe(true);
    expect(out.outline.rooms[0]!.story).toBe("Better.");
  });

  it("keeps the draft when a polish breaks a rule", async () => {
    const o = validOutline(d);
    const [a, b] = o.rooms.filter((r) => r.fiction !== "none");
    stub(reply("propose_edits", { edits: [edit({ op: "replace_fiction", roomA: a!.ref, fiction: b!.fiction, why: "Hm." })] }));
    const out = await polishOutline(d, pass, o);
    expect(out.kept).toBe(false);
    expect(out.rolledBack).toContain("used twice");
    expect(out.outline).toEqual(o);
    expect(out.proposed).toHaveLength(1);
  });

  it("keeps the draft when an edit names nothing real", async () => {
    const o = validOutline(d);
    stub(reply("propose_edits", { edits: [edit({ op: "rewrite_way", way: "W99", text: "A door.", why: "Hm." })] }));
    const out = await polishOutline(d, pass, o);
    expect(out.kept).toBe(false);
    expect(out.outline).toEqual(o);
  });

  it("treats no edits as an answer", async () => {
    const o = validOutline(d);
    stub(reply("propose_edits", { edits: [] }));
    const out = await polishOutline(d, pass, o);
    expect(out.kept).toBe(false);
    expect(out.rolledBack).toBeUndefined();
    expect(polishSchema.safeParse({ edits: [] }).success).toBe(true);
  });
});
