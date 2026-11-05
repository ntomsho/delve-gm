You are reviewing a finished outline of a dungeon. Fix every error, then make it
better to play. At most {{maxEdits}} edits:

- swap_fictions: two rooms trade fictions (roomA, roomB)
- swap_cards: two rooms trade cards (roomA, roomB)
- replace_fiction: a room takes an unused optional fiction (roomA, fiction)
- rewrite_story, rewrite_journey: a room's note (roomA, text)
- set_story_feature: add or rewrite a room's story feature (roomA, text)
- rewrite_way: what a way physically is (way, text)
- change_fiction: the dungeon's theme, history, opening, or a group's name or base
  (field, group if it is about a group, and the field's whole new text, not only the
  part you changed)
- set_key: add a key or replace one (challenge, keyKind, text for what it is, roomA for
  where it is, gotBy)

Change the fiction only to work rooms in better or make the story more engaging.
Never change the goal, and never make it seem strange or leave things around it not
making sense.

AUDIT FIRST. Check each of these in turn, and fix what fails:
- The goal's culmination, the thing acted upon to complete the objective: is it in the
  goal room with the goal entity?
- What the goal and history say the player must learn or find: is each one a key?
- Each key: is it placed, and does the player have to engage with the world to get it?
  Is it one thing? Is it clear of the way it opens?
- Each gated or concealed way: how does it open, and is what lies behind it worth it?
- The opening: does anything in the outline contradict it?
- Every note: does it agree with the ways, keys and other notes?
- Each danger, guard, lock and need, and the goal itself: can it be solved more than
  one way? Does any note read as if one answer were the only one?

Then ask:
1. Does each room fit the concept of the dungeon, including mandatory rooms?
2. Are dangers signposted, and are exploration and clever thinking rewarded?
3. Do routes to the goal ask different things of the player?
4. Does each creature's placement fit its group's goals and the layout? Guards
   stand where something is worth guarding, a lair is somewhere defensible, a
   patrol is on a through route.
5. Is it well paced: no early death traps or windfalls near the entrance, no easy
   stretches or useless finds deep in?
6. Can the player piece together a part of the dungeon's history from what they
   find here?
7. Are all the important aspects of the dungeon's history represented in at least
   one room?
8. Is the goal still intuitive, and does everything around it make sense?

You cannot remove a mandatory fiction or change anything pre-assigned.

MAKE IT BETTER TO PLAY. Empowering the player's creativity comes first: it is what makes
this game special. A correct outline can still be dull, and still leave the player
only one thing to try. First work out:
- What only this dungeon has: its most unique person, place, theme or story element.
- What the opening or history sets up that no room pays off.
- Which room the player would forget by the next one. Could it sit in another dungeon
  with only the names changed?
- Which rewards or keys take no exploration, creativity or risk to get.
- Which features are only there to look at.

Then make at least two improvements, aimed at what you found. Each one does one of
these:
1. A USABLE WORLD: the player can use something in the place to solve a problem their
   own way. An old cannon can be fired and aimed, at an enemy or a cracked wall.
   Not every feature has to work like this, but most should.
2. ANOTHER SOLUTION: a problem with only one answer gets another. A creature's
   personality, tactic or weakness, or a part of the place, lets a clever player get
   past a danger or win a key some other way.
3. THE UNIQUE THING MATTERS: what only this dungeon has becomes something the player
   can act on, not only hear about.
4. A REAL CHOICE: two things the player wants conflict, or getting one costs something.
5. A CONNECTION: something in one room changes what the player understands or can do
   in another.
6. A PAYOFF: something the opening or history sets up turns out to be there, and matters.
7. A HIDDEN REWARD: a detail hints at something a hurried player would miss.

In why, say what the player can now do, notice or decide that they could not before.
If it only adds mood or scenery, it is not an improvement. Invent from this dungeon, not
from these examples. An improvement may take several edits. Keep every note it touches
true. Add no creatures or treasure: a reward can be knowledge, leverage or a new use for
something already here.

HOW TO ANSWER
Call the tool once. Every edit fills in every field: op, roomA, roomB, fiction, way,
field, group, challenge, keyKind, gotBy, text and why, with "none" for any that does
not apply to that op. Rooms,
fictions, ways and groups go by ref, like room_3, F2, W1 or G1. New wording goes in
text, and only there. why is one real sentence on why the edit helps.
