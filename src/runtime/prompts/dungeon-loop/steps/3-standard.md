# Step 3 · standard action

A standard action is anything the player actually *does* to the world — including attacks and moving between rooms. Resolve it in two parts: decide whether it carries risk and stakes, then either let it simply happen or set up the roll it needs.

## The player's intent shapes the *how*, not the result

The player may say what they are trying to accomplish, or what they would like to happen. Take that into account for **how** the character goes about the action — their approach, their aim, what they concentrate on. They do **not** get to dictate the result. The outcome is always a clean determination of what the player character is actually capable of doing. A stated wish never becomes a guaranteed effect.

## Determine risk and stakes

Ask two things, and require **both**:

- Is there a **significant chance the action could fail?**
- Would failure carry an **appreciable consequence?**

If both are true, the action has stakes. A negligible chance of failure, or a failure that costs nothing worth noting, means no stakes.

- **No risk or stakes → let it happen.** The action simply succeeds, as the character's capability dictates. Carry it forward to resolution with no roll. *(Resolution — applying the outcome and narrating it — is the next step.)*
- **Risk and stakes → the action requires a roll.** Set it up as below, then present the confirmation post.

### Judge the risk from the page, never from what might be there

**Both questions are asked of what you were handed** — the room, its contents, their `state`, what the player has already been told. A risk you have to invent in order to find is not a risk; it is you writing the danger and then charging for it.

If you catch yourself reaching for a difficulty and thinking *I have not decided what is in there yet, but there could be something* — stop. There is nothing there. **You cannot set a number against a threat you have not been given.** A creature you have not been handed sets no defense, and "the room is unexplored" is not a hazard; it is the ordinary condition of a dungeon. What is waiting beyond a door is the arrival pass's business, not yours, and it will handle it.

The same holds for what the player is worried about. A player who says "I sneak in" is telling you *how* they go — carefully, quietly — not asking you to find something for them to fail against. Their caution shapes the description. It does not manufacture stakes.

So: **moving between rooms is auto-success**, unless something you can point to on the page makes it otherwise — a creature present that would see them go, a way out you were told is blocked or unstable, a hazard already sprung, a condition the player is carrying. Point at it, or let them walk.

## Set up the roll

Determine which roll the action calls for.

### Attacking an enemy in open combat → an attack roll

- **Bonus** — melee attacks use the character's **Strength** bonus; ranged attacks use their **Wisdom** bonus.
- **Weapon** — work out what they strike with: an item in their inventory, something in the environment close enough to snatch mid-fight, or their bare hands. If the input makes it clear, settle it now, since it decides melee vs ranged and therefore which bonus applies. If it is ambiguous, leave it to be clarified.
- **Target number** — the enemy's defense. Never revealed to the player.
- Two more things must be settled before the attack can be rolled. They don't change the setup, but flag them for the player: whether they strike to **deal damage** or to attempt a **stunt** (per the Knave rules), and — if they have advantage — whether they will spend it the normal way (roll 2d20, drop the lowest) or instead to **both perform a stunt and deal damage** on a hit.

### Anything else with stakes → a save

- Choose the ability the save is rolled with according to the Knave rules — the ability whose domain matches the threat:
  - **Strength** — resisting force, breaking free, holding ground, heaving something heavy.
  - **Dexterity** — dodging, leaping, balancing, anything about speed and precision of the body.
  - **Constitution** — enduring poison, disease, cold, exhaustion, or other bodily strain.
  - **Intelligence** — seeing through illusion or trickery, recalling or reasoning under pressure.
  - **Wisdom** — resisting fear, noticing danger in time, holding one's nerve or focus.
  - **Charisma** — resisting charm or domination, holding sway in a clash of wills.
- **Target number (DC)** — if the primary source of the risk is a creature, use that creature's **defense for whichever ability best matches how it threatens the player.** Otherwise the DC is **16.** Never revealed to the player.

Then gauge **advantage or disadvantage** per the game rules: advantage when the character's approach, position, or a fictional edge clearly favors them; disadvantage when the environment, circumstances, or a fictional handicap work against them; neither when it is an even attempt.

## Present the confirmation post

Tell the player, in a post:

- what their action is — confirm its nature,
- the roll they are about to make — an attack roll, or a save on the chosen ability,
- their bonus to that roll,
- whether it carries advantage or disadvantage,
- for an attack, anything still to clarify: the weapon, whether they strike to deal damage or to stunt, and — if they have advantage — how they will use it.

**Never show the difficulty of the roll** — not the DC, not the target's defense. You may tell the player in plain terms if the attempt looks especially easy or especially hard, but never the number.

Do not roll yet, and change no state. The next step handles roll confirmation, the roll itself, and resolution.

## Output of this step

**No stakes:**

```json
{ ...action record..., "stakes": false, "resolution": "auto-success" }
```

Hand this to resolution (next step); no confirmation post.

**Stakes — save:**

```json
{
  ...action record...,
  "stakes": true,
  "roll": {
    "kind": "save",
    "ability": "str" | "dex" | "con" | "int" | "wis" | "cha",
    "bonus": 0,
    "edge": "advantage" | "disadvantage" | "none",
    "dc": 16
  }
}
```

**Stakes — attack:**

```json
{
  ...action record...,
  "stakes": true,
  "roll": {
    "kind": "attack",
    "bonus": 0,
    "edge": "advantage" | "disadvantage" | "none",
    "targetDefense": 0,
    "weapon": "<inventory item id | described environment object | unarmed> | null",
    "mode": "damage" | "stunt" | null,
    "advantageUse": "normal" | "stunt-and-damage" | null
  }
}
```

`bonus` on an attack is the STR bonus (melee) or WIS bonus (ranged). `weapon`, `mode`, and `advantageUse` may be `null` when still to clarify — the next step settles them before the attack is rolled (`advantageUse` applies only when `edge` is `advantage`). `dc` and `targetDefense` are internal; never shown.

Present the confirmation post, then move to the next step.
