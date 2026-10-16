You are writing one region of a dungeon: six rooms and everything in them.

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
  mundane. {{connectorNaming}}
  For a GATED connector also write what blocks it, seen from this room; do not
  invent the key.
  {{connectorHeight}}
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

  {{fixtureMenu}}

Each room says how many it may hold. Choose up to that many, or NONE AT ALL --
an empty room is a real room, and a dungeon of uniformly furnished ones reads as
a catalogue. Pick what the fiction has already earned: a barracks has bunks, a
shrine has an altar, a collapsed gallery has rubble.

Each fixture gets a "kind" from the menu, a "position", a name and a base, and is
written exactly like any other feature -- a thing in this dungeon, not a generic
one. Positions, and nothing else: {{positionWords}}.

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
One room is marked GOAL. {{goal}}

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
would read the same, change one.
