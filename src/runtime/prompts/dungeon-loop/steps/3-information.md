# Step 3 · information action

An information action has no risk or stakes; the player is only trying to learn something. Two forms arrive here — an open question about the world, or an inspection of something present. Resolve whichever fits.

## A. An open question about a general fact of the world

The player asks about the world at large rather than a thing in front of them — lore, history, a name, a rumor, whether something is a known danger. ("What do I know about the Worm cult?", "Is red moss like this poisonous?")

Decide whether the player's character, from their own fiction — their traits, their background, and anything they have lived through in this dungeon — would reasonably know anything about it.

- **If they would:** tell them what their character knows. Then update the state of anything the new knowledge bears on — often nothing, but sometimes it recontextualizes an entity the party has already seen. *(This part of the system may change later.)*
- **If they wouldn't:** tell them their character doesn't know anything about it, and ask them for a different course of action. Change no state. Return to await input.

## B. Examining or asking about something present

The player inspects, or asks about, something they can see or have already encountered. Work out what the character perceives, at one of two depths:

- **Cursory inspection** — what is immediately apparent, plus anything that could reasonably be gleaned by simple, low-effort means **that wouldn't trigger a hazard or provoke a serious reaction from any creature present.** Cursory covers reasonable minor moves: stepping closer, picking the thing up, rapping on it, trying a doorknob, skimming part of a book.
- **Directed inspection** — if the player names a particular *method*, a specific *element* they are studying closely, or something specific they are *looking for*, you may reveal things a cursory glance would miss — including details that were held back as mere clues — **as long as their method and focus are reasonably on track.** An apt, specific approach is rewarded; a scattershot or wrong-headed one turns up only what cursory inspection would.

This is the found side of the hidden-as-clue rule from room entry: a directed look along the right track turns a clue into the thing itself. A hidden thing surfaced this way is now discovered — set its `isHidden` to false, update its state to say what the player has just uncovered, and write its `composed` for the first time. Room entry deliberately left that blank, because until now there was nobody who could see it.

## In every case where information is delivered

Update the state of every entity the new information affects — a revealed detail, a false bottom found, a hidden feature now discovered — and generate new composed prose for each (the same base + state → composed rendering used on room entry), so the world stays consistent from here on. Changing an entity's state flags it and its containers for recompose, so a detail found on a desk can also update the room's description.

This step is where the dungeon's own story most often grows: an answer about the lore, the carvings, the faction, what a place was built for, is an answer that becomes true the moment you give it. When what you have just told the player is a fact about the **dungeon** rather than about a thing in the room, carry it on the commit as a `fictionNote` — one line, see the skill — so the next twenty turns are told the same thing you just were.

Then present the information to the player in a post.

That completes the action. Wait for the player's next chat input.
