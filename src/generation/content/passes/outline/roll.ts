/**
 * THE OUTLINE'S DICE: everything code rolls before the model plans a dungeon.
 *
 * The map is drawn, and the model is handed the room fictions it may choose from
 * and the contents it has to place. Contents are rolled here rather than after
 * placement so the model places a concrete thing and not the word "creature", and
 * so the challenges those contents raise exist for keys to answer.
 *
 * The first half of live stocking: `settle.ts` builds the stocked dungeon from what
 * the model decides. `src/dev/cli-outline.ts` also runs this to measure outlines.
 *
 * Nothing here is written to a room. A card's creature stands in a placeholder
 * "room" named after the card, so a challenge's `roomId` says which card raised it.
 */

import type { DungeonBlueprintSeed, InhabitantGroup } from "../../blueprint.ts";
import { DUNGEON_ROOMS, DUNGEON_ROOM_DETAILS } from "../../../../rules/maze-rats/tables.ts";
import { DUNGEON_CORRIDORS, DUNGEON_ENTRANCES } from "../../../../rules/maze-rats/tables.ts";
import { Rng, type Rolled } from "../../../../shared/utils/rng.ts";
import type { Challenge } from "../../../../shared/world/challenges.ts";
import { routesOf, type Dungeon } from "../../../floorplan/graph.ts";
import { CLASSES, sizeAllows, type SizeClass } from "../../../floorplan/room-size.ts";
import { enumerateChallenges } from "../../challenges.ts";
import { designateCorridors } from "../../stock/stock.ts";
import { computeQuota, gateConnectors, structuralPrePass } from "../../stock/steps.ts";
import {
  makeGroupMobile,
  makeMinionOrWanderer,
  rollDisposition,
  rollSpecial,
} from "../../stock/creatures.ts";
import { resetMobileIds } from "../../stock/ids.ts";
import { CAIRN_CLUE, DUNGEON_ACTIVITIES, roll } from "../../stock/tables.ts";
import type { MobileEntity, RoomStock, SpecialContent, StockedConnector } from "../../types.ts";

export interface FictionCandidate {
  ref: string;
  identity: Rolled;
  detail?: Rolled;
  /** the room sizes this identity suits (`sizeAllows`) */
  fits: SizeClass[];
  /** the model must use it. The first `ceil(V / 3)` candidates, marked by code. */
  mandatory: boolean;
  /** the room that makes this place what it was built as (`ORIGIN_ROOMS`) */
  signature?: boolean;
}

export interface OutlineRoom {
  ref: string;
  index: number;
  roomId: string;
  role: RoomStock["role"];
  /** drawn long, named from the corridor table, and not given a fiction to choose */
  passage: boolean;
  sizeClass?: SizeClass;
  depth: number;
  degree: number;
  isDeadEnd: boolean;
  /** a passage's rolled identity */
  identity?: Rolled;
  detail?: Rolled;
  entranceFeature?: Rolled;
  /** refs of the ways in and out of this room */
  ways: string[];
}

export interface OutlineWay {
  ref: string;
  connector: StockedConnector;
  a: string;
  b: string;
}

export interface ContentCard {
  ref: string;
  headline: "creature" | "special" | "quiet";
  mobile?: MobileEntity;
  special?: SpecialContent;
  /** a clue's rolled keyword. The model says what it points at. */
  clue?: Rolled;
}

export interface OutlineChallenge {
  ref: string;
  challenge: Challenge;
  /** the card that raises it; none for a way or the goal */
  card?: string;
}

export interface OutlineDraft {
  blueprint: DungeonBlueprintSeed;
  rooms: OutlineRoom[];
  ways: OutlineWay[];
  /** the distinct routes from the entrance to the goal, each in order of depth */
  routes: string[][];
  fictions: FictionCandidate[];
  cards: ContentCard[];
  wandererGroups: InhabitantGroup[];
  challenges: OutlineChallenge[];
  entrance: string;
  goalRoom: string;
  /** how many keys to plan: [fewest, most] */
  keyRange: readonly [number, number];
  /** share of creature encounters tied to the roster, as stocking rolls it */
  cohesion: number;
}

