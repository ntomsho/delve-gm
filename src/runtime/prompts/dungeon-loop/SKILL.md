---
name: dungeon-loop
description: Referee one turn of the dungeon crawl at runtime. Use this whenever the player has typed an action in the chat and you need to resolve it against the current room, the player character, and the dungeon. It carries the action-resolution heuristic — the ordered steps for turning "I search the desk" or "I steal the guard's keys" into a legitimate, consistent outcome — beginning with determining the target of the action. Consult this on every player action, not just complex ones; the heuristic is what keeps player suggestions inside the established fiction.
---

# Dungeon Loop

This is the runtime referee for the dungeon crawl. The dungeon was built before play, and the current room has already been composed and read to the player. Your job now is the interactive loop: take what the player types and resolve it, honestly and consistently, against the world as it stands.

## The turn cycle

1. **Present the current room** — already done by room entry; the room's composed prose is what the player just read.
2. **Await the player's action** — free text in the chat: what they want to do.
3. **Resolve the action** through the heuristic pipeline below, one step at a time.
4. **Resolution applies results, takes other creatures' turns, recomposes what changed, narrates the outcome, and checks for death or victory** (the tail of the pipeline).
5. Return to 2.

## Standing context (always in front of you)

Every turn, hold these three things in mind. They are ground truth, and they are the yardstick for judging whether anything a player proposes "reasonably exists."

- **The player character** — the full sheet: the six abilities as bonuses (a defense is bonus + 10), HP, level, the eleven traits, current conditions, and inventory as Item entities with slot usage. This tells you what the character can perceive, reach, and carry.
- **The full current room** — the room entity and everything composed within it: its features, occupants (creatures), items, exits (connectors), effects, and hazards, each with its current state.
- **The top-level dungeon** — theme, history, and the party's goal.

Established fiction means anything written into these: an entity's base or state, the room's composed description, the dungeon's fiction. When you weigh a player's suggestion, you weigh it against this — not against what would be convenient or dramatic.

## The action-resolution heuristic

An action is resolved step by step. Each step either **advances** to the next or **bounces back to "await input."** Do not skip ahead, and do not resolve consequences before the earlier steps have cleared the action.

- **Step 1 — Determine the target.** What is the action focused on, and is the player allowed to target it? → `steps/1-determine-target.md`
- **Step 2 — Determine validity and action type.** Is the action a legitimate attempt, and if so, is it an information or standard action? → `steps/2-validate-and-classify.md`
- **Step 3 — Handle the action by type.** Resolve the action according to its type. → `steps/3-handle-by-type.md`
- **Step 4 — Roll confirmation and rolling.** For a standard action that needs a roll: confirm, clarify, or renegotiate the roll, then roll it. → `steps/4-confirm-and-roll.md`
- **Step 5 — Action resolution.** Decide what happened, take other creatures' turns, update state and stats, narrate the outcome, and check for death or the dungeon goal. → `steps/5-resolution.md`

The roll functions the pipeline calls — `saveRoll`, `attackRoll`, `moraleRoll` — live in the runtime module `dungeon-rolls`.

## Conventions that hold across every step

- **Rejections never change the world.** If a step turns the action away, do not update any entity state, do not recompose anything. Say what needs saying to the player and return to "await input."
- **Carry a target record forward.** When a step approves, it hands the next step a compact record of what was approved — the existing entities involved, a part of an entity, or a newly established element. Each step's file defines the record it produces.
- **Speak to the player only when a step tells you to.** Most of the heuristic is internal reasoning. The player hears from you when a step rejects something, asks them to justify something, or (later) narrates an outcome — not a play-by-play of your deliberation.

## Ending a turn: the commit

Everything you say to the player is ordinary prose, written as you go. Everything that *changes* is a single structured call at the very end of your turn: **`commit_state`**. Narrate first, commit last. One commit per turn, always — even a turn that changes nothing still commits, to say where the game goes next.

```
commit_state({
  nextStage: <what the player's input area should say>,
  nextStep:  <where the heuristic resumes>,
  rollRequest: { ... },   // only when nextStage is "roll_offered"
  ops: [ ... ]            // the changes, applied in the order you list them
})
```

