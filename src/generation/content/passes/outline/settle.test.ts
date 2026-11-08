import { describe, expect, it } from "vitest";
import { fakeOutline, generateOffline } from "../../../../fixtures/offline.ts";
import { blockPlanValid, roomSizes } from "../../../floorplan/blockplan.ts";
import { generateBlueprint } from "../../../floorplan/graph.ts";
import { deriveSeeds, shapeFor } from "../../../seeds.ts";
import { generateBlueprintSeed } from "../../blueprint.ts";
import { runEntitiesPass } from "../../entities-pass.ts";
import { Rng } from "../../../../shared/utils/rng.ts";
import { buildContentPassPayload } from "../content-pass/build.ts";
import { renderContentPassPrompt } from "../content-pass/prompt.ts";
import { contentPassOmissions } from "../content-pass/response.ts";
import {
  askForKeys,
  buildKeysPassPayload,
  keysPassLeaks,
  mergeKeys,
  type KeysPassPayload,
} from "../keys-pass.ts";
import { GOAL_KEY, mergeOutline, withoutStrays, type Outline } from "./response.ts";
import { rollOutline, type OutlineDraft } from "./roll.ts";
import { settleOutline } from "./settle.ts";
import { nameGoalLocation } from "../../challenges.ts";

const SEED = 1005;

function draftFor(seed: number): OutlineDraft {
  const seeds = deriveSeeds(seed);
  const blueprint = generateBlueprintSeed(1, seeds.blueprintSeed, 1);
  const { dungeon } = generateBlueprint(seeds.graphSeed, shapeFor(1, seeds.graphSeed), true);
  return rollOutline(dungeon, blueprint, {
    seed: seeds.stockSeed,
    layout: (rooms) => {
      const corridor = new Set(rooms.filter((r) => r.isCorridor).map((r) => r.index));
      const plan = blockPlanValid(dungeon, (i) => corridor.has(i), seeds.layoutSeed);
      return plan ? roomSizes(plan.rooms) : rooms.map(() => undefined);
    },
  });
}

const settle = (draft: OutlineDraft, outline: Outline) => settleOutline(draft, outline, { level: 1, seed: 7 });

describe("settling an outline", () => {
  it("puts each card in the room the outline chose", () => {
    const draft = draftFor(SEED);
    const outline = fakeOutline(draft);
    const sd = settle(draft, outline);

    for (const a of outline.rooms) {
      const card = draft.cards.find((c) => c.ref === a.card);
      if (!card?.mobile) continue;
      const room = sd.rooms[draft.rooms.findIndex((r) => r.ref === a.ref)]!;
      expect(room.occupants).toContain(card.mobile.id);
      expect(sd.mobiles.find((m) => m.id === card.mobile!.id)?.locationRoomId).toBe(room.roomId);
    }
  });

  it("gives each room the fiction and notes the outline chose", () => {
    const draft = draftFor(SEED);
    const outline = fakeOutline(draft);
    const sd = settle(draft, outline);

    outline.rooms.forEach((a) => {
      const i = draft.rooms.findIndex((r) => r.ref === a.ref);
      const expected = draft.rooms[i]!.identity ?? draft.fictions.find((f) => f.ref === a.fiction)?.identity;
      expect(sd.rooms[i]!.identity).toBe(expected);
      expect(sd.rooms[i]!.story).toBe(a.story);
      expect(sd.rooms[i]!.journey).toBe(a.journey);
    });
  });

  it("places exactly the keys the outline planned, where it planned them", () => {
    const draft = draftFor(SEED);
    const outline = fakeOutline(draft);
    const sd = settle(draft, outline);

    const placed = sd.rooms.flatMap((r) => r.rewards.flatMap((w) => (w.kind === "key" ? [{ w, roomId: r.roomId }] : [])));
    expect(placed).toHaveLength(outline.keys.length);
    for (const k of outline.keys) {
      const hit = placed.find((p) => p.w.kind === "key" && p.w.plan?.key === k.key);
      expect(hit?.roomId).toBe(draft.rooms.find((r) => r.ref === k.room)?.roomId);
    }
  });

  it("gives a key the goal needs a challenge of its own", () => {
    const draft = draftFor(SEED);
    const outline = fakeOutline(draft);
    const sd = settle(draft, outline);

    const planned = outline.keys.find((k) => k.challenge === GOAL_KEY)!;
    const challenge = sd.challenges.find((c) => c.property === planned.key);
    expect(challenge?.kind).toBe("goal-property");
    expect(challenge?.roomId).toBe(sd.goalRoomId);
  });

  it("finds a hazard or obstacle's challenge in the room its card went to", () => {
    // A special's challenge was rolled against its card, before there were rooms.
    for (const seed of [1005, 1007, 1025, 2024, 4242]) {
      const draft = draftFor(seed);
      const special = draft.challenges.find((c) => c.card && (c.challenge.kind === "hazard" || c.challenge.kind === "obstacle"));
      if (!special) continue;
      const outline = fakeOutline(draft);
      const withKey = { ...outline, keys: [...outline.keys, { challenge: special.ref, kind: "object" as const, key: "a brass plumb", room: draft.entrance, gotBy: "searching" }] };
      const sd = settle(draft, withKey);
      const holder = withKey.rooms.find((r) => r.card === special.card)!;
      const roomId = draft.rooms.find((r) => r.ref === holder.ref)!.roomId;

      const key = sd.rooms.flatMap((r) => r.rewards).find((w) => w.kind === "key" && w.plan?.key === "a brass plumb");
      const answered = sd.challenges.find((c) => key?.kind === "key" && c.id === key.challengeId);
      expect(answered?.targetId).toBe(roomId);
      return;
    }
    throw new Error("no seed rolled a special");
  });

  it("carries the objective to the writer, in place of the rolled reward", () => {
    const draft = draftFor(SEED);
    const outline = fakeOutline(draft);
    const sd = settle(draft, outline);
    const goal = sd.rooms.find((r) => r.role === "goal")!;
    expect(goal.goalDirective?.objective?.form).toBe(outline.objective.form);

    // The fact a player reads in play comes from the objective, not a table's category.
    const location = sd.challenges.find((c) => c.kind === "goal-location")!;
    expect(location.property).toBe(`where to find ${outline.objective.form}`);
    expect(location.property).not.toContain(draft.blueprint.goalSeed.reward);
  });

  it("is the same dungeon for the same plan and seed", () => {
    const draft = draftFor(SEED);
    const outline = fakeOutline(draft);
    expect(settle(draft, outline)).toEqual(settle(JSON.parse(JSON.stringify(draft)), outline));
  });
});

