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
 */

import {
  addItem,
  EQUIP_SLOTS,
  equipResolving,
  isOverburdened,
  removeItem,
  unequip as unequipSlot,
  validateEquipment,
  type EquipSlot,
} from "../../rules/knave/character.ts";
import { amountCount } from "../../rules/knave/equipment.ts";
import {
  isBook,
  maxHp,
  properName,
  setComposed,
  setIsHidden,
  setState,
  type AnyEntity,
  type ICreature,
  type IEntity,
  type IHazard,
  type IItem,
  type IMobileEffect,
  isSurfaceExit,
  type IRoomConnector,
  type IRoomFeature,
} from "../../shared/world/entities.ts";
import { makeId } from "../../shared/utils/id.ts";
import { NO_CHANGE_STAGES } from "../../shared/types/turn.ts";
import { applyDraw, grantCoin, noteResolutions, recordFact, resolutionsFrom } from "../mechanics/challenges.ts";
import { heldItems } from "../mechanics/occupancy.ts";
import { routeTo, stepToward } from "../mechanics/travel.ts";
import { isWritable, normalizePath, writablePaths, type EntityKind } from "./paths.ts";
import {
  PLAYER_ID,
  type ApplyResult,
  type Commit,
  type Diff,
  type EntitySpec,
  type Rejection,
  type TimeSpent,
  type World,
  type WorldEvent,
} from "../../shared/types/commit.ts";

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
  /**
   * What the player was carrying BEFORE this batch touched anything.
   *
   * `world` is the draft, so it answers "is this carried now", which is a
   * different question and the wrong one for any guard about what the turn
   * found. See the `isHidden` guard in `applyProse`.
   */
  carriedAtStart: ReadonlySet<string>;
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
 * The game master names where the player is going and the world works out how far
 * they get, which is the same bargain as everywhere else in this file: state the
 * destination, not the procedure. `routeTo` owns the graph — see travel.ts for
 * what stops a walk and why the destination itself is never checked.
 *
 * Two things are settled here rather than there. A route that does not exist is
 * a REJECTION, so the reasons reach the game master and it gets the one retry §5
 * allows — and so is one stopped before its first step, which goes nowhere; a
 * route that ends short is APPLIED, because getting as far as the Torture Room
 * and finding something in it is a real outcome and not an error.
 * The event says so, and the arrival pass describes wherever they actually are.
 *
 * Read AFTER any earlier diff in the same batch, deliberately: unbar the door
 * and walk through it is one commit, and the unbarring is already applied by the
 * time the route is drawn.
 */
function walkTo(ctx: Ctx, to: string): void {
  const route = routeTo(ctx.world, to);
  if (route.unreachable) fail(route.unreachable);

  // STOPPED BEFORE THE FIRST STEP IS A REJECTION, not a walk that ended short.
  // A walk cut off partway is a real outcome — they are somewhere new, and the
  // arrival pass says where. One that never got going leaves the game master's own
  // narration as the only account of the turn, and that narration was written
  // assuming the move: "You push through the iron gate … The Gatehouse is
  // brutally cold" while the player stood in the Cell block (2026-10-15, the
  // Frosted Gaol). Refused, the game master gets the reason and its one retry: open
  // the way in the same commit, or leave the move out and say they are stopped.
  if (route.stoppedBy && route.legs.length === 0 && route.endsAt !== to) {
    fail(
      `the player cannot set out: ${route.stoppedBy}. Nothing earlier in this commit clears it, so they ` +
        `would not move at all. If the action overcomes it, clear it in the same commit before the move ` +
        `(for a way, set its "conditional" to null); if it does not, leave the move out and narrate them ` +
        `stopped in front of it.`
    );
  }

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
    // YOU CANNOT DISCOVER WHAT YOU WALKED IN CARRYING.
    //
    // The one mechanical tell of a whole class of failure, and the reason it
    // needs a guard and not only a rule: the commit that caused it was
    // *valid*. Asked to reveal something found in the stables, the game master
    // needed an entity for a lantern, was told never to invent an id, and so
    // reached for the nearest plausible one — the player's own lantern, which
    // it then described as half-buried in the straw of a room they were only
    // passing through. Every path it wrote is writable on an item, so there
    // were no grounds to refuse it. (8a A3, seq 454 of the 2026-08-10 run.)
    //
    // `isHidden` on a thing they already had is the part that cannot be
    // anything else. Concealment is read only of things standing in a room;
    // the character sheet renders the whole inventory either way, so the write
    // is inert as well as incoherent. Refusing it costs nothing legitimate,
    // and it takes the batch — and the invented prose riding along with it —
    // down too.
    //
    // THE QUESTION IS ABOUT THE TURN, NOT ABOUT THIS INSTANT, and reading the
    // draft got that wrong for a whole class of legitimate commit. A pickup
    // that also reveals is two diffs — `parentId` to the player, `isHidden`
    // false — and the second one arrives with the first already applied to the
    // draft, so a guard reading `world` refuses a ledger for being in an
    // inventory the diff above it put the ledger in. Atomicity then took the
    // pickup down with the reveal, and the retry read its own refusal as "they
    // already have it" and committed nothing at all, three turns running.
    // (8a A8, the Bookyard in the 2026-08-12 run.) `carriedAtStart` is the
    // state the batch began in, which is what "already had it" ever meant.
    //
    // What is deliberately NOT guarded: `parentId` to the room the player is
    // standing in, which is indistinguishable from putting something down
    // because it *is* putting something down; and `composed` describing a
    // carried item as scenery, which is the other half of the tell and is
    // prose no check can read. SKILL.md rule 3 carries those.
    if (ctx.carriedAtStart.has(entity.id)) {
      fail(
        `${entity.name} was already in the player's inventory when this turn began, so it ` +
          `cannot be hidden or revealed — they walked in holding it. Something the player ` +
          `has just found is a DIFFERENT thing, even when they already own one like it: ` +
          `create it with children[] on whatever holds it and leave this one alone. ` +
          `(Picking up something concealed IS allowed: set parentId to the player and ` +
          `isHidden to false in the same commit.)`
      );
    }
    // Through the helper: concealing settles the description debt, revealing
    // opens one. See setIsHidden.
    setIsHidden(entity, asBoolean(value, "isHidden"));
    return true;
  }
  return false;
}