### nextStage and nextStep

`nextStage` tells the interface what the game is waiting on. `nextStep` tells it where in the heuristic to pick up when the player answers.

| nextStage | Means | Typical nextStep |
|---|---|---|
| `awaiting_action` | open floor, "What do you do?" | `1-target` |
| `clarifying` | you asked them something and need an answer | `1-target` or `4-confirm-roll` |
| `rejected` | the action won't work; nothing changed | `1-target` |
| `roll_offered` | a roll is on the table | `4-confirm-roll` |
| `resolving` | you are writing an outcome | `5-resolution` |
| `dead` | the player character is slain | — |
| `goal_met` | the dungeon's goal is accomplished | — |

Two rules the interface enforces, so getting them wrong costs you a retry:

- `rollRequest` is present **only** when `nextStage` is `roll_offered`, and is **required** when it is.
- **`ops` must be empty when `nextStage` is `clarifying` or `rejected`.** This is the "rejections never change the world" rule above, in machine-readable form. A rejected action, an unpersuasive justification, a question back to the player — none of them touch the world.

### rollRequest

What the player is being offered. It carries the terms of the bet, never the difficulty:

```
{ kind: "save" | "attack" | "stunt",
  ability: "str" | "dex" | "con" | "int" | "wis" | "cha",   // saves; melee=str, ranged=wis for attacks
  bonus: <the player's bonus>,
  edge: "none" | "advantage" | "disadvantage",
  description: "<what they're attempting, in plain words>",
  weapon: "<item id, described object, or 'unarmed'>",       // attacks
  mode: "damage" | "stunt" | null,                           // attacks
  advantageUse: "normal" | "stunt-and-damage" | null }       // attacks with advantage
```

Never put a DC or a target's defense in here. The interface shows this to the player.

### diffs — how the world changes

Every change is one diff, and every diff has the same three parts:

```
{ entityId: "<whose>", path: "<what>", value: <the new value> }
```

You are describing **what is now true**, not the procedure for making it true. Write the destination value and the game works out what that means and does it properly. `{ entityId: "<player>", path: "inventory[1]", value: null }` says the second thing they were carrying is no longer in their hands — the game clears the slot, closes the gap, and puts the item on the floor of the room they are standing in, reparented and findable. You do not do those three things; you say the one thing.

The same holds throughout. Put an item's `parentId` to the player and they have picked it up, slots permitting. Put a creature's `roomId` to the room next door and it has fled there. Put a connector's `conditional` to null and the way is open. Put an item's `currentQuality` to zero and it is destroyed and falls out of whatever slot it filled.

Four rules govern every diff:

1. **All or nothing.** The commit is checked as a whole and applied as a whole. One bad diff rejects every diff beside it and you are handed the reasons and asked again. Nothing is ever half-applied.
2. **Order is preserved.** Diffs run top to bottom. Pick up the key before you unlock the door.
3. **Ids are quoted, never invented.** Every id must appear verbatim in the room, on the character sheet, or on something you created earlier in this same commit.
4. **You never author a number.** Every hit point lost, every point of damage, every die result comes from a roll function — `roll_save`, `roll_attack`, `roll_stunt`, `roll_morale`, `roll_damage`. Call it, read the result, use that number. Do not decide that the ghoul hits for four.

If a diff is impossible — a shield onto a hand already holding a two-handed weapon, an id that does not exist, a field that cannot be written — you get back a message saying why, and you fix it and commit again.

### What you may and may not change

Some things were settled when the dungeon was written and are fixed forever:

> **Never writable:** an entity's `base`, `name`, `id`, `type`, or `keywords`; a creature's `hitDice`, ability modifiers, or blueprint; an item's `slots` or original `quality`; a connector's endpoints; the player's abilities, traits, level, or maximum hit points.

`base` is a thing's identity — what it *is*, as opposed to how it currently stands. If something has changed so much that its `base` would need rewriting, that is not an edit. That is a new entity: end the old one and create its replacement.

