/**
 * KNAVE 1.0 TABLES
 * ================
 *
 * Transcribed from `docs/Knave 1.0.pdf`. Tables and stat lines only — no dice,
 * no logic, no item construction. `character-creation.ts` is what rolls on
 * these; keeping the two apart means a transcription error is a diff in one
 * file with no behaviour in it.
 *
 * WHY THESE ARE NEW AND NOT REUSED. `docs/CODING-PLAN.md` §3 says to check
 * `dungeon-blueprint.ts` first, because the Maze Rats character tables feeding
 * `genNpc` "overlap heavily" and duplicating a table is how two copies drift.
 * Checked, and they do not overlap: those are **36-entry** d66 tables built for
 * NPCs, and Knave's are **20-entry** d20 tables built for a PC. The pairs that
 * share a name share nothing else —
 *
 *   | axis       | Maze Rats (dungeon-blueprint.ts) | Knave (here) |
 *   |------------|----------------------------------|--------------|
 *   | Misfortunes| 36 entries, incl. Sick, Sued     | 20 entries   |
 *   | Clothing   | 36 entries, incl. Haute couture  | 20 entries   |
 *   | Background | = UNDERWORLD_NPCS, 36 entries    | 20 entries   |
 *
 * — and Knave has no Maze Rats counterpart at all for physique, face, skin,
 * hair, virtue, vice, speech or alignment. Reusing one would silently change
 * both the entries and the distribution. So: transcribed fresh, and this note
 * is here so the question is not reopened.
 *
 * TWO TABLES ARE HOUSE-RULED and say so at the site. Everything else is the
 * book verbatim, including the printed ordering quirk at spell 90.
 */

import type { ArmorType } from "./dungeon-entities.ts";

const t = (s: string): readonly string[] => s.split("|");

// ===========================================================================
// THE ELEVEN TRAITS  (d20 each, p.2)
// ===========================================================================

export const PHYSIQUE = t(
  "Athletic|Brawny|Corpulent|Delicate|Gaunt|Hulking|Lanky|Ripped|Rugged|Scrawny|Short|Sinewy|Slender|Flabby|Statuesque|Stout|Tiny|Towering|Willowy|Wiry"
);

export const FACE = t(
  "Bloated|Blunt|Bony|Chiseled|Delicate|Elongated|Patrician|Pinched|Hawkish|Broken|Impish|Narrow|Ratlike|Round|Sunken|Sharp|Soft|Square|Wide|Wolfish"
);

export const SKIN = t(
  "Battle scar|Birthmark|Burn scar|Dark|Makeup|Oily|Pale|Perfect|Pierced|Pockmarked|Reeking|Tattooed|Rosy|Rough|Sallow|Sunburned|Tanned|War paint|Weathered|Whip scar"
);

export const HAIR = t(
  "Bald|Braided|Bristly|Cropped|Curly|Disheveled|Dreadlocks|Filthy|Frizzy|Greased|Limp|Long|Luxurious|Mohawk|Oily|Ponytail|Silky|Topknot|Wavy|Wispy"
);

export const CLOTHING = t(
  "Antique|Bloody|Ceremonial|Decorated|Eccentric|Elegant|Fashionable|Filthy|Flamboyant|Stained|Foreign|Frayed|Frumpy|Livery|Oversized|Patched|Perfumed|Rancid|Torn|Undersized"
);

export const VIRTUE = t(
  "Ambitious|Cautious|Courageous|Courteous|Curious|Disciplined|Focused|Generous|Gregarious|Honest|Honorable|Humble|Idealistic|Just|Loyal|Merciful|Righteous|Serene|Stoic|Tolerant"
);

export const VICE = t(
  "Aggressive|Arrogant|Bitter|Cowardly|Cruel|Deceitful|Flippant|Gluttonous|Greedy|Irascible|Lazy|Nervous|Prejudiced|Reckless|Rude|Suspicious|Vain|Vengeful|Wasteful|Whiny"
);

export const SPEECH = t(
  "Blunt|Booming|Breathy|Cryptic|Drawling|Droning|Flowery|Formal|Gravelly|Hoarse|Mumbling|Precise|Quaint|Rambling|Rapid-fire|Dialect|Slow|Squeaky|Stuttering|Whispery"
);

