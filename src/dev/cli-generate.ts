/**
 * HEADLESS GENERATION
 * ===================
 *
 * Runs the whole pipeline for a seed and dumps the result to JSON. No UI, no
 * browser — this is where the expensive, high-uncertainty part gets iterated on
 * in an environment where a change costs a shell command.
 *
 *   node src/dev/cli-generate.ts --seed 1005 --size 2
 *   node src/dev/cli-generate.ts --seed 1005 --size 2 --dry     # prompts only, no calls
 *   node src/dev/cli-generate.ts --seed 1005 --out out/1005.json
 *   node src/dev/cli-generate.ts --seed 1005 --size 3 --dry --map out/1005.svg
 *
 * `--dry` is the workhorse. It renders every prompt the run would send and
 * exits, so prompt wording can be iterated at zero cost and zero latency.
 *
 * THE KEY. This process reads ANTHROPIC_API_KEY out of .env.local and calls the
 * API directly, because there is no dev server here to proxy through. That is
 * the intended shape: the rule is that the key never reaches the browser, and
 * this is Node.
 */

import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  buildContentPassPayload,
  buildDungeonPassPayload,
  floorplanSvg,
  generateBlueprint,
  generateBlueprintSeed,
  generateFloorplanValid,
  renderContentPassPrompt,
  renderDungeonPassPrompt,
  resolveBase,
  Rng,
  runEntitiesPass,
  stockDungeon,
  validateFloorplan,
  type Dungeon,
  type Size,
  type StockedDungeon,
} from "../engine/index.ts";
import { configureTransport } from "../runtime/llm/client.ts";
import { generateDungeon, validateWritten, type GenerationProgress } from "../runtime/generate.ts";
import { chunksFor, deriveSeeds } from "../runtime/seeds.ts";

// ---------------------------------------------------------------------------
// ARGS
// ---------------------------------------------------------------------------

interface Args {
  seed: number;
  size: Size;
  level: number;
  out: string | null;
  dry: boolean;
  chunk: number | null;
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
  if (![1, 2, 3, 4, 5].includes(size)) die(`--size must be 1-5, got ${size}`);

  return {
    seed: num("seed", 1005),
    size: size as Size,
    level: num("level", 1),
    out: get("out") ?? null,
    dry: argv.includes("--dry"),
    chunk: argv.includes("--chunk") ? num("chunk", 0) : null,
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

  const { dungeon } = generateBlueprint(seeds.graphSeed, { chunks: chunksFor(args.size) }, true);
  const sd = stockDungeon(dungeon, bp, { level: args.level, seed: seeds.stockSeed });
  const ep = runEntitiesPass(sd, bp, new Rng(sd.seed));

  const placeholder =
    "[DUNGEON PASS OUTPUT — theme, history, who lives here, and the goal would be here]";

  const chunks = [...new Set(sd.rooms.map((r) => r.chunk))].sort((a, b) => a - b);
  const wanted = args.chunk === null ? chunks : chunks.filter((c) => c === args.chunk);
  if (!wanted.length) die(`--chunk ${args.chunk} is out of range (have ${chunks.join(", ")})`);

  for (const chunk of wanted) {
    console.log("\n" + RULE);
    console.log(`CONTENT PASS  —  chunk ${chunk} of ${chunks.length}`);
    console.log(RULE);
    console.log(renderContentPassPrompt(buildContentPassPayload(sd, bp, ep, chunk, placeholder)));
  }

  console.error(
    `\n[dry] ${chunks.length} chunk(s), ${sd.rooms.length} rooms, ` +
      `${ep.creatures.length} creature anchors, ${bp.inhabitants.length} inhabitant group(s). No calls made.`
  );

  // The floorplan is pure, so --map needs no key and belongs here as much as in
  // a live run. This is the iteration surface for the geometry.
  if (args.map) writeMap(args, dungeon, sd);
}

/**
 * Draw the plan and say whether it is sound. Plain line art, no decoration —
 * the point is to look at a hundred of them, not to look at one nicely.
 */
function writeMap(args: Args, dungeon: Dungeon, sd: StockedDungeon): void {
  const seeds = deriveSeeds(args.seed);
  const started = Date.now();
  const fp = generateFloorplanValid(dungeon, sd, { seed: seeds.layoutSeed });
  if (!fp) {
    console.error(
      `\n[map] no floorplan: the packer could not draw this graph. ` +
        `That is expected at sizes 4-5 — see CODING-PLAN §6a.`
    );
    return;
  }

  const problems = validateFloorplan(fp, dungeon, sd);
  const corridors = fp.rooms.filter((r) => r.isCorridor).length;
  console.error(
    `\n[map] ${fp.rooms.length} rooms (${corridors} corridors), ${fp.doors.length} doors, ` +
      `${fp.bounds.w}x${fp.bounds.h} cells, ${fp.attempts} attempt(s), ${Date.now() - started}ms`
  );
  if (problems.length) {
    console.error(`[map] ${problems.length} PROBLEM(S) — the plan is not sound:`);
    for (const p of problems.slice(0, 10)) console.error(`  ${p}`);
  }

  mkdirSync(dirname(resolve(args.map!)), { recursive: true });
  writeFileSync(resolve(args.map!), floorplanSvg(fp));
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
  writing: "Writing the rooms",
  joining: "Writing the ways between regions",
};

async function liveRun(args: Args): Promise<void> {
  configureTransport({
    baseUrl: "https://api.anthropic.com",
    headers: { "x-api-key": loadApiKey(), "anthropic-version": "2023-06-01" },
  });

  const started = Date.now();
  let lastLine = "";
  const report = (p: GenerationProgress) => {
    const line =
      p.chunksTotal !== undefined
        ? `${STAGE_LABEL[p.stage]} — ${p.chunksDone} of ${p.chunksTotal} regions`
        : STAGE_LABEL[p.stage];
    if (line === lastLine) return;
    lastLine = line;
    console.error(`  ${line}`);
  };

  console.error(
    `LIVE RUN — calling the model. seed ${args.seed}, size ${args.size}, ` +
      `level ${args.level}, ${chunksFor(args.size)} region(s).`
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

  if (args.map) writeMap(args, gd.graph, gd.stocked);

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
