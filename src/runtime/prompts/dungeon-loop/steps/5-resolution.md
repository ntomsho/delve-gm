# Step 5 — Action resolution

Everything the action needs has been decided: a no-stakes action carries an auto-success; a stakes action carries the result of a save or attack roll. Now resolve it fully — decide what happened, let the world react, write the changes into the world, and narrate it. This is also where other creatures take their turns.

The roll functions used below are provided by the runtime (`dungeon-rolls`): `saveRoll`, `attackRoll`, `moraleRoll`.

## 1. Decide what happened

Work out, in general terms, the outcome from the player's input and the roll result (if any):

- **Auto-success (no stakes)** — the player does what they set out to do, but keep the effects **fairly minor.** A no-stakes action should not produce large swings.
- **Roll succeeded** — they accomplish what they set out to do, within reason, **without suffering harm.**
- **Roll failed** — they **do not** accomplish their goal, and they suffer some consequence of the attempt.

For an **attack**, the roll's success is a **hit**:

- **Hit, dealing damage** → apply the rolled damage to the target.
- **Hit, performing a stunt** → the stunt happens (per the Knave rules); no damage — *unless* the player spent advantage on **stunt-and-damage**, in which case both the stunt and the damage land.
- **Miss** → the blow does not connect; the goal is not met, and the opening may cost the player (often through the creatures' turns below).

Let the player's stated intent shape *what* success looks like, but keep the result inside what the character could actually achieve — never a wish granted wholesale.

## 2. Take other creatures' turns

Resolution also simulates the rest of the scene. For any creature involved in the action, or acting at the same time, decide two things: how the result of the action affects it, and what it does on its own turn.

**Creature attacks.** A creature in combat with the player (or with another creature) may attack. Roll it with `attackRoll`:

- **bonus** — the creature's **Strength** bonus for a melee attack, **Wisdom** bonus for a ranged one (a creature's ability bonus is its Hit Dice plus any modifier),
- against the **player's armor defense** — the defense of the armor they wear, or **11** unarmored,
- dealing the creature's **damage die** on a hit.
- On a **natural 20**, the creature deals **+1d** damage *and* the player's **armor loses 1 `currentQuality`.** (The +1d is automatic in the roll; apply the armor-quality loss here.)

**Morale.** An action can break a group's nerve. Roll morale for the opposing creatures when any of these happens — or anything you judge comparable:

- half of their group is eliminated,
- their leader (or largest specimen) is defeated,
- a single creature is dropped to half its health or less.

A morale roll is **2d6 against the creatures' morale rating** (default 7). If the roll comes up **higher** than their morale, they break — attempting to flee, retreat, or parley. Fold that into what they do on their turn.

## 3. Update state and stats

With the action, its consequences, and the creatures' reactions decided, write it all into the world:

- update the **state** of every affected entity (which flags it, and its containers, for recompose),
- apply changes to **game stats**: hit points from damage dealt or taken, items **consumed or damaged** (spend `currentQuality`), a **creature slain**, the **player or an entity moved** to another room, and so on.

## 4. Narrate and recompose

Draft a post that narrates how the action plays out and lays out its effects — the outcome, any damage, what the creatures did, what changed. At the same time, generate fresh **composed** prose for every entity you updated (the same base + state → composed rendering used on room entry), so the world stays consistent from here on.

**If the player moved to a new room** as part of the action, run that room the way the entrance room was run: collect its entities, compose anything whose `composed` is stale (`needUpdate`), bottom-up to the room itself, and include a description of the new location in the post.

## 5. End-of-turn checks

The action is complete. Before looping, check two things:

- **Is the player still alive?** If their hit points are **0 or below**, they have been slain and the run is over. *(Exactly what happens then is deferred until the app is built.)*
- **Has the goal been met?** If the player has accomplished the dungeon's goal, the run is over as well.

If neither, the turn ends. Return to the start of the loop and await the player's next chat input.