export const BACKGROUND = t(
  "Alchemist|Beggar|Butcher|Burglar|Charlatan|Cleric|Cook|Cultist|Gambler|Herbalist|Magician|Mariner|Mercenary|Merchant|Outlaw|Performer|Pickpocket|Smuggler|Student|Tracker"
);

export const MISFORTUNES = t(
  "Abandoned|Addicted|Blackmailed|Condemned|Cursed|Defrauded|Demoted|Discredited|Disowned|Exiled|Framed|Haunted|Kidnapped|Mutilated|Poor|Pursued|Rejected|Replaced|Robbed|Suspected"
);

/**
 * Alignment is the one trait printed as bands rather than twenty entries:
 * 1-5 Law, 6-15 Neutrality, 16-20 Chaos. Expanded to twenty so every trait
 * rolls the same way and `rollTrait` needs no special case — the distribution
 * is identical either way.
 */
export const ALIGNMENT: readonly string[] = [
  ...Array<string>(5).fill("Law"),
  ...Array<string>(10).fill("Neutrality"),
  ...Array<string>(5).fill("Chaos"),
];

/** Every trait table, keyed the way `CharacterTraits` is. */
export const TRAIT_TABLES = {
  physique: PHYSIQUE,
  face: FACE,
  skin: SKIN,
  hair: HAIR,
  clothing: CLOTHING,
  virtue: VIRTUE,
  vice: VICE,
  speech: SPEECH,
  background: BACKGROUND,
  misfortunes: MISFORTUNES,
  alignment: ALIGNMENT,
} as const satisfies Record<string, readonly string[]>;

// ===========================================================================
// ARMOR AND WEAPONS  (the Item Costs page, p.3)
// ===========================================================================

export interface ArmorStat {
  name: string;
  armorType: ArmorType;
  /** For `body`, the armor defense. For a helmet or a shield, the flat +1. */
  defense: number;
  slots: number;
  quality: number;
  /** copper pennies */
  cost: number;
}

export const ARMOR_STATS = {
  gambeson: { name: "Gambeson", armorType: "body", defense: 12, slots: 1, quality: 3, cost: 60 },
  brigandine: { name: "Brigandine", armorType: "body", defense: 13, slots: 2, quality: 4, cost: 500 },
  chain: { name: "Chain", armorType: "body", defense: 14, slots: 3, quality: 5, cost: 1200 },
  halfPlate: { name: "Half plate", armorType: "body", defense: 15, slots: 4, quality: 6, cost: 4000 },
  fullPlate: { name: "Full plate", armorType: "body", defense: 16, slots: 5, quality: 7, cost: 8000 },
  helmet: { name: "Helmet", armorType: "helmet", defense: 1, slots: 1, quality: 1, cost: 40 },
  shield: { name: "Shield", armorType: "shield", defense: 1, slots: 1, quality: 1, cost: 40 },
} as const satisfies Record<string, ArmorStat>;

export type ArmorKey = keyof typeof ARMOR_STATS;

export type WeaponClassKey = "light" | "medium" | "heavy" | "sling" | "bow" | "crossbow";

/**
 * **The class is the mechanical choice; the name is flavour on top of it.**
 *
 * The book prices weapons by class and lists representative names for each, so
 * everything that matters in play — damage, hands, slots, quality, cost — is a
 * fact about the class and identical across its names. Picking a Medium weapon
 * and then deciding it is an axe rather than a mace is a decision about the
 * fiction, and the interface asks it in that order.
 *
 * The three ranged classes are their own single weapon: a sling is a sling, and
 * offering a second screen to choose which kind would be a screen with one
 * button on it.
 *
 * The Heavy class is **two-handed**, which is what makes `canEquip`'s shield
 * conflict bite in ordinary play rather than as an edge case.
 *
 * NOTE: `CODING-PLAN.md` §3 gives the d10 class `quality 2`. The PDF says
 * 3 quality, and the PDF wins.
 */
export interface WeaponClass {
  key: WeaponClassKey;
  label: string;
  damage: string;
  hands: 1 | 2;
  ranged?: boolean;
  slots: number;
  quality: number;
  cost: number;
  /** The names this class can be called. One, for a ranged class. */
  names: readonly string[];
}

