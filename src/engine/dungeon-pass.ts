/**
 * DUNGEON PASS  (once, up front)
 * ==============================
 *
 * The first call, and the only one that sees the whole dungeon at once. It
 * turns the rolled genome -- purpose, ruination, inhabitants, goal seed -- into
 * the standing fiction every later pass writes against:
 *
 *   theme      the sensory register: material, light, sound, smell
 *   history    what it was, what happened, who is here now
 *   goal       ONE objective resolved out of the reward/mission pair
 *   opening    what the player reads before the first room
 *   groups     the shared base for each rolled inhabitant group
 *
 * INHABITANT BASES ARE WRITTEN HERE. A group is a dungeon-level thing: it can
 * be placed in several rooms across several chunks, and every instance shares
 * one identity. Writing it once, here, is what keeps chunks from each inventing
 * their own version of the same population -- and who lives here belongs in the
 * dungeon's fiction anyway, not in whichever room happens to hold them.
 *
 * Wanderer groups are NOT written here. They do not exist yet (stocking rolls
 * them), they are filler drawn when the rolled inhabitants are already placed,
 * and they are explicitly not part of the resident population. The content pass
 * writes theirs, in the one chunk each appears in.
 */

import {
  rollSheet,
  type DungeonBlueprintSeed,
  type Size,
} from "./dungeon-blueprint.ts";
import { properName } from "./dungeon-entities.ts";
import type { GroupTemplate } from "./dungeon-entities.ts";

// ===========================================================================
// PAYLOAD
// ===========================================================================

export interface DungeonPassPayload {
  /** the full rolled genome as text; group ids appear inline, in brackets */
  rollSheet: string;
  /** every id in bp.inhabitants -- the exact set the response must cover */
  groupIds: string[];
  size: Size;
  level: number;
  instructions: string;
  responseSchema: string;
}

export function buildDungeonPassPayload(bp: DungeonBlueprintSeed): DungeonPassPayload {
  return {
    rollSheet: rollSheet(bp),
    groupIds: bp.inhabitants.map((g) => g.id),
    size: bp.size,
    level: bp.level ?? 1,
    instructions: DUNGEON_PASS_INSTRUCTIONS,
    responseSchema: DUNGEON_PASS_SCHEMA,
  };
}

// ===========================================================================
// RESPONSE
// ===========================================================================

export interface DungeonPassGroup {
  /** must match one of payload.groupIds exactly */
  id: string;
  /** what these are called, plural: "the Ashen Choir", "fen-seals" */
  name: string;
  /** their standing identity, shared by every instance anywhere in the dungeon */
  base: string;
}

export interface DungeonPassResponse {
  name: string;
  theme: string;
  history: string;
  goal: {
    /** one line, shown to the player as their objective */
    summary: string;
    /** what actually satisfies it, for the referee */
    spec: string;
  };
  /** what the player reads before the first room */
  openingProse: string;
  groups: DungeonPassGroup[];
}

// ===========================================================================
// RENDER
// ===========================================================================

export function renderDungeonPassPrompt(p: DungeonPassPayload): string {
  const L: string[] = [];
  L.push(p.instructions, "");
  L.push(p.rollSheet, "");
  L.push(`=== GROUPS YOU MUST WRITE (${p.groupIds.length}) ===`);
  L.push(
    "One name + base for each id below, exactly these ids and no others. They are",
    "the groups printed above; the id is in brackets on each group's header line."
  );
  for (const id of p.groupIds) L.push(`  ${id}`);
  L.push("");
  L.push("=== RESPONSE FORMAT ===", p.responseSchema);
  return L.join("\n");
}

// ===========================================================================
// INSTRUCTIONS + SCHEMA
// ===========================================================================

