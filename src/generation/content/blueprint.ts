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

import { SPELLS } from "../../rules/knave/tables.ts";

// ---------------------------------------------------------------------------
// RNG
// ---------------------------------------------------------------------------

function mulberry32(a: number) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Rng {
  private f: () => number;
  readonly seed: number;
  constructor(seed: number) {
    this.seed = seed;
    this.f = mulberry32(seed);
  }
  next(): number {
    return this.f();
  }
  /** 1..n inclusive */
  d(n: number): number {
    return Math.floor(this.f() * n) + 1;
  }
  /** inclusive range */
  range(lo: number, hi: number): number {
    return lo + Math.floor(this.f() * (hi - lo + 1));
  }
  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.f() * arr.length)];
  }
  /** n distinct picks */
  pickN<T>(arr: readonly T[], n: number): T[] {
    const pool = [...arr];
    const out: T[] = [];
    while (out.length < n && pool.length) {
      out.push(pool.splice(Math.floor(this.f() * pool.length), 1)[0]);
    }
    return out;
  }
  chance(p: number): boolean {
    return this.f() < p;
  }
  coin(): boolean {
    return this.f() < 0.5;
  }
}

// ---------------------------------------------------------------------------
// TABLES
// ---------------------------------------------------------------------------

const t = (s: string): string[] => s.split("|");

// --- Maze Rats: THE MAZE -----------------------------------------------------

const DUNGEON_FORMS = t(
  "Arena|Asylum|Aviary|Bank|Baths|Body|{Building Room}|Casino|Catacombs|Cave|Court|{Dungeon Room}|Forge|Garden|Hideout|Hotel|{L. Cl. Building}|Laboratory|Library|Market|Mine|Monastery|Museum|Nursery|Orphanage|Palace|Prison|Sewer|Ship|Slave pit|Temple|Theater|{U. Cl. Building}|University|Vault|Zoo"
);

const DUNGEON_REWARDS = t(
  "Ancient lore|Animal ally|Army|Blessing|Blueprints|Cultural artifact|Enemy weakness|Faction ally|Forewarning|Guide|Holy relic|Influential ally|Instructions|Jewels|Key|Lost formula|Machine|Magic item|Magical ally|Map|Marital ally|Masterpiece|{Monster} ally|Oracle|Piles of loot|Planar portal|Prophecy|Renown|Spell|Transformation|Transport|{Treasure Item}|Uncovered plot|{Val. Material}|Vision|Weapon"
);

const BUILDING_ROOMS = t(
  "Arboretum|Atrium|Attic|Aviary|Ballroom|Baths|Bed chamber|Cabinet|Chapel|Cloakroom|Dining room|Dressing room|{Dungeon Room}|Garden|Garret|Greenhouse|Junk room|Kitchen|Larder|Library|Map room|Menagerie|Mews|Nursery|Pantry|Parlor|Privy|Root cellar|Saucery|Scullery|Smoking room|Spicery|Still room|Study|Trophy room|Wardrobe"
);

const DUNGEON_ROOMS = t(
  "Armory|Banquet hall|Barracks|{Building Room}|Catacombs|Cavern|Chasm|Courtyard|Crypt|Dormitory|Fighting pit|Forge|Fountain|Gate house|Guard room|Kennel|{L. Cl. Building}|Laboratory|Mess hall|Mine shaft|Museum|Oubliette|Pool|Prison|Record room|Shrine|Slaughterhouse|Stables|Storeroom|Throne room|Torture room|Treasury|{U. Cl. Building}|Vault|Well|Workshop"
);

const LOWER_CLASS_BUILDINGS = t(
  "Apothecary|Asylum|Baker|Brewery|Butcher|Candlemaker|Catacombs|Cheesemaker|Criminal den|Curiosity shop|Dock|Fighting pit|Forge|Fortuneteller|Gambling hall|Leatherworks|Marketplace|Mason|Mill|Moneylender|Orphanage|Outfitter|Prison|Sewers|Shipyards|Shrine|Stockyard|Stonecarver|Tattooist|Tavern|Theater|Veterinarian|Warehouse|Watchtower|Weaver|Workshop"
);

const UPPER_CLASS_BUILDINGS = t(
  "Academy|Alchemist|Archive|Art dealer|Barber|Bookbinder|Bookseller|Castle|Clockmaker|Clothier|Courthouse|Furrier|Gallery|Garden|Haberdashery|Jeweler|Law office|Locksmith|Lounge|Manor|Museum|Observatory|Opera house|Park|Physician|Printer|Public baths|Restaurant|Salon|Stables|Taxidermist|Temple|Tobacconist|Townhouse|Winery|Zoo"
);

/**
 * Corridors are rooms whose identity is a passage. A room designated a corridor
 * during stocking rolls `identity` here instead of on DUNGEON_ROOMS; `detail`
 * still rolls on the shared Dungeon Room Detail table, so it swaps one table
 * and changes no fields.
 *
 * Twenty entries against the house format of thirty-six. Deliberate and final --
 * `roll` uses `rng.pick`, so any length works. Flagged so a later reader does
 * not "fix" it.
 *
 * `Bridge` implies crossing something a flat plane cannot show, and shares the
 * flavour-only status of stairs and shafts: it matters inside the room it names
 * and nowhere else.
 */
const DUNGEON_CORRIDORS = t(
  "Antechamber|Atrium|Bridge|Burrow|Chute|Cloister|Concourse|Corridor|Gallery|Hallway|Hollow wall|Passageway|Ramp|Sewer|Shaft|Stairwell|Steps|Tunnel|Walkway|Waterway"
);

const DUNGEON_ENTRANCES = t(
  "All libraries|Beaver dam|Behind waterfall|Chalk rectangle|Chest bottom|Chimney|Cupboard|Dolmen shadow|Down a well|Fiery pit|Fog road|Forest spring|Giant book|Gypsy wagon|Hollow tree|Huge keyhole|Iron maiden|Living tattoo|Magic painting|Man-shape hole|Maze potion|Mirror|Monster mouth|Monster wound|Narrow alley|Rain door|Sewer grate|Sudden rift|Tidal cave|Tower top|Tree roots|Under the bed|Unfolded map|Up a tree|Whirlpool|Wine barrel"
);

