/**
 * THE APPLIER
 * ===========
 *
 * The single chokepoint between what the referee says happened and what the
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
 */

import {
  addItem,
  EQUIP_SLOTS,
  isOverburdened,
  makeId,
  maxHp,
  removeItem,
  setComposed,
  setIsHidden,
  setState,
  validateEquipment,
  type AnyEntity,
  type EquipSlot,
  type ICreature,
  type IEntity,
  type IHazard,
  type IItem,
  type IMobileEffect,
  isSurfaceExit,
  type IRoomConnector,
  type IRoomFeature,
} from "../../engine/index.ts";
import { equipResolving, unequip as unequipSlot } from "../../engine/index.ts";
import { NO_CHANGE_STAGES } from "../types.ts";
import { heldItems } from "../occupancy.ts";
import { routeTo } from "../travel.ts";
import { isWritable, normalizePath, writablePaths, type EntityKind } from "./paths.ts";
import {
  PLAYER_ID,
  type ApplyResult,
  type Commit,
  type Diff,
  type EntitySpec,
  type Rejection,
  type World,
  type WorldEvent,
} from "./types.ts";

// ---------------------------------------------------------------------------
// INDEX
// ---------------------------------------------------------------------------

interface Entry {
  kind: EntityKind;
  entity: AnyEntity | null; // null for the player, which is not an IEntity
}

function indexWorld(w: World): Map<string, Entry> {
  const m = new Map<string, Entry>();
  m.set(PLAYER_ID, { kind: "PlayerCharacter", entity: null });
  m.set(w.pc.id, { kind: "PlayerCharacter", entity: null });

  for (const r of w.entities.rooms) m.set(r.id, { kind: "Room", entity: r });
  for (const c of w.entities.connectors) m.set(c.id, { kind: "RoomConnector", entity: c });
  for (const c of w.entities.creatures) m.set(c.id, { kind: "Creature", entity: c });
  for (const f of w.entities.features) m.set(f.id, { kind: "RoomFeature", entity: f });
  for (const h of w.entities.hazards) m.set(h.id, { kind: "Hazard", entity: h });
  for (const e of w.entities.effects) m.set(e.id, { kind: "MobileEffect", entity: e });
  // Items live in two places: loose in the world, or carried by the player.
  for (const i of w.entities.items) m.set(i.id, { kind: "Item", entity: i });
  for (const i of w.pc.inventory) m.set(i.id, { kind: "Item", entity: i });
  return m;
}

// ---------------------------------------------------------------------------
// CONTEXT
// ---------------------------------------------------------------------------

class Failure extends Error {}

const fail = (reason: string): never => {
  throw new Failure(reason);
};

interface Ctx {
  world: World;
  index: Map<string, Entry>;
  events: WorldEvent[];
  /** ref -> minted id, so a commit can reference what it just created */
  refs: Map<string, string>;
}

const asNumber = (v: unknown, what: string): number =>
  typeof v === "number" && Number.isFinite(v) ? v : fail(`${what} must be a number`);

const asString = (v: unknown, what: string): string =>
  typeof v === "string" && v.trim() !== "" ? v : fail(`${what} must be a non-empty string`);

const asBoolean = (v: unknown, what: string): boolean =>
  typeof v === "boolean" ? v : fail(`${what} must be true or false`);

function resolveId(ctx: Ctx, id: string): string {
  return ctx.refs.get(id) ?? id;
}

function requireEntity(ctx: Ctx, id: string): Entry {
  const entry = ctx.index.get(resolveId(ctx, id));
  return entry ?? fail(`no entity with id ${JSON.stringify(id)}`);
}

// ---------------------------------------------------------------------------
// REMOVAL
// ---------------------------------------------------------------------------

function removeFromWorld(ctx: Ctx, entity: AnyEntity): void {
  const e = ctx.world.entities;
  const drop = <T extends { id: string }>(list: T[]) => {
    const i = list.findIndex((x) => x.id === entity.id);
    if (i !== -1) list.splice(i, 1);
  };
  drop(e.rooms); drop(e.connectors); drop(e.creatures);
  drop(e.features); drop(e.items); drop(e.hazards); drop(e.effects);
  removeItem(ctx.world.pc, entity.id); // no-op unless the player held it
  ctx.index.delete(entity.id);
}