const DUNGEON_PASS_INSTRUCTIONS = `You are establishing a dungeon's standing fiction, before any of its rooms are
written. Everything below has already been rolled. Your job is to make one
coherent place out of it -- not to choose what is there, and not to describe any
individual room.

Whatever you write here is read by every later pass and cannot be contradicted
afterwards. Commit to it.

WHAT TO WRITE

name        What this place is called. Short. It may be what its builders called
            it, or what people call it now -- pick whichever the fiction earns.

theme       The sensory register, in a few sentences: what it is built from,
            what the light is like, what it sounds like, what it smells of, what
            the air does. Concrete nouns. This is the palette every room draws
            from, so make it specific enough to constrain and broad enough to
            furnish twenty rooms.

history     What the place was for, what happened to it, and how it came to hold
            what it holds now. Tie the ruination cause to the inhabitants: the
            best dungeons are one story, not a building plus some monsters that
            wandered in. A few short paragraphs.

goal        You are given a Dungeon Reward and a Mission. Resolve them into ONE
            objective -- take one, discard the other, or fuse them, whichever
            reads best. Then write it twice:
              summary: one line the player is told before they go in.
              spec:    what actually counts as achieving it, for the referee.
                       Concrete enough to adjudicate: what must be found, done,
                       taken, or ended. This decides when the run is won, so do
                       not leave it to taste.

opening     Everything the player knows walking in. Second person, present
            tense, three or four short paragraphs, and the ONLY briefing they
            get -- they cannot see the theme, the history, or the goal spec, and
            nothing later in the run will stop to explain what they are doing
            here. Write it as prose, not as a briefing document with headings.

            It must carry four things:

              WHAT THIS PLACE IS, and roughly where. A ruined abbey under a
              tidal flat; a mine the road still goes past. Enough for the
              player to picture it from outside before they are inside it.

              WHAT IS SAID TO HAVE HAPPENED HERE. A version of the history --
              the version that reached the surface. It may be thin, wrong in
              places, or half legend. What it must NOT be is complete: leave
              the player something to find out. If the truth is that the
              abbot's own order did this, the rumour can be that something came
              up out of the sea.

              WHAT THEY ARE GOING TO MEET. The shape of the danger, not its
              statistics. Say the thing lives here and hunts; do not say its
              hit dice, its weakness, or how many there are. A player should be
              able to decide what to bring and still be surprised.

              WHY THEY CAME, and WHAT THEY ARE HERE TO DO. The why is brief and
              may stay vague for now -- hired, paid in advance, owed a favour,
              sent. One clause is enough. The WHAT is not vague: it is the goal
              you wrote above, said plainly, in its own sentence, near the end
              where it lands last. The player should be able to close the
              opening and say what they are here for in one line. If they
              cannot, rewrite it.

            End at the threshold: the way in, and the first thing the place does
            to them. The next thing they read is the first room, so hand off
            into it rather than describing it.

groups      For each listed group id, a plural name and a standing base.
            The base is what these things ARE, permanently and everywhere in
            this dungeon: their form, their nature, how they behave, what they
            want. Realise the rolled keywords into a creature or a faction; do
            not list the keywords back.
            Write nothing that a single encounter could change. No "currently",
            no "at the moment", no room, no posture, no wound. Twelve instances
            of this group in eight rooms all share this one description, so
            anything true of only one of them does not belong in it.
            A group's LEADER and any named people get their own descriptions
            later -- write the group here, not its individuals.

HARD RULES
1. Do not contradict the rolls. Form, ruination, inhabitants and goal seed are
   settled; you are realising them, not revising them.
2. Do not write rooms. No room names, no floor plan, no "in the eastern wing".
   Rooms are written later, by a pass that has the layout in front of it. This
   binds the opening too: it ends AT the way in, and the room beyond it is the
   next thing the player reads, written by somebody who can see it.
3. Return a base for every listed group id and for no other id.
4. Keywords are seeds, not vocabulary. "Fungal" means work out what the fungus
   has done to them; it does not mean using the word "fungal".
5. Write prose, not notes. This is read as fiction by everything downstream.
6. The opening and the goal summary must say the same thing. The summary is the
   objective as a line; the opening is that same objective as something a person
   was asked to go and do. They are read minutes apart, and disagreeing is worse
   than either of them being weak.
7. The opening tells the player what they were TOLD, not what is true. Theme and
   history are the facts, and they are for the referee. What reached the player
   is allowed to be partial, and should be.`;