const DUNGEON_ROOM_DETAILS = t(
  "Bas-relief|Blood trail|Bones|Chains|Chalk marks|Claw marks|Corpses|Cracked beams|Crumbling walls|Decaying food|Decaying nest|Dripping water|Fading murals|Faint breeze|Faint footsteps|Fallen pillars|Fungus|Furniture|Graffiti|Mosaics|Recent repairs|Rotting books|Rubble|Shed skin|Slime trails|Spider webs|Stalactites|Stench|Smoke stains|Thick dust|Torn clothes|Tree roots|Unusual smell|Vibrations|Vines|Whispers"
);

const DUNGEON_TRICKS = t(
  "Absorption|Activation|Animation|Blessings|Communication|Confusion|Consumption|Creation|Curses|Deception|Duplication|{Ethereal Effect}|Exchange|Imprisonment|Instructions|Interrogation|Mind-control|{Mission}|Mood-alteration|Nullification|{Physical Effect}|Planeshift|Protection|Rejuvenation|Release|Reversal|Rotation|Scrying|Size-alteration|Summoning|Theft|Time-alteration|Transformation|Transmutation|Transportation|Wonder"
);

const DUNGEON_HAZARDS = t(
  "Acid drip|Bloodsuckers|Cave-in|Choking dust|Crude oil|Crystal shards|Deafening noise|Dense fog|Ensnaring vines|Fallen floor|Flooding|Freezing|Geysers|Magma|Magnetic field|Mud flow|Narrow ledge|Narrow passage|Poison goo|Poison plants|Precipice|Quicksand|Radiation|Rockslide|Rotten ceiling|Rotten floor|Sinkhole|Slippery slope|Spider webs|Spores|Steam vents|Strong winds|Tar pit|Tight passage|Toppling object|Toxic fumes"
);

/**
 * Maze Rats prints these as separate Trap Effects / Trap Triggers tables. A good
 * trap should have a fairly obvious trigger -- the challenge is avoiding the
 * effect, avoiding the trigger, or finding a way to deactivate it.
 */
const TRAP_EFFECTS = t(
  "Acid pool|Adhesive|Alarm|Armor melts|Bear trap|Blinding spray|Blunt pendulum|Boiling tar|Collapsing floor|Crocodile pit|Crushing walls|Deep pit|Falling cage|Falling ceiling|Fills with sand|Flooding|Giant magnet|Hard vacuum|Lava flow|Lightning|Living statues|Missile fire|{Monster} freed|Net trap|Pendulum blade|Poison gas|Poison needle|Quicksand|Rage gas|Rolling boulder|Room freezes|Room on fire|Sleeping gas|Spiked pit|Tombs open|Wall spikes"
);

const TRAP_TRIGGERS = t(
  "Blow|Break|Burn|Choice|Countdown|Darkness|Drain|Eat|Insert|Kill|Knock|Light|Magic|Melody|Noise|Open|Phrase|Pour|Press|Proximity|Pull|Read|Reflect|Release|Remove|Retrieve|Rudeness|Shut|Sit|Sleep|Slide|Touch|Turn|Unbalance|Unearth|Write"
);

// --- Cairn 2e: Dungeon Seeds -------------------------------------------------

const CAIRN_BUILT_BY = t(
  "A Fallen Hero|A Fanatical Cult|A Forgotten Empire|A Long-Dead Poet|A Militant Order|A Renowned Alchemist|A Royal Dynasty|A Secret Society|A Tyrannical Ruler|A Warrior Tribe|A Wealthy Recluse|Desperate Rebels|Heretical Alchemists|Heretical Monks|Immoral Sorcerers|Inverted Astrologers|Mob Families|Opulent Merchants|Pilgrims to a Dead God|Rogue Scholars"
);

const CAIRN_RUIN_CONDITION = t(
  "Corpse|Crumbling|Cursed|Desecrated|Devoured|Displaced|Divided|Frozen|Haunted|Infested|Overgrown|Overpopulated|Petrified|Plundered|Poisoned|Scorched|Shrouded in Mist|Submerged|Unending|Warped"
);

const CAIRN_RUIN_CAUSE = t(
  "Alchemical Accident|Ancient Curse|Cataclysmic Flood|Civil War|Competing Rituals|Consumed by a Beast|Disease|Hedonism|Invasion|Long-Term Abandonment|Magic Gone Awry|Magical Seal|Natural Disaster|Natural Erosion|Obfuscation|Overrun with Monsters|Sudden Change in Climate|Teleported to Another Realm|Turned to Stone|Unresolved Spirits"
);

const CAIRN_COMPOSITION = t(
  "Bone|Coral|Crystal|Earth|Ethereal Fabric|Flesh|Floating Platforms|Fungi|Glass|Ice|Living Plants|Marble|Metal|Obsidian|Petrified Wood|Sand|Shadow Material|Stone|Webs|Wood"
);

// --- Maze Rats: THE CITY (factions) -----------------------------------------

const FACTIONS = t(
  "Art movement|Beggar's guild|Black market|Brotherhood|City guard|Conspiracy|Craft guild|Crime family|Crime ring|Dark cult|Explorer's club|Free company|Gourmand club|Heist crew|Heretical sect|High council|Hired killers|Local militia|National church|Noble house|Outlander clan|Outlaw gang|Political party|Religious order|Religious sect|Resistance|Royal army|Royal house|Scholar's circle|Secret society|Spy network|Street artists|Street gang|Street musicians|Theater troupe|Trade company"
);

const FACTION_TRAITS = t(
  "Bankrupt|Bureaucratic|Charitable|Confused|Connected|Corrupt|Decadent|Decaying|Delusional|Divided|Dwindling|Efficient|Esoteric|Expanding|Hunted|Incompetent|Incorruptible|Insane|Insular|Manipulative|Martial|{Personality}|Pious|Popular|Righteous|Ruthless|Secret|Subversive|Suppressed|Threatened|Thriving|Unpopular|Up-and-coming|Wealthy|Well-prepared|Xenophobic"
);

const FACTION_GOALS = t(
  "Advise leader|Avoid detection|Awaken being|Collect artifacts|Construct base|Control {faction}|Control politics|Create artifact|Create {monster}|Defeat {faction}|Defend borders|Defend leader|Destroy artifacts|Destroy being|Destroy villain|Enforce law|Enrich members|Entertain|Exchange goods|Hear rumors|Indulge tastes|Infiltrate {faction}|Map the wild|Overthrow order|Preserve lineage|Preserve lore|Produce goods|Promote arts|Promote craft|Purge traitors|Sell services|Share knowledge|Spread beliefs|Summon evil|Survive|Transport goods"
);

