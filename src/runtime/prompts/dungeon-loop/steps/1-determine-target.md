# Step 1 — Determine the target of the action

## Purpose

Before anything can be resolved, find the **target**: the thing the player is asking about or attempting to act upon. Then decide whether the player is allowed to target it. This step *only* identifies and validates the target — it does not resolve what happens to it. That comes later.

Gauge the general focus of the action. If the player says "I search the writing desk," the target is the desk. If they say "I throw a torch at the gathered rats," the target is the swarm of rats. Strip the action down to what it is aimed at.

## What can be a target

- **An existing entity** — a room feature they want to inspect, a creature they attack, an item they pick up.
- **A constituent part of an entity** — something named in an entity's description or state but not modeled as its own entity: the keyring noted on a guard's belt, a single rat within a Horde, a carving on a wall that never became its own entity.
- **Multiple entities as a whole** — a knot of creatures caught in one spell, three torches doused at once.
- **Something that plausibly exists but has no entity yet** — a cask of wine the player takes from a storeroom you described but never enumerated.

## Decide by where the target comes from

Work through these in order. The first that fits decides the outcome.

### A. It is already there → approve automatically

Approve with no questions, and advance, when the target is:

- **An existing entity the player is aware of.** "Aware of" means they have perceived it. A concealed thing they have not yet discovered is *not* a valid named target — but note that an action like "I search the shelves" validly targets the shelves (an existing entity); whether that turns up the hidden thing is resolved in a later step, not here.
- **A part of an entity's description or state**, even without its own entity: the individual rat in the Horde, the keyring the guard's state says hangs at his belt, the loose flagstone mentioned in the room.
- **Anything the player has been told about**, whether or not you can find it in a `base` or a `state`. If it is in a `composed` description they have read, it is established and it is theirs to act on — see "state and composed" in the skill. Approve it, and record that its `state` needs catching up.

These are free to target. Record the target and move on.

> **You may never reject something on the grounds that a thing you already described is not there.** The room's description is your own words, and the player believing them is not a mistake they made. If your description mentioned ledges and the current state does not, the ledges are real and the state is behind — fix the state. This is the single most damaging thing you can get wrong: it makes the world unreliable, and a player who cannot trust the description cannot play.

### B. It is not there yet → judge whether it reasonably could be

The player may propose a target that is neither an entity nor part of any entity's description. Allow it **only if it is something that could reasonably be expected to exist given the current state of the fiction.**

**Approve and incorporate** when it follows naturally from what is established:

> The guard's state never mentioned keys, but a guard standing watch over cells could reasonably carry them. → Reasonable. Treat the keys as true from now on, record them as a newly established element on the guard, approve, advance.

**Reject** when it does not fit — because the thing wouldn't have it, because it is unfounded, or because it contradicts established fiction:

> The figure is another prisoner, not a guard. A fellow prisoner would not be holding your cell keys. → Reject.

> The player wants to lift a magical artifact off the guard. Nothing establishes one, and it is a large unearned gain. → Reject.

> The fiction already states a *different* guard, down the hall, carries the keys. → Direct contradiction. → Reject.

**To reject:** tell the player plainly that the element doesn't exist, say *why* it was rejected, and ask them for a different course of action. Do not update any state. Return to await input.

### C. On the fence → ask them to justify

If you are genuinely unsure whether the proposed element fits, **or** it is plausible but would hand the player a significant advantage or benefit, don't simply wave it through. Ask the player to justify why that element would be present. Phrase it as a request for *their* reasoning, not a yes/no:

- "Why do you think this guard would have the keys to your cell specifically?"
- "How do you know there's poison in the pantry?"
- "What makes you think that this wall is weak enough to be broken?"

Then wait for their answer, and judge it against the established fiction:

- **Sound reasoning that connects one or more existing details of the fiction to their claim → approve, incorporate, advance.** The connection to established detail is the bar. "The room description said the guard was drunk and slumped over — he'd never notice me lifting his keys" leans on something real. A confident assertion that hangs on nothing already in the fiction does not clear it.
- **Otherwise → gently tell them you are not persuaded**, and ask for a different action. Return to await input; change nothing.
- **If they say they don't know, or want to take the suggestion back → tell them to propose a different action instead.** Return to await input.

## Movement: the target is a way out, and it must be the right one

When the player is going somewhere, the target is **the connector they leave by** — not the room they name. Take it from the "Ways out" list, which gives you, for each one: what it is called, what it physically is, and the room on the far side, named whenever they have been there.

Match their words to that list, and be strict about what counts as a match:

- They name a way out, or describe it unmistakably ("the iron door", "the stair down") → that connector. Approve.
- They name a room, and **exactly one** way out leads there → that connector. Approve.
- They say "back", "back the way I came", "out" → work it out from the previous turns' records, which name the rooms they moved between. If those settle it beyond doubt, approve. If they do not, ask.

**If you cannot settle it, ask — every time.** Two ways out could serve, the room they named is not on the list, "back" is ambiguous, they named somewhere they have not been and you are guessing which direction it lies in: all of these are questions, not judgement calls. Put the options to them in the words the list uses:

> "Two ways lead out of here — the ascending passage to the Torture Room, and the mirrored corridor to the Laboratory. Which do you take?"

