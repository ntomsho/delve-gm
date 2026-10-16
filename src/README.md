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
| `dev/` | Developer CLIs and the local API server (`api-server.ts`). Each `cli-*.ts` teaches Node `?raw` and then imports its script from `lib/`. Nothing imports it. |
| `ui/` | React. The only folder that imports it. One subfolder per screen (`sign-in/`, `characters/`, `create/`, `shop/`, `run-setup/`, `play/`), plus `app/` (the screen router, the URL switches, and one hook each for the account, the roster, run setup and the run in hand), `shared/` (theme, media queries, the store hook) and `test-utils/` (jsdom setup). |
| `server/` | The API. `app.ts` is the shell (CORS, the sign-in gate, errors); `routes/` holds the Hono routes, one file per area; `db/` is Postgres, one file per table behind the `repo.ts` facade; `illustrations/` draws and stores illustrations and sprites; plus auth and allowances. `vercel.ts` is the deployed entry point. |
| `api-client/` | The browser's calls to our own API: auth, characters, dungeons, allowance. |
| `fixtures/` | Stand-ins for the model: the offline dungeon and the stub game master, used by tests, the dev CLIs and `?offline`. Loaded by the browser only on `?offline`. |
| `gameplay/` | A run being played. `turn.ts` is the turn state machine; `game-master/` is the model that runs each turn, the code that builds its prompt and the schema of what it commits; `diffs/` is the applier, the one place game state changes (dispatch in `apply.ts`, one handler per entity kind in `handlers.ts`); `state/` is the store; `mechanics/` holds play-time rules (movement, occupancy, challenges, loot); `tally/` scores a finished run; `view/` derives what the screen and the game master both see, one file per view (room, entities, census, character panel, map); `sessions/` wraps one run, played in the browser or through the server. |
| `illustrations/` | Room illustrations and creature sprites: the camera search, button hotspots, where figures stand, the guide image and the prompts for the image model. |
| `journal/` | The per-run event log, and its readable rendering. Records what generation and gameplay did, so it sits above generation; generation writes to it through `generation/log.ts`. |
| `generation/` | Building a dungeon. `generate.ts` is the pipeline. `floorplan/` is the physical dungeon: graph, planar layout, room shapes, fixtures and the map. `content/` is what is in it: stocking (`stock/`), challenges, rewards, and the model passes that write its prose (the content pass in `passes/content-pass/`, one file per stage), with their schemas in `content/passes/schemas.ts`. |
| `llm/` | The Anthropic transport, forced-tool JSON calls, the shape of a validation issue, and `models.ts`, the only file allowed to name a model. Knows nothing about the game: each schema lives with the code that asks for that answer. |
| `prompts/` | Every instruction to a model, as markdown: the game master's playbook, the generation passes, the tally, and the illustration and sprite prompts. `loader.ts` is the one place they are imported, with each prompt's design note beside it. |
| `rules/` | The game systems, one folder each. `knave/` is Knave 1.0, the system played: dice, the character sheet, creation, levelling, equipment and the shop. `maze-rats/` and `cairn/` are the tables generation rolls on. Another game's rules would sit beside them. |
| `shared/` | Used across areas. `types/` holds the turn and commit shapes; `world/` the world model (entities, challenges, placement, what a creature was rolled from); `utils/` small helpers: the seeded `Rng`, ids, grid keys, formatting, zod helpers. |

**Not yet where it belongs.** Knave's assumptions still reach outside
`rules/knave/`: `gameplay/diffs/paths.ts`, `gameplay/game-master/render.ts`,
`gameplay/game-master/schemas.ts`, `gameplay/turn.ts`, `shared/world/entities.ts` and the
content pass's stat blocks, and `shared/types/` names Knave's sheet and roll results (the
two layer exceptions). They move behind a ruleset interface when there is a second game
to put behind it (`docs/ROADMAP.md`, *A second ruleset*).
