# Delve GM

A single-player dungeon crawl run by an LLM game master. You type what your character
does in plain language; the game master works out what happens, asks for a roll when
there is something at stake, and narrates the result. The rules are
Knave 1.0, and the dungeons are stocked from the
tables of *Maze Rats* and *Cairn*.

**Play it at [aidungeon.vercel.app](https://aidungeon.vercel.app)**: sign in with Google
or play as a guest.

## What makes it work

Letting a language model run a game raises two problems. It invents things the game
doesn't support, and it forgets what it said three turns ago. Most of this codebase
exists to keep the model honest.

- **The whole dungeon exists before the first turn.** Code lays out the rooms on a
  grid and stocks them from the tables: creatures, hazards, treasure, and the thing
  you came for. The model then writes the prose for all of it, six rooms per call and
  in parallel. Nothing is improvised during play, so what's behind the door was there
  before you opened it.
- **The model never generates a number.** Dice, damage, treasure values, room shapes
  and experience all come from seeded random numbers in code. When the game master
  needs a roll it calls a tool, and code answers it.
- **A turn is a commit, not a conversation.** The game master answers with a typed
  object: the paragraph you read, the next stage of the turn, and a list of state
  changes (`{ entityId, path, value }`). One applier validates and applies the whole
  batch atomically, against an allowlist of what may change. A refused batch changes
  nothing, and the model gets one more try with the reasons in front of it.
- **What you've read is binding.** Narration appears only after its commit has applied,
  so prose on screen is always true of the game state. Everything you've been told is
  stored on the entity and handed back to the model on every turn, so it doesn't drift.
- **The map only knows what you know.** Fog of war is the same rule as the prose: a
  thing appears on the map once you've been told about it.
- **Illustrations are composed in code.** For each room, a camera search picks the view
  that frames the most of it. A guide image drawn from the floor plan then tells the
  image model where the walls and doors go, and the result is thresholded to one-bit
  ink. Images are cached by what they show, so a room is drawn once for everyone who
  plays that dungeon.

[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) has the full design.

## The stack

TypeScript throughout. React 19 and Tailwind in the browser; vanilla Zustand for game
state. Hono on a single Vercel function; Supabase for Postgres, auth and image storage.
Claude Haiku 4.5 for everything the model writes; GPT Image 2 and FLUX.2 through fal for
the illustrations. Vitest for about 2,000 tests.

The code is organised in layers, each importing only from the layers below it.
[`src/README.md`](src/README.md) maps the folders, and `src/architecture.test.ts`
enforces the layering on every import. The game itself (generation, the turn machine,
the applier, the rules) touches no browser or server API, so it runs headless under
vitest and in a terminal.

## Running it

Requires Node 24: the dev scripts run TypeScript directly on Node's type stripping.

```sh
npm install
npm run dev:web
```

Then open **http://localhost:5173/?offline=1**. Offline mode needs no keys and no
server: a fixture dungeon, a stub game master and a test character, all in the browser.

To play the real game locally, copy `.env.local.example` to `.env.local`, fill in an
Anthropic key and a Supabase project, apply `supabase/migrations/`, and run `npm run
dev`. That starts the web app and the API together.

From a terminal:

```sh
npm run play:offline                         # a whole run against the fixtures, free
npm run play -- --seed 1005 --size 1         # a real dungeon and game master (reads .env.local)
npm run generate:dry -- --seed 1005 --size 2 # every generation prompt, no calls
```

## Tests

```sh
npm test            # the whole suite: headless, then the React tests in jsdom
npm run typecheck
npm run test:db     # opt-in: tests against a real database (needs DATABASE_URL)
```

Everything except `test:db` runs with no network and no keys.

## Deploying

Vercel serves `dist/` and one function, `api/index.js`. The API is bundled by Vite
(`npm run build:api`), because the prompts are markdown imported with `?raw`, and
Vercel's own bundler doesn't understand that. The bundle is committed because Vercel
checks that the function's file exists before it runs the build.

## Documents

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md): how it's built and the rules the code
  keeps.
- [`docs/ROADMAP.md`](docs/ROADMAP.md): what's not built yet.
- [`src/README.md`](src/README.md): where everything lives.
- [`docs/queries.sql`](docs/queries.sql): admin queries for reading playtests out of
  the database.

## Credits

Knave 1.0 and Maze Rats are by Ben Milton; Cairn is by Yochai Gal. The illustration
style references in `assets/` were generated for this project from written
descriptions.
