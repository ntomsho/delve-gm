/**
 * blueprint.ts
 *
 * Procedural generation of the top-level dungeon blueprint: everything that is
 * decided BEFORE the rooms loop runs.
 *
 * Sources:
 *   - Maze Rats v4.3 by Ben Milton (CC BY 4.0)
 *   - Cairn 2e "Dungeon Seeds", Yochai Gal (CC BY-SA 4.0)
 *
 * Pipeline:
 *   1. procgen  -> rolls the seed bundle (this file)
 *   2. synthesis -> one LLM pass emitting theme -> history -> goal spec -> starting prose
 *   3. rooms loop -> binds entrances, goal entity, and concrete room contents (later)
 *
 * Conventions:
 *   - Maze Rats tables are 36 entries (2d6: first die = group of 6, second = item).
 *     We sample uniformly across all 36, which is equivalent.
 *   - Bolded MR entries are "cascades": they point at another table. They are
 *     encoded here with {Braces} and resolved by resolveCascades().
 *   - Entity cascades ({NPC}, {faction}, {monster}) do NOT re-enter the pipeline.
 *     They emit a stub for the LLM to bind or briefly write up. This caps recursion.
 *
 * NOTE: a couple of tables were transcribed from the PDF's column layout and are
 * one entry short or contain a duplicate (flagged inline). Sampling is by array
 * length, so this is harmless; correct at leisure.
 */

import {
  CAIRN_BUILT_BY,
  CAIRN_COMPOSITION,
  CAIRN_RUIN_CAUSE,
  CAIRN_RUIN_CONDITION,
} from "../../rules/cairn/dungeon-seeds.ts";
import {
  APPEARANCES,
  ASSETS,
  BACKGROUNDS,
  CIVILIZED_NPCS,
  CLOTHING,
  DUNGEON_FORMS,
  DUNGEON_REWARDS,
  FACTIONS,
  FACTION_GOALS,
  FACTION_TRAITS,
  FEMALE_NAMES,
  HOBBIES,
  LIABILITIES,
  LOWER_SURNAMES,
  MALE_NAMES,
  MANNERISMS,
  METHODS,
  MISFORTUNES,
  MISSIONS,
  MONSTER_ABILITIES,
  MONSTER_FEATURES,
  MONSTER_PERSONALITY,
  MONSTER_TACTICS,
  MONSTER_TRAITS,
  MONSTER_WEAKNESS,
  MUTATIONS,
  NPC_GOALS,
  PERSONALITIES,
  PHYSICAL_DETAILS,
  RELATIONSHIPS,
  REPUTATIONS,
  SECRETS,
  UNDERWORLD_NPCS,
  UPPER_SURNAMES,
  WILDERNESS_NPCS,
  roll,
  rollAnimal,
  rollDistinct,
} from "../../rules/maze-rats/tables.ts";
import type { Rolled } from "../../rules/maze-rats/tables.ts";
import { makeId } from "../../shared/utils/id.ts";
import { Rng } from "../../shared/utils/rng.ts";

// ---------------------------------------------------------------------------
// TYPES
// ---------------------------------------------------------------------------

export type Size = 1 | 2 | 3 | 4 | 5;
export type Tier = "Solo" | "Band" | "Horde";
export type Complexity = "simple" | "complex" | "major";
export type Silhouette = "humanoid" | "beastlike";
export type GoalBranch = "same" | "opposed" | "own";

export interface MonsterSeed {
  complexity: Complexity;
  silhouette: Silhouette;
  /** beastlike only: the reference animals, one or two, already decided here */
  animals?: string[];
  /** humanoid only: free grafted seed */
  humanoidSeed?: { table: "Mutation" | "Feature" | "Trait"; result: Rolled };
  traitsAndAbilities: { table: "Trait" | "Ability"; result: Rolled }[];
  featuresAndMutations: { table: "Feature" | "Mutation"; result: Rolled }[];
  tactic: Rolled;
  weaknesses: Rolled[];
  personality: Rolled;
}

export interface NpcSeed {
  /** unique id; creatures reference this via narrative.member */
  id: string;
  isLeader: boolean;
  /** free agents get a current role; faction members get a past background */
  origin: { kind: "role" | "background"; result: Rolled };
  name: string;
  presentingGender: "male" | "female";
  surnameOptions: { upper: string; lower: string };
  asset: Rolled;
  liability: Rolled;
  method: Rolled;
  appearance: Rolled;
  personality: Rolled;
  goal: Rolled;
  flavor: { table: string; result: Rolled }[];
}

