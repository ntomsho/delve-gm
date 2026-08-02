# Dungeon Crawler — UI Design Brief

## The product

A single-player dungeon crawl where an LLM acts as referee. The player types what they want to do in plain language; the referee decides what happens, rolls the dice, and narrates the result. Underneath it is **Knave 1.0** — a lean OSR tabletop game where characters are fragile, inventory is measured in slots you will run out of, and cleverness beats combat because combat kills you.

The whole dungeon is generated before play begins: rooms, monsters, treasure, the thing you came for. Nothing is improvised on the fly. The player's job is to get in, find it, and get out alive.

**Audience:** people who play OSR tabletop games, or who want to. They read. They are comfortable with a character sheet. They are not looking for a JRPG.

**The screen's single job:** make a text conversation feel like a game, not a chat window. Everything visual exists to keep the player oriented — where am I, how hurt am I, what am I carrying, what is the game waiting on me for.

**Deliverable:** static React + Tailwind components with mock data. No engine wiring, no API calls. Shapes and states are specified below; invent plausible content to fill them.

---

## Tone and constraints

The subject's own world is where the visual direction should come from — this is a game about ink, dice, torchlight, graph paper, and a character sheet you erase a lot. Take a real position on that; do not land on generic dark-fantasy game UI.

Hard constraints:

- Desktop-first. Must not break at tablet width. Mobile is out of scope.
- Tailwind only. No component library.
- The map is SVG, React-rendered.
- Text is the primary medium. Whatever the design does, prose must be comfortable to read for an hour. Type choice for the narration column is the most consequential decision in this brief.
- Keyboard-first play. The player should never need the mouse during a normal turn.

One thing worth designing against: the room description is the game. When it arrives it should feel like arriving somewhere, not like a new paragraph in a log.

---

## Screens

### 1. Character creation

Multi-step, back-navigable, nothing committed until the end.

1. **Abilities.** Six abilities — STR, DEX, CON, INT, WIS, CHA — stored as bonuses, typically +1 to +3 at level 1. Each has a *defense* of bonus + 10, always shown alongside. Two modes the player picks between: **roll** (with a reroll-all, not per-ability) and **point buy**.
2. **Traits.** Eleven rolled descriptors — physique, face, skin, hair, clothing, virtue, vice, speech, background, misfortunes, alignment. Each is a short phrase, e.g. "Bony", "Broken nose", "Ashen", "Cropped", "Fashionable". Presented as a sheet the player can accept or reroll individually. This is where the character becomes a person; give it more room than a form deserves.
3. **Hit points.** A single d8 roll. This is both starting and maximum HP. A 1 here is a real and funny problem.
4. **Equipment.** Everyone starts with 2 days of rations and one weapon of their choice. Armor and gear are then **rolled** on tables — or the player can opt out and shop instead with 3d6×20 copper pieces. Both paths need to exist. The shopping interface must show **slot cost** as prominently as price, because slots are the real constraint.
5. **Name and confirm.** Full sheet review, then save.

Also needs a **character library** — saved characters, load one, delete, start fresh.

Slot capacity is CON defense (CON bonus + 10), typically 11–13. Most items cost 1 slot, some cost more. Going over capacity is allowed but flagged. The slot meter should be visible from the moment the player has anything to carry, and should read as *a budget being spent*, not a progress bar being filled.

### 2. Generation / loading

The dungeon is written before play, which takes real time — this is a genuine wait, not a spinner's worth. The pipeline runs in named stages, and reporting them honestly is better than hiding them:

- Laying out the dungeon
- Deciding what lives here
- Writing its history
- Stocking the rooms
- Writing the rooms *(this is the long one — it runs in parallel batches of six rooms and can report progress, e.g. 3 of 7 regions)*

Design this as a real screen with something to look at, not a modal. It's the player's first impression and it sets the fiction.

### 3. Play

The main screen. Three regions:

**Narration column (primary).** The conversation. Referee prose and the player's own typed actions, distinguishable but not styled like a chat app with bubbles and avatars. Room arrivals deserve a stronger visual break than ordinary exchanges. Narration streams in token by token — design for text that arrives progressively.

