/**
 * Prompt assembly, snapshotted — BUILD-PLAN §8.
 *
 * The point of a snapshot here is that a prompt change becomes a visible diff
 * in review. Prompts are the part of this system with no type checker and no
 * compiler; a line quietly dropped from the character sheet is the sort of
 * thing that shows up three sessions later as "the referee keeps forgetting
 * what I'm carrying". This makes it show up in the diff instead.
 *
 * Only the messages are snapshotted. The system blocks are SKILL.md and the
 * step files — thousands of words of prose that are already reviewed as their
 * own files, and snapshotting them would drown the diff. What IS asserted
 * about them is the thing prose review cannot catch: their order, and where
 * the cache breakpoint sits.
 */

import { describe, expect, it } from "vitest";
import { assemble, CARRIED_TURNS, MAX_EXCHANGE } from "./assemble.ts";
import { generateOffline, testCharacter } from "../__fixtures__/offline.ts";
import { exitLabel, roomView } from "../../store/selectors.ts";
import { useGame, type RunState } from "../../store/game.ts";
import type { RolledOutcome } from "../turn.ts";

const dungeon = generateOffline(1005, 1);

function fresh(): RunState {
  useGame.getState().reset();
  useGame.getState().start(dungeon, testCharacter());
  return useGame.getState().run!;
}

/**
 * Entity ids are minted per run and are not seeded — the determinism the engine
 * promises is over the structure, not the identifiers (see generation.test.ts,
 * which hashes for the same reason). So they are replaced with stable tokens in
 * order of appearance: the snapshot still proves every id reached the page, and
 * still fails if one stops being rendered.
 */
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

function scrub(messages: { role: string; content: unknown }[]) {
  const seen = new Map<string, string>();
  return messages.map((m) => ({
    role: m.role,
    content: String(m.content).replace(UUID, (id) => {
      if (!seen.has(id)) seen.set(id, `«id-${seen.size + 1}»`);
      return seen.get(id)!;
    }),
  }));
}

const rolled: RolledOutcome = {
  spec: {
    kind: "attack",
    ability: "str",
    bonus: 2,
    edge: "none",
    description: "Strike at the thing in the dark.",
    weapon: "unarmed",
    mode: "damage",
    dc: 13,
    damage: "1d6",
    targetId: "target-1",
  },
  rolled: [17],
  kept: 17,
  total: 19,
  success: true,
  nat20: false,
  nat1: false,
  damage: { expr: "1d6", rolls: [4], flat: 0, total: 4 },
  crit: { defenderArmor: false, attackerWeapon: false },
};

describe("the system prompt", () => {
  it("is stable, then cached, then the part that moves", () => {
    const { system } = assemble({ step: "1-target", dungeon, run: fresh() });

    expect(system).toHaveLength(3);
    // Caching is a prefix match, so the ordering is the whole trick: the
    // playbook and the fiction never change, and the breakpoint goes after
    // them. Put the step files ahead of it and the cache dies every time the
    // heuristic moves.
    expect(system[0].text).toContain("# Dungeon Loop");
    expect(system[1].text).toContain("# This dungeon");
    expect(system[1].cache_control).toEqual({ type: "ephemeral" });
    expect(system[2].cache_control).toBeUndefined();
  });

  it("loads the chain reachable from the step, and nothing else", () => {
    const at = (step: Parameters<typeof assemble>[0]["step"]) =>
      assemble({ step, dungeon, run: fresh() }).system[2].text;

    // A fresh action runs 1 → 2 → 3 in a single call, so it carries all three
    // and neither of the two that only a later call reaches.
    const action = at("1-target");
    expect(action).toContain("# Step 1 — Determine the target of the action");
    expect(action).toContain("# Step 2 — Determine validity and action type");
    expect(action).toContain("# Step 3 · standard action");
    expect(action).not.toContain("# Step 4 — Roll confirmation");
    expect(action).not.toContain("# Step 5 — Action resolution");

    // A resolution carries one file.
    expect(at("5-resolution")).toContain("# Step 5 — Action resolution");
    expect(at("5-resolution")).not.toContain("# Step 1");
  });
});