export interface MonsterGroup {
  /** stable reference key: `<dungeonId>:g<i>` */
  id: string;
  kind: "monsters";
  tier: Tier;
  monster: MonsterSeed;
  biggerSpecimen?: MonsterSeed;
}

export interface PeopleGroup {
  /** stable reference key: `<dungeonId>:g<i>` */
  id: string;
  kind: "people";
  tier: Tier;
  faction: Rolled;
  traits: Rolled[];
  goalBranch: GoalBranch;
  ownGoal?: Rolled;
  npcs: NpcSeed[];
  /** Horde: leader plus an undefined mass of underlings */
  undefinedUnderlings: boolean;
}

export type InhabitantGroup = MonsterGroup | PeopleGroup;

export interface DungeonBlueprintSeed {
  id: string;
  seed: number;
  size: Size;
  level?: number;
  purpose: { form: Rolled; builtBy: string };
  ruination:
    | { ruined: true; condition: string; cause: string }
    | { ruined: false; secondaryForm: Rolled; composition: string };
  inhabitants: InhabitantGroup[];
  goalSeed: { reward: Rolled; mission: Rolled };
}

// ---------------------------------------------------------------------------
// GENERATORS
// ---------------------------------------------------------------------------

export const TIER_COMPLEXITY: Record<Tier, Complexity> = {
  Solo: "major",
  Band: "complex",
  Horde: "simple",
};

export function genMonster(complexity: Complexity, rng: Rng): MonsterSeed {
  const silhouette: Silhouette = rng.coin() ? "humanoid" : "beastlike";

  let animals: string[] | undefined;
  let humanoidSeed: MonsterSeed["humanoidSeed"];

  if (silhouette === "beastlike") {
    // One animal or two, decided here rather than by the writing pass. Handed
    // both and told to "pick one or combine", a model combines every time, and
    // every beast in the dungeon comes out a chimera. The coin is what keeps
    // some of them one clean animal -- and it is a number, so it is rolled.
    animals = rng.coin() ? [rollAnimal(rng)] : [rollAnimal(rng), rollAnimal(rng)];
  } else {
    const pick = rng.d(3);
    if (pick === 1) humanoidSeed = { table: "Mutation", result: roll(MUTATIONS, rng) };
    else if (pick === 2) humanoidSeed = { table: "Feature", result: roll(MONSTER_FEATURES, rng) };
    else humanoidSeed = { table: "Trait", result: roll(MONSTER_TRAITS, rng) };
  }

  // Traits / Abilities line: simple 1, complex 2, major 2 (+1 guaranteed Ability below)
  const taCount = complexity === "simple" ? 1 : 2;
  const traitsAndAbilities: MonsterSeed["traitsAndAbilities"] = [];
  for (let i = 0; i < taCount; i++) {
    if (rng.coin()) traitsAndAbilities.push({ table: "Trait", result: roll(MONSTER_TRAITS, rng) });
    else traitsAndAbilities.push({ table: "Ability", result: roll(MONSTER_ABILITIES, rng) });
  }
  // majors always field at least one active power
  if (complexity === "major") {
    traitsAndAbilities.push({ table: "Ability", result: roll(MONSTER_ABILITIES, rng) });
  }

  // Features / Mutations line
  const fmCount = complexity === "major" ? 2 : 1;
  const featuresAndMutations: MonsterSeed["featuresAndMutations"] = [];
  for (let i = 0; i < fmCount; i++) {
    if (rng.coin()) featuresAndMutations.push({ table: "Feature", result: roll(MONSTER_FEATURES, rng) });
    else featuresAndMutations.push({ table: "Mutation", result: roll(MUTATIONS, rng) });
  }

  // Weakness
  let weaknessCount = 0;
  if (complexity === "simple") weaknessCount = rng.chance(0.25) ? 1 : 0;
  else if (complexity === "complex") weaknessCount = rng.chance(0.75) ? 1 : 0;
  else weaknessCount = rng.coin() ? 1 : 2;
  const weaknesses = rollDistinct(MONSTER_WEAKNESS, weaknessCount, rng);

  return {
    complexity,
    silhouette,
    animals,
    humanoidSeed,
    traitsAndAbilities,
    featuresAndMutations,
    tactic: roll(MONSTER_TACTICS, rng),
    weaknesses,
    personality: roll(MONSTER_PERSONALITY, rng),
  };
}

