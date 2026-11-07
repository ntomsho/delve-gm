/**
 * The CLI behind `dev/cli-generate.ts`, which teaches Node `?raw` first and then
 * imports this. Usage is in that file.
 */

import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { blockPlanValid, roomSizes, type BlockPlan } from "../../generation/floorplan/blockplan.ts";
import { renderContentPassPrompt } from "../../generation/content/passes/content-pass/prompt.ts";
import { buildContentPassPayload } from "../../generation/content/passes/content-pass/build.ts";
import {
  buildDungeonPassPayload,
  renderDungeonPassPrompt,
} from "../../generation/content/passes/dungeon-pass.ts";
import { generateBlueprint, type Dungeon } from "../../generation/floorplan/graph.ts";
import { generateBlueprintSeed, type Size } from "../../generation/content/blueprint.ts";
import { Rng } from "../../shared/utils/rng.ts";
import { resolveBase } from "../../shared/world/entities.ts";
import { runEntitiesPass } from "../../generation/content/entities-pass.ts";
import { siteRooms } from "../../generation/floorplan/geometry.ts";
import { fakeDungeonPass, fakeOutline } from "../../fixtures/offline.ts";
import { renderOutlinePrompt } from "../../generation/content/passes/outline/prompt.ts";
import { rollOutline } from "../../generation/content/passes/outline/roll.ts";
import { settleOutline } from "../../generation/content/passes/outline/settle.ts";
import type { StockedDungeon } from "../../generation/content/types.ts";
import { configureTransport } from "../../llm/client.ts";
import { floorplanLayout, type PlacedThing } from "../../generation/floorplan/map-layout.ts";
import { placedThings } from "../../gameplay/mechanics/occupancy.ts";
import { layoutSvg } from "../../generation/floorplan/map-svg.ts";
import { generateDungeon, validateWritten, type GenerationProgress } from "../../generation/generate.ts";
import { deriveSeeds, shapeFor, SIZE_NAMES } from "../../generation/seeds.ts";

// ---------------------------------------------------------------------------
// ARGS
// ---------------------------------------------------------------------------

interface Args {
  seed: number;
  size: Size;
  level: number;
  out: string | null;
  dry: boolean;
  /** where to write the floorplan as plain line art */
  map: string | null;
}

function parseArgs(argv: string[]): Args {
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? undefined : argv[i + 1];
  };
  const num = (name: string, fallback: number): number => {
    const raw = get(name);
    if (raw === undefined) return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n)) die(`--${name} must be a number, got "${raw}"`);
    return n;
  };

  const size = num("size", 2);
  if (![1, 2, 3].includes(size)) die(`--size must be 1 (small), 2 (medium) or 3 (large), got ${size}`);

  return {
    seed: num("seed", 1005),
    size: size as Size,
    level: num("level", 1),
    out: get("out") ?? null,
    dry: argv.includes("--dry"),
    map: argv.includes("--map") ? (get("map") ?? "out/map.svg") : null,
  };
}

