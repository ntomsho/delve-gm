/**
 * A GAME MASTER WITH NO MODEL BEHIND IT
 * =================================
 *
 * Canned envelopes, chosen by keyword on what the player typed. It exists so
 * the turn machine can be driven through every stage, every diff shape and
 * every rejection path before a single token is spent — and, because it reads
 * the real world to build its diffs, it is also a playable demo: the ids it
 * quotes are the ids the applier will look up, so a stub commit fails exactly
 * where a model's would.
 *
 * ONE THING IT DOES THAT A GAME MASTER MUST NOT. Where a creature strikes back, the
 * stub subtracts a flat point of damage, because it has no dice of its own: the
 * player's roll is made by the machine and handed over, but a creature's turn
 * happens inside the resolution, where the game master would call the dice tool.
 * That tool is Phase 4. Until it exists this is the one number in the game not
 * drawn from the RNG, and it is marked at both call sites so it cannot quietly
 * become the pattern.
 *
 * It is NOT a simulation of the game master's judgement. Each branch exists to
 * exercise one shape of answer:
 *
 *   look / window   rejected, and must therefore change nothing
 *   door            clarifying, likewise
 *   attack          a roll offered, then resolved off the dice it comes back with
 *   force / climb   a save offered
 *   take            parentId — picking something up
 *   search          children[] with a ref, used again later in the same commit
 *   go / leave      the player's roomId — the one route to a room entry
 *   poison          hp.current to nothing, which the store turns into `dead`
 *   goal            goal_met
 *   cheat           a commit the applier must refuse, twice, to reach `error`
 *   anything else   an ordinary resolution
 *
 * Under __fixtures__ so vitest does not collect it as a suite.
 */

import { dcFromDefense, ORDINARY_DC } from "../rules/knave/rolls.ts";
import {
  farSide,
  isSurfaceExit,
  isWeapon,
  touches,
  type ICreature,
} from "../shared/world/entities.ts";
import { creatureDefense } from "../gameplay/view/character.ts";
import { needsComposition } from "../gameplay/view/room.ts";
import { directContents } from "../gameplay/mechanics/occupancy.ts";
import { PLAYER_ID, type Commit, type Diff } from "../shared/types/commit.ts";
import type { RollSpec } from "../shared/types/turn.ts";
import type { GameMaster, GameMasterReply, GameMasterRequest } from "../gameplay/turn.ts";

// ---------------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------------

const reply = (narration: string, commit: Commit): GameMasterReply => ({ narration, commit });

/** Where an ordinary turn leaves the game: open floor, top of the heuristic. */
const open = (diffs: Diff[]): Commit => ({
  nextStage: "awaiting_action",
  timeSpent: "instant",
  nextStep: "1-target",
  diffs,
});

function creatureHere(req: GameMasterRequest): ICreature | undefined {
  return req.run.entities.creatures.find((c) => c.roomId === req.run.currentRoomId);
}

function looseItemHere(req: GameMasterRequest) {
  return req.run.entities.items.find(
    (i) => i.parentId === req.run.currentRoomId && i.isHidden !== true
  );
}

/**
 * An unblocked way out, and the room on the far side.
 *
 * Somewhere NEW for preference. The first unblocked connector is usually the
 * one just walked through, so taking it would bounce the player between two
 * rooms forever — which makes the stub useless for finding a fight by hand.
 * A room nobody has described yet is one nobody has stood in.
 */
function wayOut(req: GameMasterRequest): { connectorId: string; toRoomId: string } | undefined {
  const here = req.run.currentRoomId;
  const rooms = req.run.entities.rooms;

  const ways = req.run.entities.connectors
    .filter((x) => touches(x, here) && x.conditional === undefined)
    // Never hidden, and never the way OUT — a stub that wandered onto the
    // surface would end its own run looking for a fight.
    .filter((x) => x.isHidden !== true && !isSurfaceExit(x))
    .map((x) => ({ connectorId: x.id, toRoomId: farSide(x, here)! }));

  const unseen = ways.find((w) => rooms.find((r) => r.id === w.toRoomId)?.composed === undefined);
  return unseen ?? ways[0];
}