describe("repairing an outline", () => {
  it("leaves one copy of a room the model listed twice", () => {
    const outline = fakeOutline(draftFor(SEED));
    const twice = outline.rooms[1]!;
    const whole = { ...outline, rooms: [...outline.rooms, { ...twice, story: "a second copy" }] };
    const merged = mergeOutline(whole, { ...outline, rooms: [{ ...twice, story: "the repaired one" }], ways: [], clues: [], keys: [], fictionChanges: [] });
    expect(merged.rooms.filter((r) => r.ref === twice.ref).map((r) => r.story)).toEqual(["the repaired one"]);
    expect(merged.rooms).toHaveLength(outline.rooms.length);
  });
});

describe("repairing an outline that invented something", () => {
  it("drops a room that does not exist, which a repair could never replace", () => {
    const draft = draftFor(SEED);
    const outline = fakeOutline(draft);
    const stray = { ...outline.rooms[0]!, ref: "none" };
    const cleaned = withoutStrays(draft, { ...outline, rooms: [...outline.rooms, stray], ways: [...outline.ways, { ref: "W99", form: "x" }] });
    expect(cleaned.rooms).toEqual(outline.rooms);
    expect(cleaned.ways).toEqual(outline.ways);
  });
});

describe("the goal's location, once the objective is named", () => {
  it.each([
    ["Oracle", "where to find the Oracle"],
    ["The Warden", "where to find the Warden"],
    ["A ledger of debts", "where to find a ledger of debts"],
    ["Eldress Gilse Tallow", "where to find Eldress Gilse Tallow", true],
  ] as [string, string, boolean?][])("names %s plainly", (name, fact, named) => {
    const draft = draftFor(SEED);
    const sd = settle(draft, fakeOutline(draft));
    nameGoalLocation(sd, name, named);
    const location = sd.challenges.find((c) => c.kind === "goal-location")!;
    expect(location.property).toBe(fact);
    for (const e of sd.reserve) if (e.challengeId === location.id) expect(e.fact).toBe(fact);
  });

  it("is the written name in a finished dungeon, and its key answers that", () => {
    const gd = generateOffline(SEED, 1);
    const location = gd.stocked.challenges.find((c) => c.kind === "goal-location")!;
    expect(location.property).toMatch(/^where to find the /);
    expect(location.property.length).toBeLessThan(60);
    const key = gd.stocked.rooms.flatMap((r) => r.rewards).find((w) => w.kind === "key" && w.challengeId === location.id);
    if (key?.kind === "key") expect(key.answers).toBe(location.property);
  });
});

