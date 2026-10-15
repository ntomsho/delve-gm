# src/

Where everything lives, in layers. Each folder may import only from the folders
below it; folders on one line may not import each other.

```
  dev                 developer CLIs: may reach into anything
  ui · server         the browser and the API (neither can load the other)
  api-client          the browser's calls to our API
  fixtures            stand-ins for the model
  gameplay            a run being played
  illustrations       pictures of rooms and creatures
  journal             the run's event log
  generation          building a dungeon
  llm                 talking to the model
  prompts             what the model is told
  rules               the game systems
  shared              types, the world model, small helpers
```

`src/architecture.test.ts` enforces this for every import, type imports
included, and lists the two places it is not yet true. It also forbids any
cycle of imports that load code.

| Folder | What it holds |
|---|---|
| `dev/` | Developer CLIs (`cli-*.ts`) and the local API server (`api-server.ts`); helpers in `lib/`. Nothing imports it. |
| `ui/` | React. The only folder that imports it. One subfolder per screen (`sign-in/`, `characters/`, `create/`, `shop/`, `run-setup/`, `play/`), plus `app/` (the shell and URL switches), `shared/` (theme, media queries, the store hook) and `test-utils/` (jsdom setup). |
| `server/` | The API: Hono routes (`app.ts`), Postgres (`db/`), illustration and sprite storage (`illustrations/`), auth and allowances. `vercel.ts` is the deployed entry point. |
| `api-client/` | The browser's calls to our own API: auth, characters, dungeons, allowance. |
| `fixtures/` | Stand-ins for the model: the offline dungeon and the stub game master, used by tests, the dev CLIs and `?offline`. Loaded by the browser only on `?offline`. |
| `gameplay/` | A run being played. `turn.ts` is the turn state machine; `game-master/` is the model that runs each turn, the code that builds its prompt and the schema of what it commits; `diffs/` is the applier, the one place game state changes; `state/` is the store; `mechanics/` holds play-time rules (movement, occupancy, challenges, loot); `tally/` scores a finished run; `view/` derives what the screen and the game master both see; `sessions/` wraps one run, played in the browser or through the server. |
| `illustrations/` | Room illustrations and creature sprites: the camera search, button hotspots, where figures stand, the guide image and the prompts for the image model. |
| `journal/` | The per-run event log, and its readable rendering. Records what generation and gameplay did, so it sits above generation; generation writes to it through `generation/log.ts`. |
| `generation/` | Building a dungeon. `generate.ts` is the pipeline. `floorplan/` is the physical dungeon: graph, planar layout, room shapes, fixtures and the map. `content/` is what is in it: stocking, challenges, rewards, and the model passes that write its prose, with their schemas in `content/passes/schemas.ts`. |
| `llm/` | The Anthropic transport, forced-tool JSON calls, the shape of a validation issue, and `models.ts`, the only file allowed to name a model. Knows nothing about the game: each schema lives with the code that asks for that answer. |
| `prompts/` | Every instruction to a model, as markdown. `loader.ts` is the one place it is imported. |
| `rules/` | The game systems, one folder each. `knave/` is Knave 1.0, the system played: dice, the character sheet, creation, levelling, equipment and the shop. `maze-rats/` and `cairn/` are the tables generation rolls on. Another game's rules would sit beside them. |
| `shared/` | Used across areas. `types/` holds the turn and commit shapes; `world/` the world model (entities, challenges, placement, what a creature was rolled from); `utils/` small helpers: the seeded `Rng`, ids, grid keys, formatting, zod helpers. |

**Not yet where it belongs.** Some code still sits inside a large file and will
move when that file is split:

- `prompts/`: the generation, tally and illustration instructions are still
  TypeScript strings beside the code that sends them.
- `rules/knave/`: Knave assumptions are still built into `gameplay/diffs/paths.ts`,
  `gameplay/game-master/render.ts`, `gameplay/game-master/schemas.ts`, `gameplay/turn.ts`,
  `shared/world/entities.ts` and the content pass's stat blocks, and `shared/types/`
  names Knave's sheet and roll results (the two layer exceptions).
- `server/routes/`: the routes are all in `server/app.ts`.