// ---------------------------------------------------------------------------
// ROOM ENTRY
// ---------------------------------------------------------------------------

/**
 * Describe the room and everything in it that owes the player prose.
 *
 * `needsComposition` is the same selector the real room-entry pass will use, so
 * the stub writes exactly the set a model would be asked to write — including
 * nothing at all, when the player walks back into a room they have already seen
 * and nothing has moved.
 */
function roomEntry(req: GameMasterRequest): GameMasterReply {
  const room = req.run.entities.rooms.find((r) => r.id === req.run.currentRoomId);
  const owed = needsComposition(req.run);

  const diffs: Diff[] = owed.flatMap((e) => [
    { entityId: e.id, path: "state", value: "as the player finds it" },
    {
      entityId: e.id,
      path: "composed",
      value:
        e.type === "Room"
          ? `${e.name}. The air is close and the floor is uneven underfoot.`
          : `${e.name}, where it has evidently stood for some time.`,
    },
  ]);

  const contents = directContents(req.run.currentRoomId, req.run.entities).filter(
    (e) => e.isHidden !== true
  );

  return reply(
    `${room?.name ?? "Somewhere"}.\n\n` +
      (contents.length > 0
        ? `You can make out ${contents.map((c) => c.name).join(", ")}.`
        : "There is nothing here but the walls."),
    open(diffs)
  );
}

// ---------------------------------------------------------------------------
// ROLLS
// ---------------------------------------------------------------------------

function offerAttack(req: GameMasterRequest): GameMasterReply {
  const target = creatureHere(req);
  if (!target) {
    return reply("There is nothing in here to fight.", {
      nextStage: "rejected",
      timeSpent: "instant",
      nextStep: "1-target",
      diffs: [],
    });
  }

  const weapon = req.run.pc.inventory.find((i) => i.id === req.run.pc.equipped.weapon);
  const spec: RollSpec = {
    kind: "attack",
    ability: "str",
    bonus: req.run.pc.abilities.str,
    edge: "none",
    description: `Strike at ${target.name}.`,
    weapon: weapon?.id ?? "unarmed",
    mode: "damage",
    // Already converted: the game master holds the defense, the machine does not.
    dc: dcFromDefense(creatureDefense(target, "str")),
    damage: weapon && isWeapon(weapon) ? weapon.weapon.damage : "1d4",
    targetId: target.id,
  };

  return reply(`${target.name} turns toward you. It will come down to the swing.`, {
    nextStage: "roll_offered",
    timeSpent: "instant",
    nextStep: "4-confirm-roll",
    rollRequest: spec,
    diffs: [],
  });
}

function offerSave(req: GameMasterRequest, input: string): GameMasterReply {
  const spec: RollSpec = {
    kind: "save",
    ability: "str",
    bonus: req.run.pc.abilities.str,
    edge: "disadvantage",
    description: `${input} — awkwardly, and with nothing to brace against.`,
    dc: ORDINARY_DC,
  };

  return reply("It will take some doing.", {
    nextStage: "roll_offered",
    timeSpent: "instant",
    nextStep: "4-confirm-roll",
    rollRequest: spec,
    diffs: [],
  });
}

