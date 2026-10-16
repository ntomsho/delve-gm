/**
 * THE APPLIER
 * ===========
 *
 * The single chokepoint between what the game master says happened and what the
 * save file contains.
 *
 * ATOMIC BY CONSTRUCTION. The batch is applied to a deep clone; the clone is
 * adopted only if every diff succeeded. That is stronger than validating first
 * and applying second, and it is the only approach that copes with a batch
 * whose later diffs depend on its earlier ones — unequip the shield, then take
 * up the two-handed sword. Validating both against the starting state would
 * refuse the second for a conflict that the first had already resolved.
 *
 * The invariants are not re-implemented here. `equip`, `addItem`, `removeItem`
 * and `validateEquipment` already own them, so the handlers call those. A
 * well-formed write straight to `equipped.shield` would pass any path check and
 * still produce a shield worn alongside a two-hander; routing through `equip`
 * cannot.
 *
 * This file is the dispatch and the entry point. What each kind of path does is
 * in `handlers.ts`; the index and per-commit context they share is in
 * `context.ts`.
 */

import {
  unequip as unequipSlot,
  validateEquipment,
  type EquipSlot,
} from "../../rules/knave/character.ts";
import {
  type ICreature,
  type IHazard,
  type IItem,
  type IMobileEffect,
  isSurfaceExit,
  type IRoomConnector,
  type IRoomFeature,
} from "../../shared/world/entities.ts";
import { NO_CHANGE_STAGES } from "../../shared/types/turn.ts";
import {
  applyDraw,
  grantCoin,
  noteResolutions,
  recordFact,
  resolutionsFrom,
} from "../mechanics/challenges.ts";
import { stepToward } from "../mechanics/travel.ts";
import { isWritable, normalizePath, writablePaths } from "./paths.ts";
import {
  PLAYER_ID,
  type ApplyResult,
  type Commit,
  type Diff,
  type Rejection,
  type TimeSpent,
  type World,
} from "../../shared/types/commit.ts";
import {
  Failure,
  asBoolean,
  asString,
  fail,
  indexWorld,
  requireEntity,
  resolveId,
  type Ctx,
} from "./context.ts";
import {
  applyProse,
  applyToCreature,
  applyToItem,
  applyToPlayer,
  createEntity,
} from "./handlers.ts";

// ---------------------------------------------------------------------------
// DISPATCH
// ---------------------------------------------------------------------------

function applyOne(ctx: Ctx, diff: Diff): void {
  const raw = diff.path;
  const path = normalizePath(raw);
  const entry = requireEntity(ctx, diff.entityId);

  if (!isWritable(entry.kind, path)) {
    fail(
      `${entry.kind} has no writable path ${JSON.stringify(path)}; ` +
        `it accepts ${writablePaths(entry.kind).join(", ")}`
    );
  }

  if (path === "children[]") {
    createEntity(ctx, diff.entityId, diff.value);
    return;
  }

  if (entry.kind === "PlayerCharacter") {
    applyToPlayer(ctx, path, raw, diff.value);
    return;
  }

  const entity = entry.entity!;
  if (applyProse(ctx, entity, path, diff.value)) return;

  switch (entry.kind) {
    case "Item":
      applyToItem(ctx, entity as IItem, path, diff.value);
      return;
    case "Creature":
      applyToCreature(ctx, entity as ICreature, path, diff.value);
      return;
    case "RoomConnector": {
      const conn = entity as IRoomConnector;
      // Deleting the field is how a lock gets resolved — "absent" is the model
      // for "freely usable", so null must remove it rather than store a null.
      if (diff.value === null) delete conn.conditional;
      else conn.conditional = asString(diff.value, "conditional");
      return;
    }
    case "RoomFeature": {
      const f = entity as IRoomFeature;
      if (path === "roomId") {
        const room = requireEntity(ctx, asString(diff.value, "roomId"));
        if (room.kind !== "Room") fail("roomId must name a room");
        f.roomId = resolveId(ctx, diff.value as string);
        return;
      }
      break;
    }
    case "Hazard": {
      const h = entity as IHazard;
      if (path === "sprung") { h.sprung = asBoolean(diff.value, "sprung"); return; }
      if (path === "active") { h.active = asBoolean(diff.value, "active"); return; }
      break;
    }
    case "MobileEffect": {
      const fx = entity as IMobileEffect;
      if (path === "roomIds") {
        if (!Array.isArray(diff.value)) fail("roomIds must be an array of room ids");
        const ids = (diff.value as unknown[]).map((v) => asString(v, "a room id"));
        for (const id of ids) {
          if (requireEntity(ctx, id).kind !== "Room") fail(`${id} is not a room`);
        }
        fx.roomIds = ids.map((id) => resolveId(ctx, id));
        return;
      }
      break;
    }
    case "Room":
      break; // prose only, handled above
  }

  fail(`unhandled ${entry.kind} path ${JSON.stringify(path)}`);
}