function die(msg: string): never {
  console.error(`cli-generate: ${msg}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// ENV
// ---------------------------------------------------------------------------

function loadApiKey(): string {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;

  const path = resolve(process.cwd(), ".env.local");
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    die(`no ANTHROPIC_API_KEY in the environment and no .env.local at ${path}\n` +
        `             copy .env.local.example and fill it in, or run with --dry`);
  }

  for (const line of text.split("\n")) {
    const m = line.match(/^\s*ANTHROPIC_API_KEY\s*=\s*(.*?)\s*$/);
    if (m) {
      const value = m[1].replace(/^["']|["']$/g, "");
      if (value && !value.startsWith("sk-ant-...")) return value;
    }
  }
  die(".env.local has no usable ANTHROPIC_API_KEY");
}

// ---------------------------------------------------------------------------
// DRY RUN
// ---------------------------------------------------------------------------

const RULE = "=".repeat(78);

/** Every prompt the run would send, rendered, with nothing called. */
function dryRun(args: Args): void {
  // Announced up front, on stderr, because the prompts that follow are
  // thousands of lines and a note at the bottom is a note nobody reads.
  console.error("DRY RUN — rendering prompts only. No model calls will be made.");
  console.error("Drop --dry (or use `npm run generate`) to generate for real.\n");

  const seeds = deriveSeeds(args.seed);
  const bp = generateBlueprintSeed(args.size, seeds.blueprintSeed, args.level);

  console.log(RULE);
  console.log(`DUNGEON PASS  —  seed ${args.seed}, size ${args.size}, level ${args.level}`);
  console.log(RULE);
  console.log(renderDungeonPassPrompt(buildDungeonPassPayload(bp)));

  const { dungeon } = generateBlueprint(seeds.graphSeed, shapeFor(args.size, seeds.graphSeed), true);

  // THE DRAWING RUNS INSIDE THE ROLL, exactly as it does in `generate.ts`. A dry run
  // that skipped it would render prompts without the "as drawn" line and without the
  // fixture menu. The outline here is a stand-in: nothing is called, so nothing plans.
  let plan: BlockPlan | null = null;
  const draft = rollOutline(dungeon, bp, {
    level: args.level,
    seed: seeds.stockSeed,
    layout: (rooms) => {
      const corridor = new Set(rooms.filter((r) => r.isCorridor).map((r) => r.index));
      plan = blockPlanValid(dungeon, (i) => corridor.has(i), seeds.layoutSeed);
      return plan ? roomSizes(plan.rooms) : rooms.map(() => undefined);
    },
  });
  const sd = settleOutline(draft, fakeOutline(draft), { level: args.level, seed: seeds.stockSeed });
  const ep = runEntitiesPass(sd, bp, new Rng(sd.seed));

  const drawn = plan as BlockPlan | null;
  const corridors = new Set(sd.rooms.filter((r) => r.isCorridor).map((r) => r.index));
  const site = drawn
    ? siteRooms(drawn, dungeon, { isCorridor: (i) => corridors.has(i) })
    : undefined;
  if (!drawn) {
    console.error(
      "[dry] NO LAYOUT for this graph — prompts will carry no geometry and no " +
        "fixture menu. A live run throws the graph away and generates another.\n"
    );
  }

  const placeholder =
    "[DUNGEON PASS OUTPUT — theme, history, who lives here, and the goal would be here]";

  console.log("\n" + RULE);
  console.log("OUTLINE  (with a stand-in dungeon pass)");
  console.log(RULE);
  console.log(renderOutlinePrompt(draft, fakeDungeonPass(bp.inhabitants.map((g) => g.id))));

  console.log("\n" + RULE);
  console.log("CONTENT PASS  (with a stand-in outline)");
  console.log(RULE);
  console.log(renderContentPassPrompt(buildContentPassPayload(sd, bp, ep, placeholder, site)));

  console.error(
    `\n[dry] ${sd.rooms.length} rooms, ` +
      `${ep.creatures.length} creature anchors, ${bp.inhabitants.length} inhabitant group(s). No calls made.`
  );

  // The floorplan is pure, so --map needs no key and belongs here as much as in
  // a live run. This is the iteration surface for the geometry.
  //
  // NOTHING IS PLACED HERE. Fixtures come back from the content pass, which a
  // dry run never makes, so the dry map draws the rooms and no dots. Placement
  // is eyeballed off a live `--out` run, or off `--map` on one.
  if (args.map) writeMap(args, dungeon, sd, drawn);
}

/**
 * Draw the plan and say whether it is sound. Plain line art, no decoration —
 * the point is to look at a hundred of them, not to look at one nicely.
 */
function writeMap(
  args: Args,
  dungeon: Dungeon,
  sd: StockedDungeon,
  drawn?: BlockPlan | null,
  placed: readonly PlacedThing[] = []
): void {
  const seeds = deriveSeeds(args.seed);
  const started = Date.now();
  const corridors = new Set(sd.rooms.filter((r) => r.isCorridor).map((r) => r.index));
  // Reuse the plan the caller already drew when there is one. Drawing it twice
  // from the same seed gives the same answer, but it also silently permits the
  // two to drift if either side ever changes how it seeds the layout.
  const plan = drawn ?? blockPlanValid(dungeon, (i) => corridors.has(i), seeds.layoutSeed);
  if (!plan) {
    console.error(
      `\n[map] no layout: untangling did not clear every crossing on this graph. ` +
        `A live run throws the graph away and generates another.`
    );
    return;
  }

  // Through `floorplanLayout`, not straight off the plan, so this draws exactly
  // what the game draws. A dump that renders the plan its own way can look
  // right while the map in the app looks wrong.
  const layout = floorplanLayout(plan, dungeon, {
    isCorridor: (i) => corridors.has(i),
    placed,
  });
  const marks = layout.fixtures.reduce((n, f) => n + f.at.length, 0);
  console.error(
    `\n[map] ${layout.rooms.length} rooms (${corridors.size} corridors), ` +
      `${layout.connectors.length} doors${layout.surface ? " + the way out" : ", NO WAY OUT"}, ` +
      `${layout.fixtures.length} placed (${marks} marks), ` +
      `${Math.round(layout.bounds.w)}x${Math.round(layout.bounds.h)}, ` +
      `${plan.attempts} attempt(s), ${Date.now() - started}ms`
  );

  mkdirSync(dirname(resolve(args.map!)), { recursive: true });
  writeFileSync(resolve(args.map!), layoutSvg(layout));
  console.error(`[map] Wrote ${args.map}`);
}

// ---------------------------------------------------------------------------
// LIVE RUN
// ---------------------------------------------------------------------------

const STAGE_LABEL: Record<GenerationProgress["stage"], string> = {
  layout: "Laying out the dungeon",
  inhabitants: "Deciding what lives here",
  history: "Writing its history",
  stocking: "Stocking the rooms",
  planning: "Planning the dungeon",
  reviewing: "Reviewing the plan",
  writing: "Writing the rooms",
  keys: "Writing the keys",
};

async function liveRun(args: Args): Promise<void> {
  configureTransport({
    baseUrl: "https://api.anthropic.com",
    headers: { "x-api-key": loadApiKey(), "anthropic-version": "2023-06-01" },
  });

  const started = Date.now();
  let lastLine = "";
  const report = (p: GenerationProgress) => {
    const line = STAGE_LABEL[p.stage];
    if (line === lastLine) return;
    lastLine = line;
    console.error(`  ${line}`);
  };

  console.error(
    `LIVE RUN — calling the model. seed ${args.seed}, size ${args.size} (${SIZE_NAMES[args.size]}), ` +
      `level ${args.level}, ${shapeFor(args.size, String(args.seed)).rooms} rooms.`
  );
  const gd = await generateDungeon({
    seed: args.seed,
    size: args.size,
    level: args.level,
    onProgress: report,
  });

  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const e = gd.entities;
  console.error(
    `\n"${gd.pass.name}" — ${e.rooms.length} rooms, ${e.creatures.length} creatures, ` +
      `${e.items.length} items, ${e.features.length} features, ${e.hazards.length} hazards`
  );
  console.error(`Goal: ${gd.pass.goal.summary}`);
  console.error(
    `${seconds}s, ${gd.usage.inputTokens.toLocaleString()} in / ${gd.usage.outputTokens.toLocaleString()} out`
  );

  const problems = validateWritten(gd);
  if (problems.length) {
    console.error(`\n${problems.length} PROBLEM(S):`);
    for (const p of problems.slice(0, 20)) {
      console.error(`  [${p.kind}] ${p.entityId.slice(0, 8)} — ${p.detail}`);
    }
    if (problems.length > 20) console.error(`  …and ${problems.length - 20} more`);
  } else {
    console.error("\nFully written: every entity has a name and a resolvable base.");
  }

  if (args.map) writeMap(args, gd.graph, gd.stocked, gd.blockplan, placedThings(e));

  const out = args.out ?? `out/dungeon-${args.seed}-s${args.size}.json`;
  mkdirSync(dirname(resolve(out)), { recursive: true });
  writeFileSync(resolve(out), JSON.stringify(gd, null, 2));
  console.error(`\nWrote ${out}`);

  // A sample, so a run says something about quality without opening the JSON.
  const room = e.rooms.find((r) => r.id === gd.stocked.entranceRoomId) ?? e.rooms[0];
  if (room) {
    console.error(`\n--- ${room.name} (entrance) ---`);
    console.error(resolveBase(room, e.registry) ?? "(no base)");
  }

  if (problems.length) process.exit(1);
}

// ---------------------------------------------------------------------------

const args = parseArgs(process.argv.slice(2));
if (args.dry) {
  dryRun(args);
} else {
  await liveRun(args);
}