/** Destroy an item, wherever it is, clearing any slot that pointed at it. */
function destroyItem(ctx: Ctx, item: IItem, why: string): void {
  const wasEquipped = EQUIP_SLOTS.some((s) => ctx.world.pc.equipped[s] === item.id);
  removeFromWorld(ctx, item);
  ctx.events.push({ kind: "item-destroyed", entityId: item.id, detail: `${item.name || "an item"} ${why}` });
  if (wasEquipped) {
    ctx.events.push({ kind: "unequipped", entityId: item.id, detail: `${item.name || "an item"} left its slot` });
  }
}

/** Kill a creature; what it carried falls where it stood. */
function slayCreature(ctx: Ctx, creature: ICreature): void {
  for (const item of heldItems(creature.id, ctx.world.entities)) item.parentId = creature.roomId;
  removeFromWorld(ctx, creature);
  ctx.events.push({
    kind: "creature-slain",
    entityId: creature.id,
    detail: `${creature.name || "a creature"} is dead`,
  });
}

/**
 * THE PLAYER WALKS. They do not appear.
 *
 * The referee names where the player is going and the world works out how far
 * they get, which is the same bargain as everywhere else in this file: state the
 * destination, not the procedure. `routeTo` owns the graph — see travel.ts for
 * what stops a walk and why the destination itself is never checked.
 *
 * Two things are settled here rather than there. A route that does not exist is
 * a REJECTION, so the reasons reach the referee and it gets the one retry §5
 * allows; a route that ends short is APPLIED, because getting as far as the
 * Torture Room and finding something in it is a real outcome and not an error.
 * The event says so, and the arrival pass describes wherever they actually are.
 *
 * Read AFTER any earlier diff in the same batch, deliberately: unbar the door
 * and walk through it is one commit, and the unbarring is already applied by the
 * time the route is drawn.
 */
function walkTo(ctx: Ctx, to: string): void {
  const route = routeTo(ctx.world, to);
  if (route.unreachable) fail(route.unreachable);

  ctx.world.currentRoomId = route.endsAt;

  // The last way they actually crossed — which is how the room they are now in
  // knows which of its exits is the one behind them. Left alone when the walk
  // covered no ground at all, because then nothing was crossed.
  const last = route.legs[route.legs.length - 1];
  if (last) ctx.world.arrivedVia = last.connectorId;

  if (route.stoppedBy) {
    ctx.events.push({
      kind: "movement-stopped",
      entityId: ctx.world.pc.id,
      detail: route.stoppedBy,
    });
  }
}

// ---------------------------------------------------------------------------
// HANDLERS
// ---------------------------------------------------------------------------

function applyProse(ctx: Ctx, entity: IEntity, path: string, value: unknown): boolean {
  if (path === "state") {
    // Marks needUpdate and leaves the existing description alone: the thing may
    // be two rooms away, and there is no sense spending a call describing it
    // until the player is looking at it again.
    setState(entity, asString(value, "state"));
    return true;
  }
  if (path === "composed") {
    setComposed(entity, asString(value, "composed"));
    return true;
  }
  if (path === "isHidden") {
    // Through the helper: concealing settles the description debt, revealing
    // opens one. See setIsHidden.
    setIsHidden(entity, asBoolean(value, "isHidden"));
    return true;
  }
  return false;
}

function applyToItem(ctx: Ctx, item: IItem, path: string, value: unknown): void {
  switch (path) {
    case "amount":
      item.amount = asString(value, "amount");
      return;

    case "currentQuality": {
      const q = asNumber(value, "currentQuality");
      const ceiling = item.quality ?? q;
      item.currentQuality = Math.max(0, Math.min(ceiling, q));
      if (item.currentQuality === 0) destroyItem(ctx, item, "is destroyed");
      return;
    }

    case "parentId": {
      // null means gone from the world entirely.
      if (value === null) {
        destroyItem(ctx, item, "is gone");
        return;
      }
      const target = asString(value, "parentId");
      const heldByPlayer = ctx.world.pc.inventory.some((i) => i.id === item.id);

      if (target === PLAYER_ID || target === ctx.world.pc.id) {
        if (heldByPlayer) return; // already carried
        const i = ctx.world.entities.items.findIndex((x) => x.id === item.id);
        if (i !== -1) ctx.world.entities.items.splice(i, 1);
        // Forced: the fiction has already committed to the pickup. Being
        // overburdened is a condition to report, not a reason to refuse.
        addItem(ctx.world.pc, item, { force: true });
        if (isOverburdened(ctx.world.pc)) {
          ctx.events.push({
            kind: "overburdened",
            entityId: ctx.world.pc.id,
            detail: "carrying more than their slots allow",
          });
        }
        return;
      }

      // Moving out into the world — the holder must exist.
      requireEntity(ctx, target);
      if (heldByPlayer) {
        const removed = removeItem(ctx.world.pc, item.id);
        if (removed) ctx.world.entities.items.push(removed);
      }
      item.parentId = resolveId(ctx, target);
      return;
    }
  }
  fail(`unhandled Item path ${JSON.stringify(path)}`);
}

