/**
 * CAIRN 2E: DUNGEON SEEDS
 * =======================
 *
 * Yochai Gal, Cairn 2e "Dungeon Seeds" (CC BY-SA 4.0). Who built the place, how
 * it fell, and what it is made of. Plain data; `generation/content/blueprint.ts`
 * rolls on it.
 */

/** A table written as one `|`-separated line, as the source prints it. */
const t = (s: string): string[] => s.split("|");

export const CAIRN_BUILT_BY = t(
  "A Fallen Hero|A Fanatical Cult|A Forgotten Empire|A Long-Dead Poet|A Militant Order|A Renowned Alchemist|A Royal Dynasty|A Secret Society|A Tyrannical Ruler|A Warrior Tribe|A Wealthy Recluse|Desperate Rebels|Heretical Alchemists|Heretical Monks|Immoral Sorcerers|Inverted Astrologers|Mob Families|Opulent Merchants|Pilgrims to a Dead God|Rogue Scholars"
);

export const CAIRN_RUIN_CONDITION = t(
  "Corpse|Crumbling|Cursed|Desecrated|Devoured|Displaced|Divided|Frozen|Haunted|Infested|Overgrown|Overpopulated|Petrified|Plundered|Poisoned|Scorched|Shrouded in Mist|Submerged|Unending|Warped"
);

export const CAIRN_RUIN_CAUSE = t(
  "Alchemical Accident|Ancient Curse|Cataclysmic Flood|Civil War|Competing Rituals|Consumed by a Beast|Disease|Hedonism|Invasion|Long-Term Abandonment|Magic Gone Awry|Magical Seal|Natural Disaster|Natural Erosion|Obfuscation|Overrun with Monsters|Sudden Change in Climate|Teleported to Another Realm|Turned to Stone|Unresolved Spirits"
);

export const CAIRN_COMPOSITION = t(
  "Bone|Coral|Crystal|Earth|Ethereal Fabric|Flesh|Floating Platforms|Fungi|Glass|Ice|Living Plants|Marble|Metal|Obsidian|Petrified Wood|Sand|Shadow Material|Stone|Webs|Wood"
);