// --- Maze Rats: MONSTERS & ANIMALS ------------------------------------------

const AERIAL_ANIMALS = t(
  "Albatross|Bat|Beetle|Bird of Paradise|Butterfly|Condor|Crane|Crow|Dragonfly|Eagle|Falcon|Firefly|Flamingo|Fly|Flying Squirrel|Goose|Gull|Hummingbird|Kingfisher|Locust|Magpie|Mantis|Mockingbird|Mosquito|Moth|Owl|Parrot|Peacock|Pelican|Pteranodon|Rooster|Sparrow|Swan|Vulture|Wasp|Woodpecker"
);

const TERRESTRIAL_ANIMALS = t(
  "Ant|Ape|Armadillo|Badger|Bear|Boar|Caterpillar|Centipede|Chameleon|Cockroach|Deer|Elephant|Ferret|Fox|Giraffe|Goat|Horse|Human|Mole|Ostrich|Ox|Porcupine|Rabbit|Raccoon|Rat|Rhinoceros|Scorpion|Sheep|Slug|Snail|Snake|Spider|Squirrel|Tiger|Wolf|Wolverine"
);

const AQUATIC_ANIMALS = t(
  "Alligator|Amoeba|Anglerfish|Beaver|Clam|Crab|Dolphin|Eel|Frog|Hippopotamus|Jellyfish|Leech|Lobster|Manatee|Manta Ray|Muskrat|Narwhal|Newt|Octopus|Otter|Penguin|Platypus|Pufferfish|Salamander|Sea Anemone|Sea Urchin|Seahorse|Seal|Shark|Shrimp|Squid|Swordfish|Tadpole|Turtle|Walrus|Whale"
);

const MONSTER_TRAITS = t(
  "Amphibious|Bloated|Brittle|Cannibal|Clay-like|Colossal|Crystalline|Decaying|{Ether. Element}|Ethereal|Ever-young|Eyeless|Fearless|Fluffy|Fungal|Gelatinous|Geometric|Hardened|Illusory|Intelligent|Iridescent|Luminous|Many-headed|Mechanical|{Phys. Element}|Planar|Reflective|Rubbery|Shadowy|Sharp|Skeletal|Slimy|Sticky|Stinking|Tiny|Translucent"
);

const MONSTER_ABILITIES = t(
  "Absorbing|Acid blood|Anti-magic|Blinding|Breath weapon|Camouflaging|Duplicating|Electric|Entangling|{Ethereal Effect}|Exploding|Flying|Gaze weapon|Hypnotizing|Impervious|Invisible|Life-draining|Magnetic|Mimicking|Mind-Reading|Paralyzing|Phasing|{Physical Effect}|Poisonous|Radioactive|Reflective|Regenerating|Shapeshifting|Spell-casting|Stealthy|Strangling|Super-strength|Telekinetic|Teleporting|Vampiric|Wall-Crawling"
);

const MONSTER_FEATURES = t(
  "Antlers|Beak|Carapace|Claws|Compound eyes|Eye Stalks|Fangs|Fins|Fur|Gills|Hooves|Horns|Legless|Long tongue|Many-eyed|Many-limbed|Mucus|Pincers|Illustrations|Plumage|Proboscis|Scales|Segments|Shaggy hair|Shell|Spikes|Spinnerets|Spines|Stinger|Suction cups|Tail|Talons|Tentacles|Trunk|Tusks|Wings"
);

const MUTATIONS = t(
  "Ages|Attracts birds|Child-form|Corpulence|Covered in hair|{Animal} arms|{Animal} eyes|{Animal} head|{Animal} legs|{Animal} mouth|{Animal} skin|{Animal}-form|Cyclops|Extra arms|Extra eyes|Extra legs|Forked tongue|Gender swap|Hunchback|{Item}-form|Long arms|Lose all hair|Loses teeth|{Monster Feature}|{Monster Trait}|No eyes|No mouth|{Phys. Element}-skin|Second face|Sheds skin|Shrinks|Shrivels|Skin boils|Slime trail|Translucent skin|Weeps blood"
);

const MONSTER_TACTICS = t(
  "Ambush|Call for support|Capture|Charge|Climb foes|Compel worship|Create barrier|Deceive|Demand duel|Disorient|Encircle|Evade|Gang up|Gather strength|Go berserk|Harry|Hurl foes|Immobilize|Manipulate|Mock|Monologue|Order minion|Protect leader|Protect self|Scatter foes|Stalk|Steal from|Swarm|Target insolent|Target leader|Target nearest|Target richest|Target strongest|Target weakest|Toy with|Use terrain"
);

const MONSTER_WEAKNESS = t(
  "Bells|Birdsong|Children|Cold|Cold Iron|Competition|Conversation|Deformity|Flattery|Flowers|Gifts|Gold|Heat|Holy Icon|Holy Water|Home Cooking|{Insanities}|Mirrors|Mistletoe|Moonlight|Music|{Methods}|Phylactery|{Phys. Element}|Puzzles|Riddles|Rituals|Silver|Sunlight|Tears|True Name|{Val. Materials}|Weak Spot|{Weapon Items}|Wine|Wormwood"
);

const MONSTER_PERSONALITY = t(
  "Alien|Aloof|Bored|Cautious|Cowardly|Curious|Devious|Distractable|Educated|Embittered|Envious|Erudite|Fanatical|Forgetful|Generous|Hateful|Honorable|Humble|Jaded|Jovial|Legalistic|Manipulative|Megalomaniac|Melancholy|Meticulous|Mystical|Obsessive|Out of Touch|Paranoid|Polite|Psychopathic|Sophisticated|Touchy|Unimpressed|Vain|Xenophobic"
);

// --- Maze Rats: CHARACTERS ---------------------------------------------------

