/**
 * WHAT MAY BE WRITTEN
 *
 * Consulted before dispatch, so an unwritable path is refused without a handler
 * ever seeing it. The prohibitions matter more than the permissions:
 *
 *   base, name, id, type, keywords, blueprintId, narrative.*, stats.hitDice,
 *   stats.modifiers, slots, quality, endpointA, endpointB,
 *   and on the player: abilities, traits, level, mode, hp.max
 *
 * `base` is identity — what a thing IS, as against how it currently stands. If
 * something changed enough that its base would need rewriting, that is not an
 * edit, it is a new entity. `name` goes with it: names were written once
 * alongside base, and a game master renaming things mid-run makes the transcript
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
  // Two ways to move a creature, and they are not the same instruction.
  // `roomId` puts it there — for one already next door, or one being placed
  // outright. `approach` names somewhere it is heading and lets the applier do
  // the walking, a room per turn: routing is a graph question with one right
  // answer, so nothing about it should be guessed. See `stepToward`.
  Creature: [...COMMON, "activity", "count", "stats.hp", "roomId", "approach"],
  // `resolved` is the obstacle half of `Hazard.sprung`: the one bit of a puzzle
  // that changes in play. `isObstacle` is deliberately absent beside it —
  // whether a thing IS the puzzle was settled at generation.
  RoomFeature: [...COMMON, "roomId", "resolved"],
  // `value` is deliberately absent: what a thing is worth is a number, and the
  // game master does not write numbers. The two book fields are not the same kind
  // of thing — they are a reading being recorded, and both come back off the
  // `consult` roll rather than out of the game master's head.
  Item: [...COMMON, "currentQuality", "amount", "parentId", "book.uses", "book.exhausted"],
  MobileEffect: [...COMMON, "roomIds"],
  Hazard: [...COMMON, "sprung", "active"],
  PlayerCharacter: [
    "hp.current",
    "conditions[]",
    "conditions[#]",
    // Both spellings, and they mean what the `conditions` pair immediately
    // above means: `[]` appends, `[#]` addresses a position. A pickup is an
    // append however it is written, because the inventory is compacted and has
    // no positions to hold open — see the handler.
    "inventory[]",
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
