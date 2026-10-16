/**
 * THE CONTENT PASS'S PROMPT: a chunk's payload rendered into the call, and the
 * standing instructions the model writes the region against.
 */

import { fixtureMenu } from "../../../floorplan/fixtures.ts";
import { POSITION_WORDS } from "../../../../shared/world/placement.ts";
import type { ContentPassPayload, KW } from "./build.ts";

// ===========================================================================
// RENDER
// ===========================================================================

const kwLine = (kw: KW) =>
  Object.entries(kw).map(([t, v]) => `${t}=${v}`).join("  |  ") || "--";

export function renderContentPassPrompt(p: ContentPassPayload): string {
  const L: string[] = [];
  L.push(p.instructions, "");
  L.push("=== DUNGEON FICTION (shared context) ===", p.dungeonContext, "");
  L.push(`=== ROOMS TO WRITE (${p.rooms.length}) ===`, "");

  for (const r of p.rooms) {
    L.push(`--- ${r.ref} ---`);
    L.push(`identity: ${r.identity}`);
    if (r.role !== "normal") L.push(`role: ${r.role}`);
    L.push(`depth: ${r.depth}   tension: ${r.tension}${r.isDeadEnd ? "   dead end" : ""}`);
    L.push(`headline: ${r.headline}${r.stacked ? ` + ${r.stacked}` : ""}`);
    L.push(`room keywords: ${kwLine(r.keywords)}`);
    // AS DRAWN. Placed directly under the identity, because the two are read
    // together: the identity says what the place was built as and this says
    // what it came out as, and where they disagree the drawing is the fact.
    if (r.geometry) L.push(`as drawn: ${r.geometry}`);

    for (const e of r.entities) {
      L.push(`entity [${e.ref}] ${e.kind} (${e.entity})${e.hidden ? " HIDDEN" : ""}: ${kwLine(e.keywords)}` + (e.note ? ` -- ${e.note}` : ""));
    }
    for (const d of r.detailCandidates) {
      L.push(`promotable detail [${kwLine(d.keywords)}] -- make it an entity only if a player would act on it`);
    }
    for (const c of r.connectors) {
      const where = c.wall ? ` in ${c.wall}` : "";
      if (c.surface) {
        L.push(
          `connector [${c.ref}] OUT OF THE DUNGEON${where} -- the way the party came in and the ` +
            `only way back to daylight; realise it from [${kwLine(c.surface)}] and say what ` +
            `it physically is. Name it as a thing, not as an exit.`
        );
        continue;
      }
      if (c.seam) {
        L.push(
          `way out [${c.ref}]${where} to ${c.toRef} (${c.toIdentity})${c.gated ? " GATED" : ""}` +
            ` -- WRITTEN ELSEWHERE. It leaves this region, so it is written by a later ` +
            `pass that can see both rooms. Count it among this room's ways out; do not ` +
            `name it, describe it, or return it.`
        );
        continue;
      }
      const flags = `${c.gated ? " GATED" : ""}${c.hidden ? " CONCEALED" : ""}`;
      const asks = [
        c.hidden
          ? "write it as the thing a person would walk past -- a seam, a draught, a panel that rings hollow -- not as a door"
          : "say what it physically is",
        c.gated ? "and what blocks it, from here" : "no barrier",
      ].join("; ");
      // The far side is named so the form can suit it -- a kennel wants a gate,
      // a vault wants a door -- and for no other reason. It must not reach the
      // connector's name; see CONNECTOR_NAMING.
      L.push(`connector [${c.ref}]${where} to ${c.toRef} (${c.toIdentity})${flags} -- ${asks}`);
    }
    for (const en of r.encounters) {
      L.push(`encounter [${en.ref}] ${en.tier}, ${en.affiliation}, currently ${en.activity}, disposition ${en.disposition}`);
      if (en.group) L.push(`    mass: ${en.group.count} x rank-and-file -> ONE consolidated entity, one stat block  [${kwLine(en.group.keywords)}]`);
      for (const d of en.distinct) {
        L.push(`    distinct ${d.kind}${d.member ? ` [${d.member}]` : ""}${d.isLeader ? " (leader)" : ""} -> its own entity  [${kwLine(d.keywords)}]`);
      }
      for (const line of en.template.split("\n")) L.push(`      ${line}`);
    }
    if (r.goal) {
      L.push(`GOAL HERE: reward "${r.goal.reward}" + mission "${r.goal.mission}".`);
      L.push(`  ${GOAL_INSTRUCTION}`);
    }
    if (r.gatedExits.length) L.push(`gated exits: ${r.gatedExits.join(", ")}`);
    if (r.openExits.length) L.push(`open exits: ${r.openExits.join(", ")}`);
    if (r.fixtures) {
      L.push(
        `fixtures: up to ${r.fixtures.cap}, or none` +
          (r.fixtures.corridor ? " -- A PASSAGE: starred kinds only" : "")
      );
    }
    L.push("");
  }

  if (p.borders.length) {
    L.push(`=== BORDER ROOMS -- context only, do NOT write ===`, "");
    for (const b of p.borders) L.push(`${b.ref}: ${b.identity} (${b.headline}) -- ${b.summary}; connects to ${b.connectsTo.join(", ")}`);
    L.push("");
  }

  L.push("=== RESPONSE FORMAT ===", p.responseSchema);
  return L.join("\n");
}