const FLAVOR_TABLES: { name: string; table: readonly string[] }[] = [
  { name: "Physical Details", table: PHYSICAL_DETAILS },
  { name: "Clothing", table: CLOTHING },
  { name: "Mannerisms", table: MANNERISMS },
  { name: "Secrets", table: SECRETS },
  { name: "Reputations", table: REPUTATIONS },
  { name: "Hobbies", table: HOBBIES },
  { name: "Misfortunes", table: MISFORTUNES },
  { name: "Relationships", table: RELATIONSHIPS },
  { name: "Missions", table: MISSIONS },
];

export function genNpc(isFactionMember: boolean, isLeader: boolean, rng: Rng, usedNames?: Set<string>): NpcSeed {
  let origin: NpcSeed["origin"];
  if (isFactionMember) {
    origin = { kind: "background", result: roll(BACKGROUNDS, rng) };
  } else {
    const d = rng.d(6);
    const tbl = d === 1 ? CIVILIZED_NPCS : d <= 3 ? UNDERWORLD_NPCS : WILDERNESS_NPCS;
    origin = { kind: "role", result: roll(tbl, rng) };
  }

  const presentingGender: "male" | "female" = rng.coin() ? "male" : "female";
  const namePool = presentingGender === "male" ? MALE_NAMES : FEMALE_NAMES;
  let name = rng.pick(namePool);
  let nameTries = 0;
  while (usedNames?.has(name) && nameTries++ < 20) name = rng.pick(namePool);
  usedNames?.add(name);

  const flavorCount = rng.d(6);
  const chosen = rng.pickN(FLAVOR_TABLES, flavorCount);
  const flavor = chosen.map((c) => ({ table: c.name, result: roll(c.table, rng) }));

  return {
    id: makeId(),
    isLeader,
    origin,
    name,
    presentingGender,
    surnameOptions: { upper: rng.pick(UPPER_SURNAMES), lower: rng.pick(LOWER_SURNAMES) },
    asset: roll(ASSETS, rng),
    liability: roll(LIABILITIES, rng),
    method: roll(METHODS, rng),
    appearance: roll(APPEARANCES, rng),
    personality: roll(PERSONALITIES, rng),
    goal: roll(NPC_GOALS, rng),
    flavor,
  };
}

/** Whether a group is part of the dungeon's resident population or a wandering encounter. */
export type GroupOrigin = "inhabitant" | "wanderer";

/**
 * Named NPCs a Band produces. Every one of these is a person with a background,
 * asset, liability, method, appearance, personality, and goal, so the count is
 * really "how much apparatus is this encounter worth". Residents can carry more
 * of it than something met in a corridor.
 */
const BAND_NPC_WEIGHTS: Record<GroupOrigin, ReadonlyArray<readonly [number, number]>> = {
  inhabitant: [
    [2, 0.25],
    [3, 0.5],
    [4, 0.25],
  ],
  wanderer: [
    [2, 0.5],
    [3, 0.35],
    [4, 0.15],
  ],
};

function bandNpcCount(origin: GroupOrigin, rng: Rng): number {
  const weights = BAND_NPC_WEIGHTS[origin];
  let x = rng.next();
  for (const [n, p] of weights) {
    x -= p;
    if (x <= 0) return n;
  }
  return weights[weights.length - 1][0];
}

export function genPeopleGroup(
  tier: Tier,
  rng: Rng,
  origin: GroupOrigin = "inhabitant"
): PeopleGroup {
  const traitCount = rng.coin() ? 1 : 2;
  const traits = rollDistinct(FACTION_TRAITS, traitCount, rng);

  const branchRoll = rng.d(3);
  const goalBranch: GoalBranch = branchRoll === 1 ? "same" : branchRoll === 2 ? "opposed" : "own";
  const ownGoal = goalBranch === "own" ? roll(FACTION_GOALS, rng) : undefined;

  let npcCount: number;
  let undefinedUnderlings = false;
  if (tier === "Solo") npcCount = 1;
  else if (tier === "Band") npcCount = bandNpcCount(origin, rng);
  else {
    npcCount = 1;
    undefinedUnderlings = true;
  }

  const npcs: NpcSeed[] = [];
  const usedNames = new Set<string>();
  for (let i = 0; i < npcCount; i++) npcs.push(genNpc(true, i === 0, rng, usedNames));

  return {
    id: makeId(),
    kind: "people",
    tier,
    faction: roll(FACTIONS, rng),
    traits,
    goalBranch,
    ownGoal,
    npcs,
    undefinedUnderlings,
  };
}