/** The dice have come back. Spend them. */
function resolveRoll(req: GameMasterRequest): GameMasterReply {
  const rolled = req.roll!;
  const spec = rolled.spec;

  if (spec.kind !== "attack") {
    return rolled.success
      ? reply("It gives, all at once, and you keep your feet.", open([
          { entityId: req.run.currentRoomId, path: "state", value: "something here has been forced" },
          { entityId: req.run.currentRoomId, path: "composed", value: "The room, and the thing you forced in it." },
        ]))
      : reply("It does not give, and you come away with a wrenched shoulder.", open([
          // AUTHORED NUMBER — see the header. Phase 4's dice tool replaces it.
          { entityId: PLAYER_ID, path: "hp.current", value: Math.max(1, req.run.pc.hp.current - 1) },
          { entityId: PLAYER_ID, path: "conditions[]", value: "wrenched shoulder" },
        ]));
  }

  const target = req.run.entities.creatures.find((c) => c.id === spec.targetId);
  if (!target) return reply("Whatever you swung at is no longer there.", open([]));

  if (!rolled.success) {
    return reply(
      `The swing goes wide of ${target.name}, and it answers.`,
      open([
        { entityId: target.id, path: "activity", value: "pressing the attack" },
        { entityId: target.id, path: "state", value: "unhurt, and no longer curious" },
        // AUTHORED NUMBER — see the header. Phase 4's dice tool replaces it.
        { entityId: PLAYER_ID, path: "hp.current", value: Math.max(1, req.run.pc.hp.current - 1) },
      ])
    );
  }

  // Every number here came off the dice: the machine rolled damage, this only
  // subtracts it. A stub that invented one would be teaching the wrong lesson.
  const damage = rolled.damage?.total ?? 0;
  const left = target.stats.hp - damage;

  const diffs: Diff[] = [{ entityId: target.id, path: "stats.hp", value: left }];
  // A natural 20 costs the defender's armour a point. The player has no armour
  // to take it from here, so the fumble branch is the one that bites.
  if (rolled.crit.attackerWeapon && spec.weapon && spec.weapon !== "unarmed") {
    const weapon = req.run.pc.inventory.find((i) => i.id === spec.weapon);
    if (weapon) {
      diffs.push({
        entityId: weapon.id,
        path: "currentQuality",
        value: (weapon.currentQuality ?? weapon.quality ?? 1) - 1,
      });
    }
  }
  if (left > 0) {
    diffs.push({ entityId: target.id, path: "state", value: "bleeding, still upright" });
    diffs.push({ entityId: target.id, path: "composed", value: `${target.name}, bleeding.` });
  }

  return reply(
    left > 0
      ? `You open ${target.name} for ${damage}. It is still standing.`
      : `${damage} is enough. ${target.name} goes down and stays down.`,
    open(diffs)
  );
}

// ---------------------------------------------------------------------------
// THE STUB
// ---------------------------------------------------------------------------

export const stubGameMaster: GameMaster = async (req) => respond(req);