const CIVILIZED_NPCS = t(
  "Acolyte|Actor|Apothecary|Baker|Barber|Blacksmith|Brewer|Bureaucrat|Butcher|Carpenter|Clockmaker|Courier|Courtier|Diplomat|Fishmonger|Guard|Haberdasher|Innkeeper|Item-seller|Jeweler|Knight|Locksmith|Mason|Miller|Musician|Noble|Painter|Priest|Scholar|Scribe|Sculptor|Shipwright|Soldier|Tailor|Taxidermist|Wigmaker"
);

const UNDERWORLD_NPCS = t(
  "Alchemist|Beggar-prince|Blackmailer|Bounty-hunter|Chimney sweep|Coin-clipper|Contortionist|Counterfeiter|Cultist|Cutpurse|Debt-collector|Deserter|Fence|Fortuneteller|Galley slave|Gambler|Gravedigger|Headsman|Hedge knight|Highwayman|Housebreaker|Kidnapper|Mad prophet|Mountebank|Peddler|Pit-fighter|Poisoner|Rat-catcher|Scrivener|Sellsword|Slave|Smuggler|Street performer|Tattooist|Urchin|Usurer"
);

// NOTE: PDF column OCR duplicates "Tinker"; harmless (slightly weights that result).
const WILDERNESS_NPCS = t(
  "Apiarist|Bandit|Caravan Guard|Caravaneer|Druid|Exile|Explorer|Farmer|Fisherman|Forager|Fugitive|Hedge wizard|Hermit|Hunter|Messenger|Minstrel|Monk|Monster hunter|Outlander|Tinker|Pilgrim|Poacher|Raider|Ranger|Sage|Scavenger|Scout|Seer|Shepherd|Surveyor|Tinker|Tomb raider|Trader|Trapper|Witch|Woodcutter"
);

/** MR character-creation Background table is identical to the Underworld NPC list. */
const BACKGROUNDS = UNDERWORLD_NPCS;

const FEMALE_NAMES = t(
  "Adelaide|Alma|Barsaba|Beatrix|Bianca|Cleopha|Clover|Constance|Damaris|Daphne|Demona|Elsbeth|Esme|Fern|Hester|Hippolyta|Jessamine|Jilly|Morgot|Minerva|Nerissa|Odette|Olga|Orchid|Pepper|Phoebe|Piety|Poppy|Silence|Sybil|Trillby|Tuesday|Ursula|Vivian|Wendy|Zora"
);

const MALE_NAMES = t(
  "Balthazar|Basil|Bertram|Blaxton|Chadwick|Clovis|Destrian|Ellis|Erasmus|Faustus|Finn|Fitzhugh|Florian|Fox|Godwin|Hannibal|Jasper|Jiles|Jules|Leopold|Merrick|Mortimer|Ogden|Orion|Oswald|Percival|Peregrine|Quentin|Redmaine|Reinhold|Silas|Stilton|Stratford|Tenpiece|Waverly|Webster"
);

const UPPER_SURNAMES = t(
  "Belvedere|Bithesea|Calaver|Carvolo|De Rippe|Droll|Dunlow|Edevane|Erelong|Febland|Fernsby|Fisk|Gastrell|Girdwood|Gorgon|Grimeson|Gruger|Hitheryon|La Marque|Malmora|Miter|Oblington|Onymous|Phillifent|Portendorfer|Romatet|Rothery|Skorbeck|Slora|Southwark|Stavish|Vandermeer|Wellbelove|Westergren|Wexley|Wilberforce"
);

const LOWER_SURNAMES = t(
  "Barrow|Beetleman|Berrycloth|Birdwhistle|Bobich|Chips|Coffin|Crumpling|Culpepper|Dankworth|Digworthy|Dreggs|Gimble|Graveworm|Greelish|Hardwick|Hatman|Hovel|Knibbs|Midnighter|Needle|Nethercoat|Pestle|Relish|Rumbold|Rummage|Sallow|Saltmarsh|Silverless|Skitter|Slee|Slitherly|Stoker|Tarwater|Tumbler|Villin"
);

// NOTE: transcribed 35 of 36 (one column entry illegible in source layout).
const ASSETS = t(
  "Authority|Avoids detection|Calls in favors|Charming|Cooks the books|Erases evidence|Excellent liar|Extremely rich|Faction-leader|Faction-member|Fortified base|Interrogator|Gorgeous|Hears rumors|Huge family|Huge library|Impersonator|Knows a guy|Knows a way in|Launders money|Learned|Local celebrity|Local knowledge|Loyal henchmen|Middling oracle|Nothing to lose|Owns the guards|Powerful spouse|Procures gear|Pulls the strings|Secret lab|Sells contraband|Smuggles goods|Spy network|War hero"
);

const LIABILITIES = t(
  "Addiction|Alcoholic|Corrupt ally|Coward|Decadent|Forbidden love|Gambler|Glutton|Greedy|Heretic|Huge debts|Imposter|{Insanity}|Jealous|Leaves evidence|Many enemies|Misinformed|Money trail|Narcissist|Needs medicine|OCD|Paranoid|Partyer|Poor equipment|Protective|Scandalous|Softhearted|Strict routines|Superstitious|Suspicious|Temper|Trusting|Vulnerable base|Wanted|Weak-willed|Widely despised"
);

// NOTE: transcribed 35 of 36 (one column entry illegible in source layout).
const METHODS = t(
  "Alchemy|Blackmail|Bluster|Bribery|Bullying|Bureaucracy|Charm|Commerce|Cronies|Debate|Deduction|Eloquence|Espionage|Fast-talking|Favors|Hard Work|Humor|Investigation|Legal maneuvers|Manipulation|Misdirection|Money|Nagging|Negotiation|Persistence|Piety|Preparation|Quick Wit|Research|Rumors|Sabotage|Teamwork|Theft|Threats|Violence"
);

const APPEARANCES = t(
  "Aquiline|Athletic|Barrel-chested|Boney|Brawny|Brutish|Bullnecked|Chiseled|Coltish|Corpulent|Craggy|Delicate|Furrowed|Gaunt|Gorgeous|Grizzled|Haggard|Handsome|Hideous|Lanky|Pudgy|Ripped|Rosy|Scrawny|Sinewy|Slender|Slumped|Solid|Square-jawed|Statuesque|Towering|Trim|Weathered|Willowy|Wiry|Wrinkled"
);

