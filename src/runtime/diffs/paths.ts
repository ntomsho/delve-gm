/**
 * WHAT MAY BE WRITTEN
 *
 * Consulted before dispatch, so an unwritable path is refused without a handler
 * ever seeing it. The prohibitions matter more than the permissions:
 *
 *   base, name, id, type, keywords, blueprintId, narrative.*, stats.hitDice,
 *   stats.modifiers, slots, quality, endpointA, endpointB,
 *   and on the player: abilities, traits, level, hp.max
 *
 * `base` is identity — what a thing IS, as against how it currently stands. If
 * something changed enough that its base would need rewriting, that is not an
 * edit, it is a new entity. `name` goes with it: names were written once
 * alongside base, and a referee renaming things mid-run makes the transcript
 * and the map disagree about what happened.
 */

export type EntityKind =
  | "Room"
  | "RoomConnector"
  | "Creature"
  | "RoomFeature"
  | "Item"
  | "MobileEffect"
  | "Hazard"
  | "PlayerCharacter";

/**
 * Array indices are collapsed to `[#]` so one entry covers every index, while
 * `[]` (append) stays a distinct path with distinct meaning.
 */
export function normalizePath(path: string): string {
  return path.replace(/\[\s*\d+\s*\]/g, "[#]").trim();
}

/**
 * True of every entity: the prose pair, and whether the player is aware of it.
 *
 * `isHidden` sits here rather than on features alone because anything can be
 * concealed — a creature waiting in the dark, a door behind a tapestry, a coin
 * under a flagstone. A Room is the one exception: the map reads
 * `composed !== undefined` as "the player has been here", which only holds if a
 * room can never be hidden.
 */
const COMMON = ["state", "composed", "isHidden"] as const;

const WRITABLE: Record<EntityKind, readonly string[]> = {
  Room: ["state", "composed"],
  RoomConnector: [...COMMON, "conditional"],
  Creature: [...COMMON, "activity", "count", "stats.hp", "roomId"],
  RoomFeature: [...COMMON, "roomId"],
  Item: [...COMMON, "currentQuality", "amount", "parentId"],
  MobileEffect: [...COMMON, "roomIds"],
  Hazard: [...COMMON, "sprung", "active"],
  PlayerCharacter: [
    "hp.current",
    "conditions[]",
    "conditions[#]",
    "inventory[#]",
    "equipped.weapon",
    "equipped.armor",
    "equipped.helmet",
    "equipped.shield",
    // Where they are standing. The one way the player moves, and so the only
    // route to a room entry during play — the turn machine watches for it.
    "roomId",
  ],
};

/** Creating a new entity under a holder. Legal on anything that can hold one. */
const CREATE_PATH = "children[]";

const CREATE_HOLDERS: readonly EntityKind[] = [
  "Room",
  "Creature",
  "RoomFeature",
  "Item",
  "PlayerCharacter",
];

export function isCreatePath(path: string): boolean {
  return normalizePath(path) === CREATE_PATH;
}

export function canHoldNewEntities(kind: EntityKind): boolean {
  return CREATE_HOLDERS.includes(kind);
}

export function isWritable(kind: EntityKind, path: string): boolean {
  const p = normalizePath(path);
  if (p === CREATE_PATH) return canHoldNewEntities(kind);
  return WRITABLE[kind].includes(p);
}

/** For error messages: what this kind of thing does accept. */
export function writablePaths(kind: EntityKind): readonly string[] {
  return canHoldNewEntities(kind) ? [...WRITABLE[kind], CREATE_PATH] : WRITABLE[kind];
}