/** Tries before a roll gives up on suiting a size, as in `stockDungeon`. */
const ROLL_TRIES = 12;
/** Rerolls of the mandatory set before generation fails, which no measured seed needs. */
const MANDATORY_TRIES = 50;
/**
 * Keys to plan, by dungeon size. Generous: what the goal needs is a key too, and the
 * player has to engage with the world to get each one.
 */
const KEY_RANGE = { small: [1, 6], larger: [2, 8] } as const;

/**
 * The room an origin cannot be itself without: a theater with no theater in it is not
 * a theater. Rolled fictions gave none of the three measured dungeons one. Where there
 * are several, any of them will do.
 *
 * MOST ORIGINS ARE NOT HERE, ON PURPOSE. A hideout needs nothing to be a hideout, and
 * nearly anything rolled works in a prison. Keyed on the rolled result, so a Theater
 * reached through the building tables gets one too.
 */
export const ORIGIN_ROOMS: Readonly<Record<string, readonly string[]>> = {
  Arena: ["Fighting pit"],
  Asylum: ["Prison", "Physician"],
  Aviary: ["Aviary"],
  Bank: ["Vault"],
  Baths: ["Baths"],
  Casino: ["Gambling hall"],
  Court: ["Courthouse"],
  Forge: ["Forge"],
  Hotel: ["Bed chamber"],
  Laboratory: ["Laboratory"],
  Library: ["Library"],
  Market: ["Marketplace"],
  Mine: ["Mine shaft"],
  Monastery: ["Chapel"],
  Museum: ["Museum"],
  Palace: ["Throne room"],
  Ship: ["Bridge"],
  Temple: ["Temple"],
  Theater: ["Theater"],
  University: ["Classroom", "Library"],
  Vault: ["Vault"],
  Zoo: ["Zoo"],
};

/** Can every mandatory fiction have a room of its own? A plain bipartite matching. */
export function mandatoryFit(mandatory: readonly FictionCandidate[], rooms: readonly OutlineRoom[]): boolean {
  const chambers = rooms.filter((r) => !r.passage);
  const owner = new Map<string, number>();
  const place = (f: number, seen: Set<string>): boolean => {
    for (const r of chambers) {
      if (seen.has(r.ref)) continue;
      if (r.sizeClass && !mandatory[f]!.fits.includes(r.sizeClass)) continue;
      seen.add(r.ref);
      const held = owner.get(r.ref);
      if (held === undefined || place(held, seen)) {
        owner.set(r.ref, f);
        return true;
      }
    }
    return false;
  };
  return mandatory.every((_, f) => place(f, new Set()));
}

function rollFiction(ref: string, sizes: ReadonlySet<SizeClass>, rng: Rng, mandatory: boolean): FictionCandidate {
  const suits = (id: Rolled) => sizes.size === 0 || [...sizes].some((c) => sizeAllows(id, c));
  let identity = roll(DUNGEON_ROOMS, rng);
  for (let t = 0; t < ROLL_TRIES && !suits(identity); t++) identity = roll(DUNGEON_ROOMS, rng);
  return {
    ref,
    identity,
    ...(rng.chance(0.5) ? { detail: roll(DUNGEON_ROOM_DETAILS, rng) } : {}),
    fits: CLASSES.filter((c) => sizeAllows(identity, c)),
    mandatory,
  };
}

/**
 * The origin's own room, if it has one. It takes the first mandatory slot, so the
 * number of fictions does not change.
 *
 * What it is matters more than how big it is: where no chamber is big enough for a
 * Theater, the dungeon gets a cramped one, not none.
 */
