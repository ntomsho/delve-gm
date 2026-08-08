/**
 * ENGINE BARREL
 * =============
 *
 * Import from here rather than from individual modules. Four names are declared
 * in more than one engine file and mean different things in each; this file is
 * where that is resolved once, instead of at every call site by whoever gets it
 * wrong first.
 *
 * | Name                | Phase A                       | Elsewhere                                  |
 * |---------------------|-------------------------------|--------------------------------------------|
 * | `Rng`               | `type Rng = () => number`     | `class Rng` in dungeon-blueprint            |
 * | `DungeonBlueprint`  | graph output, Partial<IRoom>[] | `DungeonBlueprintSeed`, the rolled genome   |
 * | `makeEntityId`      | phase-a                       | `makeId` in dungeon-blueprint (identical)   |
 * | `generate`          | phase-a graph generator       | —                                           |
 *
 * Phase A's are re-exported under disambiguated names. `Rng` unqualified is
 * always the seeded class — that is the one anything drawing randomness wants.
 */

// --- structure (Phase A) ---------------------------------------------------
export {
  generate as generateGraph,
  generateBlueprint,
  generateValid,
  toBlueprint,
  summarize,
  toSvg,
  makeEntityId,
  makeRng as makeRngFn,
} from "./dungeon-phase-a.ts";
export type {
  Dungeon,
  Room as GraphRoom,
  Edge as GraphEdge,
  EdgeKind,
  Vec,
  Stats as GraphStats,
  Params as GraphParams,
  DungeonBlueprint as GraphBlueprint,
  Rng as RngFn,
} from "./dungeon-phase-a.ts";

// --- planarity -------------------------------------------------------------
// Phase A calls this itself; exported because the floorplan packer reads the
// embedding it produces.
export { checkPlanarity } from "./dungeon-planarity.ts";
export type { PlanarityResult, Pair as PlanarityPair } from "./dungeon-planarity.ts";

// --- the genome and the tables ---------------------------------------------
export * from "./dungeon-blueprint.ts";

// --- the entity model ------------------------------------------------------
export * from "./dungeon-entities.ts";

// --- stocking --------------------------------------------------------------
export * from "./dungeon-rooms-loop.ts";

// --- deterministic entity emission -----------------------------------------
export * from "./dungeon-entities-pass.ts";

// --- the content pass ------------------------------------------------------
// DepthBand/TensionBand live here now; the duplicate pair in dungeon-rooms-loop
// went with the superseded Rooms Pass.
export * from "./dungeon-content-pass.ts";

// --- the dungeon pass ------------------------------------------------------
export * from "./dungeon-pass.ts";

// --- the seams pass --------------------------------------------------------
// The ways between chunks, written after every chunk has landed. See the header
// there for why they cannot be written by the chunks themselves.
export * from "./dungeon-seams-pass.ts";

// --- dice ------------------------------------------------------------------
// `Edge` here is advantage/disadvantage. Phase A's `Edge` (a graph connection)
// is re-exported above as `GraphEdge`.
export * from "./dungeon-rolls.ts";

// --- the player character --------------------------------------------------
// `armorDefense` is declared in both dungeon-entities (for CreatureStats) and
// dungeon-character (for a PlayerCharacter). Both are wanted; the PC one is
// re-exported under a distinct name rather than shadowing the creature one.
export {
  slotCapacity,
  slotsUsed,
  slotsFree,
  isOverburdened,
  canCarry,
  inventoryStatus,
  addItem,
  removeItem,
  EQUIP_SLOTS,
  heldItem,
  canEquip,
  equip,
  equipResolving,
  conflictingSlots,
  unequip,
  validateEquipment,
  meleeAttackBonus,
  rangedAttackBonus,
  armorDefense as pcArmorDefense,
  equippedSummary,
  itemSummary,
} from "./dungeon-character.ts";
export type {
  PlayerCharacter,
  CharacterAbilities,
  CharacterTraits,
  EquippedSlots,
  EquipSlot,
  EquipCheck,
  EquipOutcome,
  SlotReport,
} from "./dungeon-character.ts";

// --- the floorplan ---------------------------------------------------------
// `Point` and `Rect` are declared here; nothing else in the engine has them.
export * from "./dungeon-floorplan.ts";
