# Step 2 — Determine validity and action type

Step 1 settled *what* the action is aimed at and approved the target. Now judge whether the action itself is legitimate, and if so, what kind of action it is. This step consumes the approved target record from step 1.

## Determine whether the action is valid

The action is valid if it is something the player could reasonably do — or attempt to do — to the target, with **at least some plausible chance of success.** The bar is a *plausible attempt*, not a likely one: long odds are fine, zero odds are not.

Judge plausibility from the player's vantage. **Factors the player could not know do not lower the plausible chance of success.** A lock that is secretly rusted shut, a guard who secretly cannot be bribed, a floor that is secretly rigged — none of these make the attempt invalid. They get resolved when the action plays out, and the attempt may simply fail then. What the player *does* know — everything in the established fiction — does constrain them.

### An action is invalid when any of these is true

- **It isn't the player's own action.** The player controls their character and nothing else. Narrating what another creature does, or what the world does on its own, is not an action they can take. "The guard wanders off," "it starts to rain," "my torchbearer charges in" (when no such ally is established) — invalid. **One exception:** a chat input that reads as an open question — no action by anyone, just asking for information the character might know or perceive about their surroundings — is accepted, and classified as an **information action** (below).
- **It relies on another creature doing something they wouldn't reasonably do.** The player may *attempt* to influence a creature — persuade, threaten, deceive, distract — and that attempt is valid; the creature's response is judged later. But an action that *presumes* the response, or only works if the creature acts against its own nature, is invalid. "I hold out my hand and the guard gives me the keys" presumes a hostile guard's cooperation → invalid. "I try to convince the guard I'm his relief so he'll hand over the keys" is a valid attempt.
- **It contradicts the established fiction.** An action with no plausible chance *because of what the player already knows.* "I lift the one-ton portcullis the room described, bare-handed," or "I fly across the chasm" with no established means of flight → invalid.

When the action is invalid, tell the player it isn't valid, briefly say why, and ask them to choose a different action. Change no state. Return to await input.

## If valid, determine the action type

There are two types. Classify by the action's **primary purpose**:

1. **Information** — a no-risk, no-stakes action whose primary aim is to get information about something in the fiction. Two forms: cursory inspection of a target ("look at", "examine", "watch"), and open questions about the world ("What do I know about the Worm cult?", "What can I hear beyond the door?"). Check this first: "I look at the guard" is an information action, and "I peer through the doorway into the next room" is information, not movement — the player is gathering information, not acting on the world. An inspection that would need a risky method, trip a hazard, or provoke a creature is *not* this type — that carries stakes, so it is a standard action.
2. **Standard** — everything else the player actually *does* to the world: picking a lock, drinking a potion, shoving a statue, swinging a sword at a ghoul, stepping through a doorway into the next room, persuading a guard. Attacks and moving between rooms are ordinary standard actions; they are not special-cased.

When it is unclear, decide by what the player is *chiefly* trying to do: to learn (information) or to act on the world (standard).

## Output of this step

On success, extend the target record from step 1:

```json
{
  ...target record...,
  "valid": true,
  "actionType": "information" | "standard"
}
```

On an invalid action, produce no advancing record: deliver the "not valid, here's why, choose another action" message and return to await input. No state changes.

## Worked examples

- "I examine the runes above the arch." → valid; **information**.
- "I peer through the barred window into the next cell." → valid; **information** (gathering information, not acting).
- "I swing my mace at the skeleton." → valid; **standard** (an attack is a standard action).
- "I step through the western doorway." → valid; **standard** (moving between rooms is a standard action).
- "I try to pry the gem from the idol's eye with my dagger." → valid (a plausible attempt, long odds are fine); **standard**.
- "I pick the lock on the chest." — unknown to the player, the lock is rusted solid. → still **valid**; the hidden factor doesn't remove the plausible attempt (it may fail later); **standard**.
- "I command the ogre to kneel and it obeys." → **invalid**: relies on a creature doing something unreasonable / presumes the response. Ask for a different action.
- "The portcullis rises and I stroll under it." → **invalid**: not the player's own action / presumes a world event. Ask for a different action.
- "I leap the twenty-foot chasm the room described in a single bound." → **invalid**: contradicts what the player already knows; no plausible chance. Ask for a different action.