export const WEAPON_CLASSES: readonly WeaponClass[] = [
  { key: "light", label: "Light", damage: "1d6", hands: 1, slots: 1, quality: 3, cost: 5, names: t("Dagger|Cudgel|Sickle|Staff") },
  { key: "medium", label: "Medium", damage: "1d8", hands: 1, slots: 2, quality: 3, cost: 10, names: t("Spear|Sword|Mace|Axe|Flail") },
  { key: "heavy", label: "Heavy", damage: "1d10", hands: 2, slots: 3, quality: 3, cost: 20, names: t("Halberd|War Hammer|Long Sword|Battle Axe") },
  { key: "sling", label: "Sling", damage: "1d4", hands: 1, ranged: true, slots: 1, quality: 3, cost: 5, names: ["Sling"] },
  { key: "bow", label: "Bow", damage: "1d6", hands: 2, ranged: true, slots: 2, quality: 3, cost: 15, names: ["Bow"] },
  { key: "crossbow", label: "Crossbow", damage: "1d8", hands: 2, ranged: true, slots: 3, quality: 3, cost: 60, names: ["Crossbow"] },
];

/** One named weapon, with its class's numbers already on it. */
export interface WeaponStat {
  name: string;
  classKey: WeaponClassKey;
  damage: string;
  hands: 1 | 2;
  ranged?: boolean;
  slots: number;
  quality: number;
  cost: number;
}

export function weaponsIn(c: WeaponClass): readonly WeaponStat[] {
  const { key, label: _label, names, ...spec } = c;
  void _label;
  return names.map((name) => ({ name, classKey: key, ...spec }));
}

/** Every weapon, flattened. The class list is what the picker walks. */
export const WEAPONS: readonly WeaponStat[] = WEAPON_CLASSES.flatMap((c) => weaponsIn(c));

export function weaponClass(key: WeaponClassKey): WeaponClass {
  const found = WEAPON_CLASSES.find((c) => c.key === key);
  if (!found) throw new Error(`no weapon class called ${key}`);
  return found;
}

// ===========================================================================
// STARTING GEAR  (p.2)
// ===========================================================================

export interface GearEntry {
  name: string;
  /** count or measurement WITH its unit, matching `IItem.amount` */
  amount?: string;
  /** Knave: "most items take up one slot". Nothing on these three tables doesn't. */
  slots?: number;
  /** copper pennies, from the Item Costs page — for the shop, not for creation */
  cost: number;
}

/** Roll TWICE on this one. */
export const DUNGEONEERING_GEAR: readonly GearEntry[] = [
  { name: "Rope", amount: "50 feet", cost: 10 },
  { name: "Pulleys", cost: 30 },
  { name: "Candles", amount: "5", cost: 5 },
  { name: "Chain", amount: "10 feet", cost: 10 },
  { name: "Chalk", amount: "10 pieces", cost: 1 },
  { name: "Crowbar", cost: 10 },
  { name: "Tinderbox", cost: 10 },
  { name: "Grappling hook", cost: 10 },
  { name: "Hammer", cost: 10 },
  { name: "Waterskin", cost: 5 },
  { name: "Lantern", cost: 30 },
  { name: "Lamp oil", amount: "4 hours", cost: 5 },
  { name: "Padlock", cost: 20 },
  { name: "Manacles", cost: 10 },
  { name: "Mirror", cost: 200 },
  { name: "Pole", amount: "10 feet", cost: 5 },
  { name: "Sack", cost: 1 },
  { name: "Tent", cost: 50 },
  { name: "Iron spikes", amount: "5", cost: 25 },
  { name: "Torches", amount: "5", cost: 5 },
];

export const GENERAL_GEAR_1: readonly GearEntry[] = [
  { name: "Air bladder", cost: 5 },
  { name: "Bear trap", cost: 20 },
  { name: "Shovel", cost: 10 },
  { name: "Bellows", cost: 10 },
  { name: "Grease", cost: 1 },
  { name: "Saw", cost: 10 },
  { name: "Bucket", cost: 5 },
  { name: "Caltrops", amount: "1 bag", cost: 10 },
  { name: "Chisel", cost: 5 },
  { name: "Drill", cost: 10 },
  { name: "Fishing rod", cost: 10 },
  { name: "Marbles", amount: "1 bag", cost: 5 },
  { name: "Glue", amount: "1 bottle", cost: 1 },
  { name: "Pick", cost: 10 },
  { name: "Hourglass", cost: 300 },
  { name: "Net", cost: 10 },
  { name: "Tongs", cost: 10 },
  { name: "Lockpicks", cost: 100 },
  { name: "Metal file", cost: 5 },
  { name: "Nails", amount: "12", cost: 5 },
];

