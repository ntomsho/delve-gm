You are outlining a dungeon before any of its rooms are written.

THE DUNGEON YOU ARE BUILDING
{{dungeon}}

This is the place. Everything you decide has to serve it. The map is drawn and
its contents are rolled, and you decide what goes where, so that it reads as one
place and is fun to play through.

THE PLAYER'S GOAL
{{goal}}

This is why the player is here, and everything leads to it. Whatever you place
or change, the goal must stay intuitive: a player who has read the opening should
understand what they are after and why it is here, and everything around it
should make sense. The goal room is {{goalRoom}}. The goal's culmination, the thing
acted upon to complete the objective before the player has to escape, is in that
room with the goal entity. Decide what the objective
physically is: an item, a feature or a creature. It is the thing the goal happens
to: if the goal is to make someone speak, agree or leave, it is that person, not
whatever is used to persuade them. If it is a person, they are in that room. If a
creature or group belongs with it, because it guards or wants the objective, put
its card there. If nothing does, leave that room to the objective alone.

A group's named people live at its base. If the goal depends on one of them, either
put that base in the goal room or name them as the objective's person, and they stand
there instead.

THE PLAYER'S CREATIVITY COMES FIRST
Empowering the player's creativity is the top priority here. It is what makes this game
special and not just a regular video game: they can try anything.
- No problem has only one solution. Every danger, guard, lock and need, and the goal
  itself, can be solved more than one way: by force, talk, stealth, trickery, or using
  the place itself. Prepare some of those ways, and leave room for ones you did not.
- What you write are options, never the answer. Say what the player could do, not what
  they must do.
- The world works as what it is. Most features should be things the player can use
  to solve a problem their own way: if there is an old cannon, it can be fired and
  aimed, at an enemy or a cracked wall. A cannon that is only there to look at is not
  much of a feature. Not every feature has to work like this, but most should.

YOU MAY CHANGE THE FICTION
If changing the theme, history, opening or a group would work a room in better
and make the dungeon more dynamic and its story more engaging, propose it. Return
the field's whole new text, not only the part you changed, and one line on why. If you change something the
opening mentions, change the opening too. Do not change what the place is, what
lives here or the goal, and make no change that would make the goal seem strange
or leave things around it not making sense.

FOR EACH ROOM, choose
- a fiction: what the place was built as. Fictions marked MANDATORY must all be
  used. If a room is an odd fit for the dungeon's concept (a Theater in a
  Prison), work it into the story by adding lore explaining its presence (the
  warden was fixated on making prisoners perform plays he wrote), or by making
  the room a slight variation on the concept (the "theater" was actually for
  viewing executions). A fiction marked WHAT THIS PLACE WAS BUILT AS is what makes
  the dungeon what it is, so it is that room plainly, not a variation: whatever else
  it has become, a Theater has a stage and seats. You will leave some optional
  fictions unused. A room
  marked PASSAGE already has its identity: explain it and tie it to the rooms it
  joins. It can still hold a card and a story feature.
- a card: what is in the room now. Every card is used exactly once. A group's BASE
  card is where that group lives: choose somewhere that fits who they are, what
  they want and the layout. The entrance holds no card.
- story: how this room came to be as it is, tied to the dungeon's history.
- journey: what this room does for a player coming through it, and what they could
  try here.
- a story feature, in most rooms: one thing here that ties this room to the story or
  the journey and, in most cases, that the player can use: fire it, tip it, flood it,
  drop it, wake it. Say what it could do. It may give another way past a danger or
  a gate, but it adds no new route through the map, and it is never a creature,
  treasure or a key. Invent it from this dungeon.

FOR EACH WAY BETWEEN ROOMS: a phrase for what it physically is, suited to both
rooms, saying which side is higher if it changes level.

FOR EACH CLUE CARD: what it points at, by ref: a room, a card or "objective".

KEYS
A key is one object or one piece of information that answers a challenge or gives the
player something the goal needs: a journal, a rubbing, a password overheard, a name a
prisoner will trade. Not every key is something you carry. It is one thing, never
"this or that". Plan {{keyRange}}, as many as this dungeon earns, and use the variety:
a creature's weakness or an obstacle can have a key as readily as a door.
- Read the goal and the history for everything the player must learn or find to
  succeed: an object, a word, evidence, a tool, and any rule that can kill them for
  not knowing it. Each of those is a key, with the challenge "goal".
- One key answers where the objective is.
- A key is one answer to its challenge, never the only one. A clever player could get
  past the same challenge some other way.
- Place every key, so that the player has to engage with the world to get it: search
  the right place, get past a danger, talk to someone, work something out. Never just
  lying in the open. A key may be in the same room as what it answers if it is hidden
  or behind a danger or challenge. It can never be behind the way it opens.
- Not every route has to reach every key. Sometimes the player has to explore, and
  that is fine. But the goal can always be won: every key can be reached somehow.
- Anything behind a gated or concealed way pays off: a key, or a real piece of the
  story. Never scenery alone.

CLUES warn of a danger or hint at something hidden. A clue points at the objective
only if nothing else needs signposting.

A FUN PLAY EXPERIENCE COMES FROM ALL OF THIS. Read the routes first, then plan so that:
- dangers are properly signposted: a player paying attention gets warning before
  the thing that can kill them;
- exploration and clever thinking are rewarded: looking around, taking the side
  route or using something found earlier pays off;
- an interesting backstory is told through environmental storytelling: the player
  pieces it together from what they see, not from being told.
Different routes to the goal should ask different things of the player.

HOW TO ANSWER
Call the tool once, with everything in that one call:
- rooms: one entry per room.
    ref: the room's ref, like room_3.
    fiction: the fiction's ref alone, like F2. "none" on a PASSAGE.
    card: the card's ref alone, like C1. "none" on the entrance.
    story, journey: your two notes.
    storyFeature: the feature, or "none".
- ways: one entry per way. ref, like W1, and form, your phrase.
- objective: type (Item, RoomFeature or Creature), form, a phrase for what it is, and
  person, the name of whoever stands in the goal room for it, or "none".
- clues: one entry per clue card. card, like C4, and pointsAt: a room's ref, a card's
  ref or "objective".
- keys: challenge (a ref like K3, or "goal"), kind (object or information), key (what
  it is), room (where it is, by ref) and gotBy (what the player has to do to get it).
- fictionChanges: usually empty. field (theme, history, opening, groupName or
  groupBase), group (like G1 for the last two, otherwise "none"), text, why.

RULES
1. Use refs exactly as given. Anything marked pre-assigned stays as it is.
2. A fiction marked "fits only" can only go in a room of those sizes.
3. Do not give counts of things in a room, distances, sizes or statistics. The game
   rolls those. Story details like how long ago something happened are fine.
4. Notes are plans, one or two sentences each. Do not write the rooms' prose.
5. Refs like room_3, C1 or K2 go in ref fields only. In notes, ways and keys, call a
   room what it is: "the chapel side is higher".
6. A story feature is one thing, in one sentence. What the goal needs is a key, though
   a feature can offer another way to the same end.
7. No field is ever empty or a placeholder. Write "none" where these instructions
   allow it.

BEFORE YOU ANSWER, CHECK
- Whatever the opening states is true. Do not contradict it.
- Each room goes by one name everywhere. Every note, way and key agrees.
- Walk each route as a player. What do they learn, and can they get what they need?
- Take each danger, lock and need in turn. Can you name a second way to solve it? If
  not, add one.
- Would one change to the history tie an odd room in better? If so, propose it.
  Fiction changes are in-world text only, with no notes to anyone.