function signatureFiction(form: Rolled, sizes: ReadonlySet<SizeClass>, rng: Rng): FictionCandidate | undefined {
  const options = ORIGIN_ROOMS[form];
  if (!options) return undefined;
  const identity = rng.pick(options);
  const fits = CLASSES.filter((c) => sizeAllows(identity, c));
  const suits = sizes.size === 0 || fits.some((c) => sizes.has(c));
  return {
    ref: "F1",
    identity,
    ...(rng.chance(0.5) ? { detail: roll(DUNGEON_ROOM_DETAILS, rng) } : {}),
    fits: suits ? fits : [...CLASSES],
    mandatory: true,
    signature: true,
  };
}

export function rollOutline(
  dungeon: Dungeon,
  blueprint: DungeonBlueprintSeed,
  opts: {
    seed: number;
    level?: number;
    /** draws the map, as `stockDungeon`'s hook does, once the passages are known */
    layout?: (rooms: RoomStock[]) => Array<SizeClass | undefined>;
  }
): OutlineDraft {
  const rng = new Rng(opts.seed);
  resetMobileIds(opts.seed);
  const cohesion = 0.55 + rng.next() * 0.35;
  const s = structuralPrePass(dungeon, rng);
  const connectors = gateConnectors(dungeon, s, rng);

  const stock: RoomStock[] = dungeon.rooms.map((r, i) => ({
    roomId: r.entityId,
    index: i,
    role: i === s.entrance ? "entrance" : i === s.goal ? "goal" : "normal",
    headline: "quiet",
    claimed: false,
    isCorridor: false,
    identity: "",
    depth: s.depth[i]!,
    degree: s.adj[i]!.length,
    isDeadEnd: s.deadEnds.has(i),
    danger: 0,
    occupants: [],
    rewards: [],
  }));
  designateCorridors(stock, s, rng);
  const sizes = opts.layout?.(stock);
  stock.forEach((r, i) => {
    const size = sizes?.[i];
    if (size) r.sizeClass = size;
  });

  const refOf = (i: number) => `room_${i}`;
  const refById = new Map(stock.map((r) => [r.roomId, refOf(r.index)]));

  const ways: OutlineWay[] = connectors.map((c, i) => ({
    ref: `W${i + 1}`,
    connector: c,
    a: refById.get(c.a)!,
    b: refById.get(c.b)!,
  }));

  const rooms: OutlineRoom[] = stock.map((r) => {
    const ref = refOf(r.index);
    return {
      ref,
      index: r.index,
      roomId: r.roomId,
      role: r.role,
      passage: r.isCorridor,
      ...(r.sizeClass ? { sizeClass: r.sizeClass } : {}),
      depth: r.depth,
      degree: r.degree,
      isDeadEnd: r.isDeadEnd,
      ...(r.isCorridor ? { identity: roll(DUNGEON_CORRIDORS, rng) } : {}),
      ...(r.isCorridor && rng.chance(0.5) ? { detail: roll(DUNGEON_ROOM_DETAILS, rng) } : {}),
      ...(r.role === "entrance" ? { entranceFeature: roll(DUNGEON_ENTRANCES, rng) } : {}),
      ways: ways.filter((w) => w.a === ref || w.b === ref).map((w) => w.ref),
    };
  });

  // --- room fictions --------------------------------------------------------
  const chambers = rooms.filter((r) => !r.passage);
  const chamberSizes = new Set(chambers.flatMap((r) => (r.sizeClass ? [r.sizeClass] : [])));
  const wanted = Math.ceil(1.5 * chambers.length);
  const mandatoryCount = Math.min(Math.ceil(rooms.length / 3), chambers.length);

  const signature = signatureFiction(blueprint.purpose.form, chamberSizes, rng);
  let mandatory: FictionCandidate[] = [];
  for (let t = 0; ; t++) {
    mandatory = Array.from({ length: mandatoryCount }, (_, i) =>
      i === 0 && signature ? signature : rollFiction(`F${i + 1}`, chamberSizes, rng, true)
    );
    if (mandatoryFit(mandatory, rooms)) break;
    if (t >= MANDATORY_TRIES) throw new Error("no set of mandatory fictions fits this dungeon's rooms");
  }
  const fictions = [
    ...mandatory,
    ...Array.from({ length: wanted - mandatoryCount }, (_, i) =>
      rollFiction(`F${mandatoryCount + i + 1}`, chamberSizes, rng, false)
    ),
  ];

  // --- content cards --------------------------------------------------------
  // One for each room but the entrance and the goal room, in the mix stocking's
  // quota asks for. Group bases count toward the creature share, as they always
  // have; the goal room's `special` is the objective itself.
  const bases = blueprint.inhabitants.length;
  const open = Math.max(0, rooms.length - 2 - bases);
  const quota = computeQuota(rooms.length, { creature: bases, special: 1, quiet: 0 }, open);

  const cards: ContentCard[] = [];
  const add = (card: Omit<ContentCard, "ref">) => {
    const ref = `C${cards.length + 1}`;
    if (card.mobile) card.mobile.locationRoomId = ref;
    cards.push({ ref, ...card });
  };
  const wandererGroups: InhabitantGroup[] = [];

  blueprint.inhabitants.forEach((g, gi) => {
    add({ headline: "creature", mobile: makeGroupMobile(g, gi, "", true, rng) });
  });
  for (let i = 0; i < quota.creature; i++) {
    add({ headline: "creature", mobile: makeMinionOrWanderer(blueprint, "", cohesion, wandererGroups, rng) });
  }
  for (const c of cards) {
    const m = c.mobile!;
    if (!m.activity) m.activity = roll(DUNGEON_ACTIVITIES, rng);
    if (!m.disposition) m.disposition = rollDisposition(blueprint, m, rng);
  }
  for (let i = 0; i < quota.special; i++) add({ headline: "special", special: rollSpecial(rng) });
  for (let i = 0; i < quota.quiet; i++) {
    add({ headline: "quiet", ...(rng.chance(0.5) ? { clue: roll(CAIRN_CLUE, rng) } : {}) });
  }

  // --- what they raise ------------------------------------------------------
  // `enumerateChallenges` reads rooms, so each card with something to answer stands
  // in as a room of its own for the length of this call.
  const goal = stock[s.goal]!;
  const asRoom = (c: ContentCard): RoomStock => ({
    ...goal,
    roomId: c.ref,
    role: "normal",
    ...(c.special ? { special: c.special } : {}),
  });
  const raised = enumerateChallenges({
    rooms: [
      ...stock.map((r) =>
        r.index === s.goal
          ? { ...r, goalDirective: { reward: "the objective", mission: "", instruction: "" } }
          : r
      ),
      ...cards.filter((c) => c.special).map(asRoom),
    ],
    mobiles: cards.flatMap((c) => (c.mobile ? [c.mobile] : [])),
    connectors,
    goalRoomId: goal.roomId,
  });
  const cardRefs = new Set(cards.map((c) => c.ref));
  const challenges: OutlineChallenge[] = raised.map((challenge, i) => ({
    ref: `K${i + 1}`,
    challenge,
    ...(cardRefs.has(challenge.roomId) ? { card: challenge.roomId } : {}),
  }));

  // --- routes ---------------------------------------------------------------
  const routes = routesOf(rooms.length, dungeon.edges, s.entrance, s.goal).map((route) =>
    [...route].sort((a, b) => s.depth[a]! - s.depth[b]!).map(refOf)
  );

  return {
    blueprint,
    rooms,
    ways,
    routes,
    fictions,
    cards,
    wandererGroups,
    challenges,
    entrance: refOf(s.entrance),
    goalRoom: refOf(s.goal),
    keyRange: rooms.length <= 6 ? KEY_RANGE.small : KEY_RANGE.larger,
    cohesion,
  };
}