function monsterBaseKey(m: MonsterSeed): string {
  return m.silhouette === "beastlike"
    ? `beast:${[...(m.animals ?? [])].sort().join("+")}`
    : `humanoid:${m.humanoidSeed?.result}`;
}

export function genMonsterGroup(tier: Tier, rng: Rng, usedKeys?: Set<string>): MonsterGroup {
  let monster = genMonster(TIER_COMPLEXITY[tier], rng);
  // monster groups may not repeat within one dungeon; people groups may
  let attempts = 0;
  while (usedKeys?.has(monsterBaseKey(monster)) && attempts++ < 12) {
    monster = genMonster(TIER_COMPLEXITY[tier], rng);
  }
  usedKeys?.add(monsterBaseKey(monster));

  let biggerSpecimen: MonsterSeed | undefined;
  if (tier === "Horde") {
    // same base silhouette re-rolled at a higher tier
    const upTier: Complexity = rng.coin() ? "complex" : "major";
    biggerSpecimen = genMonster(upTier, rng);
    biggerSpecimen.silhouette = monster.silhouette;
    biggerSpecimen.animals = monster.animals;
    biggerSpecimen.humanoidSeed = monster.humanoidSeed;
  }

  return { id: makeId(), kind: "monsters", tier, monster, biggerSpecimen };
}

function groupCountForSize(size: Size, rng: Rng): number {
  if (size === 1) return 1;
  if (size === 2 || size === 3) return rng.range(1, 2);
  return rng.range(2, 3);
}

export function generateBlueprintSeed(size: Size, seed: number, level?: number): DungeonBlueprintSeed {
  const rng = new Rng(seed);
  const dungeonId = `dungeon_${seed.toString(36)}`;

  // --- Purpose ---
  const form = roll(DUNGEON_FORMS, rng);
  const builtBy = rng.pick(CAIRN_BUILT_BY);

  // --- Ruination: 75% ruined ---
  const ruination: DungeonBlueprintSeed["ruination"] = rng.chance(0.75)
    ? { ruined: true, condition: rng.pick(CAIRN_RUIN_CONDITION), cause: rng.pick(CAIRN_RUIN_CAUSE) }
    : { ruined: false, secondaryForm: roll(DUNGEON_FORMS, rng), composition: rng.pick(CAIRN_COMPOSITION) };

  // --- Inhabitants ---
  const count = groupCountForSize(size, rng);
  const inhabitants: InhabitantGroup[] = [];
  const usedMonsterKeys = new Set<string>();
  for (let i = 0; i < count; i++) {
    const tier: Tier = rng.pick(["Solo", "Band", "Horde"] as Tier[]);
    if (rng.coin()) inhabitants.push(genMonsterGroup(tier, rng, usedMonsterKeys));
    else inhabitants.push(genPeopleGroup(tier, rng));
  }

  // --- Goal seed: reward + mission. The synthesis pass picks one, discards the
  // other, or combines them into a single coherent objective. ---
  const goalSeed = { reward: roll(DUNGEON_REWARDS, rng), mission: roll(MISSIONS, rng) };

  return {
    id: dungeonId,
    seed,
    size,
    level,
    purpose: { form, builtBy },
    ruination,
    inhabitants,
    goalSeed,
  };
}

// ---------------------------------------------------------------------------
// ROLL SHEET (the text handed to the synthesis pass)
// ---------------------------------------------------------------------------

const r = (x: Rolled) => x;

function monsterSheet(m: MonsterSeed, indent = "    "): string[] {
  const L: string[] = [];
  L.push(`${indent}Complexity: ${m.complexity}`);
  L.push(`${indent}Silhouette: ${m.silhouette}`);
  if (m.animals)
    L.push(`${indent}Reference animal${m.animals.length > 1 ? "s (both, not either)" : ""}: ${m.animals.join(" / ")}`);
  if (m.humanoidSeed) L.push(`${indent}Humanoid seed (${m.humanoidSeed.table}): ${r(m.humanoidSeed.result)}`);
  L.push(`${indent}Traits/Abilities: ${m.traitsAndAbilities.map((x) => `${x.table}: ${r(x.result)}`).join("; ")}`);
  L.push(`${indent}Features/Mutations: ${m.featuresAndMutations.map((x) => `${x.table}: ${r(x.result)}`).join("; ")}`);
  L.push(`${indent}Tactic: ${r(m.tactic)}`);
  L.push(`${indent}Weakness: ${m.weaknesses.length ? m.weaknesses.map(r).join("; ") : "(none)"}`);
  L.push(`${indent}Personality: ${r(m.personality)}  (discard if not intelligent enough)`);
  return L;
}

