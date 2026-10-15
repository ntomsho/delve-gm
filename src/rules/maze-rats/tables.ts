/**
 * MAZE RATS TABLES
 * ================
 *
 * Maze Rats v4.3 by Ben Milton (CC BY 4.0): the random tables generation rolls
 * on, and the roller that resolves their cascades.
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

import { SPELLS } from "../knave/tables.ts";
import type { Rng, Rolled } from "../../shared/utils/rng.ts";

const t = (s: string): string[] => s.split("|");

// --- Maze Rats: THE MAZE -----------------------------------------------------

export const DUNGEON_FORMS = t(
  "Arena|Asylum|Aviary|Bank|Baths|Body|{Building Room}|Casino|Catacombs|Cave|Court|{Dungeon Room}|Forge|Garden|Hideout|Hotel|{L. Cl. Building}|Laboratory|Library|Market|Mine|Monastery|Museum|Nursery|Orphanage|Palace|Prison|Sewer|Ship|Slave pit|Temple|Theater|{U. Cl. Building}|University|Vault|Zoo"
);

export const DUNGEON_REWARDS = t(
  "Ancient lore|Animal ally|Army|Blessing|Blueprints|Cultural artifact|Enemy weakness|Faction ally|Forewarning|Guide|Holy relic|Influential ally|Instructions|Jewels|Key|Lost formula|Machine|Magic item|Magical ally|Map|Marital ally|Masterpiece|{Monster} ally|Oracle|Piles of loot|Planar portal|Prophecy|Renown|Spell|Transformation|Transport|{Treasure Item}|Uncovered plot|{Val. Material}|Vision|Weapon"
);

export const BUILDING_ROOMS = t(
  "Arboretum|Atrium|Attic|Aviary|Ballroom|Baths|Bed chamber|Cabinet|Chapel|Cloakroom|Dining room|Dressing room|{Dungeon Room}|Garden|Garret|Greenhouse|Junk room|Kitchen|Larder|Library|Map room|Menagerie|Mews|Nursery|Pantry|Parlor|Privy|Root cellar|Saucery|Scullery|Smoking room|Spicery|Still room|Study|Trophy room|Wardrobe"
);

export const DUNGEON_ROOMS = t(
  "Armory|Banquet hall|Barracks|{Building Room}|Catacombs|Cavern|Chasm|Courtyard|Crypt|Dormitory|Fighting pit|Forge|Fountain|Gate house|Guard room|Kennel|{L. Cl. Building}|Laboratory|Mess hall|Mine shaft|Museum|Oubliette|Pool|Prison|Record room|Shrine|Slaughterhouse|Stables|Storeroom|Throne room|Torture room|Treasury|{U. Cl. Building}|Vault|Well|Workshop"
);

export const LOWER_CLASS_BUILDINGS = t(
  "Apothecary|Asylum|Baker|Brewery|Butcher|Candlemaker|Catacombs|Cheesemaker|Criminal den|Curiosity shop|Dock|Fighting pit|Forge|Fortuneteller|Gambling hall|Leatherworks|Marketplace|Mason|Mill|Moneylender|Orphanage|Outfitter|Prison|Sewers|Shipyards|Shrine|Stockyard|Stonecarver|Tattooist|Tavern|Theater|Veterinarian|Warehouse|Watchtower|Weaver|Workshop"
);

export const UPPER_CLASS_BUILDINGS = t(
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
export const DUNGEON_CORRIDORS = t(
  "Antechamber|Atrium|Bridge|Burrow|Chute|Cloister|Concourse|Corridor|Gallery|Hallway|Hollow wall|Passageway|Ramp|Sewer|Shaft|Stairwell|Steps|Tunnel|Walkway|Waterway"
);

export const DUNGEON_ENTRANCES = t(
  "All libraries|Beaver dam|Behind waterfall|Chalk rectangle|Chest bottom|Chimney|Cupboard|Dolmen shadow|Down a well|Fiery pit|Fog road|Forest spring|Giant book|Gypsy wagon|Hollow tree|Huge keyhole|Iron maiden|Living tattoo|Magic painting|Man-shape hole|Maze potion|Mirror|Monster mouth|Monster wound|Narrow alley|Rain door|Sewer grate|Sudden rift|Tidal cave|Tower top|Tree roots|Under the bed|Unfolded map|Up a tree|Whirlpool|Wine barrel"
);

export const DUNGEON_ROOM_DETAILS = t(
  "Bas-relief|Blood trail|Bones|Chains|Chalk marks|Claw marks|Corpses|Cracked beams|Crumbling walls|Decaying food|Decaying nest|Dripping water|Fading murals|Faint breeze|Faint footsteps|Fallen pillars|Fungus|Furniture|Graffiti|Mosaics|Recent repairs|Rotting books|Rubble|Shed skin|Slime trails|Spider webs|Stalactites|Stench|Smoke stains|Thick dust|Torn clothes|Tree roots|Unusual smell|Vibrations|Vines|Whispers"
);

export const DUNGEON_TRICKS = t(
  "Absorption|Activation|Animation|Blessings|Communication|Confusion|Consumption|Creation|Curses|Deception|Duplication|{Ethereal Effect}|Exchange|Imprisonment|Instructions|Interrogation|Mind-control|{Mission}|Mood-alteration|Nullification|{Physical Effect}|Planeshift|Protection|Rejuvenation|Release|Reversal|Rotation|Scrying|Size-alteration|Summoning|Theft|Time-alteration|Transformation|Transmutation|Transportation|Wonder"
);

export const DUNGEON_HAZARDS = t(
  "Acid drip|Bloodsuckers|Cave-in|Choking dust|Crude oil|Crystal shards|Deafening noise|Dense fog|Ensnaring vines|Fallen floor|Flooding|Freezing|Geysers|Magma|Magnetic field|Mud flow|Narrow ledge|Narrow passage|Poison goo|Poison plants|Precipice|Quicksand|Radiation|Rockslide|Rotten ceiling|Rotten floor|Sinkhole|Slippery slope|Spider webs|Spores|Steam vents|Strong winds|Tar pit|Tight passage|Toppling object|Toxic fumes"
);

/**
 * Maze Rats prints these as separate Trap Effects / Trap Triggers tables. A good
 * trap should have a fairly obvious trigger -- the challenge is avoiding the
 * effect, avoiding the trigger, or finding a way to deactivate it.
 */
