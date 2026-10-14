/**
 * ROOM ILLUSTRATION SPIKE — THE SUBJECTS
 * ===============================
 *
 * What the first image test draws: 3 exteriors and 12 interiors chosen to
 * cover the layouts the camera has to handle and the range of looks a dungeon
 * can have (walls, condition, wet or dry, living or dead).
 *
 * Each interior is REAL GEOMETRY WITH WRITTEN FICTION. The floor, doors and
 * footprints are a room an offline dungeon actually drew, found by the
 * `pick` test; the words are written here, at the length and in the voice the
 * content pass writes in, so the condensing call is tested on what it will
 * really be given. A footprint is relabelled only where its shape suits — a
 * row of wall-hugging shelves can become bunks or cells, never a pool.
 *
 * The spike is testing image models, not the content pass, so this is fair:
 * everything the camera, the guide and the buttons do runs on real data.
 */

import type { FixtureKind } from "../../generation/floorplan/fixtures.ts";

/** What a candidate room is, for `pick`. */
export interface Candidate {
  cells: number;
  w: number;
  h: number;
  corridor: boolean;
  /** fixture kinds of the room's placed features */
  fixtures: FixtureKind[];
  /** placed features of any kind */
  placed: number;
  /** a feature in two or more separate pieces */
  multiPiece: boolean;
  /** floor cells over bounding-box cells, 1 for a rectangle */
  fill: number;
  /** the way out of the dungeon opens from this room */
  surfaceExit: boolean;
  /** with the chosen camera: the way out is in the picture */
  surfaceShown: boolean;
  /** with the chosen camera: hotspots routed round a corner */
  around: number;
  /** with the chosen camera: placed features in the picture */
  featuresShown: number;
}

export interface FeatureSpec {
  name: string;
  /** full-length fiction, as the content pass would write it */
  base: string;
  /**
   * The footprint it takes from the bound room: a fixture kind; "one-piece",
   * any footprint that is a single connected piece (an altar is in one place);
   * or "any" footprint at all. Absent for something with no footprint (`spread`).
   */
  fits?: FixtureKind | "one-piece" | "any";
  /**
   * No footprint: a treatment of the whole room, or a sound or smell. The
   * `rolled` entry is what makes it one or the other (`featurePresence`).
   */
  spread?: boolean;
  /** the table entry it was "rolled" from, which decides its presence */
  rolled?: Record<string, string>;
}

export interface Prose {
  name: string;
  base: string;
}

export interface InteriorSubject {
  id: string;
  title: string;
  /** what about the layout this subject tests */
  tests: string;
  vibe: { walls: "cave" | "rough-hewn" | "dressed stone"; condition: string; moisture: string; life: string };
  theme: keyof typeof THEMES;
  room: Prose;
  /** relabel the room's doors, in order; reused round if the room has more */
  exits: Prose[];
  /** the way out of the dungeon, when the room has it */
  wayOut?: Prose;
  features: FeatureSpec[];
  pick: (c: Candidate) => boolean;
}

export interface ExteriorSubject {
  id: string;
  title: string;
  /**
   * The place and its way in, as the opening prose and the surface exit would
   * describe them. The only input an exterior gets: a dungeon's THEME is about
   * its inside, and fed to an outside view it brings ceilings with it.
   */
  description: string;
}

// ---------------------------------------------------------------------------
// THEMES — one per fictional dungeon, as the dungeon pass's THEME would read
// ---------------------------------------------------------------------------