describe("the outline in the room writer's prompt", () => {
  function payloadFor(seed: number) {
    const draft = draftFor(seed);
    const outline = fakeOutline(draft);
    const sd = settle(draft, outline);
    const ep = runEntitiesPass(sd, draft.blueprint, new Rng(sd.seed));
    return { draft, outline, payload: buildContentPassPayload(sd, draft.blueprint, ep, "[fiction]") };
  }

  it("shows the notes, the ways, the keys and the objective", () => {
    const { outline, payload } = payloadFor(SEED);
    const prompt = renderContentPassPrompt(payload);
    expect(prompt).toContain(`story note: ${outline.rooms[0]!.story}`);
    expect(prompt).toContain(`the outline says: ${outline.ways[0]!.form}`);
    expect(prompt).toContain(outline.keys[0]!.gotBy);
    expect(prompt).toContain(`the objective is a Item: ${outline.objective.form}`);
  });

  it("lists a story feature as an entity that must be written", () => {
    const { outline, payload } = payloadFor(SEED);
    const feature = outline.rooms.find((r) => r.storyFeature !== "none")!;
    const brief = payload.rooms.find((r) => r.ref === feature.ref)!;
    expect(brief.entities.some((e) => e.kind === "story" && e.keywords["Story feature"] === feature.storyFeature)).toBe(true);
  });

  it("sends back a goal written as a different kind of thing", () => {
    const { payload } = payloadFor(SEED);
    const res = {
      rooms: payload.rooms.map((r) => ({
        ref: r.ref,
        name: r.ref,
        base: "A room.",
        ...(r.goal ? { goal: { entityType: "Creature" as const, name: "x", base: "y" } } : {}),
      })),
    };
    expect(contentPassOmissions(payload, res).some((o) => /the objective is a Item/.test(o.message))).toBe(true);
  });
});

describe("game shorthand in what the player reads", () => {
  const payload = (fact: string): KeysPassPayload => ({
    dungeonContext: "",
    instructions: "",
    responseSchema: "",
    keys: [
      {
        ref: "key1",
        roomName: "Hall",
        roomBase: "A hall.",
        target: { name: "x", base: "y", fact, label: "z", kind: "obstacle" },
      },
    ],
  });
  const answer = (base: string) => ({ keys: [{ ref: "key1", name: "A ledger", base }] });

  it.each([
    ["where Magic item lies", 'A note on the flyleaf: where Magic item lies.'],
    ["the way is blocked", 'Scratched on its shank: "the way is blocked".'],
    ["Contraption, which reversal", "The caption reads: Contraption, which reversal."],
  ])("catches %s", (fact, base) => {
    const leaks = keysPassLeaks(payload(fact), answer(base));
    expect(leaks).toHaveLength(1);
    expect(leaks[0]!.path).toBe("keys.key1");
  });

  it("catches the shape even when the fact is worded differently", () => {
    expect(keysPassLeaks(payload("flowers"), answer("It reads: where Enemy weakness lies."))).toHaveLength(1);
  });

  it("leaves ordinary prose alone, including a fact that is fair to say", () => {
    expect(keysPassLeaks(payload("flowers"), answer("The ghoul recoils from flowers."))).toEqual([]);
    expect(keysPassLeaks(payload("the way is blocked"), answer("A note: the door sticks, lift as you pull."))).toEqual([]);
  });

  it("asks again for only the keys that leaked, and keeps the rest", () => {
    expect(askForKeys([{ path: "keys.key1" }])).toContain("ONLY these keys: key1");
    const merged = mergeKeys(
      { keys: [{ ref: "a", name: "A", base: "old" }, { ref: "b", name: "B", base: "kept" }] },
      { keys: [{ ref: "a", name: "A", base: "new" }] }
    );
    expect(merged.keys.map((k) => k.base)).toEqual(["new", "kept"]);
  });

  it("has no shorthand in a key's brief as a whole dungeon writes it", () => {
    const gd = generateOffline(SEED, 1);
    const keys = buildKeysPassPayload(gd.stocked, gd.entities, "");
    const location = keys.keys.find((k) => k.target.kind === "goal-location");
    expect(location?.target.fact).toMatch(/^where to find /);
    expect(location?.plan?.key).toBeTruthy();
  });
});