**Map (secondary).** SVG. Rooms as nodes, connectors as edges, current position marked. **Fog of war:** unvisited rooms are unknown and should not be shown as anything but blank space or an inferred exit. Visited rooms stay drawn. Some connectors are *gated* — locked, blocked, flooded, concealed — and that state matters to the player's planning, so it needs a visual language. Design so this can later become a real dungeon map with room shapes rather than dots; don't build a visual grammar that only works for circles.

**Character panel (persistent).** Never more than a glance away: HP current/max, the six abilities as bonus/defense, armor defense, what's equipped, inventory with slot usage, and **conditions** — free-text status effects like "hungry", "poisoned", "leg wound", which can accumulate. HP changes and new conditions should be noticeable when they happen, not just different on next look.

### 4. Terminal states

**Death** and **goal achieved**. Both end the run. Death is the expected outcome in this genre and should be treated with some grace rather than as a failure screen. Both need a route back to the character library.

---

## The central mechanic: turn stages

**This is the most important thing in the brief.** The game is always in exactly one stage, and the area around the chat input must always tell the player what the game wants from them. A player should never wonder whether it's their move.

| Stage | What's happening | Input area |
|---|---|---|
| `room_entry` | New room being described | Input disabled, narration streaming |
| `awaiting_action` | Game is waiting | Open. **"What do you do?"** |
| `clarifying` | Referee needs to know which thing you meant | Open, framed as answering a question |
| `rejected` | The action won't work; nothing changed | Open, framed as try something else |
| `roll_offered` | A roll is on the table — what's being rolled, against what, with what edge | **Roll button live, input still open** so the player can argue or change approach |
| `rolling` | Dice in flight | Disabled |
| `resolving` | Referee writing the outcome | Disabled, narration streaming |
| `dead` / `goal_met` | Run over | Closed |

`roll_offered` is the one that carries the most design weight. It has to show the player the terms of the bet — which ability, against what defense, whether they have advantage or disadvantage — and make clear that they can still talk instead of rolling. Renegotiating the terms is a legitimate move in this kind of game, and the interface should say so.

`rejected` deserves care too. The referee turning an action away is a normal, frequent event, not an error. It should never read as a system failure or an apology. It should read like a person across the table saying "there's no window in here."

---

## Data shapes

Enough to build against. Invent content freely.

```ts
PlayerCharacter {
  name: string
  level: number
  hp: { current: number; max: number }        // max is typically 1–8
  abilities: { str, dex, con, int, wis, cha } // BONUSES, +1 to +3 at level 1
                                              // defense = bonus + 10, always shown
  traits: { physique, face, skin, hair, clothing, virtue,
            vice, speech, background, misfortunes, alignment }  // short phrases
  inventory: Item[]
  equipped: { weapon?, armor?, helmet?, shield? }   // ids into inventory
  conditions: string[]                              // free text, can be several
}

Item {
  name: string
  amount?: number        // "Rations (2)"
  slots?: number         // default 1
  quality?: number       // items degrade; current vs original both matter
  weapon?: { damage: string; hands: 1 | 2; ranged?: boolean }  // "1d6", "1d8"
  armor?: { defense: number }                                   // 11 unarmored
}

RollSpec {
  kind: "save" | "attack"
  ability: "str" | "dex" | "con" | "int" | "wis" | "cha"
  bonus: number
  target: number         // 15 for an ordinary save, or an opponent's defense
  edge: "none" | "advantage" | "disadvantage"
  damage?: string        // attacks only
  description: string    // "Vault the collapsed pillar before it settles"
}
```

Derived numbers the panel should show, not make the player compute: armor defense (armor + 1 per helmet + 1 per shield, or 11 unarmored), melee attack bonus (STR), ranged attack bonus (WIS), slots used / capacity.

---

## Writing

Interface copy is part of this brief. Some of it is diegetic — the game addressing the player — and some is plainly the software talking. Be deliberate about which is which, and keep them from blurring.

The one line that matters most is the prompt above the input. **"What do you do?"** is the tabletop convention and it is doing real work; if you change it, change it for a reason you can defend.

Empty states and failures are direction, not mood. An empty character library is an invitation to roll one up. A model timeout is the software talking and should say what happened and what to do.

---

## Deliverables

1. A design plan first — palette as named hex values, type pairing with roles, layout concept, and the one signature element this game will be remembered by. Justify the choices against *this* subject, not against dark-fantasy UI in general.
2. Then the components: character creation flow, generation screen, play screen with all eight input states, and both terminal screens. Static, mock data, no wiring.