export const TRAP_EFFECTS = t(
  "Acid pool|Adhesive|Alarm|Armor melts|Bear trap|Blinding spray|Blunt pendulum|Boiling tar|Collapsing floor|Crocodile pit|Crushing walls|Deep pit|Falling cage|Falling ceiling|Fills with sand|Flooding|Giant magnet|Hard vacuum|Lava flow|Lightning|Living statues|Missile fire|{Monster} freed|Net trap|Pendulum blade|Poison gas|Poison needle|Quicksand|Rage gas|Rolling boulder|Room freezes|Room on fire|Sleeping gas|Spiked pit|Tombs open|Wall spikes"
);

export const TRAP_TRIGGERS = t(
  "Blow|Break|Burn|Choice|Countdown|Darkness|Drain|Eat|Insert|Kill|Knock|Light|Magic|Melody|Noise|Open|Phrase|Pour|Press|Proximity|Pull|Read|Reflect|Release|Remove|Retrieve|Rudeness|Shut|Sit|Sleep|Slide|Touch|Turn|Unbalance|Unearth|Write"
);

// --- Maze Rats: THE CITY (factions) -----------------------------------------

export const FACTIONS = t(
  "Art movement|Beggar's guild|Black market|Brotherhood|City guard|Conspiracy|Craft guild|Crime family|Crime ring|Dark cult|Explorer's club|Free company|Gourmand club|Heist crew|Heretical sect|High council|Hired killers|Local militia|National church|Noble house|Outlander clan|Outlaw gang|Political party|Religious order|Religious sect|Resistance|Royal army|Royal house|Scholar's circle|Secret society|Spy network|Street artists|Street gang|Street musicians|Theater troupe|Trade company"
);

export const FACTION_TRAITS = t(
  "Bankrupt|Bureaucratic|Charitable|Confused|Connected|Corrupt|Decadent|Decaying|Delusional|Divided|Dwindling|Efficient|Esoteric|Expanding|Hunted|Incompetent|Incorruptible|Insane|Insular|Manipulative|Martial|{Personality}|Pious|Popular|Righteous|Ruthless|Secret|Subversive|Suppressed|Threatened|Thriving|Unpopular|Up-and-coming|Wealthy|Well-prepared|Xenophobic"
);

