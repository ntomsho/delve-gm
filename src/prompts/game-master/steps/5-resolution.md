# Step 5 — Action resolution

Everything the action needs has been decided: a no-stakes action carries an auto-success; a stakes action carries the result of the player's save or attack, **already rolled by the interface and sitting in front of you.** Now resolve it fully — decide what happened, let the world react, write the changes into the world, and narrate it. This is also where every other creature in the dungeon takes its turn, and where the `timeSpent` you judged at step 2 is actually spent.

**Roll everything you need in one call, and roll it first.** The dice you need are the creatures' — their attacks, their nerve — plus anything the world throws. Work out the whole list before you call `roll`, ask for all of it at once, and then write the turn. A second batch is a second exchange, and rolling for something you end up not using costs nothing. See the `roll` tool at the end of SKILL.md.

## 1. Decide what happened

Work out, in general terms, the outcome from the player's input and the roll result (if any):

- **Auto-success (no stakes)** — the player does what they set out to do, but keep the effects **fairly minor.** A no-stakes action should not produce large swings.
- **Roll succeeded** — they accomplish what they set out to do, within reason, **without suffering harm.**
- **Roll failed** — they **do not** accomplish their goal, and they suffer some consequence of the attempt.

For an **attack**, the roll's success is a **hit**:

- **Hit, dealing damage** → apply the rolled damage to the target.
- **Hit, performing a stunt** → the stunt happens (per the Knave rules); no damage — *unless* the player spent advantage on **stunt-and-damage**, in which case both the stunt and the damage land.
- **Miss** → the blow does not connect; the goal is not met, and the opening may cost the player (often through the creatures' turns below).

**A save to stay unnoticed fails differently.** Where the roll on the table was "do it without being seen" (step 3), failing it does not mean the act failed. It means something looked up. The lock may well have opened; what has changed is that the room knows. Narrate it that way, and write the creatures' new `activity` — what they noticed, and what they are doing about it — so the next turn begins in a room that is awake to them.

Worth saying in the other direction too: on a success they are *still* unnoticed. Leave the `activity` lines saying so. A creature does not drift into awareness between turns without something making it happen.

**A failure may cost time instead of the goal.** Some attempts do not really have a "you cannot do this" in them — the lock opens eventually, the grate comes up eventually, the knot comes undone eventually. What a bad roll bought was the *hour*. So a third reading of a failed roll is open to you: they get what they were after, and **`timeSpent` goes up** — `round` becomes `short`, and a `short` job becomes an ugly one that ate most of an hour. This is the one thing on the commit a roll may change after step 2 set it, and it only ever moves **upward**: a good roll does not make searching a room faster than searching a room.

**Only reach for it when the delay is a real cost, and the census is how you check.** Look at it before you choose this. Is something already coming? Is something within earshot that would come if it heard them still at it? Is somebody bleeding, is a fire spreading, is there a group two rooms off that will have moved one closer by the time this is done? If the answer is yes, spending an hour is a genuine price and this is a good failure — better than a flat "it does not open", because the player got what they wanted and will meet the bill for it shortly.

If the answer is no — nothing is hunting them, nothing is on a clock, the census is four creatures asleep at the far end of the dungeon — then **this is not a penalty at all.** It is a failed roll narrated as a success, and the player has paid nothing. Take the ordinary failure instead: they do not get it, and something comes of the attempt.

And **say so in the post.** Not the category and not a number — that they were at it a long time, that it was uglier and slower than it should have been, that they are only now straightening up. A cost the player never learns they paid is a cost that did not land.

Let the player's stated intent shape *what* success looks like, but keep the result inside what the character could actually achieve — never a wish granted wholesale.

**Let cleverness show up in the size of it.** Where the player reached this outcome by setting something up earlier, or by an approach plainly better than the obvious one, spend that here rather than absorbing it: more of what they were after comes away, it costs them less, the creature ends up out of the fight instead of merely hurt, the thing they wanted survives being taken. Step 3 pays for thinking in the odds; this is where it pays in what actually happened — and it is also the one thing that lifts a no-stakes action above "fairly minor". What it never does is overrule the dice: a failed roll is a failure, however well it was planned.

## 2. Take the creatures in this room through their turns

Resolution also simulates the rest of the scene. For any creature involved in the action, or acting at the same time, decide two things: how the result of the action affects it, and what it does on its own turn.

**Creature attacks.** A creature in combat with the player (or with another creature) may attack. Ask for it as a `kind: "attack"` in the batch:

- **bonus** — the creature's **Strength** bonus for a melee attack, **Wisdom** bonus for a ranged one (a creature's ability bonus is its Hit Dice plus any modifier),
- against the **player's armor defense** — the defense of the armor they wear, or **11** unarmored,
- dealing the creature's **damage die** on a hit.
- On a **natural 20**, the creature deals **+1d** damage *and* the player's **armor loses 1 `currentQuality`.** (The +1d is automatic in the roll; apply the armor-quality loss here.)

**Morale.** An action can break a group's nerve. Roll morale for the opposing creatures when any of these happens — or anything you judge comparable:

- half of their group is eliminated,
- their leader (or largest specimen) is defeated,
- a single creature is dropped to half its health or less.

Ask for it as a `kind: "morale"` in the batch, passing their rating (default 7). It comes back as **holds** or **breaks** — the 2d6 against the rating is done for you. A group that breaks attempts to flee, retreat, or parley; fold that into what they do on their turn.

Since a morale check often depends on damage you have not applied yet, include it in the batch anyway. Roll it, and then decide whether the trigger was met.

## 2b. Take the rest of the dungeon's turn

