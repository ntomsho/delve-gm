# Step 4 — Roll confirmation

The player has been shown what the roll will be (the standard-action confirmation post). Now handle their response. Loop here until they either **cancel** or **take the roll** — nothing is rolled and nothing changes until then.

**You do not roll this one.** The dice for the player's own roll are thrown by the interface, not by you: you settle the terms and put them on the table as a `rollRequest`, the player takes it when they are ready, and the result comes back to you at step 5 already made. Your job in this step is to get the terms right and then get out of the way.

## Read the player's response

The player's message will be one of:

- **taking the roll** — but note that this usually reaches you as the *result*, not as a message: if they simply pressed the button, the next thing you see is step 5 with the dice already thrown;
- a **cancellation** / abandoning the action,
- for an attack, a **clarification** of an outstanding detail,
- an **adjustment or negotiation** for a better roll or a changed action.

So what you handle here is the *talking*. If the message is ambiguous, ask them to adjust or cancel — the roll is already on the table and stays there.

## Settling the terms

The roll goes on the table as a `rollRequest`. Everything in it must be settled before it does.

**Save.** The player's **bonus**, whether they have **advantage or disadvantage**, and the **DC** (defaults to 16; a creature's defense converts to one).

**Attack.** All three attack details must be settled first:

- the **weapon** — an item in their inventory, or an environment object close enough to grab mid-fight, or bare hands;
- whether they strike to **deal damage** or to attempt a **stunt**;
- if they have advantage, whether they spend it **normally** (roll 2d20, drop the lowest) or to **perform a stunt and deal damage** on a hit.

If any of these is still open, ask for it and leave the roll off the table. Once all are settled, the request carries the character's attack bonus (STR for melee, WIS for ranged), the edge, the weapon's damage die, the target's defense and whether the weapon is well suited to it. If the player spent advantage on stunt-and-damage, set the edge to none — the advantage bought the combination, not a reroll — and apply the stunt in resolution.

## Cancel → restart the loop

If the player abandons the attack or the action, change no state. Ask them for a different course of action and return to await input — the start of the loop.

## Adjust or negotiate → update the roll, then re-confirm

The player may argue for a better roll or change their action. If they can articulate a **good reason — especially one that leans on other established entities** — allow it. Reasonable changes include:

- gaining **advantage** on the roll,
- **cancelling out a disadvantage,**
- **changing the equipment** they use,
- or otherwise changing the nature of the action — including **which stat** the roll uses or **which target** they roll against.

Apply the change (recompute bonus, edge, DC or target, or weapon as needed), then present the updated roll and ask them to confirm it. A weak or unfounded reason earns no change — say so plainly and leave the roll as it stood.

Keep the difficulty hidden throughout. Re-present the bonus and the edge; never the DC or the target's defense. A qualitative "this still looks like a long shot" is fine; a number is not.

## The loop

Put the roll on the table → read whatever they say back → cancel / clarify / adjust, and put it back on the table amended. It continues until the player **cancels** (return to the start of the loop, no state change) or **takes it** — at which point the dice are thrown for you and the next thing you see is step 5, holding the result.