// ===========================================================================
// INSTRUCTIONS + SCHEMA
// ===========================================================================

/**
 * A connector is read from both ends, and it is one entity with one name.
 *
 * Name it "Corridor to the Kennel" and the player standing IN the Kennel reads
 * "Corridor to the Kennel" on the way out — pointing at where they already are.
 * A game master asked to route "go back to the Laboratory" then has two exits both
 * claiming to lead to the Kennel and picks by coin toss. So the name carries the
 * nature of the crossing and nothing else, and `renderRoom` appends the room on
 * the far side, correct from whichever end is being read.
 */
export const CONNECTOR_NAMING = `Its NAME is what the thing physically is and
  NOTHING else -- "Iron door", "Low archway", "Spiral stair", "Flooded crawl",
  "Rope bridge". Name NEITHER room it joins: no "to the", no "from the", no room
  name, no direction. One connector is walked both ways and read from both ends,
  so a name that points is wrong from one of them. Where it leads is appended
  when it is read, and is not yours to write.`;

/**
 * A stair has a top and a bottom, and one entity read from both ends has no
 * "up" of its own.
 *
 * So the form says which ROOM is the upper one, by name. That is the one phrasing
 * that survives being read from either side, and without it the same flight of
 * steps is written as descending from both of its rooms -- which is what a player
 * walking back the way they came finds out.
 *
 * Both rooms are named by whoever is writing: a chunk writes only the connectors
 * whose two rooms it is naming in the same response, and the seams pass is handed
 * the names the chunks settled.
 */
export const CONNECTOR_HEIGHT = `Where it changes level -- a stair, a ladder, a
  shaft, a ramp, a hole in the floor, a drop -- the FORM must say which of the two
  rooms is above and which below, BY NAME: "a stair, the Counting Room at its head
  and the Sump at its foot". Not "leads down", which is true from only one end.`;

const GOAL_INSTRUCTION =
  "Create exactly one entity that embodies the objective. Read the fiction and " +
  "decide what type it needs to be -- an Item, a RoomFeature, or a Creature -- so " +
  "that a party acting on it plausibly satisfies the mission. Then name and write it.";