function applyToItem(ctx: Ctx, item: IItem, path: string, value: unknown): void {
  switch (path) {
    /*
     * WHAT IS LEFT OF IT — AND NOTHING LEFT IS NO ROW AT ALL.
     *
     * `setPurse` made this call for money first: "A purse of nothing is no row
     * at all", because a line reading "Copper (0 cp)" on a sheet is noise. This
     * is that decision generalised to everything measured. The last ration eaten
     * is not a ration of zero days in the pack; it is no rations.
     *
     * ONLY ON A STATED ZERO. `amountCount` reads the leading integer or nothing,
     * and "a handful" is nothing — an unparseable amount must not delete a
     * thing. Getting that backwards would erase items on a game master's turn of
     * phrase, which is the one failure here that the player could not recover
     * from.
     */
    case "amount": {
      item.amount = asString(value, "amount");
      if (amountCount(item.amount) === 0) destroyItem(ctx, item, "is used up");
      return;
    }

    case "book.uses": {
      // One reading at a time, and no reading un-read. The count only ever
      // moves up, and only ever by one, because that is what a consultation is
      // — see `consultRoll`, which is the only thing that should be producing
      // this number.
      if (!isBook(item)) return fail(`${item.name} is not a book, so it has no consultations`);
      const uses = asNumber(value, "book.uses");
      item.book.uses = Math.min(Math.max(uses, item.book.uses), item.book.uses + 1);
      return;
    }

    case "book.exhausted": {
      // A LATCH. A book that has given up everything in it does not get it
      // back, so this only ever goes one way — see BookFacts.
      if (!isBook(item)) return fail(`${item.name} is not a book, so it cannot be read out`);
      if (asBoolean(value, "book.exhausted")) {
        item.book.exhausted = true;
        ctx.events.push({
          kind: "book-exhausted",
          entityId: item.id,
          detail: `${item.name || "the book"} has nothing further to tell anyone`,
        });
      }
      return;
    }

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
        takeIntoInventory(ctx, item);
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
      // Put somewhere outright, so whatever it was walking toward is settled
      // one way or the other. Leaving the destination on would have it turn
      // round and set off again next turn.
      delete creature.approach;
      return;
    }

    /*
     * THE CREATURE WALKS. It does not appear.
     *
     * `walkTo` for creatures, and the same bargain: the destination is what is
     * asked for, and the world answers back with where it actually got to. The
     * game master holds one room and cannot see the graph; it says "it hears the
     * fight and comes" and the applier spends the three rooms of walking, one
     * per turn, in the sweep at the foot of this file.
     *
     * A DESTINATION WITH NO ROUTE IS REFUSED, not quietly dropped. A silently
     * ignored write is a creature the game master believes is on its way and that
     * never arrives, and the game master finds out about it never.
     *
     * Nothing moves here. The write sets the destination; the sweep does the
     * stepping, and it does it for this creature too — so a creature told to
     * come is one room closer by the end of the same commit, and exactly one.
     */
    case "approach": {
      const room = requireEntity(ctx, asString(value, "approach"));
      if (room.kind !== "Room") fail("approach must name a room");
      const to = resolveId(ctx, value as string);

      if (to === creature.roomId) {
        // Already standing in it. Not an error — "come here" said of something
        // that is here is satisfied, not impossible.
        delete creature.approach;
        return;
      }
      if (stepToward(ctx.world, creature.roomId, to) === undefined) {
        fail(
          `no way leads from ${creature.name || "that creature"}'s room to ${JSON.stringify(to)}. ` +
            `It cannot walk somewhere no corridor reaches.`
        );
      }
      creature.approach = to;
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

  // NULL IS A DROP; A VALUE IS A PICKUP.
  //
  // This path used to take null and nothing else, and the refusal read
  // "nothing carried at index 7" — true, and useless. In one playtest the
  // game master reached for it three times to say "they now have this": twice for
  // things found by searching, once for a lockbox lifted by telekinesis. It is
  // the path that most obviously names where a thing ended up, and stating a
  // destination value is precisely what the envelope asks for, so the
  // vocabulary was inviting the mistake it then refused. (8a A2.)
  //
  // THE INDEX IS ADVISORY ON A PICKUP. The inventory is a compacted list, so
  // the item goes on the end; honouring a stated position would mean opening
  // holes in an array whose whole contract is that it has none. `inventory[]`
  // and `inventory[4]` therefore do the same thing, which is what the
  // `conditions` pair above already establishes as the convention.
  if (path === "inventory[#]" || path === "inventory[]") {
    if (value === null) {
      if (path === "inventory[]") fail("inventory[] appends; write inventory[i] with null to drop");
      const i = indexOf(raw);
      const item =
        pc.inventory[i] ??
        fail(
          `nothing carried at index ${i} to drop — to put something INTO the player's hands, ` +
            `write that item to inventory[] (an id to move one that exists, an entity to make ` +
            `one), or set the item's own parentId to "${PLAYER_ID}"`
        );
      // A drop is three consequences from one stated fact: out of the slot, out
      // of any equipment slot, and onto the floor where the player stands.
      const removed = removeItem(pc, item.id);
      if (removed) {
        removed.parentId = ctx.world.currentRoomId;
        ctx.world.entities.items.push(removed);
      }
      return;
    }

    // An id moves something that already exists. Anything else is a spec, and
    // mints exactly as `children[]` on the player does — same function, so a
    // thing found by searching cannot arrive half-formed down one route and
    // whole down the other.
    if (typeof value === "string") {
      const entry = requireEntity(ctx, value);
      if (entry.kind !== "Item" || !entry.entity) {
        fail(
          `only an item can be carried; ${JSON.stringify(value)} is a ${entry.kind} — ` +
            `to make something new, write the entity itself rather than an id`
        );
      }
      takeIntoInventory(ctx, entry.entity as IItem);
      return;
    }
    createEntity(ctx, PLAYER_ID, value);
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

/**
 * Into the player's hands, from wherever it was.
 *
 * Shared by `item.parentId = <player>` and by `inventory[…] = <id>`, which are
 * two ways of saying the same thing and were once two different code paths —
 * one of which worked. Whichever the game master reaches for, the item leaves the
 * world's list, the equip slots stay coherent, and the slot budget is reported
 * rather than enforced.
 *
 * FORCED, deliberately: the fiction has already committed to the pickup by the
 * time this runs, so being overburdened is a condition to narrate, not grounds
 * to refuse a commit and unsay a paragraph.
 */
function takeIntoInventory(ctx: Ctx, item: IItem): void {
  if (ctx.world.pc.inventory.some((i) => i.id === item.id)) return; // already carried
  const i = ctx.world.entities.items.findIndex((x) => x.id === item.id);
  if (i !== -1) ctx.world.entities.items.splice(i, 1);
  addItem(ctx.world.pc, item, { force: true });
  if (isOverburdened(ctx.world.pc)) {
    ctx.events.push({
      kind: "overburdened",
      entityId: ctx.world.pc.id,
      detail: "carrying more than their slots allow",
    });
  }
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
  // Capitalised here, at the mint, not where it is drawn — see `properName`.
  const name = properName(asString(spec.name, "the new entity's name"));
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
      // Worth nothing until something says otherwise, and the something cannot
      // be the game master: a price is a number, and the model does not write those.
      // Grades are gone with `rollItemValue`, so there is no longer even a
      // judgement it could offer here — what a found thing is worth is decided
      // at generation, from the conserved pot or from the catalog.
      value: 0,
    };
    if (spec.state) setState(item, spec.state);
    // Through the same door a pickup uses, so something minted straight into
    // the player's hands reports the slot budget exactly as something taken
    // off the floor does. It used to call `addItem` here and say nothing.
    if (holder.kind === "PlayerCharacter") takeIntoInventory(ctx, item);
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
 * `roomId` is the whole of the move: occupancy is relational (BUILD-PLAN §4.3),
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
