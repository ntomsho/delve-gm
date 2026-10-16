# Roadmap

Work that is not built yet, grouped by area and in no particular order. Each item can be
picked up on its own unless it says otherwise. How the built game works is in
[`ARCHITECTURE.md`](ARCHITECTURE.md).

Much of this comes from two full playtests: **R1**, a size 1 dungeon played start to
finish, and **R2**, eight turns of a size 2 dungeon spent mostly talking to its
inhabitants. The longer notes on each item, with the playtest evidence, are in the last
version of `docs/BUILD-PLAN.md` in git history
(`git log --diff-filter=D -- docs/BUILD-PLAN.md`).

---

## Play

- **Spellcasting.** The playbook has no guidance. The rule to write into
  `3-standard.md`: a spell succeeds automatically unless it targets a creature or
  attempts something difficult, and it is exhausted after use, follow-up actions of the
  same effect included. Needs `spellBook.exhausted` added to the writable paths.
- **One obstacle, one roll.** In R1 the game master charged three rolls for one grate,
  because its `conditional` listed three clauses. Tell the game master that a
  `conditional` is one obstacle, and have the content pass write it as one.
- **An attack cap.** At most a fixed number of creatures (suggested: 3) attack the
  player in one exchange; the rest press in. Also bounds the batched `roll` call. Then
  measure group sizes against dungeon level, and decide whether hit dice 0 creatures
  fight as a mob.
- **Effects with consequences.** A magnetic field the player walked through in chain
  mail did nothing. Either effects get a consequence field the content pass fills, or
  walking into one becomes an event the resolution step is told about.
- **Creature reactions.** Insulting a faction in front of one of its members got no
  response, because the game master is only asked about the target. Ask what every
  creature present does on a turn that changes state, and put the other creatures in
  front of each one when deciding.
- **Followers.** A creature that leads a cooperating player somewhere, or carries off a
  downed one, as a creature whose `activity` is following. No party and no second sheet.
- **Rest.** Fully specified: a `rest_offered` stage beside `roll_offered`, a heal rolled
  in code on the button press, `steps/6-rest.md`. It makes the `long` time category
  reachable.
- **Take item.** Commits carry take offers; clicking one applies its diffs directly with
  no model call and no turn spent.
- **Value for items made mid-run.** An item the game master creates is worth 0 until the
  applier has an RNG to roll a value with (the same plumbing *Take item* needs).
- **Telling the game master it got something wrong.** Deliberately deferred. Revisit
  after a run in which the software behaves and the game master is still wrong.

## Generation

- **Prose discipline.** Absolute directions only; positions and shapes that match the
  plan; no verbatim reuse of a room's description; fewer verbal tics; room names that
  match their descriptions. Mostly playbook changes.
- **Room plans.** Hand the model an ASCII plan of a room's cells beside the geometry
  sentence. Measure on a dozen rooms before adopting.
- **Connectors written with their room.** Write a room's ways out with the room that
  first claims them, so the room's own description and its doors agree. Decide what
  is left of the seams pass.
- **The entrance in the fiction.** The entrance is rolled in stocking, which the
  dungeon pass runs alongside and cannot see. Roll it before the split, and replace the
  fairy-tale entries in the Maze Rats table.
- **First impressions.** A stranger's name should not be on the room card before the
  player has learned it. A `properNamed` flag that the game master may flip once.
- **One leader, one entity.** A group's leader is written once per chunk that holds a
  member, so one named NPC can be two entities. Fix in stocking, and add a validation
  check.
- **The goal names what is in the goal room.** R2's goal named an NPC met in the third
  room, so meeting her read as arriving at the goal.
- **The placed-key spread.** Placed keys vary from 1 to 9 at size 5, against an
  intended four. Narrowing it means changing the placement order.
- **Positions from the planar embedding.** About one size 5 layout attempt in eight
  fails and is retried. Deriving positions from the embedding would make it succeed
  first time.