const PERSONALITIES = t(
  "Bitter|Brave|Cautious|Chipper|Contrary|Cowardly|Cunning|Driven|Entitled|Gregarious|Grumpy|Heartless|Honor-bound|Hotheaded|Inquisitive|Irascible|Jolly|Know-it-all|Lazy|Loyal|Menacing|Mopey|Nervous|Protective|Righteous|Rude|Sarcastic|Savage|Scheming|Serene|Spacey|Stoic|Stubborn|Stuck-up|Suspicious|Wisecracking"
);

const NPC_GOALS = t(
  "A better life|Acceptance|Acquire {item}|Craft {item}|Destroy {faction}|Destroy {item}|Enlightenment|Fame|Found {faction}|Freedom|Glory|Impress {NPC}|Infamy|Infiltrate {faction}|Justice|Kidnap {NPC}|Lead {faction}|Learning|Locate {NPC}|Love|Mastery|Power|Reach location|Rescue {NPC}|Resolve dispute|Restore {faction}|Reveal a secret|Revenge|Sabotage {faction}|Serve a deity|Serve evil|Serve {faction}|Serve ideology|Serve leader|Serve the needy|Wealth"
);

const PHYSICAL_DETAILS = t(
  "Acid scars|Battle scars|Birthmark|Braided hair|Brand mark|Broken nose|Bronze skinned|Burn scars|Bushy eyebrows|Curly hair|Dark skinned|Dreadlocks|Exotic accent|Flogging scars|Freckles|Gold tooth|Hoarse voice|Huge beard|Long hair|Matted hair|Missing ear|Missing teeth|Mustache|Muttonchops|Nine fingers|Oiled hair|One-eyed|Pale skinned|Piercings|Ritual scars|Sallow skin|Shaved head|Sunburned|Tangled hair|Tattoos|Topknot"
);

const CLOTHING = t(
  "Antique|Battle-torn|Bedraggled|Blood-stained|Ceremonial|Dated|Decaying|Eccentric|Elegant|Embroidered|Exotic|Fashionable|Flamboyant|Food-stained|Formal|Frayed|Frumpy|Garish|Grimy|Haute couture|Lacey|Livery|Mud-stained|Ostentatious|Oversized|Patched|Patterned|Perfumed|Practical|Rumpled|Sigils|Singed|Tasteless|Undersized|Wine-stained|Worn out"
);

const MANNERISMS = t(
  "Anecdotes|Breathy|Chuckles|Clipped|Cryptic|Deep voice|Drawl|Enunciates|Flowery speech|Gravelly voice|Highly formal|Hypnotic|Interrupts|Laconic|Laughs|Long pauses|Melodious|Monotone|Mumbles|Narrates|Overly casual|Quaint sayings|Rambles|Random facts|Rapid-fire|Rhyming|Robotic|Slow speech|Speechifies|Squeaky|Street slang|Stutters|Talks to self|Trails off|Very loud|Whispers"
);

const SECRETS = t(
  "Addicted|Artificial|Assassin|Bankrupt|Beholden|Counterspy|Cultist|Demigod|Evil lineage|Exile|Fence|Fugitive|Ghost|Has a child|Heretic|High born|Huge fortune|Illusion|Insurrectionist|Low born|Married|Mind-controlled|{Misfortune}|Monster hunter|Non-human|{NPC}|Polygamist|Protects relic|Scandalous birth|Secret police|Serial killer|Smuggler|Spy|Time traveler|Transformed|War criminal"
);

const REPUTATIONS = t(
  "Ambitious|Authoritative|Boor|Borrower|Celebrity|Charitable|Cheat|Dangerous|Entertainer|Gossip|Hardworking|Holy|Honest|Hypochondriac|Idiot|Influential|Layabout|Leader|Misanthrope|Miser|Neighborly|Nutjob|Obnoxious|Overeducated|Partier|Pious|Proper|Prophet of doom|Repulsive|Respected|Riffraff|Scandalous|Slime ball|Terrifying|Weirdo|Wise"
);

const HOBBIES = t(
  "Archaeology|Art collecting|Bad fiction|Calligraphy|Card games|Clockwork|Collecting cats|Cuisine|Dark lore|Dog breeding|Embroidery|Exercise|Falconry|Fashion|Fishing|Foreign cultures|Gardening|History|Horseracing|Hunting|Instrument|Knitting|Lawn games|Mountaineering|Opera|Painting|Poetry|Puzzle-solving|Riddling|Science|Sculpture|Sketching|Smoking|Theater|Weaving|Whiskey"
);

const MISFORTUNES = t(
  "Abandoned|Addicted|Arrested|Blackmailed|Burgled|Challenged|Condemned|Crippled|Cursed|Defrauded|Demoted|Depressed|Discredited|Dismissed|Disowned|Exiled|Famished|Forgotten|Framed|Haunted|Humiliated|Impoverished|Kidnapped|Lost|Mobbed|Mutilated|Overworked|Poisoned|Pursued|Rejected|Replaced|Robbed|Sick|Sued|Suspected|Transformed"
);

const RELATIONSHIPS = t(
  "Adviser|Blackmailer|Business partner|Business rival|Buyer|Captor|Client|Confidant|Debtor|Disciple|Guardian|Henchman|Idol|Informant|Master|Mentor|Nemesis|Offspring|Parent|Patron|Political rival|Prisoner|Protege|Quarry|Right hand|Romantic rival|Servant|Sibling|Social rival|Spouse|Stalker|Suitor|Supplicant|Supplier|Sweetheart|Unrequited love"
);

const MISSIONS = t(
  "Apprehend|Assassinate|Blackmail|Burgle|Chart|Convince|Deface|Defraud|Deliver|Destroy|Discredit|Escort|Exfiltrate|Extort|Follow|Frame|Impersonate|Impress|Infiltrate|Interrogate|Investigate|Kidnap|Locate|Plant|Protect|Raid|Replace|Retrieve|Rob|Ruin|Sabotage|Smuggle|Surveil|Take Over|Terrorize|Threaten"
);

// --- Maze Rats: MAGIC / TREASURE (cascade targets) --------------------------

// NOTE: source lists "Wood" twice in Physical Elements; preserved as printed.
const PHYSICAL_ELEMENTS = t(
  "Acid|Amber|Bark|Blood|Bone|Brine|Clay|Crow|Crystal|Ember|Flesh|Fungus|Glass|Honey|Ice|Insect|Wood|Lava|Moss|Obsidian|Oil|Poison|Rat|Salt|Sand|Sap|Serpent|Slime|Stone|Tar|Thorn|Vine|Water|Wine|Wood|Worm"
);

