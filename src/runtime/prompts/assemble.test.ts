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
import { exitLabel, needsComposition, roomView } from "../../store/selectors.ts";
import { createGameStore, type RunState } from "../../store/game.ts";
/** This file's own store — see the note atop `store/game.ts`. */
const useGame = createGameStore();

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

  // What play establishes about the place reads as a continuation of the
  // dungeon's fiction, but it grows during the run — so it goes BEHIND the
  // breakpoint, where a change costs one call's cache rather than every call's.
  it("carries what play has established, after the cached block", () => {
    const run = fresh();
    expect(assemble({ step: "1-target", dungeon, run }).system).toHaveLength(3);

    const { system } = assemble({
      step: "1-target",
      dungeon,
      run: { ...run, fiction: ["The gaol was built over a mine."] },
    });
    expect(system).toHaveLength(4);
    expect(system[1].cache_control).toEqual({ type: "ephemeral" });
    expect(system[2].text).toContain("The gaol was built over a mine.");
    expect(system[2].cache_control).toBeUndefined();
  });

  it("loads the chain reachable from the step, and nothing else", () => {
    const at = (step: Parameters<typeof assemble>[0]["step"]) =>
      assemble({ step, dungeon, run: fresh() }).system.at(-1)!.text;

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

  // The case that did not exist, which is why the defect below shipped.
  it("a retry after a roll, which must still hold the roll", () => {
    expect(
      scrub(
        assemble({
          step: "5-resolution",
          dungeon,
          run: fresh(),
          roll: rolled,
          rejections: ["inventory[8]: nothing carried at index 8"],
        }).messages
      )
    ).toMatchSnapshot();
  });
});

// ===========================================================================
// 8a A1 — A REFUSED COMMIT MUST NOT THROW THE TURN AWAY
// ===========================================================================

/**
 * The reasons are a preamble. They were a substitute, and the substitution
 * dropped the only line carrying the player's roll — so a retry at step 5 was
 * a resolution with no number in it, and the referee restarted the heuristic
 * and offered the same roll again. Seed 15341: a save won at 20, re-rolled to
 * a 9, and the objective lost with it.
 *
 * The property is a superset, asserted line by line rather than by snapshot,
 * because the thing that must hold is "nothing was dropped" and a snapshot
 * only tells you something moved.
 */
describe("a retry is the original ask, plus the reasons", () => {
  const last = (p: ReturnType<typeof assemble>) => p.messages.at(-1)!.content as string;

  const shapes = [
    { name: "a resolution holding a roll", req: { step: "5-resolution" as const, roll: rolled } },
    { name: "a room entry", req: { step: "room-entry" as const } },
    { name: "an action in progress", req: { step: "1-target" as const } },
  ];

  it("drops nothing from any of the three asks", () => {
    for (const { name, req } of shapes) {
      const run = fresh();
      const first = last(assemble({ dungeon, run, ...req }));
      const retry = last(assemble({ dungeon, run, ...req, rejections: ["x: refused"] }));

      for (const line of first.split("\n")) {
        if (line.trim() !== "") expect(retry, `${name}: dropped "${line}"`).toContain(line);
      }
      expect(retry, name).toContain("x: refused");
      expect(retry, name).toContain("This is the same turn, not a new one.");
    }
  });

  it("still puts the roll and its total in front of the referee", () => {
    const run = fresh();
    const retry = last(
      assemble({
        step: "5-resolution",
        dungeon,
        run,
        roll: rolled,
        rejections: ["inventory[8]: nothing carried at index 8"],
      })
    );

    // The exact line that vanished, and the number that vanished with it.
    expect(retry).toContain("## The roll the player just took");
    expect(retry).toContain("**19**");
    expect(retry).toContain("Resolve the action at step 5.");
    // And the reasons come first, so the refusal frames the ask rather than
    // arriving as a footnote to it.
    expect(retry.indexOf("REFUSED")).toBeLessThan(retry.indexOf("The roll the player just took"));
  });

  it("still lists what a room entry owes, so a retry does not compose the wrong things", () => {
    const run = fresh();
    const owed = needsComposition(run);
    expect(owed.length).toBeGreaterThan(0);

    const retry = last(
      assemble({ step: "room-entry", dungeon, run, rejections: ["base: never writable"] })
    );
    for (const e of owed) expect(retry).toContain(e.id);
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

  // Defence in depth behind `renderRoll`: the dice should not reach the
  // referee through one line of one branch of one function ever again.
  it("carries a roll on the player's side without making it something they said", () => {
    fresh();
    useGame.getState().pushTranscript({ role: "roll", text: "DEX save: 17 +3 = 20 — success" });

    const { messages } = assemble({ step: "5-resolution", dungeon, run: useGame.getState().run! });

    expect(messages[1].role).toBe("user");
    expect(messages[1].content).toBe("The player rolled: DEX save: 17 +3 = 20 — success");
    expect(messages[1].content).not.toContain("The player says");
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

  // 8f. A concealed WAY OUT used to arrive here dressed exactly like an open
  // one: `renderEntity` marks a concealed thing standing in a room, and nothing
  // marked a door. The referee then counted it among the ways out and described
  // it, which is the one thing a secret door must not survive.
  it("marks a concealed way out, and does not count it in the drawing", () => {
    const run = fresh();
    const secret = run.entities.connectors.find((c) => c.isHidden === true && c.endpointB !== null);
    // No guard-and-return: a fixture with no secret way makes this test a lie,
    // and the right answer is to hear about it rather than pass.
    expect(secret, "no concealed way in the fixture dungeon").toBeDefined();
    run.currentRoomId = secret!.endpointA;

    const brief = assemble({ step: "1-target", dungeon, run }).messages[0].content as string;

    // Listed, because the referee has to know it is there to be found...
    expect(brief).toContain(secret!.id);
    // ...marked, so it knows not to say so...
    const line = brief.split("\n").find((l) => l.includes(secret!.id))!;
    expect(line).toContain("NOT YET FOUND BY THE PLAYER");
    expect(line).toContain("do not count it among the ways out");

    // ...and absent from the count in the drawing, which is where R2's "four
    // ways lead out" came from in a room the panel showed three ways out of.
    const drawn = brief.slice(brief.indexOf("### As drawn on the map"));
    const ways = drawn.slice(drawn.indexOf("Ways out:"), drawn.indexOf("\n", drawn.indexOf("Ways out:")));
    const visible = roomView(run, dungeon, run.currentRoomId)!.exits;
    const counted = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight"];
    const said = [...ways.matchAll(/(\w+) off the/g)].reduce((n, m) => n + counted.indexOf(m[1]), 0);
    expect(said).toBe(visible.length);
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
