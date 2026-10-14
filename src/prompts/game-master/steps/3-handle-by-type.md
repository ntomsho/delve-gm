# Step 3 — Handle the action by type

A valid action arrives here carrying its `actionType` from step 2. Dispatch to the matching handler. Each handler resolves the action on its own terms — updating state, recomposing what changed, presenting the result to the player, and returning to await input when the action completes (or bouncing back to await input if it turns the player away).

- **information** → `steps/3-information.md`
- **standard** → `steps/3-standard.md`