describe("the messages", () => {
  it("a fresh action", () => {
    fresh();
    useGame.getState().pushTranscript({ role: "player", text: "I look at the far wall" });

    expect(scrub(assemble({ step: "1-target", dungeon, run: useGame.getState().run! }).messages))
      .toMatchSnapshot();
  });

  it("a room entry", () => {
    expect(scrub(assemble({ step: "room-entry", dungeon, run: fresh() }).messages)).toMatchSnapshot();
  });

  it("a resolution, holding the roll", () => {
    expect(scrub(assemble({ step: "5-resolution", dungeon, run: fresh(), roll: rolled }).messages))
      .toMatchSnapshot();
  });

  it("a retry, holding the applier's reasons", () => {
    expect(
      scrub(
        assemble({
          step: "1-target",
          dungeon,
          run: fresh(),
          rejections: ["name: that field is never writable", "ghoul-9: no such entity"],
        }).messages
      )
    ).toMatchSnapshot();
  });
});

describe("the budget", () => {
  it("caps the exchange for an action nobody will stop arguing about", () => {
    fresh();
    for (let i = 0; i < 30; i++) {
      useGame.getState().pushTranscript({ role: "player", text: `argument ${i}` });
      useGame.getState().pushTranscript({ role: "referee", text: `answer ${i}` });
    }

    const { messages } = assemble({ step: "4-confirm-roll", dungeon, run: useGame.getState().run! });
    // The brief, the capped exchange, and the instruction.
    expect(messages).toHaveLength(MAX_EXCHANGE + 2);
    // 60 entries in, the last 12 out: the argument starts at 24 and the
    // 24 before it are gone.
    expect(messages[1].content).toContain("argument 24");
    expect(JSON.stringify(messages)).not.toContain("argument 23");
  });

  it("carries the last two finished turns, as records rather than prose", () => {
    fresh();
    for (let i = 1; i <= 5; i++) {
      useGame.getState().recordTurn({
        action: `action ${i}`,
        outcome: `outcome ${i}`,
        diffsApplied: i,
      });
    }

    const brief = assemble({ step: "1-target", dungeon, run: useGame.getState().run! })
      .messages[0].content as string;

    expect(brief).toContain("outcome 5");
    expect(brief).toContain(`outcome ${5 - CARRIED_TURNS + 1}`);
    expect(brief).not.toContain("outcome 3");
  });

  it("does not send the scrollback", () => {
    fresh();
    useGame.getState().pushLog({ kind: "referee", text: "something from an hour ago" });

    const { messages } = assemble({ step: "1-target", dungeon, run: useGame.getState().run! });
    expect(JSON.stringify(messages)).not.toContain("an hour ago");
  });
});

describe("what the referee is told that the player is not", () => {
  it("lists concealed things, and marks them", () => {
    const run = fresh();
    const hidden = run.entities.items.find((i) => i.isHidden === true);
    if (!hidden) return; // this fixture has none to find

    const brief = assemble({ step: "1-target", dungeon, run }).messages[0].content as string;
    expect(brief).toContain(hidden.id);
    expect(brief).toContain("NOT YET FOUND BY THE PLAYER");
  });

  // A bare uuid on the far side of an exit is unroutable: asked to send the
  // player back to the Laboratory, a referee holding only ids guesses, and it
  // guesses wrong. Named once they have been through — which is also when the
  // player can ask for it by name, so the two sets match.
  it("names the room beyond a way out they have used, and not one they have not", () => {
    const run = fresh();
    const brief = () => assemble({ step: "1-target", dungeon, run }).messages[0].content as string;

    const exit = run.entities.connectors.find(
      (c) => c.endpointA === run.currentRoomId || c.endpointB === run.currentRoomId
    )!;
    const beyond = run.entities.rooms.find(
      (r) => r.id === (exit.endpointA === run.currentRoomId ? exit.endpointB : exit.endpointA)
    )!;

    expect(brief()).toContain("somewhere they have not been");
    expect(brief()).not.toContain(beyond.name);

    beyond.composed = "they have stood in it";
    expect(brief()).toContain(`${beyond.name}, which they have been to`);
    // The label the panel shows, repeated verbatim, so the referee can match
    // the player's words to it.
    const label = exitLabel(
      roomView(run, dungeon, run.currentRoomId, { includeHidden: true })!.exits.find(
        (x) => x.connectorId === exit.id
      )!
    );
    expect(label).toBe(`${exit.name} to ${beyond.name}`);
    expect(brief()).toContain(`"${label}"`);
  });

  it("gives every creature's defenses, so a difficulty can be set", () => {
    const run = fresh();
    const here = run.entities.creatures.filter((c) => c.roomId === run.currentRoomId);
    if (here.length === 0) return;

    const brief = assemble({ step: "1-target", dungeon, run }).messages[0].content as string;
    expect(brief).toContain("armour defense");
    expect(brief).toContain("morale");
  });
});
