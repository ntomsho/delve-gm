/**
 * WHAT A HANDLER WORKS AGAINST: the world indexed by id, and the context of one
 * commit as it is applied — the clone being written, the events so far, and the
 * coercions every handler uses to read a diff's value.
 */

import type { AnyEntity } from "../../shared/world/entities.ts";
import type { EntityKind } from "./paths.ts";
import { PLAYER_ID, type World, type WorldEvent } from "../../shared/types/commit.ts";

// ---------------------------------------------------------------------------
// INDEX
// ---------------------------------------------------------------------------

interface Entry {
  kind: EntityKind;
  entity: AnyEntity | null; // null for the player, which is not an IEntity
}

export function indexWorld(w: World): Map<string, Entry> {
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

export class Failure extends Error {}

export const fail = (reason: string): never => {
  throw new Failure(reason);
};

export interface Ctx {
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

export const asNumber = (v: unknown, what: string): number =>
  typeof v === "number" && Number.isFinite(v) ? v : fail(`${what} must be a number`);

export const asString = (v: unknown, what: string): string =>
  typeof v === "string" && v.trim() !== "" ? v : fail(`${what} must be a non-empty string`);

export const asBoolean = (v: unknown, what: string): boolean =>
  typeof v === "boolean" ? v : fail(`${what} must be true or false`);

export function resolveId(ctx: Ctx, id: string): string {
  return ctx.refs.get(id) ?? id;
}

export function requireEntity(ctx: Ctx, id: string): Entry {
  const entry = ctx.index.get(resolveId(ctx, id));
  return entry ?? fail(`no entity with id ${JSON.stringify(id)}`);
}