const ETHEREAL_ELEMENTS = t(
  "Ash|Chaos|Distortion|Dream|Dust|Echo|Ectoplasm|Fire|Fog|Ghost|Harmony|Heat|Light|Lightning|Memory|Mind|Mutation|Negation|Plague|Plasma|Probability|Rain|Rot|Shadow|Smoke|Snow|Soul|Star|Stasis|Steam|Thunder|Time|Void|Warp|Whisper|Wind"
);

const PHYSICAL_EFFECTS = t(
  "Animating|Attracting|Binding|Blossoming|Consuming|Creeping|Crushing|Diminishing|Dividing|Duplicating|Enveloping|Expanding|Fusing|Grasping|Hastening|Hindering|Illuminating|Imprisoning|Levitating|Opening|Petrifying|Phasing|Piercing|Pursuing|Reflecting|Regenerating|Rending|Repelling|Resurrecting|Screaming|Sealing|Shapeshifting|Shielding|Spawning|Transmuting|Transporting"
);

const ETHEREAL_EFFECTS = t(
  "Avenging|Banishing|Bewildering|Blinding|Charming|Communicating|Compelling|Concealing|Deafening|Deceiving|Deciphering|Disguising|Dispelling|Emboldening|Encoding|Energizing|Enlightening|Enraging|Excruciating|Foreseeing|Intoxicating|Maddening|Mesmerizing|Mindreading|Nullifying|Paralyzing|Revealing|Revolting|Scrying|Silencing|Soothing|Summoning|Terrifying|Warding|Wearying|Withering"
);

/**
 * BARE `{Element}` AND `{Effect}`, which the treasure and potion tables use and
 * the magic tables do not. Maze Rats splits both physical from ethereal; an
 * entry that asks for neither half means either, so these are the two halves
 * concatenated and the draw is an even split between them.
 */
const ELEMENTS: readonly string[] = [...PHYSICAL_ELEMENTS, ...ETHEREAL_ELEMENTS];
const EFFECTS: readonly string[] = [...PHYSICAL_EFFECTS, ...ETHEREAL_EFFECTS];

/**
 * `{Spell}` is Maze Rats' own spell generator in the original. We use Knave's
 * hundred instead — the same list `rewards.ts` mints a spellbook from,
 * so a potion of X and a book of X name the same spell.
 */
const SPELL_NAMES: readonly string[] = SPELLS.map((s) => s.name);

/**
 * `{Edible Plant}` in MAGICAL_INGREDIENTS is the only reader of this one.
 */
const EDIBLE_PLANTS = t(
  "Acorns|Apples|Asparagus|Blackberries|Blueberries|Carrots|Cattail|Cherries|Chickweed|Chicory|Clover|Dandelion|Dead-nettle|Elderberries|Fireweed|Gooseberries|Hazelnuts|Henbit|Hickory nuts|Honeysuckle|Leeks|Milk thistle|Mint|Mulberries|Mushrooms|Mustard|Onion|Pecans|Persimmons|Raspberries|Strawberries|Walnuts|Watercress|Wild garlic|Wild grapes|Wood sorrel"
);

// NOTE: 35 entries, one short of the 36 a Maze Rats table carries.
const POISONOUS_PLANTS = t(
  "Angel's trumpet|Baneberry|Belladonna|Black truffle|Bleeding heart|Celandine|Cocklebur|Columbine|Crowncup|Deathcap|Dumbcane|Foxglove|Hemlock|Hogweed|Holly|Horse chestnut|Hyacinth|Ivy|Jessamine|Kudzu|Larkspur|Mandrake|Mangrove|Mistletoe|Moonflower|Nightshade|Oleander|Ragwort|Reindeer lichen|Snakeweed|Spindle|Stinkhorn|Waxcap|Wine-cap|Wolfsbane|Wormwood"
);

const INSANITIES = t(
  "Always lies|Always polite|{Animal}-form|Cannot count|Cannot lie|Faceblind|Fears birds|Fears blood|Fears books|Fears darkness|Fears fire|Fears gold|Fears horses|Fears iron|Fears music|Fears own hand|Fears PC|Fears rain|Fears rivers|Fears silence|Fears sleep|Fears sunlight|Fears the moon|Fears trees|Genius|Gorgeous|Hates violence|Invisible|{Monster Ability}|{Monster Feature}|{Monster Trait}|Must sing|New {Personality}|Says thoughts|Sees dead people|Translucent"
);

const VALUABLE_MATERIALS = t(
  "Alabaster|Amber|Aquamarine|Azurite|Beryl|Black Pearl|Bloodstone|Bone China|Chalcedony|Cinnabar|Coral|Diamond|Ebony|Emerald|Fire Agate|Garnet|Gold|Ivory|Jade|Jasper|Jet|Lapis Lazuli|Malachite|Moonstone|Onyx|Opal|Pearl|Platinum|Porcelain|Ruby|Sapphire|Serpentine|Silver|Star Iron|Topaz|Turquoise"
);

const WEAPON_ITEMS = t(
  "Arming sword|Backsword|Battleaxe|Blowpipe|Claymore|Club|Crossbow|Cutlass|Dagger|Flail|Flanged mace|Glaive|Halberd|Hammer|Hatchet|Horsebow|Hunting knife|Lance|Longbow|Longsword|Mace|Maul|Morningstar|Pike|Scimitar|Shortbow|Sickle|Sling|Spear|Staff|Stake|Stiletto|Throwing axe|Warhammer|Warpick|Whip"
);

const TREASURE_ITEMS = t(
  "Alchemy recipe|Amulet|Astrolabe|Blueprints|Calligraphy|Carpet|Compass|Contract|Crown|Crystal|Deed|Embroidery|Fine china|Fine liquor|Instrument|Magical book|Microscope|Music box|Orrery|Painting|Perfume|Prayer book|Printing block|Rare textile|Royal robes|Saint's relic|Scrimshaw|Sextant|Sheet music|Signet ring|Silverware|Spices|Spyglass|Tapestry|Telescope|Treasure map"
);

