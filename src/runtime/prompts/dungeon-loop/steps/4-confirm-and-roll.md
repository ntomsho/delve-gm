# Step 4 — Roll confirmation and rolling

The player has been shown what the roll will be (the standard-action confirmation post). Now handle their response. Loop here until they either **cancel** or **confirm** — nothing is rolled and nothing changes until then.

## Read the player's response

Their input — or the automated confirm the interface can send — will be one of:

- a **confirmation** to go ahead,
- a **cancellation** / abandoning the action,
- for an attack, a **clarification** of an outstanding detail,
- an **adjustment or negotiation** for a better roll or a changed action.

Interpret which it is. A clear yes — including the automated confirm input — is a confirmation. If the message is ambiguous, ask them to confirm, adjust, or cancel.

## Confirm → roll

Roll only once nothing is left to clarify.

**Save.** Call the save roll function with:

- the player's **bonus**,
- whether they have **advantage or disadvantage**,
- the **DC** (defaults to 16).

It returns **success or failure.** Hand that result to the next step (resolution).

**Attack.** First make sure all three attack details are settled:

- the **weapon** — an item in their inventory, or an environment object close enough to grab mid-fight, or bare hands;
- whether they strike to **deal damage** or to attempt a **stunt**;
- if they have advantage, whether they spend it **normally** (roll 2d20, drop the lowest) or to **perform a stunt and deal damage** on a hit.

If any of these is still open, ask for it and do not roll. Once all are settled, call the attack roll function — the character's attack bonus (STR for melee, WIS for ranged), the edge, the weapon's damage die, the target's defense, and whether the weapon is well suited to the target — and hand the result to the next step (resolution). If the player spent advantage on stunt-and-damage, pass the edge as none (the advantage went to the combo, not a reroll) and apply the stunt in resolution.

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

Present roll → read response → confirm / cancel / clarify / adjust — and repeat. It continues until the player **cancels** (return to the start of the loop, no state change) or **confirms** (call the roll function; the next step is action resolution).