export const GENERAL_GEAR_2: readonly GearEntry[] = [
  { name: "Incense", amount: "1 packet", cost: 10 },
  { name: "Sponge", cost: 5 },
  { name: "Lens", cost: 100 },
  { name: "Perfume", cost: 50 },
  { name: "Horn", cost: 10 },
  { name: "Bottle", cost: 1 },
  { name: "Soap", cost: 1 },
  { name: "Spyglass", cost: 1000 },
  { name: "Tar pot", cost: 10 },
  { name: "Twine", amount: "300 feet", cost: 5 },
  { name: "Fake jewels", cost: 50 },
  { name: "Blank book", cost: 300 },
  { name: "Card deck", cost: 5 },
  { name: "Dice set", cost: 5 },
  { name: "Cook pots", cost: 10 },
  { name: "Face paint", cost: 10 },
  { name: "Whistle", cost: 5 },
  { name: "Instrument", cost: 200 },
  { name: "Quill and ink", cost: 1 },
  { name: "Small bell", cost: 20 },
];

/** Everyone starts with these two days, free, whichever path they take. */
export const STARTING_RATIONS: GearEntry = { name: "Travel rations", amount: "2 days", cost: 10 };

// ---------------------------------------------------------------------------
// The two house-ruled tables
// ---------------------------------------------------------------------------

export interface ArmorTableResult {
  armor: ArmorKey | null;
  /** How many random spellbooks the result carries. */
  spellbooks: number;
}

/**
 * ARMOR (d20). **House-ruled.** As printed: 1-3 no armor · 4-14 Gambeson ·
 * 15-19 Brigandine · 20 Chain. Ours widens the empty band by two and pays for
 * it with a spellbook, which is the trade the book itself suggests one line
 * above the table — *"allow new PCs to roll a random spell in exchange for not
 * starting with any armor"*. Written out per face rather than as bands so the
 * divergence is visible rather than arithmetic.
 */
export function rollArmorTable(d20: number): ArmorTableResult {
  if (d20 <= 5) return { armor: null, spellbooks: 1 };
  if (d20 <= 14) return { armor: "gambeson", spellbooks: 0 };
  if (d20 <= 19) return { armor: "brigandine", spellbooks: 0 };
  return { armor: "chain", spellbooks: 0 };
}

export interface HelmetShieldResult {
  helmet: boolean;
  shield: boolean;
  spellbooks: number;
}

/**
 * HELMETS AND SHIELDS (d20). **House-ruled.** As printed: 1-13 none ·
 * 14-16 Helmet · 17-19 Shield · 20 both. Ours gives the dead band to
 * spellbooks and hands out protection far more often — a helmet from 6, a
 * shield from 12.
 */
export function rollHelmetShieldTable(d20: number): HelmetShieldResult {
  if (d20 <= 5) return { helmet: false, shield: false, spellbooks: 1 };
  if (d20 <= 11) return { helmet: true, shield: false, spellbooks: 0 };
  if (d20 <= 19) return { helmet: false, shield: true, spellbooks: 0 };
  return { helmet: true, shield: true, spellbooks: 0 };
}

// ===========================================================================
// THE HUNDRED LEVEL-LESS SPELLS  (p.6-7)
// ===========================================================================

export interface Spell {
  name: string;
  /** The printed effect. `L` is the caster's level, as the book uses it. */
  effect: string;
}

const spell = (s: string): Spell => {
  const i = s.indexOf(": ");
  return { name: s.slice(0, i), effect: s.slice(i + 2) };
};

/**
 * A spellbook holds exactly one of these and can be read once per day, so a
 * rolled spellbook is a whole item rather than a line on a sheet. `L` is the
 * caster's level; ongoing effects last L×10 minutes and reach 40 feet unless
 * the entry says otherwise.
 *
 * NOTE: 90 is printed as Summon Idol, out of the alphabetical run the rest of
 * the list keeps. Preserved as printed — same treatment as the duplicate
 * "Tinker" in `dungeon-blueprint.ts`.
 */