/**
 * THE SIX THAT WERE EMPTY — Maze Rats, transcribed.
 *
 * They are the tables the reward rows draw on, and every one of them is now
 * filled. `rollTable` and `rollTreasure` in rewards.ts still guard
 * against an empty list, because that guard is what let these ship unfilled;
 * it is now unreachable for these six and stays for the next stub.
 *
 * THE CASCADE TOKENS IN HERE RESOLVE THROUGH `CONTENT_CASCADES` BELOW, and
 * every one of them is registered — see the block comment on that table for
 * the four keys these entries are the only readers of.
 */
const MISC_ITEMS = t(
  "Bowl|Brass bell|Brooch|Carved figurine|Cup|Deck of cards|Drawing|Foreign coin|Game piece|Glass eye|Glass jar|Hair comb|Handkerchief|Hinged box|Hourglass|Human tooth|Hunting horn|Loaded dice|Long fork|Numbered key|Oil lamp|Old doll|Pain pot|Pencil|Purse|Quill pen|Salve|Scissors|Scroll|Sealed letter|Sewing needle|Shaving razor|Silver button|Skull|Tobacco pipe|Wine bottle"
);

const WORN_ITEMS = t(
  "Belt|Blouse|Boots|Bracelet|Breastplate|Brigandine|Cincture|Cloak|Coat|Dress|Earring|Eyepatch|Gambeson|Gauntlets|Glove|Gown|Hat|Helmet|Hose|Leathers|Locket|Mail shirt|Mask|Necklace|Illustration mail|Ring|Robe|Sandals|Scarf|Shirt|Shoes|Skirt|Slippers|Socks|Trousers|Veil"
);

const TOOL_ITEMS = t(
  "Acid flask|Bear trap|Bellows|Bolt-cutters|Chain|Chisel|Crowbar|Door ram|Ear trumpet|Fire oil|Fishing hook|Goggles|Grappling hook|Grease|Hacksaw|Hammer|Hand drill|Lantern|Lens|Lock/key|Lockpicks|Manacles|Metal file|Mortar/pestle|Needle|Pickaxe|Pitchfork|Pliers|Pole|Pulleys|Rope|Scissors|Shovel|Spikes|Steel wire|Tongs"
);

const TREASURE_TRAITS = t(
  "Altered|Ancient|Blessed|Bulky|Compact|Consumable|Cultural value|Cursed|Damaged|Disguised|Draws enemies|{Effect}|{Element}|Embellished|Encoded|Exotic|Extra-planar|Famous|Forbidden|Fragile|Heavy|Immovable|Impracticable|Indestructible|Intelligent|Masterwork|Military value|Non-human|Owned|Partial|Political value|Religious value|Repaired|Royal|Toxic|Vile"
);

const MAGICAL_INGREDIENTS = t(
  "Ancient liquor|{Animal}|Blind eye|Boiled cat|{Book} book page|Bottled fog|Coffin nail|Corpse's hair|Crossroad dust|Cultist entrails|{Edible Plant}|Exotic spice|Killer's hand|King's tooth|Last breath|Liar's tongue|Lightning bolt|Lodestone|Monk's vow|{Monster Feature}|Newborn's cry|Oil portrait|{Potion}|{Phys. Element}|{Poisonous Plant}|Pyre ember|Queen bee|Queen's blood|Ship's barnacle|Star-metal|Thief's finger|Tomb flower|{Valuable Material}|Wedding ring|Widow's tears|Wizard skull"
);

// NOTE: `{Spell}` sits out of the alphabetical run the rest of the list keeps,
// preserved as printed — same treatment as the duplicate "Wood" in Physical
// Elements and "Tinker" further up.
const POTIONS = t(
  "{Animal}-form|Body swap|Camouflage|Control animals|Control {Element}|Cure affliction|Detect evil|Detect gold|Detect hidden|Direction sense|{Element}-form|{Element}-skin|Extra arm|Flight|Ghost-speech|Heat vision|{Insanity}|Invulnerable|{Item}-form|Magic immunity|Mirror image|{Monster Ability}|{Monster Feature}|{Monster Trait}|{Mutation}|Night vision|{Spell}|Restore health|Speed|Stretchy|Super-jump|Super-strength|Telekinesis|Tongues|Water-breathing|Water-walking"
);

/**
 * WHAT A BOOK IS ABOUT — Maze Rats.
 *
 * Rolled once, when the book is made, and it is the whole of what the book IS:
 * how much is in it is not decided here but found out by reading it, one d6 at
 * a time. See `BookFacts` and `consultRoll`.
 *
 * The game master reads the subject generously — a heading, not a boundary — which
 * is what makes a book worth the slot it costs. Step 3 of the playbook owns
 * that rule.
 */
export const BOOK_SUBJECTS: readonly string[] = [
  "Alchemy",
  "Art",
  "Astrology",
  "Blackmail",
  "Charts & Maps",
  "Conspiracies",
  "Cookbook",
  "Criminals",
  "Divination",
  "Etiquette",
  "Fashion",
  "Genealogy",
  "Hagiography",
  "History",
  "Journal",
  "Language",
  "Laws",
  "Letters",
  "Lost empires",
  "Lost places",
  "Love poems",
  "Monsters",
  "Mythology",
  "Odd customs",
  "Oratory",
  "Propaganda",
  "Prophecies",
  "Siegecraft",
  "Songs",
  "State secrets",
  "Sword fighting",
  "Theology",
  "Treasures",
  "War chronicle",
  "Who's who",
  "Witch-hunting"
];

/** Empty string only if the table is ever emptied — a book with no subject is legal. */
export function rollBookSubject(rng: Rng): string {
  return BOOK_SUBJECTS.length ? rng.pick(BOOK_SUBJECTS) : "";
}

// ---------------------------------------------------------------------------
// CASCADES
// ---------------------------------------------------------------------------

/**
 * Content cascades resolve inline (capped depth).
 * Entity cascades emit a stub -- they never re-enter the pipeline, which is what
 * caps recursion. The synthesis pass binds them to an existing entity or writes
 * a brief new one.
 */
