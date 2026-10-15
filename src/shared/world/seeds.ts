/**
 * WHAT GENERATION ROLLED FOR A CREATURE
 *
 * The table results a monster or a person was built from. Rolled in
 * `generation/content/blueprint.ts` and kept on the creature template, so the
 * writing passes and the game master can read what it was made of.
 */

import type { Rolled } from "../utils/rng.ts";

export type Complexity = "simple" | "complex" | "major";

export type Silhouette = "humanoid" | "beastlike";

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
