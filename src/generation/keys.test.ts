/**
 * THE KEYS PASS  (R2)
 * ===================
 *
 * What R1 could not test, because none of it exists until a dungeon has been
 * WRITTEN: a key needs its lock to have a name before there is anything to write
 * about, and the objective has no keyable properties until a chunk has decided
 * what the objective physically is.
 *
 * So these run against `generateOffline`, which is the whole pipeline with the
 * model swapped for a fake that answers point for point. The fake quotes each
 * fact verbatim exactly as the real instruction demands — that is the property
 * the resolution write depends on, and a fake that paraphrased would hide it.
 */

import { describe, expect, it } from "vitest";
import { applyContentPass, buildContentPassPayload } from "./content/passes/content-pass.ts";
import {
  applyKeysPass,
  buildKeysPassPayload,
  keysPassOmissions,
  unwritableKeys,
  withheldKeyItems,
  type KeysPassPayload,
  type KeysPassResponse,
} from "./content/passes/keys-pass.ts";
import { resolveBase } from "../shared/world/entities.ts";
import { Rng } from "../shared/utils/rng.ts";
import { runEntitiesPass } from "./content/entities-pass.ts";
import { fakeKeysPass, generateOffline } from "../fixtures/offline.ts";

const SEEDS = [1005, 4242, 77, 90210, 31337];

/** Every placed key in a dungeon, paired with the challenge it answers. */
function placedKeys(gd: ReturnType<typeof generateOffline>) {
  const out = [];
  for (const r of gd.stocked.rooms) {
    for (const rw of r.rewards) {
      if (rw.kind !== "key") continue;
      out.push({ reward: rw, challenge: gd.stocked.challenges.find((c) => c.id === rw.challengeId) });
    }
  }
  return out;
}

/** The item a reward produced, through the binding that is the only link. */
function itemOfReward(gd: ReturnType<typeof generateOffline>, rewardId: string) {
  const id = gd.entities.bindings.find((b) => b.rewardId === rewardId)?.entityId;
  return gd.entities.items.find((i) => i.id === id);
}

// ===========================================================================
// WHAT THE CONTENT PASS LEAVES ALONE
// ===========================================================================

describe("the content pass withholds placed keys", () => {
  it.each(SEEDS)("seed %i names no placed key in any chunk payload", (seed) => {
    // Deliberately BEFORE the content pass: this is the state the payloads are
    // built in, and the point is that the keys are absent from them.
    const gd = generateOffline(seed, 2);
    const fresh = runEntitiesPass(gd.stocked, gd.blueprint, new Rng(gd.stocked.seed));
    const withheld = withheldKeyItems(gd.stocked, fresh);
    expect(withheld.size).toBeGreaterThan(0);

    const chunks = [...new Set(gd.stocked.rooms.map((r) => r.chunk))];
    const named = new Set<string>();
    for (const chunk of chunks) {
      const p = buildContentPassPayload(gd.stocked, gd.blueprint, fresh, chunk, "[fiction]");
      for (const r of p.rooms) for (const e of r.entities) named.add(e.ref);
    }
    for (const id of withheld) expect(named.has(id)).toBe(false);
  });

  it("refuses a write to a withheld key even if one comes back anyway", () => {
    const gd = generateOffline(1005, 2);
    const ep = runEntitiesPass(gd.stocked, gd.blueprint, new Rng(gd.stocked.seed));
    const withheld = [...withheldKeyItems(gd.stocked, ep)];
    expect(withheld.length).toBeGreaterThan(0);
    const victim = withheld[0]!;
    const roomOf = ep.bindings.find((b) => b.entityId === victim)!.roomId;
    const room = gd.stocked.rooms.find((r) => r.roomId === roomOf)!;

    const payload = buildContentPassPayload(gd.stocked, gd.blueprint, ep, room.chunk, "[fiction]");
    // A response that names the withheld key regardless — the failure mode the
    // applier guard exists for, and the one a payload-only fix would miss.
    applyContentPass(
      {
        rooms: payload.rooms.map((r) => ({
          ref: r.ref,
          name: `Room ${r.ref}`,
          base: "A room.",
          entities: [
            ...r.entities.map((e) => ({ ref: e.ref, name: "thing", base: "A thing." })),
            { ref: victim, name: "SMUGGLED KEY", base: "Written by the wrong pass." },
          ],
        })),
      },
      payload,
      ep,
      gd.blueprint,
      gd.stocked,
      new Rng(1)
    );

    const item = ep.items.find((i) => i.id === victim)!;
    expect(item.name).toBe("");
    expect(item.base).toBeUndefined();
  });

  it("still gives a withheld key a position on the map", () => {
    // Withholding it from the writing must not withhold it from the drawing:
    // a key lying on the floor is as findable as the strongbox beside it, and
    // the pass that names it has no ground left to place it on.
    const gd = generateOffline(1005, 2);
    const loose = [...withheldKeyItems(gd.stocked, gd.entities)]
      .map((id) => gd.entities.items.find((i) => i.id === id)!)
      .filter((it) => gd.entities.rooms.some((r) => r.id === it.parentId));
    expect(loose.length).toBeGreaterThan(0);
    for (const it of loose) expect(it.place).toBeDefined();
  });
});