/** Synchronous, so tests can reason about it without a clock. */
export function respond(req: GameMasterRequest): GameMasterReply {
  if (req.step === "room-entry") return roomEntry(req);
  if (req.roll) return resolveRoll(req);

  const said = (req.input ?? "").toLowerCase();

  // A retry: the applier refused what was said last time. Every branch except
  // `cheat` is well-formed, so reaching here twice means the stub is wrong —
  // say so plainly rather than papering over it.
  if (req.rejections && !said.includes("cheat")) {
    return reply(
      "You take a moment to reconsider.",
      open([{ entityId: req.run.currentRoomId, path: "state", value: "nothing has changed" }])
    );
  }

  // --- the roll negotiation, when one is on the table ----------------------
  if (req.step === "4-confirm-roll") {
    if (said.includes("cancel") || said.includes("never mind") || said.includes("stop")) {
      // A cancel changes nothing, and so does not spend a turn.
      return reply("You think better of it.", open([]));
    }
    // Anything else is treated as a renegotiation that earns nothing: the roll
    // stands exactly as offered, which is the "weak reason" branch of step 4.
    return reply("That does not change the odds. The roll stands.", {
      nextStage: "roll_offered",
      timeSpent: "instant",
      nextStep: "4-confirm-roll",
      rollRequest: req.run.pendingRoll!,
      diffs: [],
    });
  }

  // --- rejections and clarifications: both must change nothing -------------
  if (said.includes("window") || said.includes("sky") || said.includes("sun")) {
    return reply("There is no window. You are a long way underground.", {
      nextStage: "rejected",
      timeSpent: "instant",
      nextStep: "1-target",
      diffs: [],
    });
  }

  if (said.includes("door")) {
    return reply("Which door — the one you came in by, or the other?", {
      nextStage: "clarifying",
      timeSpent: "instant",
      nextStep: "1-target",
      diffs: [],
    });
  }

  // --- the deliberately bad commit -----------------------------------------
  if (said.includes("cheat")) {
    // `name` is never writable. The applier refuses it, the machine asks once
    // more, this branch says the same thing again, and the game lands on
    // `error` with the world untouched.
    return reply("Something goes wrong that the game master cannot describe.", {
      nextStage: "awaiting_action",
      timeSpent: "instant",
      nextStep: "1-target",
      diffs: [{ entityId: req.run.currentRoomId, path: "name", value: "Somewhere Else" }],
    });
  }

  // --- terminals -----------------------------------------------------------
  if (said.includes("poison")) {
    return reply("It goes down cold, and then it does not stop going down.", {
      nextStage: "awaiting_action", // the store overrides this off the death event
      timeSpent: "instant",
      nextStep: "1-target",
      diffs: [{ entityId: PLAYER_ID, path: "hp.current", value: 0 }],
    });
  }

  if (said.includes("goal") || said.includes("win")) {
    return reply("The way out is behind you, and what you came for is in your hand.", {
      nextStage: "goal_met",
      timeSpent: "instant",
      nextStep: "5-resolution",
      diffs: [{ entityId: req.run.currentRoomId, path: "state", value: "left behind" }],
    });
  }

  // --- rolls ---------------------------------------------------------------
  if (said.includes("attack") || said.includes("hit") || said.includes("strike")) {
    return offerAttack(req);
  }
  if (said.includes("force") || said.includes("climb") || said.includes("pry") || said.includes("lift")) {
    return offerSave(req, req.input ?? "");
  }

  // --- ordinary actions ----------------------------------------------------
  if (said.includes("take") || said.includes("pick up") || said.includes("grab")) {
    const item = looseItemHere(req);
    if (!item) {
      return reply("There is nothing loose in here worth carrying.", {
        nextStage: "rejected",
        timeSpent: "instant",
        nextStep: "1-target",
        diffs: [],
      });
    }
    return reply(`You take up ${item.name}.`, open([
      { entityId: item.id, path: "parentId", value: PLAYER_ID },
      { entityId: item.id, path: "state", value: "carried" },
    ]));
  }

  if (said.includes("search") || said.includes("look under") || said.includes("rummage")) {
    // Establishing something that was never written down, then acting on it in
    // the same commit — the only window in which `ref` is addressable.
    return reply(
      "Under the loose flag there is a tin box, and in it a key.",
      open([
        {
          entityId: req.run.currentRoomId,
          path: "children[]",
          value: {
            type: "Item",
            name: "tin box",
            base: "a flat tin box, the kind that holds a single small thing",
            state: "prised out of the floor",
            ref: "box",
          },
        },
        {
          entityId: "box",
          path: "children[]",
          value: { type: "Item", name: "brass key", base: "a small brass key, worn smooth", ref: "key" },
        },
        { entityId: "key", path: "parentId", value: PLAYER_ID },
        { entityId: req.run.currentRoomId, path: "state", value: "one flagstone lifted and set aside" },
      ])
    );
  }

  if (said.includes("go") || said.includes("leave") || said.includes("through") || said.includes("north")) {
    const way = wayOut(req);
    if (!way) {
      return reply("Every way out of here is shut.", {
        nextStage: "rejected",
        timeSpent: "instant",
        nextStep: "1-target",
        diffs: [],
      });
    }
    return reply("You go through.", open([
      { entityId: way.connectorId, path: "state", value: "left open behind you" },
      { entityId: PLAYER_ID, path: "roomId", value: way.toRoomId },
    ]));
  }

  // --- and everything else -------------------------------------------------
  return reply(
    "You do that, and the room is much as it was.",
    open([
      { entityId: req.run.currentRoomId, path: "state", value: `disturbed: ${req.input ?? ""}`.trim() },
      { entityId: req.run.currentRoomId, path: "composed", value: "The room, a little more disturbed than it was." },
    ])
  );
}