export const CONTENT_PASS_INSTRUCTIONS = `You are writing one region of a dungeon: six rooms and everything in them.

WHAT YOU ARE GIVEN
Every room, entity, connector, and creature has already been decided by procgen.
Counts and hit dice are already rolled. Your job is to realise it in prose and
settle the few things procgen leaves to you -- not to choose what is there. Each
line lists the rolled keywords behind it as table=value; those are seeds to
realise, not text to echo.

PER ROOM
- name + base: the room's standing description. base is IMMUTABLE -- only what is
  true of the place itself, not what a party is doing in it, nothing that changes
  when its contents change.
- Each listed entity's name + base, written the same way: fixed identity, concrete
  to this fiction.
- Each connector: name + what it physically IS -- a door, a stair, a corridor, a
  crawl, a short drop, a collapsed arch, whatever separates the two rooms, even if
  mundane. ${CONNECTOR_NAMING}
  For a GATED connector also write what blocks it, seen from this room; do not
  invent the key.
  ${CONNECTOR_HEIGHT}
- Promotable details: a detail is always part of the room's description. Make it
  its own entity ONLY if a player would act on it. Most stay as description.
- Fixtures: up to the number the room gives, off the one menu. See FIXTURES.

THE ROOM AS DRAWN
Each room has already been drawn on the map. "as drawn" gives you its real size
in feet, its proportions, whether its outline is square-cornered or broken up,
and how many ways out are in each wall; each connector says which wall it is in.

WRITE TO THE DRAWING, NOT TO THE IDENTITY. The rolled identity says what the
place was built as; the drawing says what it came out as, and where the two
disagree the drawing wins. A room rolled "Banquet hall" and drawn twenty feet
square is not a long hall -- it is what became of one, or a service room off one,
or a hall the collapse took most of. Say so. A player looking at the map and
reading your prose must not be looking at two different rooms.

Two hard rules about direction:
- Compass only. North, south, east and west are on the map and are safe. "Left",
  "right", "ahead", "behind" depend on which way the party is facing and you do
  not know that; a party that walks back through will read them as lies.
- Do not invent an exit, a window, or a level change that is not listed. The ways
  out are exactly the connectors given.

And two about the ways out, both of them because base is IMMUTABLE and there is
no later pass that can correct it:
- DO NOT COUNT THEM IN THE ROOM'S BASE. "Four ways out: east, south, and two to
  the west" stops being true the first time one is opened, barred, collapsed or
  found, and the description cannot be rewritten to catch up -- so the number goes
  on being read aloud to the player long after it is wrong. The map draws the ways
  out and the game lists them fresh every turn. Describe the room; let the
  counting be done by something that is allowed to change its mind.
- A CONCEALED way is NOT part of the room's description. Write what it physically
  is on the connector itself -- that is the text the player reads on FINDING it --
  and keep it out of the room's base entirely, not even as a hint or a draught. A
  room whose standing description mentions the crack in the west wall has no
  secret door in it, because that description is read out on arrival. Where a
  concealed way is meant to be findable, procgen lists a clue as its own entity.

Feet are given so the prose can be concrete. Round them, compare them to
something, or ignore them -- but do not contradict them.

FIXTURES -- WHAT IS STANDING IN THE ROOM
The menu, once. Starred kinds also fit in a passage; the rest need a chamber.

  ${fixtureMenu()}

Each room says how many it may hold. Choose up to that many, or NONE AT ALL --
an empty room is a real room, and a dungeon of uniformly furnished ones reads as
a catalogue. Pick what the fiction has already earned: a barracks has bunks, a
shrine has an altar, a collapsed gallery has rubble.

Each fixture gets a "kind" from the menu, a "position", a name and a base, and is
written exactly like any other feature -- a thing in this dungeon, not a generic
one. Positions, and nothing else: ${POSITION_WORDS.join(", ")}.

A fixture is furniture, never a way somewhere. "stair" on the menu means steps
INSIDE the room -- up to a dais, down into water -- that arrive nowhere else. If
you want a way between two rooms, it is one of the connectors and it is already
listed. See A WAY THROUGH IS NEVER A FEATURE.

DO NOT say how many there are. "Pillars" is your decision; six pillars is not --
the count is rolled, and the map will draw whatever it rolled. Name them in a way
that survives either number, and write the base about what they ARE rather than
about how many.

Anything already listed as an entity may ALSO take a "position", from the same
words, saying where in the room it sits. That is what puts the chest, the clue
and the hazard on the map alongside the furniture.

NAMING A ROOM
The name comes from whatever DOMINATES the room, not from the identity it was
rolled from. The rolled identity says what the place was built as; the name says
what a party walking in would call it. A kennel whose stalls stand empty, with an
iron bridge over a chasm running through the middle of it, is not the Kennel --
the bridge and the chasm are what anyone would remember it by, and what they will
say when they mean "back to the room with the bridge". So read the room's
entities and its detail, work out what the biggest thing in there actually is,
and name it for that. Short, concrete, and sayable out loud.

EVERYTHING IS THERE FOR A REASON
Before you write a room or a feature, know why it is in THIS dungeon. Usually the
answer is ordinary and needs no room on the page -- a barracks in a fort, a sump
at the bottom of a mine. But anything that does NOT obviously belong is the first
thing a party will notice and ask about, and the fiction has to be able to answer.
A theatre inside a prison must have a story behind it: who built it, for whom, and
what became of it. Put that answer in the base, as a clause, not a lecture. An
incongruity with a reason behind it is the best thing in a dungeon; one without is
a mistake the player can see from the doorway.

A WAY THROUGH IS NEVER A FEATURE
If something you are about to write reads as a way to somewhere else -- a stair,
a shaft, a hole in the wall, a rent in the floor, a tunnel, a door -- it is a
CONNECTOR, not a RoomFeature and not a promoted detail. Spend the idea on one of
the connectors this room already has: each is listed with the room it leads to,
so pick the one whose far side suits it and write it as that connector's name
and form. The rooms are joined the way they are joined; you are describing those
joins, not adding to them.

A player will try to walk through anything that looks like a passage. Written as
a feature it leads nowhere, and they find that out by trying.

The ONE exception is the connector marked OUT OF THE DUNGEON, which is a real
way through to no room at all. It is already in your list. Do not invent others.

CREATURES -- CONSOLIDATE
The count is already rolled. A mass of one creature type is ONE entity with a
single stat block; do NOT split it into individuals. "5 x rank-and-file" is one
entity you name in the plural ("Fen-seals") and write once. Only a specimen
marked "distinct" -- an elite, a named person -- becomes its own entity alongside
the mass. Write the group's shared base once (the mass); write each distinct
specimen its own base. Give the mass and each distinct one a one-line current
activity fitting the encounter. Stats: you are given the hit-dice spine; return
only DEVIATIONS the keywords imply (a heavier die for claws, armour, a morale or
ability shift). Leave stats out for an average body.

BEASTS -- WHAT THE REFERENCE ANIMALS ARE FOR
A beastlike monster is listed with one reference animal or two. That was decided
by the roll, not left to you: one means one, two means both. They are the starting
point for a body, NOT the description of it. Take the general shape and bearing
from them -- how it stands, how it moves, how much of the room it takes up -- and
then write SPECIFIC borrowed parts: the shape of the snout, what it has instead of
ears, the horn or the antler, the set of the eyes, the feet, the hide.

What you must not do is name the animal and stop. "Badger-like", "part badger,
part Pteranodon", "resembles a heron" -- that is the reference showing through
where a creature should be. Name an animal only when the naming does real work
("the flat spade-shaped digging claws of a badger" both names it and tells you
something); otherwise the player should be able to picture the thing without ever
learning what it was built out of.

THE GOAL
One room is marked GOAL. ${GOAL_INSTRUCTION}

HARD RULES
1. Every listed entity, encounter, and connector must appear exactly once -- except
   a way out marked WRITTEN ELSEWHERE, which you must NOT return. That one leaves
   this region and is written by a pass that can see the room on the other side.
   Do not add a creature, hazard, or connector that was not listed.
2. Keywords are seeds, not labels. Realise them into the place; do not gloss.
3. Do not contradict the fiction. Material, history, and the state of the ruin are
   settled.
4. Depth and tension are tone, never content. A calm room holding a lethal thing
   still holds it.
5. A clue must point at what it is said to point at, written as something noticed.

MAKE THEM DISTINCT
These rooms are read in sequence. Give each one something the others lack. If two
would read the same, change one.`;