// ===========================================================================
// THE PAYLOAD
// ===========================================================================

describe("the keys payload", () => {
  it.each(SEEDS)("seed %i quotes a written target for every placed key", (seed) => {
    const gd = generateOffline(seed, 3);
    const payload = buildKeysPassPayload(gd.stocked, gd.entities, "[fiction]");

    // The point of the whole pass: nothing is asked for that cannot be written.
    for (const k of payload.keys) {
      expect(k.target.base).not.toBe("");
      expect(k.target.fact).not.toBe("");
      expect(k.ref).not.toBe("");
    }

    // And every placed key made it in. `unwritableKeys` is the honest report of
    // any that did not, and there should be none: R1 only ever keys a challenge
    // it enumerated, and every enumerated challenge names something a pass wrote.
    expect(unwritableKeys(gd.stocked, gd.entities, payload)).toEqual([]);
    expect(payload.keys).toHaveLength(placedKeys(gd).length);
  });

  it("offers a lock rewrite for blocked ways and for nothing else", () => {
    for (const seed of SEEDS) {
      const gd = generateOffline(seed, 3);
      const payload = buildKeysPassPayload(gd.stocked, gd.entities, "[fiction]");
      for (const k of payload.keys) {
        if (k.target.kind === "blocked-way") expect(k.lockRef).toBeDefined();
        else expect(k.lockRef).toBeUndefined();
      }
    }
  });

  it("names the creature carrying a key rather than only the room", () => {
    // A carried key is a different find from one lying about, and the writer
    // cannot tell from the room alone.
    const carried = SEEDS.map((s) => generateOffline(s, 3))
      .flatMap((gd) => buildKeysPassPayload(gd.stocked, gd.entities, "[fiction]").keys)
      .filter((k) => k.carriedBy !== undefined);
    for (const k of carried) expect(k.carriedBy).not.toBe("");
  });

  it("carries the objective once a chunk has decided what it is", () => {
    const gd = generateOffline(1005, 2);
    const payload = buildKeysPassPayload(gd.stocked, gd.entities, "[fiction]");
    expect(payload.goal).toBeDefined();
    expect(payload.goal!.ref).toBe(gd.entities.goalEntityId);
    expect(payload.goal!.base).not.toBe("");
  });
});

// ===========================================================================
// THE APPLY
// ===========================================================================