function applyToCreature(ctx: Ctx, creature: ICreature, path: string, value: unknown): void {
  switch (path) {
    case "activity":
      creature.activity = asString(value, "activity");
      return;

    case "roomId": {
      const room = requireEntity(ctx, asString(value, "roomId"));
      if (room.kind !== "Room") fail("roomId must name a room");
      creature.roomId = resolveId(ctx, value as string);
      return;
    }

    case "count": {
      const n = asNumber(value, "count");
      if (n < 0) fail("count cannot be negative");
      creature.count = n;
      if (n === 0) slayCreature(ctx, creature);
      return;
    }

    case "stats.hp": {
      const hp = asNumber(value, "stats.hp");
      // Clamped above only. Overkill is worth narrating, and a floor at zero
      // would make "dropped to exactly 0" and "hit for twelve past dead" the
      // same state.
      creature.stats.hp = Math.min(maxHp(creature.stats), hp);
      if (creature.stats.hp <= 0) slayCreature(ctx, creature);
      return;
    }
  }
  fail(`unhandled Creature path ${JSON.stringify(path)}`);
}

function applyToPlayer(ctx: Ctx, path: string, raw: string, value: unknown): void {
  const pc = ctx.world.pc;

  if (path === "hp.current") {
    const hp = asNumber(value, "hp.current");
    pc.hp.current = Math.min(pc.hp.max, Math.max(-pc.hp.max, hp));
    if (pc.hp.current <= 0) {
      ctx.events.push({ kind: "player-died", entityId: pc.id, detail: "the player character is slain" });
    }
    return;
  }

  if (path === "roomId") {
    const room = requireEntity(ctx, asString(value, "roomId"));
    if (room.kind !== "Room") fail("roomId must name a room");
    // Where the player stands is world-level rather than a field on the sheet:
    // dropped things land here, and a new value is what puts the turn machine
    // into a room entry.
    walkTo(ctx, resolveId(ctx, value as string));
    return;
  }

  if (path === "conditions[]") {
    pc.conditions.push(asString(value, "a condition"));
    return;
  }

  if (path === "conditions[#]") {
    const i = indexOf(raw);
    if (i >= pc.conditions.length) fail(`no condition at index ${i}`);
    if (value !== null) fail("write null to clear a condition, or conditions[] to add one");
    pc.conditions.splice(i, 1);
    return;
  }

  if (path === "inventory[#]") {
    const i = indexOf(raw);
    const item = pc.inventory[i] ?? fail(`nothing carried at index ${i}`);
    if (value !== null) fail("write null to drop a carried item");
    // A drop is three consequences from one stated fact: out of the slot, out
    // of any equipment slot, and onto the floor where the player stands.
    const removed = removeItem(pc, item.id);
    if (removed) {
      removed.parentId = ctx.world.currentRoomId;
      ctx.world.entities.items.push(removed);
    }
    return;
  }

  if (path.startsWith("equipped.")) {
    const slot = path.slice("equipped.".length) as EquipSlot;
    if (value === null) {
      unequipSlot(pc, slot);
      return;
    }
    const id = resolveId(ctx, asString(value, "an item id"));
    // Through the resolving form, so stating the destination is enough: taking
    // up a two-hander puts the shield away by itself. Everything it displaces
    // is reported, so the narration can say the shield went on the player's
    // back rather than it vanishing quietly.
    const outcome = equipResolving(pc, slot, id);
    if (!outcome.ok) fail(outcome.reason ?? "that cannot be equipped there");
    for (const displaced of outcome.displaced) {
      ctx.events.push({
        kind: "unequipped",
        entityId: displaced,
        detail: `the ${displaced} slot was emptied to make room`,
      });
    }
    return;
  }

  fail(`unhandled player path ${JSON.stringify(path)}`);
}

function indexOf(raw: string): number {
  const m = /\[\s*(\d+)\s*\]/.exec(raw);
  return m ? Number(m[1]) : fail(`expected an index in ${JSON.stringify(raw)}`);
}