// ---------------------------------------------------------------------------
// THE WORLD MOVES WHILE THE PLAYER IS BUSY
// ---------------------------------------------------------------------------

/**
 * EVERY CREATURE WITH SOMEWHERE TO BE GETS ONE ROOM CLOSER.
 *
 * Run once per applied commit, after the diffs and before anything that reads
 * where things are. The game master names destinations; this is the only thing that
 * spends them, so "three rooms off" is three turns and not a number the game master
 * has to keep in its head.
 *
 * TIME SPENT IS THE GATE, and it is the whole of what the applier reads off
 * `timeSpent`. `instant` is a glance or a word — nobody crosses a room in the
 * time it takes to look at something, so nobody moves. Every other category is
 * a turn actually passing, and one room is what passing buys. WHICH creatures
 * are given a destination in the first place is the game master's judgement and is
 * described in the step file; this only ever spends what it was handed.
 *
 * The creature that was told to come THIS commit is stepped here too, and once.
 * The write above deliberately moves nothing, so there is exactly one stepper
 * and no case where a creature covers two rooms for one turn.
 *
 * `roomId` is the whole of the move: occupancy is relational (BUILD-PLAN §2.9),
 * so leaving one room and joining another is one assignment and there is no
 * second list to keep in step with it.
 *
 * A destination that has become unreachable — the only way to it barred by an
 * earlier diff in this same commit — leaves the creature standing and keeps the
 * destination. It is trying, and the way may open again.
 */
function walkApproaching(ctx: Ctx, timeSpent: TimeSpent): void {
  if (timeSpent === "instant") return;

  for (const creature of ctx.world.entities.creatures) {
    const to = creature.approach;
    if (to === undefined) continue;

    const next = stepToward(ctx.world, creature.roomId, to);
    if (next === undefined) continue;

    creature.roomId = next;
    if (next === to) delete creature.approach;
  }
}

// ---------------------------------------------------------------------------
// ENTRY POINT
// ---------------------------------------------------------------------------

export interface ApplyOutcome extends ApplyResult {
  /** the new world, present only when ok */
  world?: World;
}

/**
 * Apply a commit. On success the caller adopts `world`; on failure the original
 * is untouched and `rejected` explains why, in terms the game master can act on.
 */