export const THEMES = {
  hollowDelve:
    "A natural cave system bored through red sandstone by water that dried up long before anyone came here. " +
    "The passages are smooth-walled and ribbed where the old flow scoured them, the floors heaped with fallen " +
    "slabs and drifts of fine grit. Nothing grows. The air is dry enough to crack the lips, and the only light " +
    "is what leaks in from the surface or what you bring.",
  saltweptCrypts:
    "A crypt complex cut by masons who meant it to last: walls of fitted grey limestone blocks, floors of " +
    "polished flags, vaulted ceilings ribbed with carved stone. It has been sealed and kept, and it shows — no " +
    "rubble, no rot, only a fine white bloom of salt where the stone sweats. Lamps in niches still hold oil. " +
    "The air is cold, still and very dry.",
  seepingUndercroft:
    "The undercroft beneath a forgotten town, hacked out of black shale with picks and never finished. The " +
    "walls are rough and gouged, the ceilings low and uneven, and water seeps from every seam to run in the " +
    "channels of the floor. Everything is slick and dark. Nobody has worked down here in a lifetime, and the " +
    "timbers that once shored it up have rotted to stumps.",
  mossboundCaverns:
    "A drowned cave country under the fens: limestone carved into domes and galleries by still-running water, " +
    "every surface furred with moss and pale fungus, roots of the trees above hanging through cracks in the " +
    "ceiling like ropes. Pools stand everywhere. A faint green phosphorescence comes off the fungus, enough to " +
    "see by once the eyes adjust.",
  ironwrightHold:
    "A working hold dug into the mountain by a company of smiths and soldiers who are still here. The halls " +
    "near the gate are dressed stone, square-cut and whitewashed; deeper in, the workings give way to raw " +
    "cave the company never bothered to finish. Braziers burn in brackets, the floors are swept, and everything " +
    "is in use — racks full, bunks made, fires banked.",
  sunkenAbbey:
    "An abbey of fine dressed stone that sank into the marsh and filled with water. The architecture is still " +
    "handsome — pointed arches, ribbed vaults, carved capitals — but the vaults are cracked, half the floors " +
    "are under black water, and silt lies in drifts against the walls. Pale daylight comes down through broken " +
    "lancets and lies on the water in sheets.",
  rootboundTemple:
    "A temple cut into a hillside by people who worshipped the hill itself. The walls are rough-hewn and " +
    "carved with spirals, but the hill has taken it back: roots have split the ceilings and hang in curtains, " +
    "vines climb every pillar, and soil has drifted in over the floors. It is damp, green, and loud with " +
    "dripping.",
  brokenKeep:
    "The cellars of a keep that was slighted in a war and left: rough-hewn sandstone vaults, half of them " +
    "fallen in, the rest propped by the rubble of the ones that fell. It is dry and dusty and utterly still. " +
    "Shafts of grey light come down through the ruin above wherever the floor of the keep gave way.",
} as const;

// ---------------------------------------------------------------------------
// EXTERIORS
// ---------------------------------------------------------------------------

export const EXTERIORS: ExteriorSubject[] = [
  {
    id: "E1",
    title: "Haunted castle at night",
    description:
      "Night. A castle of grey granite crowns a steep, bare hill, black against an enormous full moon that " +
      "fills half the sky behind it. The keep is tall and square, with a single slender tower beside it, and " +
      "not one window is lit. The curtain wall is broken in places, its battlements gapped like bad teeth. A " +
      "road climbs the hill in switchbacks past dead, leafless trees and a gibbet with a cage swinging empty " +
      "from it. Bats wheel around the tower. Mist lies in the hollows of the hillside. The way in is the " +
      "gatehouse: two drum towers and a dark arch, its portcullis rusted half open, the road running straight " +
      "into the shadow of it.",
  },
  {
    id: "E2",
    title: "Crumbling flooded monastery",
    // Round 1's version named a church, a bell tower and a cloister, and was
    // drawn as two or three buildings. This is one building and nothing else.
    description:
      "A single great abbey church stands alone in the middle of a marsh, with no other building anywhere " +
      "in sight. It has sunk and tilted, settling to the sills of its tall pointed windows in still water, and " +
      "its one bell tower rises from the west end at a lean, reeds growing from its empty belfry. Half its roof " +
      "has fallen in, and the ribs of the vault show through like bones. A causeway of broken flagstones runs " +
      "out across the water from the reeds to the great west door, which stands open with one leaf hanging " +
      "from a single hinge. Mist lies low on the water. The way in is that open door at the end of the causeway.",
  },
  {
    id: "E3",
    title: "Overgrown hillside cave",
    description:
      "Deep in wild country, a steep hillside rises out of the forest, so overgrown it is hard to see the " +
      "rock beneath. Ferns, brambles and great hanging curtains of ivy and creeper cover everything; old " +
      "trees grow out of the slope at crooked angles, their roots gripping boulders the size of houses. " +
      "Halfway up, between two of those boulders, is the cave: a tall ragged mouth in the rock, half hidden " +
      "behind a fall of vines, with a trickle of water running out of it over mossy stones. A faint path, " +
      "almost lost in the undergrowth, climbs through the ferns to it. The way in is that dark mouth behind " +
      "the hanging vines.",
  },
];