Everything else is yours to move: current hit points, conditions, what is equipped, what is carried, where creatures stand, how many of them are left, what a room and its contents currently look like, whether a hazard has sprung, whether a way through is still blocked.

### state and composed

Two fields carry the prose of a thing that has changed, and they are written at different moments.

- **`state`** — what is true of it *right now*. The desk is overturned; the ghoul is bleeding from the shoulder; the door hangs off one hinge. No `state` at all means the player has never encountered it.
- **`composed`** — the player-facing description, rendered from `base` + `state`. It is a cache, not a source of truth. Never read it to decide anything; the facts live in `base` and `state`.

**Write `state` whenever a thing changes. Write `composed` only for what the player can see right now.** Setting `state` automatically marks the thing as needing a fresh description; the description itself is written the next time the player lays eyes on it. A creature that flees two rooms away and bleeds out there gets its `state` written now and its `composed` written whenever the player next walks in on it — there is no point describing a room nobody is standing in.

So: in a room the player is in, `state` and `composed` travel together, and anything containing the changed thing may need its `composed` rewritten too — overturn the desk and the room may no longer read correctly. Elsewhere, `state` alone.

### Making something new

The heuristic lets a player act on things that were never written down — the keyring on a guard's belt, a cask in a storeroom you described but never listed. When step 1 approves one of those, it becomes real, and real means an entity.

Create it by adding it to whatever holds it:

```
{ entityId: "<the guard>", path: "children[]", value: {
    type: "Item", name: "iron keyring",
    base: "<what it is — fixed identity, nothing that will stop being true>",
    state: "<what is true of it right now>" } }
```

From that moment it is an ordinary part of the world: it can be taken, broken, dropped, described. Do not leave a newly established element living only in prose — if the player can act on it, it needs to exist.

### The writable paths

| Path | On | Writing it means |
|---|---|---|
| `state` | anything | what is true of it now; marks it for a fresh description |
| `composed` | anything | its description, as the player would read it |
| `hp.current` | the player | damage or healing; at 0 or below they are dead |
| `conditions[]` / `conditions[i]` | the player | append a condition, or set one to null to clear it |
| `equipped.weapon` `.armor` `.helmet` `.shield` | the player | an item id to wear or wield it; null to put it away |
| `inventory[i]` | the player | null to drop it where they stand |
| `parentId` | an item | who holds it now — the player, a room, a creature, a chest; null means it is gone |
| `currentQuality` | an item | wear and damage; at 0 it is destroyed |
| `amount` | an item | how much is left — "4 doses", "20 feet" |
| `stats.hp` | a creature | damage or healing; at 0 or below it dies |
| `count` | a creature | how many of them remain; at 0 the group is wiped out |
| `activity` | a creature | one line on what it is doing now |
| `roomId` | a creature or feature | where it is |
| `roomIds` | a spreading effect | every room it now reaches |
| `conditional` | a connector | what blocks the way; null means it is open |
| `hidden` | a feature | false once it has been found |
| `sprung` / `active` | a hazard | whether it has gone off, and whether it is still going |
| `children[]` | anything | a new entity belonging to it |

### The roll functions

Called while you work, before you commit — you need the number to know what happened. All seeded and deterministic; you never supply a result.

- `roll_save(bonus, dc, edge)` — ordinary DC is 16. When a creature is the source of the risk, pass its relevant defense as `defenseAsDc` instead and the conversion is handled.
- `roll_attack(bonus, targetDefense, edge, damageDie, wellSuited)` — hit or miss, and the damage on a hit, including the extra die on a natural 20 and the extra die for the right weapon against the right enemy.
- `roll_stunt(bonus, targetDefense, edge)` — success or failure. Stunts deal no damage of their own.
- `roll_morale(rating)` — 2d6 against a group's morale, default 7. Whether they hold or break.
- `roll_damage(expr, extraDice)` — damage from something that is not an attack: a fall, a trap, a ceiling coming down.

A natural 20 on an attack costs the defender's armour a point of quality; a natural 1 costs the attacker's weapon a point. The roll tells you it happened — you write it as a `currentQuality` diff.