export function applyCommit(world: World, commit: Commit): ApplyOutcome {
  const rejected: Rejection[] = [];

  // A rejection or a clarification changes nothing. Stated in the playbook and
  // enforced here, because "the game master was told not to" is not enforcement.
  const wouldChange =
    commit.diffs.length > 0 ||
    commit.fictionNote !== undefined ||
    commit.draw !== undefined ||
    commit.coinGrant !== undefined ||
    (commit.learned?.length ?? 0) > 0;
  if (NO_CHANGE_STAGES.includes(commit.nextStage) && wouldChange) {
    const reason = `a "${commit.nextStage}" turn must not change the world`;
    const refusals = commit.diffs.map((diff) => ({ diff, reason }));
    // The fiction is part of the world for this purpose. A turn that turned the
    // player away has not established anything — least of all about the dungeon
    // — and a note attached to one is the game master writing history out of an
    // action it just refused.
    if (commit.fictionNote !== undefined) {
      refusals.push({
        diff: { entityId: "(the dungeon)", path: "fictionNote", value: commit.fictionNote },
        reason: `${reason}, and that includes adding to its fiction`,
      });
    }
    // Nor giving anything away. A turn that turned the player away has not
    // earned a key, and a turn that asked them a question has not answered one.
    if (commit.draw !== undefined) {
      refusals.push({
        diff: { entityId: commit.draw.challengeId, path: "draw", value: commit.draw.challengeId },
        reason: `${reason}, and that includes handing over a key`,
      });
    }
    for (const id of commit.learned ?? []) {
      refusals.push({
        diff: { entityId: id, path: "learned", value: id },
        reason: `${reason}, and that includes telling the player something new`,
      });
    }
    if (commit.coinGrant !== undefined) {
      refusals.push({
        diff: { entityId: PLAYER_ID, path: "coinGrant", value: commit.coinGrant.why },
        reason: `${reason}, and that includes finding money`,
      });
    }
    return { ok: false, applied: [], events: [], rejected: refusals };
  }

  const draft: World = structuredClone(world);
  const ctx: Ctx = {
    world: draft,
    index: indexWorld(draft),
    events: [],
    refs: new Map(),
    // Off the ORIGINAL, before a single diff has run. The ids are the same
    // either side of the clone, so this could be read from the draft too — it
    // is read here because that is what the field means.
    carriedAtStart: new Set(world.pc.inventory.map((i) => i.id)),
  };
  const applied: Diff[] = [];

  // The goal LATCHES. A game master that mentions it once and then forgets cannot
  // undo the win, and there is no path back to false.
  if (commit.goalMet === true && !draft.goalMet) {
    draft.goalMet = true;
    ctx.events.push({
      kind: "goal-met",
      entityId: draft.pc.id,
      detail: "the dungeon's objective is accomplished",
    });
  }

  // What the turn added to the story of the place. Appended rather than merged,
  // deduplicated so a game master restating the same fact on a retry does not stack
  // it up, and dropped along with everything else if a diff below is refused —
  // the clone is the whole of the atomicity.
  if (commit.fictionNote !== undefined) {
    const note = commit.fictionNote.trim();
    if (note !== "" && !draft.fiction.includes(note)) draft.fiction.push(note);
  }

  for (const diff of commit.diffs) {
    try {
      applyOne(ctx, diff);
      applied.push(diff);
    } catch (e) {
      if (!(e instanceof Failure)) throw e;
      rejected.push({ diff, reason: e.message });
      // One bad diff rejects the batch. Keep going only to collect the rest of
      // the reasons, so a retry can fix everything at once.
    }
  }

  // --- the reserve: a challenge answered in play ----------------------------
  //
  // AFTER the diffs, so a draw can name an object one of them just created —
  // `entityRef` is resolved through the same ref table `children[]` writes to.
  // Refused rather than warned about: an entry that is not in the reserve, or
  // has been spent, or belongs to a challenge already resolved, is the game master
  // handing out something the dungeon did not have to give.
  if (commit.draw !== undefined && rejected.length === 0) {
    const entityId = commit.draw.entityRef ? ctx.refs.get(commit.draw.entityRef) : undefined;
    if (commit.draw.entityRef !== undefined && entityId === undefined) {
      rejected.push({
        diff: { entityId: commit.draw.entityRef, path: "draw.entityRef", value: commit.draw.challengeId },
        reason: `no entity was created with ref "${commit.draw.entityRef}" in this commit`,
      });
    } else {
      const out = applyDraw(
        draft.challengeState,
        draft.challenges,
        draft.reserve,
        { challengeId: commit.draw.challengeId, ...(entityId !== undefined ? { entityId } : {}) },
        draft.turn
      );
      if (!out.ok) {
        rejected.push({
          diff: { entityId: commit.draw.challengeId, path: "draw", value: commit.draw.challengeId },
          reason: out.reason,
        });
      } else {
        const c = draft.challenges.find((x) => x.id === commit.draw!.challengeId);
        ctx.events.push({
          kind: "key-drawn",
          entityId: entityId ?? commit.draw.challengeId,
          detail: c ? c.property : commit.draw.challengeId,
        });
      }
    }
  }

  // --- what the player now knows -------------------------------------------
  //
  // Written onto the thing it is true of, in the dungeon's own words rather
  // than the game master's. A drawn key is usually learned in the same breath, so
  // this runs after the draw and can name what the draw just spent.
  for (const challengeId of commit.learned ?? []) {
    if (rejected.length > 0) break;
    const out = recordFact(draft, draft.challenges, challengeId, draft.challengeState);
    if (!out.ok) {
      rejected.push({
        diff: { entityId: challengeId, path: "learned", value: challengeId },
        reason: out.reason,
      });
      continue;
    }
    for (const w of out.wrote) {
      ctx.events.push({ kind: "fact-recorded", entityId: w.entityId, detail: w.state });
    }
  }

  // --- coin out of the allowance -------------------------------------------
  //
  // The game master says they found money; the amount is rolled here, from the run's
  // own seed. 10% of the dungeon's pot was held back at generation for exactly
  // this, and when it is spent there is no more.
  if (commit.coinGrant !== undefined && rejected.length === 0) {
    const out = grantCoin(draft, draft.challengeState, draft.turn);
    if (!out.ok) {
      rejected.push({
        diff: { entityId: PLAYER_ID, path: "coinGrant", value: commit.coinGrant.why },
        reason: out.reason,
      });
    } else {
      ctx.events.push({
        kind: "coin-granted",
        entityId: draft.pc.id,
        detail: `${out.amount} cp — ${commit.coinGrant.why}`,
      });
    }
  }

  if (rejected.length > 0) return { ok: false, applied: [], rejected, events: [] };

  // --- what the turn actually resolved --------------------------------------
  //
  // READ OFF THE WORLD, not asked for. A creature is bested because the applier
  // raised `creature-slain`; a way is open because its `conditional` is gone; an
  // obstacle is solved because `resolved` is set on it. See `resolutionsFrom`,
  // and note that the one case with no trace to read — the creature talked past
  // — is deliberately not detected here at all.
  const resolutions = resolutionsFrom(world, draft, ctx.events, draft.challenges);
  noteResolutions(draft.challengeState, draft.challenges, resolutions, draft.turn);
  for (const r of resolutions) {
    ctx.events.push({
      kind: "challenge-resolved",
      entityId: r.challengeId,
      detail: r.resolution,
    });
  }

  walkApproaching(ctx, commit.timeSpent);

  // LEAVING IS A PLACE, NOT A DECISION. A run can only end on the surface, and
  // only from a room with an unblocked way to it — checked after the diffs, so
  // that clearing the rubble and climbing out is one commit. Refused rather than
  // clamped: unlike a walk that ends short, there is no lesser outcome to apply.
  if (commit.nextStage === "departed") {
    const out = draft.entities.connectors.filter(
      (c) => isSurfaceExit(c) && c.endpointA === draft.currentRoomId && c.isHidden !== true
    );
    const reason =
      out.length === 0
        ? `the player cannot leave the dungeon from here: this room has no way to the surface. ` +
          `Walk them to one first — the way out is on the "Ways out" list of the room that has it.`
        : out.every((c) => c.conditional !== undefined)
          ? `the player cannot leave: the way to the surface is blocked — ` +
            `${out.map((c) => c.conditional).join("; ")}.`
          : undefined;

    if (reason !== undefined) {
      return {
        ok: false,
        applied: [],
        events: [],
        rejected: [{ diff: { entityId: PLAYER_ID, path: "nextStage", value: "departed" }, reason }],
      };
    }
  }

  // Equipment can become illegal as a side effect — the shield survived but the
  // armour it was legal beside did not. Put down whatever no longer holds, and
  // say so rather than silently dropping it.
  for (const issue of validateEquipment(draft.pc)) {
    const slot = issue.split(":")[0] as EquipSlot;
    const id = draft.pc.equipped[slot];
    unequipSlot(draft.pc, slot);
    ctx.events.push({ kind: "unequipped", entityId: id ?? slot, detail: issue });
  }

  return { ok: true, world: draft, applied, rejected: [], events: ctx.events };
}