// ---------------------------------------------------------------------------
// INTERIORS
// ---------------------------------------------------------------------------

const surface = (name: string, base: string, entry: string): FeatureSpec => ({
  name,
  base,
  spread: true,
  rolled: { "Room Detail": entry },
});

export const INTERIORS: InteriorSubject[] = [
  {
    id: "I1",
    title: "Cave mouth",
    tests: "the entrance room, with daylight from the way out in the picture",
    vibe: { walls: "cave", condition: "abandoned", moisture: "dry", life: "lifeless" },
    theme: "hollowDelve",
    room: {
      name: "The Sand Throat",
      base:
        "The first chamber inside the cave is a wide, low throat of red sandstone, its walls smoothed into long " +
        "ribs by water that has not run here in an age. Grit has drifted in from outside and lies in rippled " +
        "dunes across the floor, deepest near the mouth. Daylight comes in sideways and turns the stone the " +
        "colour of rust before it fails a little way in. The ceiling is close enough to touch in places, and " +
        "there are old soot marks on it where travellers once sheltered and lit fires. It smells of dust and " +
        "nothing else. Deeper in, the throat narrows and the dark begins.",
    },
    wayOut: {
      name: "The cave mouth",
      base: "A ragged opening in the sandstone, wider than it is tall, full of white daylight and the hiss of wind over sand.",
    },
    exits: [
      { name: "The narrowing passage", base: "The throat pinches down into a ribbed passage a little taller than a man, its walls scoured smooth and dark." },
      { name: "A low crawl", base: "A low gap under a shelf of rock, half choked with sand, where the cave goes on at a crouch." },
    ],
    features: [
      {
        name: "Fallen slabs",
        base: "A heap of sandstone slabs that have peeled away from the ceiling and shattered on the floor, their broken faces still sharp and pale against the weathered rock.",
        fits: "rubble",
      },
      {
        name: "The cold hearth",
        base: "A ring of blackened stones with a scatter of old charcoal in it, where someone once made camp out of the wind. The ash has long since blown away.",
        fits: "one-piece",
      },
    ],
    pick: (c) => c.surfaceExit && c.surfaceShown && !c.corridor && c.cells >= 12 && c.fixtures.includes("rubble") && c.placed >= 2,
  },
  {
    id: "I2",
    title: "Shrine cell",
    tests: "a 10-ft room, where the camera cannot get back far",
    vibe: { walls: "dressed stone", condition: "pristine", moisture: "dry", life: "lifeless" },
    theme: "saltweptCrypts",
    room: {
      name: "The Lamplit Cell",
      base:
        "A small square cell of fitted limestone, barely large enough for three people to stand in, its walls " +
        "so finely jointed that a knife blade would not go between the blocks. The ceiling is a shallow vault. " +
        "A lamp burns in a niche above the door, steady in the still air, and its light shows a white bloom of " +
        "salt along the base of every wall. The floor flags are polished smooth by generations of knees. " +
        "Someone still tends this place: there is no dust, and the oil in the lamp is fresh.",
    },
    exits: [{ name: "The cell door", base: "A narrow doorway with a carved lintel, framing the dark of the corridor beyond." }],
    features: [
      {
        name: "The altar stone",
        base: "A block of pale limestone, waist high, its top worn into a shallow dish by the cups that have been set on it, its sides carved with a band of interlocking rings.",
        fits: "one-piece",
      },
      {
        name: "Offering bowls",
        base: "A row of small bronze bowls set along a ledge, each holding a little lamp oil or a few dry flower heads, polished bright by careful hands.",
        fits: "any",
      },
    ],
    pick: (c) => !c.corridor && c.cells <= 9 && c.placed >= 1,
  },
  {
    id: "I3",
    title: "Seeping corridor",
    tests: "a tight two-wide corridor: deep one-point perspective",
    vibe: { walls: "rough-hewn", condition: "abandoned", moisture: "wet", life: "lifeless" },
    theme: "seepingUndercroft",
    room: {
      name: "The Weeping Cut",
      base:
        "A long, narrow cut through black shale, only wide enough for two to walk abreast, its walls left " +
        "rough and gouged by the picks that made it. Water seeps from every seam and runs down the walls in " +
        "glistening sheets, gathering in a channel worn into the middle of the floor. The ceiling sags low " +
        "and is held up at intervals by the rotted stumps of timber props, black and soft. The cut runs on " +
        "into darkness far longer than any light will reach, and the drip of water echoes the length of it.",
    },
    exits: [
      { name: "The far end of the cut", base: "The cut ends in a squared-off opening, its edges crumbling, beyond which the dark opens out." },
      { name: "A side opening", base: "A ragged hole in the wall of the cut, roughly man-sized, where someone broke through into another working." },
    ],
    features: [
      surface("Slime trails", "Streaks of grey-green slime run down the walls and along the floor channel, shining wet, as if something has dragged itself along here many times.", "Slime trails"),
    ],
    pick: (c) => c.corridor && Math.min(c.w, c.h) <= 2 && Math.max(c.w, c.h) >= 7,
  },
  {
    id: "I4",
    title: "Fungal grotto",
    tests: "a large open chamber with many features at scale",
    vibe: { walls: "cave", condition: "untouched", moisture: "wet", life: "overgrown" },
    theme: "mossboundCaverns",
    room: {
      name: "The Green Dome",
      base:
        "A great domed cavern of pale limestone, its ceiling lost in shadow high overhead, its floor a broken " +
        "landscape of humps and hollows that hold standing water. Everything is overgrown: moss lies thick as " +
        "fleece on every surface, shelf fungi stand out from the walls in tiers, and from cracks in the dome " +
        "hang the roots of the trees above, long and pale as ropes. A faint green light comes off the fungus, " +
        "enough to see the shape of the place. The air is warm and wet and smells of rot and earth.",
    },
    exits: [
      { name: "A mossy gallery", base: "A wide arch of limestone opening onto a gallery, its floor carpeted in moss." },
      { name: "The root curtain", base: "An opening hidden behind a hanging curtain of pale roots, which part like a bead screen." },
    ],
    features: [
      {
        name: "The still pool",
        base: "A broad pool of perfectly still black water in a hollow of the floor, its edges rimmed with moss and its surface skinned with floating spores.",
        fits: "pool",
      },
      {
        name: "Dripstone columns",
        base: "Thick columns where stalactite and stalagmite have met and fused over ages, ringed with bands of shelf fungus and furred with moss.",
        fits: "pillars",
      },
      surface("Fungus", "Pale fungus grows everywhere in this cavern — shelves, caps, frills and fans — glowing faintly green in the dark.", "Fungus"),
    ],
    pick: (c) => !c.corridor && c.cells >= 30 && c.fixtures.includes("pool") && c.fixtures.includes("pillars") && c.featuresShown >= 2,
  },
  {
    id: "I5",
    title: "Fallen cellar",
    tests: "an L-shaped room with an exit round a corner",
    vibe: { walls: "rough-hewn", condition: "ruined", moisture: "dry", life: "lifeless" },
    theme: "brokenKeep",
    room: {
      name: "The Broken Vault",
      base:
        "A cellar vault of rough-hewn sandstone, bent around a corner, its barrel ceiling cracked from end to " +
        "end. Part of it has come down: a slope of broken stone and splintered beams fills one side, and a " +
        "shaft of grey daylight falls through the hole above onto the heap. Dust lies thick on everything and " +
        "hangs in the light. Iron hooks still stud the walls where hams and sacks once hung. Nothing has moved " +
        "here in years; the only marks in the dust are the ones you make.",
    },
    exits: [
      { name: "A cellar door", base: "A squat doorway of rough stone with a broken wooden door hanging from one hinge." },
      { name: "The stair down", base: "A narrow opening onto a worn stone stair going down into the dark." },
    ],
    features: [
      {
        name: "The fallen ceiling",
        base: "A slope of broken sandstone blocks and splintered oak beams where the vault came down, the top of it lit by grey daylight through the hole above.",
        fits: "rubble",
      },
      {
        name: "Split barrels",
        base: "A tumble of old barrels, their staves sprung and their hoops rusted through, spilling a dry brown dust that was once grain.",
        fits: "one-piece",
      },
    ],
    pick: (c) => !c.corridor && c.around >= 1 && c.fill < 0.85 && c.fixtures.includes("rubble") && c.placed >= 2,
  },
  {
    id: "I6",
    title: "Crypt of niches",
    tests: "an irregular room with one feature in several separate places",
    vibe: { walls: "dressed stone", condition: "pristine", moisture: "dry", life: "lifeless" },
    theme: "saltweptCrypts",
    room: {
      name: "The Hall of Rest",
      base:
        "An irregular crypt hall of fitted limestone, its walls stepping in and out to make bays, its ceiling " +
        "a ribbed vault carved where the ribs meet into bosses shaped like closed eyes. The floor is a pavement " +
        "of grey flags laid in a herringbone. Everything is clean and whole and very cold; a bloom of salt " +
        "frosts the joints of the stone. Lamps in small wall niches give a low gold light that does not " +
        "flicker. The silence is complete.",
    },
    exits: [
      { name: "The processional arch", base: "A tall pointed arch with carved jambs, opening onto a corridor of the same fitted stone." },
      { name: "A narrow door", base: "A plain narrow doorway, its lintel carved with a single closed eye." },
    ],
    features: [
      {
        name: "Burial niches",
        base: "Long, shallow niches cut into the walls at waist height, each holding a body wrapped in linen gone yellow with age, its face covered by a small stone mask.",
        fits: "sarcophagi",
      },
    ],
    pick: (c) => !c.corridor && c.fill < 0.8 && c.fixtures.includes("sarcophagi") && c.multiPiece,
  },
  {
    id: "I7",
    title: "Barracks",
    tests: "an occupied room, lived in but with nobody in the picture",
    vibe: { walls: "dressed stone", condition: "occupied", moisture: "dry", life: "lived-in" },
    theme: "ironwrightHold",
    room: {
      name: "The Long Barrack",
      base:
        "A long barrack room of square-cut stone, whitewashed and kept clean, its floor swept and strewn with " +
        "fresh rushes. Everything is in use. Cloaks hang on pegs, boots stand in pairs, a half-finished game of " +
        "stones lies on an upturned crate, and a pot of something sits warming at the hearth. Light comes from " +
        "the fire and from a brazier in an iron bracket by the door. It smells of woodsmoke, wet wool and stew. " +
        "Whoever lives here has only just stepped out.",
    },
    exits: [
      { name: "The barrack door", base: "A heavy door of banded oak, standing open, with a lantern hung on a hook beside it." },
      { name: "An inner door", base: "A plain doorway with a curtain of sacking drawn across it." },
      { name: "The armoury arch", base: "A low round arch with an iron gate folded back against the wall, leading toward the armoury." },
    ],
    features: [
      {
        name: "Bunks",
        base: "Double-decked bunks of rough timber against the wall, each made up with a straw mattress, a grey blanket folded square, and a soldier's kit bag at its foot.",
        // A wall-hugging row. The offline pool never pairs shelves with a hearth; burial niches are the same shape.
        fits: "sarcophagi",
      },
      {
        name: "The hearth",
        base: "A wide stone hearth with a fire burning low in it, a blackened pot hanging from an iron crane over the coals, and a row of mugs on the mantel.",
        fits: "hearth",
      },
      {
        name: "Weapon racks",
        base: "Wooden racks holding spears upright in a row, with shields hung above them, every blade oiled and every strap mended.",
        fits: "one-piece",
      },
    ],
    pick: (c) => !c.corridor && c.fixtures.includes("hearth") && c.fixtures.includes("sarcophagi") && c.placed >= 3 && c.cells >= 15,
  },
  {
    id: "I8",
    title: "Flooded nave",
    tests: "a flooded hall: flat features, things standing in water",
    vibe: { walls: "dressed stone", condition: "ruined", moisture: "flooded", life: "lifeless" },
    theme: "sunkenAbbey",
    room: {
      name: "The Drowned Nave",
      base:
        "The nave of the sunken abbey, a tall hall of fine dressed stone under a ribbed vault, most of its " +
        "floor lost under still black water. Pale daylight falls through broken lancet windows high in the " +
        "walls and lies on the water in long sheets. The vault is cracked, and pieces of carved rib have " +
        "fallen and lie half sunk. Silt has drifted against the walls in grey banks. The water is perfectly " +
        "still and holds an exact reflection of the arches above it.",
    },
    exits: [
      { name: "The west door", base: "A great pointed doorway of carved stone, its door gone, standing open onto grey light." },
      { name: "The chapter arch", base: "A rounded arch at the side of the nave, its threshold under water." },
    ],
    features: [
      {
        name: "The black water",
        base: "Still, black floodwater covering the floor of the nave, deep enough to hide the flagstones, its surface unbroken and mirror-smooth.",
        fits: "pool",
      },
      {
        name: "Clustered piers",
        base: "Tall piers of clustered stone shafts rising from the water to the vault, their carved capitals of leaves still crisp, their feet lost in the flood.",
        fits: "pillars",
      },
    ],
    pick: (c) => !c.corridor && c.cells >= 20 && c.fixtures.includes("pool") && c.fixtures.includes("pillars"),
  },
  {
    id: "I9",
    title: "Overgrown temple",
    tests: "surfaces spread through the room, with objects among them",
    vibe: { walls: "rough-hewn", condition: "ruined", moisture: "damp", life: "overgrown" },
    theme: "rootboundTemple",
    room: {
      name: "The Hall of the Hill",
      base:
        "The temple's main hall, cut into the hill and carved all over with spirals, now mostly taken back by " +
        "it. Roots have broken through the ceiling and hang in thick curtains; vines climb the walls and have " +
        "pulled carved stones loose; soil has spilled in through the cracks and lies over the floor, sprouting " +
        "ferns. Water drips everywhere. Green light comes down through a split in the ceiling where the hill " +
        "has opened to the sky. The carving is still beautiful where you can see it.",
    },
    exits: [
      { name: "The spiral door", base: "A round doorway carved with spirals, half blocked by a fallen stone and laced with vines." },
      { name: "A root-choked passage", base: "A passage so thick with hanging roots that it has to be pushed through like a hedge." },
    ],
    features: [
      {
        name: "Stone pews",
        base: "Rows of low stone benches carved from the living rock, facing the altar, cracked and heaved up by roots and green with moss.",
        fits: "any",
      },
      {
        name: "The hill altar",
        base: "A great boulder of the hill's own stone, left uncut and worn smooth on top, with spirals carved around its base and a sapling growing from a crack in it.",
        fits: "one-piece",
      },
      surface("Vines and roots", "Vines and hanging roots cover the walls and ceiling of the hall, pulling at the carved stone and trailing to the floor.", "Vines"),
    ],
    pick: (c) => !c.corridor && c.cells >= 18 && c.placed >= 2 && c.featuresShown >= 2,
  },
  {
    id: "I10",
    title: "Forge cave",
    tests: "a sound that must not be drawn, beside objects that must",
    vibe: { walls: "cave", condition: "occupied", moisture: "dry", life: "lived-in" },
    theme: "ironwrightHold",
    room: {
      name: "The Smithy",
      base:
        "A smithy set up in a raw cave the company never finished dressing, its walls rough and blackened by " +
        "years of smoke. The forge glows orange and throws hard shadows across the rock. Everything is a " +
        "working clutter: half-made blades on a bench, buckets of quench water, bundles of iron bar, tongs " +
        "and hammers hung on pegs driven into cracks in the wall. The heat is fierce. From somewhere deeper in " +
        "comes the steady ring of a hammer on an anvil.",
    },
    exits: [
      { name: "The workings", base: "A rough opening into the unfinished workings, propped with timber." },
      { name: "The hall door", base: "A squared doorway of dressed stone leading back toward the halls." },
    ],
    features: [
      {
        name: "The forge",
        base: "A great forge of fitted stone built against the cave wall, its firebed glowing, a leather bellows beside it and a chimney hood of riveted iron above.",
        fits: "hearth",
      },
      {
        name: "Tool racks",
        base: "Racks of tongs, hammers and punches hung on iron pegs along the wall, each tool in its place, every handle dark with use.",
        fits: "sarcophagi",
      },
      {
        name: "Ringing hammer",
        base: "The steady ring of a hammer on an anvil, coming from somewhere deeper in the workings.",
        spread: true,
        rolled: { "Room Detail": "Vibrations" },
      },
    ],
    pick: (c) => !c.corridor && c.fixtures.includes("hearth") && c.fixtures.includes("sarcophagi") && c.cells >= 12,
  },
  {
    id: "I11",
    title: "Tablet library",
    tests: "repeated wall units in clean architecture",
    vibe: { walls: "dressed stone", condition: "pristine", moisture: "dry", life: "lifeless" },
    theme: "saltweptCrypts",
    room: {
      name: "The Keeping Room",
      base:
        "A long room of fitted limestone lined with shelves, where the crypt's keepers stored their records. " +
        "The vault is low and plain, the floor flags swept, and lamps burn in niches between the shelf bays. " +
        "Everything is orderly to the point of severity: no clutter, no dust, nothing out of place. The cold " +
        "has kept it all perfectly. A faint white salt bloom lines the joints of the walls.",
    },
    exits: [
      { name: "The keeper's door", base: "A plain square doorway with a stone threshold worn into a dip." },
      { name: "A narrow passage", base: "A narrow opening between two shelf bays leading on into the dark." },
    ],
    features: [
      {
        name: "Tablet shelves",
        base: "Deep stone shelves built into the walls, holding thin slates of grey stone stacked on edge like books, hundreds of them, in perfect rows.",
        fits: "shelves",
      },
      {
        name: "The reading desk",
        base: "A sloped desk of carved stone with a ledge to hold a tablet and a lamp bracket beside it, its top polished by elbows.",
        fits: "one-piece",
      },
    ],
    pick: (c) => !c.corridor && c.fixtures.includes("shelves") && c.placed >= 2 && c.fill >= 0.85,
  },
  {
    id: "I12",
    title: "Prison block",
    tests: "a row of identical units along a wall, in the wet",
    vibe: { walls: "rough-hewn", condition: "abandoned", moisture: "wet", life: "lifeless" },
    theme: "seepingUndercroft",
    room: {
      name: "The Holding Cells",
      base:
        "A low hall of rough black shale where prisoners were once kept, its walls running with water. Along " +
        "one side a row of cells has been cut into the rock, each closed by a rusted grille. The floor is " +
        "puddled and slick, and the channel down its middle runs with a thin stream. Chains still hang from " +
        "rings in the ceiling. It is cold, dark and abandoned, and the doors of the cells stand open.",
    },
    exits: [
      { name: "The gaoler's door", base: "A heavy doorway with an iron-strapped door, its bolt rusted open." },
      { name: "The drain arch", base: "A low arch where the floor channel runs out through the wall into the dark." },
    ],
    features: [
      {
        name: "Cells",
        base: "Small cells cut into the rock, each just long enough to lie down in, closed by a grille of rusted iron bars that now stands open.",
        fits: "sarcophagi",
      },
      surface("Hanging chains", "Rusted chains hanging from rings set in the ceiling, some ending in open manacles, dripping with water.", "Chains"),
    ],
    pick: (c) => !c.corridor && c.fixtures.includes("sarcophagi") && c.cells >= 12,
  },
];