export const CONTENT_PASS_SCHEMA = `Return JSON only, no prose outside it:

{
  "rooms": [
    {
      "ref": "<room ref, exactly as given>",
      "name": "<short room name>",
      "base": "<the room's standing description>",
      "entities": [ { "ref": "<entity ref>", "name": "<name>", "base": "<identity>", "position": "<one of the position words>" } ],
      "fixtures": [ { "kind": "<one from THIS room's menu>", "position": "<one of the position words>", "name": "<name>", "base": "<identity>" } ],
      "promotions": [ { "text": "<detail text as given>", "name": "<name>", "base": "<identity>", "hidden": false, "position": "<one of the position words>" } ],
      "connectors": [ { "ref": "<connector ref>", "name": "<what it is, naming neither room>", "form": "<what it physically is>", "requirement": "<gated only: what blocks it>" } ],
      "encounters": [
        {
          "ref": "<encounter ref>",
          "group": { "name": "<plural name>", "base": "<shared identity>", "activity": "<one line>", "stats": { "damage": "1d8" } },
          "distinct": [
            { "kind": "elite|named", "member": "<named: person id>", "name": "<name>", "base": "<identity>", "isLeader": false, "activity": "<one line>", "stats": { "armorDefense": 14 } }
          ]
        }
      ],
      "goal": { "entityType": "Item|RoomFeature|Creature", "name": "<name>", "base": "<identity>", "position": "<one of the position words>" }
    }
  ]
}

Include each key only when the room has it; "group" only when a mass is listed;
"distinct" only for specimens marked distinct; omit "goal" except in the GOAL
room. Leave "stats" out for an average creature.

"fixtures" and every "position" are optional and are omitted entirely for a room
with no "as drawn" line. NEVER put a count, a dimension, or a coordinate in any
of them: "kind" and "position" are words off the lists and nothing else.`;
