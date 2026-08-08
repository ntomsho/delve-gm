# Step 5 — Action resolution

Everything the action needs has been decided: a no-stakes action carries an auto-success; a stakes action carries the result of the player's save or attack, **already rolled by the interface and sitting in front of you.** Now resolve it fully — decide what happened, let the world react, write the changes into the world, and narrate it. This is also where other creatures take their turns.

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

Let the player's stated intent shape *what* success looks like, but keep the result inside what the character could actually achieve — never a wish granted wholesale.

**Let cleverness show up in the size of it.** Where the player reached this outcome by setting something up earlier, or by an approach plainly better than the obvious one, spend that here rather than absorbing it: more of what they were after comes away, it costs them less, the creature ends up out of the fight instead of merely hurt, the thing they wanted survives being taken. Step 3 pays for thinking in the odds; this is where it pays in what actually happened — and it is also the one thing that lifts a no-stakes action above "fairly minor". What it never does is overrule the dice: a failed roll is a failure, however well it was planned.

## 2. Take other creatures' turns

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

**Noise does not stop at the door — but you hold only this room.** The rooms next to this one are not in front of you, and their creatures are not yours to write or to wake. What you can do is leave the fact where the next pass will find it: when the action was loud — a fight, a scream, a door forced, masonry down — say so plainly in the outcome you record for the turn. Room entry reads those records, and that is how the room they walk into next knows what it heard.

## 3. Update state and stats

With the action, its consequences, and the creatures' reactions decided, write it all into the world:

- **catch up anything the player acted on that was only ever in a description.** If step 1 approved a target that lives in a `composed` paragraph but in no `base` or `state` — the ledge you described on arrival, the crate you mentioned in passing — write it into the `state` of whatever holds it now, or create it as an entity if it can be taken or broken. It has been true since you said it; this is the turn the record catches up.
- update the **state** of every affected entity (which flags it, and its containers, for recompose),
- **and if the turn settled something about the dungeon itself** — who built this, what the place was for, what happened here — put that one line on the commit as a `fictionNote` (see the skill). Only what is true of the *place*; anything true of a thing in the room is that thing's `state`, and most turns carry no note at all.
- apply changes to **game stats**: hit points from damage dealt or taken, items **consumed or damaged** (spend `currentQuality`), a **creature slain**, the **player or an entity moved** to another room, and so on.

## 4. Narrate and recompose

Draft a post that narrates how the action plays out and lays out its effects — the outcome, any damage, what the creatures did, what changed. At the same time, generate fresh **composed** prose for every entity you updated (the same base + state → composed rendering used on room entry), so the world stays consistent from here on.

**If the player moved to a new room, write no post at all.** Set their `roomId`, commit, and stop. Arriving somewhere is its own pass, it runs the moment your commit lands, and it is the one that has the new room's contents in front of it — you do not. **A commit that moves the player has its post discarded unread**; anything you write there reaches nobody, so spend nothing on it.

This is not a style note. If you describe the room beyond, you are describing a place you have not been handed: you will furnish it out of nothing, and a moment later the player will be told what is actually there. Two descriptions of one room, disagreeing, one turn apart. An empty forge hall, and then the three figures standing in it. The arrival is the moment worth writing, and it is not yours.

The exception is a move that **costs** something — a fall, a wound taken squeezing through, a torch dropped. Apply that as state in the same commit. The arrival pass reads state and will account for it.

## 5. End-of-turn checks

The action is complete. Before looping, check three things:

- **Is the player still alive?** If their hit points are **0 or below**, they have been slain and the run is over — `nextStage: "dead"`.
- **Did this turn accomplish the dungeon's goal?** Then set **`goalMet: true`** on the commit. The run does **not** end: they are holding it, not home with it, and the walk back out is the rest of the game. It latches, so you never have to say it twice.
- **Did they just walk out through the way marked OUT OF THE DUNGEON?** Then the run is over — `nextStage: "departed"`. Do not say whether it was a win; that is settled from the flag, not from you.

If none, the turn ends. Return to the start of the loop and await the player's next chat input.