describe("applying the keys pass", () => {
  it.each(SEEDS)("seed %i leaves no key unnamed and no fact paraphrased", (seed) => {
    const gd = generateOffline(seed, 3);

    for (const { reward, challenge } of placedKeys(gd)) {
      const item = itemOfReward(gd, reward.id);
      expect(item, `reward ${reward.id} produced no item`).toBeDefined();
      expect(item!.name).not.toBe("");
      expect(resolveBase(item!, gd.entities.registry)).toBeTruthy();

      // THE LINK THE RESOLUTION WRITE RIDES ON. The keyword is the fact
      // verbatim, not the prose around it — reading the fact back out of
      // written prose would be guesswork, and the fact has to match what is
      // about to be written onto the thing the key is about.
      expect(item!.keywords?.Key).toBe(challenge!.property);
      expect(item!.base).toContain(challenge!.property);
    }
  });

  it("mints the objective's properties as challenges and reserve entries", () => {
    const gd = generateOffline(1005, 2);
    const minted = gd.stocked.challenges.filter((c) => c.kind === "goal-property");
    expect(minted.length).toBeGreaterThan(0);

    for (const c of minted) {
      // Derived, never `makeId()` — a save and a reload have to agree about
      // which challenge a ledger entry names.
      expect(c.id.startsWith(`ch:goal-property:${gd.entities.goalEntityId}`)).toBe(true);
      // Every one of them is drawable, and none is placed: there is no object
      // that IS "whose name is cut on the underside".
      expect(gd.stocked.reserve.some((e) => e.challengeId === c.id)).toBe(true);
      expect(
        gd.stocked.rooms.some((r) =>
          r.rewards.some((rw) => rw.kind === "key" && rw.challengeId === c.id)
        )
      ).toBe(false);
    }
  });

  it("caps the objective's properties at three and drops duplicates", () => {
    const gd = generateOffline(4242, 2);
    const payload = buildKeysPassPayload(gd.stocked, gd.entities, "[fiction]");
    const before = gd.stocked.challenges.length;

    const res: KeysPassResponse = {
      keys: [],
      goalProperties: ["  the true seal  ", "The True Seal", "a name", "a third", "a fourth"],
    };
    const out = applyKeysPass(res, payload, gd.stocked, gd.entities);

    // "the true seal" and "The True Seal" are one property; then the cap bites.
    expect(out.goalProperties.map((c) => c.property)).toEqual(["the true seal", "a name", "a third"]);
    expect(gd.stocked.challenges.length).toBe(before + 3);
  });

  it("ignores a key it was not asked to write", () => {
    // Same rule the seams pass follows: a thing the content pass legitimately
    // owns is not this pass's to overwrite.
    const gd = generateOffline(77, 2);
    const payload: KeysPassPayload = { ...buildKeysPassPayload(gd.stocked, gd.entities, "[f]"), keys: [] };
    const victim = gd.entities.items.find((i) => i.name !== "")!;
    const was = victim.name;

    applyKeysPass({ keys: [{ ref: victim.id, name: "STOLEN", base: "Not yours." }] }, payload, gd.stocked, gd.entities);
    expect(victim.name).toBe(was);
  });

  it("rewrites a lock only where one was offered", () => {
    const gd = generateOffline(1005, 3);
    const payload = buildKeysPassPayload(gd.stocked, gd.entities, "[fiction]");
    const out = applyKeysPass(fakeKeysPass(payload), payload, gd.stocked, gd.entities);

    const offered = new Set(payload.keys.filter((k) => k.lockRef).map((k) => k.lockRef!));
    for (const ref of out.locksRewritten) expect(offered.has(ref)).toBe(true);
    // And never onto a way that was not shut in the first place.
    for (const ref of out.locksRewritten) {
      const conn = gd.entities.connectors.find((c) => c.id === ref)!;
      expect(conn.conditional).toBeTruthy();
      expect(conn.endpointB).not.toBeNull();
    }
  });

  it("reports a key that was listed and did not come back", () => {
    const gd = generateOffline(1005, 3);
    const payload = buildKeysPassPayload(gd.stocked, gd.entities, "[fiction]");
    expect(keysPassOmissions(payload, fakeKeysPass(payload))).toEqual([]);

    const res = fakeKeysPass(payload);
    const dropped = res.keys.pop()!;
    const out = keysPassOmissions(payload, res);
    expect(out).toHaveLength(1);
    expect(out[0]!.message).toContain(dropped.ref);
  });
});

// ===========================================================================
// THE BINDING REBUILD
// ===========================================================================

describe("mobile bindings survive the content pass", () => {
  it.each(SEEDS)("seed %i can still reach every creature from its mobile", (seed) => {
    // The content pass THROWS AWAY the placeholder creatures the entities pass
    // emitted and mints its own, with new ids. Before the rebuild, every
    // `mobileId` binding pointed at a creature that no longer existed — and the
    // keys pass could not find a single creature it was meant to write for.
    const gd = generateOffline(seed, 3);
    const live = new Set(gd.entities.creatures.map((c) => c.id));

    const bound = gd.entities.bindings.filter((b) => b.element === "creature" && b.mobileId);
    expect(bound.length).toBeGreaterThan(0);
    for (const b of bound) expect(live.has(b.entityId)).toBe(true);

    // And every creature-targeting challenge can find its creature.
    const byMobile = new Set(bound.map((b) => b.mobileId));
    for (const c of gd.stocked.challenges) {
      if (c.target !== "mobile") continue;
      expect(byMobile.has(c.targetId)).toBe(true);
    }
  });
});
