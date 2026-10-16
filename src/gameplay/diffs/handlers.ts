/**
 * WHAT EACH KIND OF PATH DOES: removing a thing from the world, and one handler
 * per entity kind. `apply.ts` routes each diff to one of these.
 */

import {
  addItem,
  EQUIP_SLOTS,
  equipResolving,
  isOverburdened,
  removeItem,
  unequip as unequipSlot,
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
  type IItem,
  type IRoomFeature,
} from "../../shared/world/entities.ts";
import { makeId } from "../../shared/utils/id.ts";
import { heldItems } from "../mechanics/occupancy.ts";
import { routeTo, stepToward } from "../mechanics/travel.ts";
import { PLAYER_ID, type EntitySpec } from "../../shared/types/commit.ts";
import {
  asBoolean,
  asNumber,
  asString,
  fail,
  requireEntity,
  resolveId,
  type Ctx,
} from "./context.ts";

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
 * a REJECTION, so the reasons reach the game master and it gets the one retry
 * ARCHITECTURE §5.2 allows — and so is one stopped before its first step, which goes nowhere; a
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

export function applyProse(ctx: Ctx, entity: IEntity, path: string, value: unknown): boolean {
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
    // were no grounds to refuse it. (Seen at seq 454 of playtest R1.)
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
    // (The Bookyard, in the 2026-08-12 run.) `carriedAtStart` is the
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

export function applyToItem(ctx: Ctx, item: IItem, path: string, value: unknown): void {
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

export function applyToCreature(ctx: Ctx, creature: ICreature, path: string, value: unknown): void {
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

export function applyToPlayer(ctx: Ctx, path: string, raw: string, value: unknown): void {
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
  // It takes more than null, because a refusal that reads "nothing carried at
  // index 7" is true and useless. In one playtest the
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

export function createEntity(ctx: Ctx, holderId: string, value: unknown): void {
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
      // There are no grades, so there is not even a judgement it could offer
      // here — what a found thing is worth is decided
      // at generation, from the conserved pot or from the catalog.
      value: 0,
    };
    if (spec.state) setState(item, spec.state);
    // Through the same door a pickup uses, so something minted straight into
    // the player's hands reports the slot budget exactly as something taken
    // off the floor does, rather than calling `addItem` and saying nothing.
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