function createEntity(ctx: Ctx, holderId: string, value: unknown): void {
  const spec = value as EntitySpec;
  if (!spec || typeof spec !== "object") fail("children[] takes an entity to create");
  if (spec.type !== "Item" && spec.type !== "RoomFeature") {
    // Creatures need hit dice, a stat block, and a template to resolve their
    // base through — none of which a diff can supply well. They come from
    // generation.
    fail(`cannot create a ${String(spec.type)}; only Item and RoomFeature`);
  }
  const name = asString(spec.name, "the new entity's name");
  const base = asString(spec.base, "the new entity's base");
  const holder = requireEntity(ctx, holderId);
  const resolvedHolder = resolveId(ctx, holderId);

  const id = makeId();
  if (spec.type === "Item") {
    const item: IItem = {
      id, name, type: "Item", base,
      parentId: holder.kind === "PlayerCharacter" ? ctx.world.pc.id : resolvedHolder,
      slots: spec.slots ?? 1,
      ...(spec.amount ? { amount: spec.amount } : {}),
    };
    if (spec.state) setState(item, spec.state);
    if (holder.kind === "PlayerCharacter") addItem(ctx.world.pc, item, { force: true });
    else ctx.world.entities.items.push(item);
    ctx.index.set(id, { kind: "Item", entity: item });
  } else {
    // A feature belongs to a room. If it was hung off a creature or an item,
    // it belongs to whichever room that thing is in.
    const roomId = roomContaining(ctx, resolvedHolder) ?? ctx.world.currentRoomId;
    const feature: IRoomFeature = { id, name, type: "RoomFeature", base, roomId };
    if (spec.state) setState(feature, spec.state);
    if (spec.hidden) feature.isHidden = true;
    ctx.world.entities.features.push(feature);
    ctx.index.set(id, { kind: "RoomFeature", entity: feature });
  }

  if (spec.ref) ctx.refs.set(spec.ref, id);
  ctx.events.push({ kind: "entity-created", entityId: id, detail: `${name} now exists` });
}

function roomContaining(ctx: Ctx, id: string): string | undefined {
  const e = ctx.world.entities;
  if (e.rooms.some((r) => r.id === id)) return id;
  const creature = e.creatures.find((c) => c.id === id);
  if (creature) return creature.roomId;
  const feature = e.features.find((f) => f.id === id);
  if (feature) return feature.roomId;
  const item = [...e.items, ...ctx.world.pc.inventory].find((i) => i.id === id);
  return item ? roomContaining(ctx, item.parentId) : undefined;
}

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
// ENTRY POINT
// ---------------------------------------------------------------------------

export interface ApplyOutcome extends ApplyResult {
  /** the new world, present only when ok */
  world?: World;
}

/**
 * Apply a commit. On success the caller adopts `world`; on failure the original
 * is untouched and `rejected` explains why, in terms the referee can act on.
 */
export function applyCommit(world: World, commit: Commit): ApplyOutcome {
  const rejected: Rejection[] = [];

  // A rejection or a clarification changes nothing. Stated in the playbook and
  // enforced here, because "the referee was told not to" is not enforcement.
  if (NO_CHANGE_STAGES.includes(commit.nextStage) && (commit.diffs.length > 0 || commit.fictionNote)) {
    const reason = `a "${commit.nextStage}" turn must not change the world`;
    const refusals = commit.diffs.map((diff) => ({ diff, reason }));
    // The fiction is part of the world for this purpose. A turn that turned the
    // player away has not established anything — least of all about the dungeon
    // — and a note attached to one is the referee writing history out of an
    // action it just refused.
    if (commit.fictionNote !== undefined) {
      refusals.push({
        diff: { entityId: "(the dungeon)", path: "fictionNote", value: commit.fictionNote },
        reason: `${reason}, and that includes adding to its fiction`,
      });
    }
    return { ok: false, applied: [], events: [], rejected: refusals };
  }

  const draft: World = structuredClone(world);
  const ctx: Ctx = { world: draft, index: indexWorld(draft), events: [], refs: new Map() };
  const applied: Diff[] = [];

  // The goal LATCHES. A referee that mentions it once and then forgets cannot
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
  // deduplicated so a referee restating the same fact on a retry does not stack
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

  if (rejected.length > 0) return { ok: false, applied: [], rejected, events: [] };

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