export const FACTION_GOALS = t(
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

export const MONSTER_TRAITS = t(
  "Amphibious|Bloated|Brittle|Cannibal|Clay-like|Colossal|Crystalline|Decaying|{Ether. Element}|Ethereal|Ever-young|Eyeless|Fearless|Fluffy|Fungal|Gelatinous|Geometric|Hardened|Illusory|Intelligent|Iridescent|Luminous|Many-headed|Mechanical|{Phys. Element}|Planar|Reflective|Rubbery|Shadowy|Sharp|Skeletal|Slimy|Sticky|Stinking|Tiny|Translucent"
);

export const MONSTER_ABILITIES = t(
  "Absorbing|Acid blood|Anti-magic|Blinding|Breath weapon|Camouflaging|Duplicating|Electric|Entangling|{Ethereal Effect}|Exploding|Flying|Gaze weapon|Hypnotizing|Impervious|Invisible|Life-draining|Magnetic|Mimicking|Mind-Reading|Paralyzing|Phasing|{Physical Effect}|Poisonous|Radioactive|Reflective|Regenerating|Shapeshifting|Spell-casting|Stealthy|Strangling|Super-strength|Telekinetic|Teleporting|Vampiric|Wall-Crawling"
);

export const MONSTER_FEATURES = t(
  "Antlers|Beak|Carapace|Claws|Compound eyes|Eye Stalks|Fangs|Fins|Fur|Gills|Hooves|Horns|Legless|Long tongue|Many-eyed|Many-limbed|Mucus|Pincers|Illustrations|Plumage|Proboscis|Scales|Segments|Shaggy hair|Shell|Spikes|Spinnerets|Spines|Stinger|Suction cups|Tail|Talons|Tentacles|Trunk|Tusks|Wings"
);

export const MUTATIONS = t(
  "Ages|Attracts birds|Child-form|Corpulence|Covered in hair|{Animal} arms|{Animal} eyes|{Animal} head|{Animal} legs|{Animal} mouth|{Animal} skin|{Animal}-form|Cyclops|Extra arms|Extra eyes|Extra legs|Forked tongue|Gender swap|Hunchback|{Item}-form|Long arms|Lose all hair|Loses teeth|{Monster Feature}|{Monster Trait}|No eyes|No mouth|{Phys. Element}-skin|Second face|Sheds skin|Shrinks|Shrivels|Skin boils|Slime trail|Translucent skin|Weeps blood"
);

export const MONSTER_TACTICS = t(
  "Ambush|Call for support|Capture|Charge|Climb foes|Compel worship|Create barrier|Deceive|Demand duel|Disorient|Encircle|Evade|Gang up|Gather strength|Go berserk|Harry|Hurl foes|Immobilize|Manipulate|Mock|Monologue|Order minion|Protect leader|Protect self|Scatter foes|Stalk|Steal from|Swarm|Target insolent|Target leader|Target nearest|Target richest|Target strongest|Target weakest|Toy with|Use terrain"
);

export const MONSTER_WEAKNESS = t(
  "Bells|Birdsong|Children|Cold|Cold Iron|Competition|Conversation|Deformity|Flattery|Flowers|Gifts|Gold|Heat|Holy Icon|Holy Water|Home Cooking|{Insanities}|Mirrors|Mistletoe|Moonlight|Music|{Methods}|Phylactery|{Phys. Element}|Puzzles|Riddles|Rituals|Silver|Sunlight|Tears|True Name|{Val. Materials}|Weak Spot|{Weapon Items}|Wine|Wormwood"
);

export const MONSTER_PERSONALITY = t(
  "Alien|Aloof|Bored|Cautious|Cowardly|Curious|Devious|Distractable|Educated|Embittered|Envious|Erudite|Fanatical|Forgetful|Generous|Hateful|Honorable|Humble|Jaded|Jovial|Legalistic|Manipulative|Megalomaniac|Melancholy|Meticulous|Mystical|Obsessive|Out of Touch|Paranoid|Polite|Psychopathic|Sophisticated|Touchy|Unimpressed|Vain|Xenophobic"
);

// --- Maze Rats: CHARACTERS ---------------------------------------------------

export const CIVILIZED_NPCS = t(
  "Acolyte|Actor|Apothecary|Baker|Barber|Blacksmith|Brewer|Bureaucrat|Butcher|Carpenter|Clockmaker|Courier|Courtier|Diplomat|Fishmonger|Guard|Haberdasher|Innkeeper|Item-seller|Jeweler|Knight|Locksmith|Mason|Miller|Musician|Noble|Painter|Priest|Scholar|Scribe|Sculptor|Shipwright|Soldier|Tailor|Taxidermist|Wigmaker"
);

export const UNDERWORLD_NPCS = t(
  "Alchemist|Beggar-prince|Blackmailer|Bounty-hunter|Chimney sweep|Coin-clipper|Contortionist|Counterfeiter|Cultist|Cutpurse|Debt-collector|Deserter|Fence|Fortuneteller|Galley slave|Gambler|Gravedigger|Headsman|Hedge knight|Highwayman|Housebreaker|Kidnapper|Mad prophet|Mountebank|Peddler|Pit-fighter|Poisoner|Rat-catcher|Scrivener|Sellsword|Slave|Smuggler|Street performer|Tattooist|Urchin|Usurer"
);

// NOTE: PDF column OCR duplicates "Tinker"; harmless (slightly weights that result).
export const WILDERNESS_NPCS = t(
  "Apiarist|Bandit|Caravan Guard|Caravaneer|Druid|Exile|Explorer|Farmer|Fisherman|Forager|Fugitive|Hedge wizard|Hermit|Hunter|Messenger|Minstrel|Monk|Monster hunter|Outlander|Tinker|Pilgrim|Poacher|Raider|Ranger|Sage|Scavenger|Scout|Seer|Shepherd|Surveyor|Tinker|Tomb raider|Trader|Trapper|Witch|Woodcutter"
);

/** MR character-creation Background table is identical to the Underworld NPC list. */
export const BACKGROUNDS = UNDERWORLD_NPCS;

export const FEMALE_NAMES = t(
  "Adelaide|Alma|Barsaba|Beatrix|Bianca|Cleopha|Clover|Constance|Damaris|Daphne|Demona|Elsbeth|Esme|Fern|Hester|Hippolyta|Jessamine|Jilly|Morgot|Minerva|Nerissa|Odette|Olga|Orchid|Pepper|Phoebe|Piety|Poppy|Silence|Sybil|Trillby|Tuesday|Ursula|Vivian|Wendy|Zora"
);

export const MALE_NAMES = t(
  "Balthazar|Basil|Bertram|Blaxton|Chadwick|Clovis|Destrian|Ellis|Erasmus|Faustus|Finn|Fitzhugh|Florian|Fox|Godwin|Hannibal|Jasper|Jiles|Jules|Leopold|Merrick|Mortimer|Ogden|Orion|Oswald|Percival|Peregrine|Quentin|Redmaine|Reinhold|Silas|Stilton|Stratford|Tenpiece|Waverly|Webster"
);

export const UPPER_SURNAMES = t(
  "Belvedere|Bithesea|Calaver|Carvolo|De Rippe|Droll|Dunlow|Edevane|Erelong|Febland|Fernsby|Fisk|Gastrell|Girdwood|Gorgon|Grimeson|Gruger|Hitheryon|La Marque|Malmora|Miter|Oblington|Onymous|Phillifent|Portendorfer|Romatet|Rothery|Skorbeck|Slora|Southwark|Stavish|Vandermeer|Wellbelove|Westergren|Wexley|Wilberforce"
);

export const LOWER_SURNAMES = t(
  "Barrow|Beetleman|Berrycloth|Birdwhistle|Bobich|Chips|Coffin|Crumpling|Culpepper|Dankworth|Digworthy|Dreggs|Gimble|Graveworm|Greelish|Hardwick|Hatman|Hovel|Knibbs|Midnighter|Needle|Nethercoat|Pestle|Relish|Rumbold|Rummage|Sallow|Saltmarsh|Silverless|Skitter|Slee|Slitherly|Stoker|Tarwater|Tumbler|Villin"
);

// NOTE: transcribed 35 of 36 (one column entry illegible in source layout).
export const ASSETS = t(
  "Authority|Avoids detection|Calls in favors|Charming|Cooks the books|Erases evidence|Excellent liar|Extremely rich|Faction-leader|Faction-member|Fortified base|Interrogator|Gorgeous|Hears rumors|Huge family|Huge library|Impersonator|Knows a guy|Knows a way in|Launders money|Learned|Local celebrity|Local knowledge|Loyal henchmen|Middling oracle|Nothing to lose|Owns the guards|Powerful spouse|Procures gear|Pulls the strings|Secret lab|Sells contraband|Smuggles goods|Spy network|War hero"
);

export const LIABILITIES = t(
  "Addiction|Alcoholic|Corrupt ally|Coward|Decadent|Forbidden love|Gambler|Glutton|Greedy|Heretic|Huge debts|Imposter|{Insanity}|Jealous|Leaves evidence|Many enemies|Misinformed|Money trail|Narcissist|Needs medicine|OCD|Paranoid|Partyer|Poor equipment|Protective|Scandalous|Softhearted|Strict routines|Superstitious|Suspicious|Temper|Trusting|Vulnerable base|Wanted|Weak-willed|Widely despised"
);

// NOTE: transcribed 35 of 36 (one column entry illegible in source layout).
export const METHODS = t(
  "Alchemy|Blackmail|Bluster|Bribery|Bullying|Bureaucracy|Charm|Commerce|Cronies|Debate|Deduction|Eloquence|Espionage|Fast-talking|Favors|Hard Work|Humor|Investigation|Legal maneuvers|Manipulation|Misdirection|Money|Nagging|Negotiation|Persistence|Piety|Preparation|Quick Wit|Research|Rumors|Sabotage|Teamwork|Theft|Threats|Violence"
);

export const APPEARANCES = t(
  "Aquiline|Athletic|Barrel-chested|Boney|Brawny|Brutish|Bullnecked|Chiseled|Coltish|Corpulent|Craggy|Delicate|Furrowed|Gaunt|Gorgeous|Grizzled|Haggard|Handsome|Hideous|Lanky|Pudgy|Ripped|Rosy|Scrawny|Sinewy|Slender|Slumped|Solid|Square-jawed|Statuesque|Towering|Trim|Weathered|Willowy|Wiry|Wrinkled"
);

export const PERSONALITIES = t(
  "Bitter|Brave|Cautious|Chipper|Contrary|Cowardly|Cunning|Driven|Entitled|Gregarious|Grumpy|Heartless|Honor-bound|Hotheaded|Inquisitive|Irascible|Jolly|Know-it-all|Lazy|Loyal|Menacing|Mopey|Nervous|Protective|Righteous|Rude|Sarcastic|Savage|Scheming|Serene|Spacey|Stoic|Stubborn|Stuck-up|Suspicious|Wisecracking"
);

export const NPC_GOALS = t(
  "A better life|Acceptance|Acquire {item}|Craft {item}|Destroy {faction}|Destroy {item}|Enlightenment|Fame|Found {faction}|Freedom|Glory|Impress {NPC}|Infamy|Infiltrate {faction}|Justice|Kidnap {NPC}|Lead {faction}|Learning|Locate {NPC}|Love|Mastery|Power|Reach location|Rescue {NPC}|Resolve dispute|Restore {faction}|Reveal a secret|Revenge|Sabotage {faction}|Serve a deity|Serve evil|Serve {faction}|Serve ideology|Serve leader|Serve the needy|Wealth"
);

export const PHYSICAL_DETAILS = t(
  "Acid scars|Battle scars|Birthmark|Braided hair|Brand mark|Broken nose|Bronze skinned|Burn scars|Bushy eyebrows|Curly hair|Dark skinned|Dreadlocks|Exotic accent|Flogging scars|Freckles|Gold tooth|Hoarse voice|Huge beard|Long hair|Matted hair|Missing ear|Missing teeth|Mustache|Muttonchops|Nine fingers|Oiled hair|One-eyed|Pale skinned|Piercings|Ritual scars|Sallow skin|Shaved head|Sunburned|Tangled hair|Tattoos|Topknot"
);

export const CLOTHING = t(
  "Antique|Battle-torn|Bedraggled|Blood-stained|Ceremonial|Dated|Decaying|Eccentric|Elegant|Embroidered|Exotic|Fashionable|Flamboyant|Food-stained|Formal|Frayed|Frumpy|Garish|Grimy|Haute couture|Lacey|Livery|Mud-stained|Ostentatious|Oversized|Patched|Patterned|Perfumed|Practical|Rumpled|Sigils|Singed|Tasteless|Undersized|Wine-stained|Worn out"
);

export const MANNERISMS = t(
  "Anecdotes|Breathy|Chuckles|Clipped|Cryptic|Deep voice|Drawl|Enunciates|Flowery speech|Gravelly voice|Highly formal|Hypnotic|Interrupts|Laconic|Laughs|Long pauses|Melodious|Monotone|Mumbles|Narrates|Overly casual|Quaint sayings|Rambles|Random facts|Rapid-fire|Rhyming|Robotic|Slow speech|Speechifies|Squeaky|Street slang|Stutters|Talks to self|Trails off|Very loud|Whispers"
);

export const SECRETS = t(
  "Addicted|Artificial|Assassin|Bankrupt|Beholden|Counterspy|Cultist|Demigod|Evil lineage|Exile|Fence|Fugitive|Ghost|Has a child|Heretic|High born|Huge fortune|Illusion|Insurrectionist|Low born|Married|Mind-controlled|{Misfortune}|Monster hunter|Non-human|{NPC}|Polygamist|Protects relic|Scandalous birth|Secret police|Serial killer|Smuggler|Spy|Time traveler|Transformed|War criminal"
);

export const REPUTATIONS = t(
  "Ambitious|Authoritative|Boor|Borrower|Celebrity|Charitable|Cheat|Dangerous|Entertainer|Gossip|Hardworking|Holy|Honest|Hypochondriac|Idiot|Influential|Layabout|Leader|Misanthrope|Miser|Neighborly|Nutjob|Obnoxious|Overeducated|Partier|Pious|Proper|Prophet of doom|Repulsive|Respected|Riffraff|Scandalous|Slime ball|Terrifying|Weirdo|Wise"
);

export const HOBBIES = t(
  "Archaeology|Art collecting|Bad fiction|Calligraphy|Card games|Clockwork|Collecting cats|Cuisine|Dark lore|Dog breeding|Embroidery|Exercise|Falconry|Fashion|Fishing|Foreign cultures|Gardening|History|Horseracing|Hunting|Instrument|Knitting|Lawn games|Mountaineering|Opera|Painting|Poetry|Puzzle-solving|Riddling|Science|Sculpture|Sketching|Smoking|Theater|Weaving|Whiskey"
);

export const MISFORTUNES = t(
  "Abandoned|Addicted|Arrested|Blackmailed|Burgled|Challenged|Condemned|Crippled|Cursed|Defrauded|Demoted|Depressed|Discredited|Dismissed|Disowned|Exiled|Famished|Forgotten|Framed|Haunted|Humiliated|Impoverished|Kidnapped|Lost|Mobbed|Mutilated|Overworked|Poisoned|Pursued|Rejected|Replaced|Robbed|Sick|Sued|Suspected|Transformed"
);

export const RELATIONSHIPS = t(
  "Adviser|Blackmailer|Business partner|Business rival|Buyer|Captor|Client|Confidant|Debtor|Disciple|Guardian|Henchman|Idol|Informant|Master|Mentor|Nemesis|Offspring|Parent|Patron|Political rival|Prisoner|Protege|Quarry|Right hand|Romantic rival|Servant|Sibling|Social rival|Spouse|Stalker|Suitor|Supplicant|Supplier|Sweetheart|Unrequited love"
);

export const MISSIONS = t(
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

export const VALUABLE_MATERIALS = t(
  "Alabaster|Amber|Aquamarine|Azurite|Beryl|Black Pearl|Bloodstone|Bone China|Chalcedony|Cinnabar|Coral|Diamond|Ebony|Emerald|Fire Agate|Garnet|Gold|Ivory|Jade|Jasper|Jet|Lapis Lazuli|Malachite|Moonstone|Onyx|Opal|Pearl|Platinum|Porcelain|Ruby|Sapphire|Serpentine|Silver|Star Iron|Topaz|Turquoise"
);

export const WEAPON_ITEMS = t(
  "Arming sword|Backsword|Battleaxe|Blowpipe|Claymore|Club|Crossbow|Cutlass|Dagger|Flail|Flanged mace|Glaive|Halberd|Hammer|Hatchet|Horsebow|Hunting knife|Lance|Longbow|Longsword|Mace|Maul|Morningstar|Pike|Scimitar|Shortbow|Sickle|Sling|Spear|Staff|Stake|Stiletto|Throwing axe|Warhammer|Warpick|Whip"
);

export const TREASURE_ITEMS = t(
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
export const MISC_ITEMS = t(
  "Bowl|Brass bell|Brooch|Carved figurine|Cup|Deck of cards|Drawing|Foreign coin|Game piece|Glass eye|Glass jar|Hair comb|Handkerchief|Hinged box|Hourglass|Human tooth|Hunting horn|Loaded dice|Long fork|Numbered key|Oil lamp|Old doll|Pain pot|Pencil|Purse|Quill pen|Salve|Scissors|Scroll|Sealed letter|Sewing needle|Shaving razor|Silver button|Skull|Tobacco pipe|Wine bottle"
);

export const WORN_ITEMS = t(
  "Belt|Blouse|Boots|Bracelet|Breastplate|Brigandine|Cincture|Cloak|Coat|Dress|Earring|Eyepatch|Gambeson|Gauntlets|Glove|Gown|Hat|Helmet|Hose|Leathers|Locket|Mail shirt|Mask|Necklace|Illustration mail|Ring|Robe|Sandals|Scarf|Shirt|Shoes|Skirt|Slippers|Socks|Trousers|Veil"
);

export const TOOL_ITEMS = t(
  "Acid flask|Bear trap|Bellows|Bolt-cutters|Chain|Chisel|Crowbar|Door ram|Ear trumpet|Fire oil|Fishing hook|Goggles|Grappling hook|Grease|Hacksaw|Hammer|Hand drill|Lantern|Lens|Lock/key|Lockpicks|Manacles|Metal file|Mortar/pestle|Needle|Pickaxe|Pitchfork|Pliers|Pole|Pulleys|Rope|Scissors|Shovel|Spikes|Steel wire|Tongs"
);

export const TREASURE_TRAITS = t(
  "Altered|Ancient|Blessed|Bulky|Compact|Consumable|Cultural value|Cursed|Damaged|Disguised|Draws enemies|{Effect}|{Element}|Embellished|Encoded|Exotic|Extra-planar|Famous|Forbidden|Fragile|Heavy|Immovable|Impracticable|Indestructible|Intelligent|Masterwork|Military value|Non-human|Owned|Partial|Political value|Religious value|Repaired|Royal|Toxic|Vile"
);

export const MAGICAL_INGREDIENTS = t(
  "Ancient liquor|{Animal}|Blind eye|Boiled cat|{Book} book page|Bottled fog|Coffin nail|Corpse's hair|Crossroad dust|Cultist entrails|{Edible Plant}|Exotic spice|Killer's hand|King's tooth|Last breath|Liar's tongue|Lightning bolt|Lodestone|Monk's vow|{Monster Feature}|Newborn's cry|Oil portrait|{Potion}|{Phys. Element}|{Poisonous Plant}|Pyre ember|Queen bee|Queen's blood|Ship's barnacle|Star-metal|Thief's finger|Tomb flower|{Valuable Material}|Wedding ring|Widow's tears|Wizard skull"
);

// NOTE: `{Spell}` sits out of the alphabetical run the rest of the list keeps,
// preserved as printed — same treatment as the duplicate "Wood" in Physical
// Elements and "Tinker" further up.
export const POTIONS = t(
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

export function rollAnimal(rng: Rng): string {
  const d = rng.d(6);
  const tbl = d <= 2 ? AERIAL_ANIMALS : d <= 4 ? TERRESTRIAL_ANIMALS : AQUATIC_ANIMALS;
  return rng.pick(tbl);
}

export function resolveCascades(entry: string, rng: Rng, depth = 0): string {
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

export function roll(table: readonly string[], rng: Rng): Rolled {
  return resolveCascades(rng.pick(table), rng);
}

// --- public rollers for the MAZE hazard/detail tables ------------------------

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
export function rollDistinct(table: readonly string[], n: number, rng: Rng): Rolled[] {
  return rng.pickN(table, n).map((raw) => resolveCascades(raw, rng));
}
