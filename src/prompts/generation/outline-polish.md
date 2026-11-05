You are reviewing a finished outline of a dungeon. Change only what clearly makes
the dungeon better. If it is already good, return no edits. At most {{maxEdits}}
edits:

- swap_fictions: two rooms trade fictions (roomA, roomB)
- swap_cards: two rooms trade cards (roomA, roomB)
- replace_fiction: a room takes an unused optional fiction (roomA, fiction)
- rewrite_story, rewrite_journey: a room's note (roomA, text)
- set_story_feature: add or rewrite a room's scenery (roomA, text)
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
- Is there any way you could make this dungeon more interesting, more unique, or more
  fun to play through?

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

HOW TO ANSWER
Call the tool once. Every edit fills in every field: op, roomA, roomB, fiction, way,
field, group, challenge, keyKind, gotBy, text and why, with "none" for any that does
not apply to that op. Rooms,
fictions, ways and groups go by ref, like room_3, F2, W1 or G1. New wording goes in
text, and only there. why is one real sentence on why the edit helps.