const DUNGEON_PASS_SCHEMA = `Return JSON only, no prose outside it:

{
  "name": "<the dungeon's name>",
  "theme": "<sensory register: material, light, sound, smell, air>",
  "history": "<what it was, what happened, who is here now>",
  "goal": {
    "summary": "<one line, told to the player>",
    "spec": "<what counts as achieving it, for the referee>"
  },
  "openingProse": "<second person: what the place is, what is said to have happened, what lives there, why they came, and — plainly, in its own sentence — what they are here to do>",
  "groups": [
    { "id": "<exactly as listed>", "name": "<plural name>", "base": "<standing identity>" }
  ]
}`;

// ===========================================================================
// APPLY
// ===========================================================================

export interface DungeonPassResult {
  /**
   * The standing fiction as one string. Consumed by the content pass and, at
   * runtime, as the cached static prefix on every referee call.
   *
   * Built ONCE, here, from bp.inhabitants alone. Nothing appends to it and no
   * later pass regenerates it -- wanderer bases land in registry.groups as
   * chunks complete, and anything that re-derived this string from the registry
   * would start presenting corridor filler as the dungeon's population.
   */
  dungeonContext: string;
  /** blueprintId -> shared identity; merged into ep.registry.groups */
  groups: Record<string, GroupTemplate>;
  pass: DungeonPassResponse;
}

export class DungeonPassError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DungeonPassError";
  }
}

export function applyDungeonPass(
  res: DungeonPassResponse,
  payload: DungeonPassPayload
): DungeonPassResult {
  // A group with no base is creatures with no resolvable identity -- a hard
  // failure, not a degradation. Check before anything is built on it.
  const expected = new Set(payload.groupIds);
  const got = new Set(res.groups.map((g) => g.id));
  const missing = [...expected].filter((id) => !got.has(id));
  const unknown = [...got].filter((id) => !expected.has(id));
  if (missing.length || unknown.length) {
    throw new DungeonPassError(
      [
        missing.length ? `no base returned for group(s): ${missing.join(", ")}` : "",
        unknown.length ? `base returned for unknown group(s): ${unknown.join(", ")}` : "",
      ]
        .filter(Boolean)
        .join("; ")
    );
  }
  const blank = res.groups.filter((g) => !g.base?.trim() || !g.name?.trim());
  if (blank.length) {
    throw new DungeonPassError(`empty name or base for group(s): ${blank.map((g) => g.id).join(", ")}`);
  }

  const groups: Record<string, GroupTemplate> = {};
  // A group's name IS a creature's display name — `resolveName` falls through
  // to it for every instance that has no name of its own — so it is capitalised
  // on the same rule as everything else the player reads. See `properName`.
  for (const g of res.groups) groups[g.id] = { id: g.id, name: properName(g.name), base: g.base };

  return { dungeonContext: renderDungeonContext(res), groups, pass: res };
}

/** The standing fiction, as the later passes read it. */
export function renderDungeonContext(res: DungeonPassResponse): string {
  const L: string[] = [];
  L.push(`THE DUNGEON: ${res.name}`, "");
  L.push("THEME", res.theme, "");
  L.push("HISTORY", res.history, "");
  L.push("WHO LIVES HERE");
  for (const g of res.groups) L.push(`  ${g.name} -- ${g.base}`);
  L.push("");
  L.push("THE PLAYER'S GOAL", `  ${res.goal.summary}`, `  Satisfied by: ${res.goal.spec}`);
  return L.join("\n");
}