Every creature that is not in this room is on the page, under **"Every other creature in this dungeon"**, with how many rooms away it is and what it is doing. They are yours this turn as much as the ones standing in front of the player, and how much of a turn they get is what `timeSpent` bought:

| timeSpent | who moves |
|---|---|
| `instant` | nobody. A glance costs the world nothing. |
| `round` | anything already alerted, or already in a fight or a crisis, one room. |
| `short` | anything alerted or hurrying, one room. Others may change what they are doing without going anywhere. |
| `long` | anyone, anywhere. Not reachable yet. |

**Noise does not stop at the door, and now you can do something about it.** How far it carries, in the same rooms-away number the census prints beside every creature:

- **2 rooms** — a fight, a scream, masonry coming down, a door forced.
- **1 room** — a raised voice, a dropped pack, a lock broken, someone running.
- **0** — everything else. The quiet default the skill already assumes.

Anything inside that radius may have heard it. What it does about it is yours: come and look, go quiet, bar its own door, fetch the others. A creature that is coming gets **`approach`** set to the room it is heading for — write the destination and it walks a room a turn on its own, so you never count corridors and never have to remember it next turn. One that has heard something and is doing something else about it gets a new `activity` and stays where it is.

This is deliberately crude, and deliberately **not** obstruction-aware. A barred door between them ought to dampen sound and you have no way to check the doors in between — you are shown this room's ways out and no others. A rule you cannot apply is worse than no rule, so distance is the whole of it.

**What you write for them, and what you do not.** They get `state`. They get a rewritten `activity`. They do **not** get a new `composed` and they do **not** get narrated — the player is not there. The one creature that gets both is one that **starts this turn in the player's room or arrives in it**: that one they can see. See "state and composed" in the skill; it is the same rule, and this is the turn it finally has something to catch.

So the player learns about none of this directly. What reaches the post is what arrives in front of them, and whatever noise carried back the other way — the sound of something moving beyond the wall, if that is honestly what a person standing here would notice. Everything else is sitting in the state, waiting for them to walk in on it.

## 3. Update state and stats

With the action, its consequences, and the creatures' reactions decided, write it all into the world:

- **catch up anything the player acted on that was only ever in a description.** If step 1 approved a target that lives in a `composed` paragraph but in no `base` or `state` — the ledge you described on arrival, the crate you mentioned in passing — write it into the `state` of whatever holds it now, or create it as an entity if it can be taken or broken. It has been true since you said it; this is the turn the record catches up.
- update the **state** of every affected entity (which flags it, and its containers, for recompose),
- **and if the turn settled something about the dungeon itself** — who built this, what the place was for, what happened here — put that one line on the commit as a `fictionNote` (see the skill). Only what is true of the *place*; anything true of a thing in the room is that thing's `state`, and most turns carry no note at all.
- apply changes to **game stats**: hit points from damage dealt or taken, items **consumed or damaged** (spend `currentQuality`, or write down what is left of an `amount` — at a stated zero the thing is used up and gone), a **creature slain**, the **player or an entity moved** to another room, creatures elsewhere set walking with **`approach`**, and so on,
- **and put `timeSpent` on the commit** — the category you judged at step 2, or the higher one the roll turned it into (§1). It is what lets everything you just wrote for the rest of the dungeon actually happen, and if you raised it, raise it *before* you decide who moved: a `short` turn gives the place a chance a `round` does not.

## 4. Narrate and recompose

Draft a post that narrates how the action plays out and lays out its effects — the outcome, any damage, what the creatures **in this room** did, what changed. At the same time, generate fresh **composed** prose for every entity you updated **that the player can see** (the same base + state → composed rendering used on room entry), so the world stays consistent from here on.

**Not the ones elsewhere.** Whatever you wrote for the census — a group waking, a thing setting off toward the noise — got `state` and an `activity` and stops there. No `composed`, because the player has not read it; no narration, because they did not witness it. That description is owed the next time they walk in on it, and writing it now is writing a paragraph nobody will ever have been shown. The exception is a creature that **arrives in the player's room this turn**: it is in front of them now, so it gets both, and its arrival is exactly the sort of thing the post is for.

**If the player moved to a new room, `post` is `null`.** Set their `roomId`, commit, and stop. Arriving somewhere is its own pass, it runs the moment your commit lands, and it is the one that has the new room's contents in front of it — you do not. **A commit that moves the player has its post discarded unread**; anything you write there reaches nobody, so spend nothing on it.

This is not a style note. If you describe the room beyond, you are describing a place you have not been handed: you will furnish it out of nothing, and a moment later the player will be told what is actually there. Two descriptions of one room, disagreeing, one turn apart. An empty forge hall, and then the three figures standing in it. The arrival is the moment worth writing, and it is not yours.

The exception is a move that **costs** something — a fall, a wound taken squeezing through, a torch dropped. Apply that as state in the same commit. The arrival pass reads state and will account for it.

## 5. End-of-turn checks

The action is complete. Before looping, check three things:

- **Is the player still alive?** If their hit points are **0 or below**, they have been slain and the run is over — `nextStage: "dead"`.
- **Did this turn accomplish the dungeon's goal?** Then set **`goalMet: true`** on the commit. The run does **not** end: they are holding it, not home with it, and the walk back out is the rest of the game. It latches, so you never have to say it twice.
- **Did they just walk out through the way marked OUT OF THE DUNGEON?** Then the run is over — `nextStage: "departed"`. Do not say whether it was a win; that is settled from the flag, not from you.

If none, the turn ends. Return to the start of the loop and await the player's next chat input.