function npcSheet(n: NpcSeed, indent = "      "): string[] {
  const L: string[] = [];
  const role = n.origin.kind === "role" ? "Current role" : "Background (past)";
  L.push(
    `${indent}${n.isLeader ? "[LEADER] " : ""}${n.name} (${n.presentingGender}) [${n.id}] -- surname: ${n.surnameOptions.upper} (upper) / ${n.surnameOptions.lower} (lower)`
  );
  L.push(`${indent}  ${role}: ${r(n.origin.result)}`);
  L.push(
    `${indent}  Asset: ${r(n.asset)} | Liability: ${r(n.liability)} | Method: ${r(n.method)}`
  );
  L.push(
    `${indent}  Appearance: ${r(n.appearance)} | Personality: ${r(n.personality)} | Goal: ${r(n.goal)}`
  );
  if (n.flavor.length) {
    L.push(`${indent}  Flavor (${n.flavor.length}): ${n.flavor.map((f) => `${f.table}: ${r(f.result)}`).join("; ")}`);
  }
  return L;
}

export function rollSheet(bp: DungeonBlueprintSeed): string {
  const L: string[] = [];
  L.push(`=== DUNGEON BLUEPRINT SEED ===`);
  L.push(`id: ${bp.id}   seed: ${bp.seed}   size: ${bp.size}${bp.level ? `   level: ${bp.level}` : ""}`);
  L.push("");
  L.push(`PURPOSE`);
  L.push(`  Form (original purpose): ${r(bp.purpose.form)}`);
  L.push(`  Built by: ${bp.purpose.builtBy}`);
  L.push("");
  L.push(`RUINATION`);
  if (bp.ruination.ruined) {
    L.push(`  Ruined: YES`);
    L.push(`  Condition: ${bp.ruination.condition}   (also seeds initial dungeon state)`);
    L.push(`  Cause: ${bp.ruination.cause}   (seeds history)`);
  } else {
    L.push(`  Ruined: NO -- intact, with a secondary use / notable component`);
    L.push(`  Secondary form: ${r(bp.ruination.secondaryForm)}`);
    L.push(`  Composition: ${bp.ruination.composition}`);
  }
  L.push("");
  L.push(`INHABITANTS (${bp.inhabitants.length} group${bp.inhabitants.length > 1 ? "s" : ""})`);
  bp.inhabitants.forEach((g, i) => {
    L.push(`  --- Group ${i + 1}: ${g.kind.toUpperCase()} / Tier: ${g.tier}  [${g.id}] ---`);
    if (g.kind === "monsters") {
      L.push(...monsterSheet(g.monster));
      if (g.biggerSpecimen) {
        L.push(`    -- bigger specimen (same base, higher tier) --`);
        L.push(...monsterSheet(g.biggerSpecimen, "      "));
      }
    } else {
      L.push(`    Faction: ${r(g.faction)}`);
      L.push(`    Traits: ${g.traits.map(r).join("; ")}`);
      const branch =
        g.goalBranch === "same"
          ? "SAME as player goal -- ally or rival, lean rival (break on traits)"
          : g.goalBranch === "opposed"
          ? "OPPOSED to player goal -- enemies"
          : `OWN goal: ${r(g.ownGoal!)}`;
      L.push(`    Goal branch: ${branch}`);
      if (g.undefinedUnderlings) L.push(`    Plus an undefined mass of underlings`);
      L.push(`    NPCs (${g.npcs.length}):`);
      g.npcs.forEach((n) => L.push(...npcSheet(n)));
    }
  });
  L.push("");
  L.push(`PLAYER GOAL SEED`);
  L.push(`  Dungeon Reward: ${r(bp.goalSeed.reward)}`);
  L.push(`  Mission: ${r(bp.goalSeed.mission)}`);
  L.push(`  (pick one, discard the other, or combine -- whichever reads best)`);
  return L.join("\n");
}

// The module-load demo block that used to live here touched `process` and so
// threw in a browser bundle. Its job belongs to `dev/cli-generate.ts --dry`.