const CONTENT_CASCADES: Record<string, readonly string[]> = {
  "Building Room": BUILDING_ROOMS,
  "Dungeon Room": DUNGEON_ROOMS,
  "L. Cl. Building": LOWER_CLASS_BUILDINGS,
  "U. Cl. Building": UPPER_CLASS_BUILDINGS,
  "Monster Feature": MONSTER_FEATURES,
  "Mon. Feature": MONSTER_FEATURES,
  "Monster Ability": MONSTER_ABILITIES,
  "Mon. Ability": MONSTER_ABILITIES,
  "Monster Trait": MONSTER_TRAITS,
  "Phys. Element": PHYSICAL_ELEMENTS,
  "Ether. Element": ETHEREAL_ELEMENTS,
  "Physical Effect": PHYSICAL_EFFECTS,
  "Ethereal Effect": ETHEREAL_EFFECTS,
  Insanity: INSANITIES,
  Insanities: INSANITIES,
  Methods: METHODS,
  Personality: PERSONALITIES,
  Misfortune: MISFORTUNES,
  "Val. Material": VALUABLE_MATERIALS,
  "Val. Materials": VALUABLE_MATERIALS,
  "Weapon Items": WEAPON_ITEMS,
  Mission: MISSIONS,
  "Treasure Item": TREASURE_ITEMS,
  item: TREASURE_ITEMS,
  "Misc Item": MISC_ITEMS,
  "Worn Item": WORN_ITEMS,
  "Tool Item": TOOL_ITEMS,
  "Treasure Trait": TREASURE_TRAITS,
  "Magical Ingredient": MAGICAL_INGREDIENTS,
  Potion: POTIONS,
  // Read only by the six above. `Item` and `Valuable Material` are spelling
  // aliases for keys that already existed; the rest are new pools.
  Item: TREASURE_ITEMS,
  "Valuable Material": VALUABLE_MATERIALS,
  Element: ELEMENTS,
  Effect: EFFECTS,
  Mutation: MUTATIONS,
  Spell: SPELL_NAMES,
  Book: BOOK_SUBJECTS,
  "Edible Plant": EDIBLE_PLANTS,
  "Poisonous Plant": POISONOUS_PLANTS,
};

const ENTITY_CASCADES = new Set(["NPC", "faction", "monster", "Monster"]);

const MAX_CASCADE_DEPTH = 2;

/**
 * A table draw, fully resolved. Cascades ({Braces}) are expanded in place and
 * the result is just the final text -- we do not retain the unresolved entry or
 * a separate list of entity references.
 */
export type Rolled = string;

function rollAnimal(rng: Rng): string {
  const d = rng.d(6);
  const tbl = d <= 2 ? AERIAL_ANIMALS : d <= 4 ? TERRESTRIAL_ANIMALS : AQUATIC_ANIMALS;
  return rng.pick(tbl);
}

function resolveCascades(entry: string, rng: Rng, depth = 0): string {
  return entry.replace(/\{([^}]+)\}/g, (_m, token: string) => {
    if (token === "Animal") return rollAnimal(rng);
    if (ENTITY_CASCADES.has(token)) {
      // An entity reference cannot be resolved from a table -- it names
      // something the writing pass must supply. The marker stays inline.
      return token === "NPC" ? "an NPC" : token.toLowerCase() === "faction" ? "a faction" : "a monster";
    }
    const tbl = CONTENT_CASCADES[token];
    // An UNFILLED table is not a missing one. A reference to one leaves its
    // own name inline, exactly as an unknown key does, rather than picking out
    // of an empty array. Every table is filled today; this is what keeps the
    // next stub from being a crash instead of a dull word.
    if (!tbl || tbl.length === 0) return token;
    const pickRaw = rng.pick(tbl);
    if (depth >= MAX_CASCADE_DEPTH) return pickRaw.replace(/[{}]/g, "");
    return resolveCascades(pickRaw, rng, depth + 1);
  });
}

function roll(table: readonly string[], rng: Rng): Rolled {
  return resolveCascades(rng.pick(table), rng);
}

// --- public rollers for the MAZE hazard/detail tables ------------------------

export { DUNGEON_ENTRANCES, DUNGEON_ROOM_DETAILS, DUNGEON_TRICKS, DUNGEON_HAZARDS, TRAP_EFFECTS, TRAP_TRIGGERS };
export { TREASURE_ITEMS, VALUABLE_MATERIALS, WEAPON_ITEMS };
export { MISC_ITEMS, WORN_ITEMS, TOOL_ITEMS, TREASURE_TRAITS, MAGICAL_INGREDIENTS, POTIONS };
export { DUNGEON_ROOMS, BUILDING_ROOMS, LOWER_CLASS_BUILDINGS, UPPER_CLASS_BUILDINGS };
export { DUNGEON_CORRIDORS };

export const rollDungeonEntrance = (rng: Rng): Rolled => roll(DUNGEON_ENTRANCES, rng);
export const rollRoomDetail = (rng: Rng): Rolled => roll(DUNGEON_ROOM_DETAILS, rng);
export const rollTrick = (rng: Rng): Rolled => roll(DUNGEON_TRICKS, rng);
export const rollHazard = (rng: Rng): Rolled => roll(DUNGEON_HAZARDS, rng);

/**
 * Any table, cascade-resolved. The general form of the four rollers above, for
 * callers outside this file that hold a table of their own — the reward rows
 * pick which list to draw from and then need it resolved the same way
 * everything else here is.
 *
 * Returns undefined for an empty table rather than throwing, because the six
 * stubs above are empty on purpose and a caller's answer to that is to draw
 * something else.
 */
export const rollTable = (table: readonly string[], rng: Rng): Rolled | undefined =>
  table.length ? roll(table, rng) : undefined;

/**
 * A trap is a trigger paired with an effect -- the two halves of a HazardSeed.
 * Environmental hazards use rollHazard() instead and have no trigger.
 */
export const rollTrap = (rng: Rng): { trigger: Rolled; effect: Rolled } => ({
  trigger: roll(TRAP_TRIGGERS, rng),
  effect: roll(TRAP_EFFECTS, rng),
});

/** n distinct entries from one table, each cascade-resolved */
function rollDistinct(table: readonly string[], n: number, rng: Rng): Rolled[] {
  return rng.pickN(table, n).map((raw) => resolveCascades(raw, rng));
}

// ---------------------------------------------------------------------------
// IDS
// ---------------------------------------------------------------------------

/** Unique id. Not drawn from the seeded rng — identity, not content. */
export function makeId(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    return (ch === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

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
