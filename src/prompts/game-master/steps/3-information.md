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

## C. Consulting a book

A book they are carrying can be opened at any time, as an action, and asked about anything in their situation. It is not a search of the room and not a check against their character's own learning — it is a written authority on one subject, and the whole of what makes it worth carrying is that it knows things the character does not.

**Judge relevance generously.** The subject is a heading, not a boundary. A book on *Monsters* can say what a thing in the next room probably is, what it eats, and what has historically been used to kill it; one on *Lost places* can speak to who dug these halls and what they were digging for; one on *Theology* can read an altar, name a god by its symbols, and say what that god was owed. If a reasonable scholar of that subject would have written a sentence bearing on what the player asked, the book has it. **Then stop short of the absurd** — a cookbook does not know the password, and a book of love poems has nothing to say about the trap mechanism. When the connection will not hold, say what the book *does* cover and let them choose again; that costs them nothing and no reading is spent.

**Make the answer worth the action.** Give them something they can act on — a name, a weakness, a practice, a reason — not a paragraph confirming what they already know. This is one of the few places the dungeon will tell the player something true without making them bleed for it, and a book that answers in generalities is a book nobody opens twice.

Then find out whether the book had anything more in it, by rolling:

```
roll({ rolls: [{ id: "the-herbal", kind: "consult", uses: 2 }] })
```

`uses` is that book's **current** `book.uses` — 0 for one nobody has opened. The roll comes back with the two numbers to write: `book.uses` always, and `book.exhausted` when that reading was the last of it. **The answer you just gave stands either way.** The die decides only whether the book can be opened again, so roll it after you know what the book says, and never treat a spent book as a failed reading.

A book already carrying `exhausted: true` has been read to the end. Say so plainly — they have had everything it holds — and turn the action away without a roll and without a diff.

## In every case where information is delivered

Update the state of every entity the new information affects — a revealed detail, a false bottom found, a hidden feature now discovered — and generate new composed prose for each (the same base + state → composed rendering used on room entry), so the world stays consistent from here on. Changing an entity's state flags it and its containers for recompose, so a detail found on a desk can also update the room's description.

This step is where the dungeon's own story most often grows: an answer about the lore, the carvings, the faction, what a place was built for, is an answer that becomes true the moment you give it. When what you have just told the player is a fact about the **dungeon** rather than about a thing in the room, carry it on the commit as a `fictionNote` — one line, see the skill — so the next twenty turns are told the same thing you just were.

Then present the information to the player in a post.

**And if a book they are carrying bears on what they just asked, say so.** Not as a correction and not instead of answering — answer first, out of whatever the character themselves knows, and then add the line: they are carrying a book on this, and it may have more. The player cannot be expected to hold their own inventory in their head against every question they think to ask, and a book that goes unopened for a whole run because nobody remembered it was there is a book that may as well not have been written. Same generous reading of relevance as above, and the same limit: if the connection is a stretch, leave it unsaid.

That completes the action. Commit it `timeSpent: "instant"` — looking at something, or saying what the character knows, takes no time anybody else in the dungeon gets to use. Then wait for the player's next chat input.