> "There's no way out of this chamber that leads to the Well directly. The corridor to the Laboratory goes back toward it — do you want to head that way?"

This is cheap and being wrong is not. A move you guessed at puts the player in a room they did not choose and had no way to refuse, and by the time they find out, they are standing in it. **Never infer a destination from a connector's name** — connectors are named for what they are, never for where they go, and the far side is only what the "Ways out" line says it is.

### Going somewhere further off

A room they have already been in can be named directly, however far away it is — "I head back to the Well" is one action, not four. Write its id and the walk is worked out for you: the route is drawn through rooms they have been in, and they end up as far along it as they actually get.

**They may not get all the way, and that is not a failure to correct.** A creature standing in a room on the route, a fire or gas filling one, a trap in one — whether it has gone off or is still waiting — a way that is barred: any of these ends the walk there, and the player is left in front of it. You will be told where they actually stopped, and a trap they stopped in front of has **not** sprung. Do not narrate the journey as though it completed, and do not go looking for a way round: the route already took the clearest one there was.

Somewhere they have **never** been is different — they can only step into it, one room at a time, from a way out of the room they are standing in. There is no route through unfamiliar ground, because retracing steps is what a route is.

## Incorporating a newly established element

**Know why it is there.** Anything you make real belongs to this dungeon, not just to the sentence that asked for it. Ordinary things need no explaining — a gaoler has keys, a storeroom has casks, a barracks has bedding. Something stranger does: if you are approving a thing that would make a player standing in front of it ask *what is that doing here*, the answer is part of what you write into it. Being unable to supply one is a sign the thing should have been rejected in B.

When you approve something from **B** or **C** that wasn't already in the fiction, treat it as true from here on so the world stays consistent. **Do not rewrite entity state in this step** — creating the entity and updating its holder belong to later steps. Just record the new element on the target: what it is, and which entity (or the room, if it belongs to nothing) it hangs off, so the steps that follow can realize it.

## Output of this step

**On approval**, hand the next step a target record. Shape is illustrative — keep these facts:

```json
{
  "outcome": "approved",
  "summary": "the keyring on the guard's belt",
  "scope": "part",
  "entities": ["<guard-entity-id>"],
  "part": "iron keyring at his belt",
  "newElement": {
    "description": "a ring of iron keys",
    "attachTo": "<guard-entity-id>",
    "needsEntity": true
  }
}
```

- `scope` is one of `"entity"` (an existing entity), `"part"` (a part of one), `"multiple"` (several entities as a whole — list them all in `entities`), or `"new"` (a newly established element that belongs to no existing entity — `attachTo` is then the room id).
- `entities` holds the ids of every existing entity the target maps to.
- `newElement` is present only when something was newly established in B or C; omit it otherwise.

**On rejection, or a justification you were not persuaded by, or a retraction**, produce **no advancing record.** Deliver the player-facing message the branch called for (why it was rejected / that you are not persuaded / a request to propose a different action) and return to await input. No state changes.

## Worked examples

**Existing entity.**
Input: "I open the iron chest in the corner." (an Item/feature entity in the room)
→ Existing entity the player perceives. Approve. `scope: "entity"`, `entities: [chest-id]`. Advance.

**Part of a description.**
Input: "I grab the keyring off the guard's belt." (guard's state mentions the keyring; it has no entity of its own)
→ Part of an entity's description. Approve. `scope: "part"`, `entities: [guard-id]`, `part: "keyring at his belt"`. Advance.

**Multiple entities as one.**
Input: "I sweep my flaming brand across all three ghouls." (three creature entities present)
→ Multiple entities as a whole. Approve. `scope: "multiple"`, `entities: [ghoul1, ghoul2, ghoul3]`. Advance.

**Reasonable new element — approve and incorporate.**
Input: "I take the guard's keys." (guard on cell duty; keys never mentioned)
→ Not established, but reasonable for a cell guard. Approve, record the keys as a new element on the guard. `scope: "new"` / `newElement.attachTo: guard-id, needsEntity: true`. Advance.

**Unreasonable — reject.**
Input: "I take the guard's magic sword of flame." (no magic sword established anywhere)
→ Unfounded and a large unearned gain. Reject. Tell the player there is no such sword and ask for a different action. No state change.

**Contradiction — reject.**
Input: "I take the keys off this guard." (fiction already says the keys are held by a different guard down the hall)
→ Contradicts established fiction. Reject, explaining the keys aren't on this guard. No state change.

**On the fence — justified, approve.**
Input: "I quietly slip the keys off his belt while he's not looking."
→ Plausible but a big advantage. Ask: "What makes you think you can lift them unnoticed?" Player: "The room said he's slumped and snoring drunk." → Connects to established detail. Approve, incorporate. Advance.

**On the fence — unpersuasive, bounce.**
Input: "There's a secret lever behind the throne, I pull it."
→ Ask: "Why do you think there's a lever there?" Player: "Throne rooms always have them." → Hangs on nothing in this fiction. Gently decline, ask for a different action. No state change.

**Retraction.**
Player, after being asked to justify: "Eh, never mind, I don't actually know."
→ Tell them to propose a different action instead. Return to await input.
