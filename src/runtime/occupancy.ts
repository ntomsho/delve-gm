/**
 * WHAT IS IN A ROOM
 *
 * Rooms hold no occupant list. Each thing records where it is and the answer is
 * derived by scanning — which means the two sides can never disagree, because
 * there is only one side.
 *
 * Three different link fields, because three kinds of thing are located
 * differently:
 *
 *   ICreature.roomId       the room it stands in
 *   IRoomFeature.roomId    the room it is part of
 *   IItem.parentId         a room, a creature, or a feature — so items NEST
 *   IMobileEffect.roomIds  an array; fire spans rooms
 *
 * Nesting is why "what is in this room" is a transitive question: a dagger in a
 * chest in a room is in the room. `directContents` answers the shallow version
 * (what the applier needs when something is destroyed); `roomIndex` answers the
 * transitive one (what the referee needs to describe a room).
 */

import type { AnyEntity, EntityPassResult, IItem } from "../engine/index.ts";

/** Everything whose own link field points straight at `holderId`. */
export function directContents(holderId: string, e: EntityPassResult): AnyEntity[] {
  const out: AnyEntity[] = [];
  for (const c of e.creatures) if (c.roomId === holderId) out.push(c);
  for (const f of e.features) if (f.roomId === holderId) out.push(f);
  for (const i of e.items) if (i.parentId === holderId) out.push(i);
  for (const x of e.effects) if (x.roomIds.includes(holderId)) out.push(x);
  return out;
}

/** Items held by `holderId`, one level deep. */
export function heldItems(holderId: string, e: EntityPassResult): IItem[] {
  return e.items.filter((i) => i.parentId === holderId);
}

/**
 * Every entity in every room, following items down through the creatures and
 * features that carry them.
 *
 * Rebuilt after each applied commit rather than maintained incrementally — it
 * is a linear pass over a few hundred entities, once a turn, and an index that
 * is always recomputed cannot drift.
 */
export function roomIndex(e: EntityPassResult): Map<string, AnyEntity[]> {
  const index = new Map<string, AnyEntity[]>();
  for (const room of e.rooms) index.set(room.id, []);

  const push = (roomId: string, entity: AnyEntity) => {
    const list = index.get(roomId);
    if (list) list.push(entity);
  };

  // Where does each holder live? Creatures and features are in a room; items
  // are wherever their holder is. Resolve holders first, then walk items down.
  const roomOf = new Map<string, string>();
  for (const room of e.rooms) roomOf.set(room.id, room.id);
  for (const c of e.creatures) {
    roomOf.set(c.id, c.roomId);
    push(c.roomId, c);
  }
  for (const f of e.features) {
    roomOf.set(f.id, f.roomId);
    push(f.roomId, f);
  }
  for (const x of e.effects) for (const rid of x.roomIds) push(rid, x);

  // Items can hang off items (a pouch in a pack), so resolve by walking up
  // until a known holder is reached. Bounded by the chain length, and guarded
  // against a cycle a bad diff might otherwise create.
  const byId = new Map(e.items.map((i) => [i.id, i]));
  for (const item of e.items) {
    const seen = new Set<string>([item.id]);
    let parent: string | undefined = item.parentId;
    while (parent !== undefined && !roomOf.has(parent)) {
      if (seen.has(parent)) { parent = undefined; break; }
      seen.add(parent);
      parent = byId.get(parent)?.parentId;
    }
    const room = parent === undefined ? undefined : roomOf.get(parent);
    if (room !== undefined) push(room, item);
  }

  return index;
}

/** Everything in one room, transitively. */
export function contentsOf(roomId: string, e: EntityPassResult): AnyEntity[] {
  return roomIndex(e).get(roomId) ?? [];
}
