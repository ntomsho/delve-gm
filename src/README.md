# src/

Where everything lives. Each folder may import only from the folders below it
in this list; `src/architecture.test.ts` enforces the two rules that a grep can
check.

| Folder | What it holds |
|---|---|
| `ui/` | React. The only folder that imports it. One subfolder per screen (`sign-in/`, `characters/`, `create/`, `shop/`, `run-setup/`, `play/`), plus `app/` (the shell and URL switches), `shared/` (theme, media queries, the store hook) and `test-utils/` (jsdom setup). |
| `server/` | The API: Hono routes (`app.ts`), Postgres (`db/`), illustration storage (`illustrations/`), auth and allowances. `vercel.ts` is the deployed entry point. |
| `dev/` | Developer CLIs (`cli-*.ts`) and the local API server (`api-server.ts`); helpers in `lib/`. May import anything; nothing imports it. |
| `api-client/` | The browser's calls to our own API: auth, characters, dungeons, allowance. |
| `gameplay/` | A run being played. `turn.ts` is the turn state machine; `game-master/` is the model that runs each turn and the code that builds its prompt; `diffs/` is the applier, the one place game state changes; `state/` is the store; `mechanics/` holds play-time rules (movement, occupancy, challenges, loot); `tally/` scores a finished run; `view/` derives what the screen and the game master both see; `sessions/` wraps one run, played in the browser or through the server. |
| `illustrations/` | Room illustrations: the camera search, button hotspots, the guide image and the prompts for the image model. |
| `generation/` | Building a dungeon. `generate.ts` is the pipeline. `floorplan/` is the physical dungeon: graph, planar layout, room shapes, fixtures and the map. `content/` is what is in it: stocking tables, challenges, rewards, and the model passes that write its prose. |
| `journal/` | The per-run event log, and its readable rendering. |
| `llm/` | The Anthropic transport, forced-tool JSON calls, zod schemas, and `models.ts`, the only file allowed to name a model. |
| `prompts/` | Every instruction to a model, as markdown. `loader.ts` is the one place it is imported. |
| `rules/` | The game system. `knave/` is Knave 1.0: dice, the character sheet, creation, levelling, equipment and the shop. Another game's rules would sit beside it. |
| `shared/` | Used across areas. `types/` holds the cross-cutting data shapes, `world/` the entity model, `utils/` small reusable helpers. |
| `fixtures/` | Stand-ins for the model: the offline dungeon and the stub game master, used by tests, the dev CLIs and `?offline` / `?stub`. |

**Not yet where it belongs.** Some code still sits inside a large file and will
move when that file is split:

- `shared/types/`: `GeneratedDungeon` is still in `generation/generate.ts` and
  `RunState` in `gameplay/state/store.ts`.
- `shared/utils/`: the `Rng` class and `makeId` are still in
  `generation/content/blueprint.ts`. Grid helpers (`cellKey`, `pairKey`,
  `route`, `traceOutline`) are defined separately in several floorplan and
  illustration files.
- `prompts/`: the generation, tally and illustration instructions are still
  TypeScript strings beside the code that sends them.
- `rules/knave/`: Knave assumptions are still built into `gameplay/diffs/paths.ts`,
  `gameplay/game-master/render.ts`, `llm/schemas.ts`, `gameplay/turn.ts`,
  `shared/world/entities.ts` and the content pass's stat blocks.
- `server/routes/`: the routes are all in `server/app.ts`.