export const SPELLS: readonly Spell[] = [
  "Adhere: Object is covered in extremely sticky slime.",
  "Animate Object: Object obeys your commands as best it can. It can walk 15ft per round.",
  "Anthropomorphize: A touched animal either gains human intelligence or human appearance for L days.",
  "Arcane Eye: You can see through a magical floating eyeball that flies around at your command.",
  "Astral Prison: An object is frozen in time and space within an invulnerable crystal shell.",
  "Attract: L+1 objects are strongly magnetically attracted to each other if they come within 10 feet.",
  "Auditory Illusion: You create illusory sounds that seem to come from a direction of your choice.",
  "Babble: A creature must loudly and clearly repeat everything you think. It is otherwise mute.",
  "Beast Form: You and your possessions transform into a mundane animal.",
  "Befuddle: L creatures of your choice are unable to form new short-term memories for the duration of the spell.",
  "Bend Fate: Roll L+1 d20s. Whenever you must roll a d20 after casting the spell, you must choose and then discard one of the rolled results until they are all gone.",
  "Bird Person: Your arms turn into huge bird wings.",
  "Body Swap: You switch bodies with a creature you touch. If one body dies, the other dies as well.",
  "Catherine: A woman wearing a blue dress appears until end of spell. She will obey polite, safe requests.",
  "Charm: L creatures treat you like a friend.",
  "Command: A creature obeys a single, three-word command that does not harm it.",
  "Comprehend: You become fluent in all languages.",
  "Control Plants: Nearby plants and trees obey you and gain the ability to move at 5 feet per round.",
  "Control Weather: You may alter the type of weather at will, but you do not otherwise control it.",
  "Counterspell: Make an opposed Intelligence save against the Intelligence of the caster of a nearby spell. You may do this out of turn as a reaction, or against an ongoing magical effect. On a success, you may cancel the spell.",
  "Deafen: All nearby creatures are deafened.",
  "Detect Magic: You hear nearby magical auras singing.",
  "Disassemble: Any of your body parts may be detached and reattached at will, without causing pain or damage. You can still control them.",
  "Disguise: You may alter the appearance of L characters at will as long as they remain humanoid. Attempts to duplicate other characters will seem uncanny.",
  "Displace: An object appears to be up to L×10ft from its actual position.",
  "Earthquake: The ground begins shaking violently. Structures may be damaged or collapse.",
  "Elasticity: Your body can stretch up to L×10ft.",
  "Elemental Wall: A straight wall of ice or fire L×40ft long and 10ft high rises from the ground.",
  "Filch: L visible items teleport to your hands.",
  "Fog Cloud: Dense fog spreads out from you.",
  "Frenzy: L creatures erupt in a frenzy of violence.",
  "Gate: A portal to a random plane opens.",
  "Gravity Shift: You can change the direction of gravity (for yourself only) up to once per round.",
  "Greed: L creatures develop an overwhelming urge to possess a visible item of your choice.",
  "Haste: Your movement speed is tripled.",
  "Hatred: L creatures develop a deep hatred of another creature or group of creatures and wish to destroy it.",
  "Hear Whispers: You can hear faint sounds clearly.",
  "Hover: An object hovers, frictionless, 2ft above the ground. It can hold up to L humanoids.",
  "Hypnotize: A creature enters a trance and will truthfully answer L yes or no questions you ask it.",
  "Icy Touch: A thick ice layer spreads across a touched surface, up to L×10ft in radius.",
  "Illuminate: A floating light moves as you command.",
  "Increase Gravity: The gravity in an area triples.",
  "Invisible Tether: Two objects within 10ft of each other cannot be moved more than 10ft apart.",
  "Knock: L nearby mundane or magical locks unlock.",
  "Leap: You can jump up to L×10ft in the air.",
  "Liquid Air: The air around you becomes swimmable.",
  "Magic Dampener: All nearby magical effects have their effectiveness halved.",
  "Manse: A sturdy, furnished cottage appears for L×12 hours. You can permit and forbid entry to it at will.",
  "Marble Madness: Your pockets are full of marbles, and will refill every round.",
  "Masquerade: Appearances and voices become identical to a touched character.",
  "Miniaturize: You and L other touched creatures are reduced to the size of a mouse.",
  "Mirror Image: L illusory duplicates of yourself appear under your control.",
  "Mirrorwalk: A mirror becomes a gateway to another mirror that you looked into today.",
  "Multiarm: You gain L extra arms.",
  "Night Sphere: An L×40ft wide sphere of darkness displaying the night sky appears.",
  "Objectify: You become any inanimate object between the size of a grand piano and an apple.",
  "Ooze Form: You become a living jelly.",
  "Pacify: L creatures have an aversion to violence.",
  "Phantom Coach: A ghostly coach appears until end of spell. It moves unnaturally fast over any terrain, including water.",
  "Phobia: L creatures become terrified of an object of your choice.",
  "Pit: A pit 10ft wide and L×5ft deep opens in the ground.",
  "Primeval Surge: An object grows to the size of an elephant. If it is an animal, it is enraged.",
  "Psychometry: The referee answers L yes or no questions about a touched object.",
  "Pull: An object of any size is pulled directly towards you with the strength of L men for one round.",
  "Push: An object of any size is pushed directly away from you with the strength of L men for one round.",
  "Raise Dead: L skeletons rise from the ground to serve you. They are incredibly stupid and can only obey simple orders.",
  "Raise Spirit: The spirit of a dead body manifests and will answer L questions.",
  "Read Mind: You can hear the surface thoughts of nearby creatures.",
  "Repel: L+1 objects are strongly magnetically repelled from each other if they come within 10 feet.",
  "Scry: You can see through the eyes of a creature you touched earlier today.",
  "Sculpt Elements: All inanimate material behaves like clay in your hands.",
  "Shroud: L creatures are invisible until they move.",
  "Shuffle: L creatures instantly switch places. Determine where they end up randomly.",
  "Sleep: L creatures fall into a light sleep.",
  "Smoke Form: Your body becomes living smoke.",
  "Snail Knight: 10 minutes after casting, a knight sitting astride a giant snail rides into view. He is able to answer most questions related to quests and chivalry, and may aid you if he finds you worthy.",
  "Sniff: You can smell even the faintest traces of scents.",
  "Sort: Inanimate items sort themselves according to categories you set. The categories must be visually verifiable.",
  "Spectacle: A clearly unreal but impressive illusion of your choice appears, under your control. It may be up to the size of a palace and has full motion and sound.",
  "Spellseize: Cast this as a reaction to another spell going off to make a temporary copy of it that you can cast at any time before this spell ends.",
  "Spider Climb: You can climb surfaces like a spider.",
  "Summon Cube: Once per second, (6 times per round) you may summon or banish a 3-foot-wide cube of earth. New cubes must be affixed to the earth or to other cubes.",
  "Swarm: You become a swarm of crows, rats, or piranhas. You only take damage from area effects.",
  "Telekinesis: You may mentally move L items.",
  "Telepathy: L+1 creatures can hear each other's thoughts, no matter how far apart they move.",
  "Teleport: An object disappears and reappears on the ground in a visible, clear area up to L×40ft away.",
  "Thaumaturgic Anchor: Object becomes the target of every spell cast near it.",
  "Thicket: A thicket of trees and dense brush up to L×40ft wide suddenly sprouts up.",
  "Time Jump: An object disappears as it jumps L×10 minutes into the future. When it returns, it appears in the unoccupied area nearest to where it left.",
  "Summon Idol: A carved stone statue the size of a four poster bed rises from the ground.",
  "Time Rush: Time in a 40ft bubble starts moving 10 times faster.",
  "Time Slow: Time in a 40ft bubble slows to 10%.",
  "True Sight: You see through all nearby illusions.",
  "Upwell: A spring of seawater appears.",
  "Vision: You completely control what a creature sees.",
  "Visual Illusion: A silent, immobile, illusion of your choice appears, up to the size of a bedroom.",
  "Ward: A silver circle 40ft across appears on the ground. Choose one thing that cannot cross it: living creatures, dead creatures, projectiles or metal.",
  "Web: Your wrists can shoot thick webbing.",
  "Wizard Mark: Your finger can shoot a stream of ulfire-colored paint. This paint is only visible to you, and can be seen at any distance, even through solid objects.",
  "X-Ray Vision: You gain X-Ray vision.",
].map(spell);