- **Prose for the equipment catalogue.** The 122 entries in `equipment.ts` have none
  yet. Written by hand, a few at a time.

## Map and interface

- **Creature markers** on the map, with a "last seen here" position. A follower and the
  room card's creature rows both wait on this.
- **The map's orientation and labels.** A compass rose, room names on explored rooms,
  centring on the new room, and a fog state for a corridor passed through but never
  examined.
- **The scrollback.** Larger, clearer roll results; a sticky room header; an unexplained
  layout shift on changing rooms (not yet reproduced).
- **The blank beyond the surface exit.** The space around the way out is undesigned.
- **Library run-state badges** ("in a run", "died in room 3"), which need per-character
  run state nothing stores yet.
- **Phones.** The play screen is built, in portrait and landscape. Next: the Characters
  screen and character creation. Nothing has been checked on a real phone yet.

## Illustrations

- **Item illustrations.** The equipment catalogue drawn once by a script and committed;
  unique items drawn the first time they are taken or inspected.
- **State illustrations.** Redraw a room that has changed, always editing from the base
  illustration, on re-entry only, under a per-run cap.
- **Figures after a reload.** A room left earlier keeps its creatures only in memory.
- **Refinements:** framing (the image model sometimes swaps an angled view for a
  straight-on one), rooms dense with foliage or texture, and a depth-map lock if button
  placement drifts.

## Running it for strangers

The guest accounts, daily run allowances (`src/server/allowance.ts`), the spend ledger
and the daily budget and ceiling (`src/server/spend.ts`) are built. Left:

- **Prepaid provider credit** on Anthropic and fal with auto-reload off, under the
  spend ceiling, in case the ceiling itself has a bug.
- **Image prices from the invoice.** `IMAGE_PRICES` estimates GPT Image 2 at $0.03 with
  references; check it against fal's usage page once the ledger has a week of rows.
- **A turn cap per run** and a **sweep of stale guest accounts.**
- **A cheaper turn.** Play is 84–97% of a run's cost, and input tokens are most of
  that. Measure the cache hit rate first (the query is in the `spend` migration), then
  the size of the turn prompt.
- **A curated shelf** of finished, pre-illustrated dungeons for guests, shared rather
  than copied.
- **Dungeons as a generation cache.** Hand a player any complete world of the right size
  and level they do not already hold, rather than generating a new one.

## The library as a community

Tags, search (Postgres full-text), ratings, comments, favourites and share links for
dungeons. Comments are the first text one player writes for another, so moderation and
spoilers have to be designed first. Tables: `dungeon_tags`, `dungeon_ratings`,
`dungeon_comments`, `favourites`.

## A second ruleset

Knave is the only ruleset. Its assumptions still reach outside `src/rules/knave/`: the
roll request and its resolution, the sheet the game master reads and its writable paths,
creature stats, item facts, and the rules sections of the playbook. Extract a `Ruleset`
interface when there is a second game to put behind it.

## Developer tools

- **A call log viewer** for `run.callLog`, which nothing renders.
- **Jump to room**, for testing.
- **Replay** of a run against the stub or recorded responses. A live model is not
  deterministic, so replay must say which it is.

---

## Accepted gaps

Known and deliberate. Revisit if the symptom starts to matter.

1. **Rooms have no shape families**: no round, cross- or T-shaped rooms, no niches.
2. **Large rooms are rare**, since zones average 20–40 cells. Size only feeds the
   identity roll, and the bands that matter for it are reachable.
3. **A room's proportions are rolled, not taken from what it is**, so a banquet hall is
   no likelier to be long than a privy.
4. **Target areas are a placeholder roll** rather than derived from the size classes.
5. **Corridors are only mildly narrower than chambers.**
6. **A fixture spanning several cells draws as several marks.**

## Non-goals

One player character: no multiplayer and no party. Nothing persists between dungeons
except saved characters. No light or ration clocks yet, though `turnCount` exists for
them.
