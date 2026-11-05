/**
 * The script behind `src/dev/cli-outline.ts`: measures the outline pass on its own,
 * with no content pass, across writer and reviewer models. See docs/BUILD-PLAN.md,
 * phase 2, *Measuring*.
 *
 * Each seed's dungeon pass runs once, and all four combinations outline that same
 * dungeon, so a difference between them is a difference between the models.
 *
 * `--dry` prints the prompt a seed would send, with a stand-in dungeon pass, and
 * calls nothing.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fakeDungeonPass } from "../../fixtures/offline.ts";
import { generateBlueprintSeed, type DungeonBlueprintSeed } from "../../generation/content/blueprint.ts";
import {
  buildDungeonPassPayload,
  renderDungeonPassPrompt,
  type DungeonPassResponse,
} from "../../generation/content/passes/dungeon-pass.ts";
import { renderOutlineForReview, renderOutlinePrompt } from "../../generation/content/passes/outline/prompt.ts";
import { changedFiction, type Outline, type PolishEdit } from "../../generation/content/passes/outline/response.ts";
import { rollOutline, type OutlineDraft } from "../../generation/content/passes/outline/roll.ts";
import { polishOutline, writeOutline } from "../../generation/content/passes/outline/run.ts";
import { dungeonPassToolSchema, fromDungeonPassTool } from "../../generation/content/passes/schemas.ts";
import { blockPlanValid, roomSizes } from "../../generation/floorplan/blockplan.ts";
import { generateBlueprint } from "../../generation/floorplan/graph.ts";
import { deriveSeeds, shapeFor } from "../../generation/seeds.ts";
import { callForJson, configureTransport, type FailedAttempt } from "../../llm/client.ts";
import { textCost } from "../../llm/cost.ts";
import { HAIKU, SONNET } from "../../llm/models.ts";

const SIZE = 1;
/** A plain goal, a social goal with only monsters here, and one with people. */
const DEFAULT_SEEDS = [1005, 1007, 1025];
const CHOSEN = [{ writer: HAIKU, reviewer: HAIKU }];
/** `--compare`: every pairing measured for the model choice. */
const ALL_PAIRINGS = [
  ...CHOSEN,
  { writer: HAIKU, reviewer: SONNET },
  { writer: SONNET, reviewer: HAIKU },
  { writer: SONNET, reviewer: SONNET },
];
const COMBINATIONS = process.argv.includes("--compare") ? ALL_PAIRINGS : CHOSEN;
const SHORT: Record<string, string> = { [HAIKU]: "Haiku 5.5", [SONNET]: "Sonnet 5.5" };

function die(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

function loadApiKey(): string {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  try {
    for (const line of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split("\n")) {
      const m = line.match(/^\s*ANTHROPIC_API_KEY\s*=\s*(.*?)\s*$/);
      if (m?.[1]) return m[1].replace(/^["']|["']$/g, "");
    }
  } catch {
    // Falls through to the message below.
  }
  die("no ANTHROPIC_API_KEY in the environment or .env.local; run with --dry to call nothing");
}

function draftFor(seed: number): OutlineDraft {
  const seeds = deriveSeeds(seed);
  const blueprint: DungeonBlueprintSeed = generateBlueprintSeed(SIZE, seeds.blueprintSeed, 1);
  const { dungeon } = generateBlueprint(seeds.graphSeed, shapeFor(SIZE, seeds.graphSeed), true);
  let drawn = false;
  const draft = rollOutline(dungeon, blueprint, {
    seed: seeds.stockSeed,
    layout: (rooms) => {
      const corridor = new Set(rooms.filter((r) => r.isCorridor).map((r) => r.index));
      const plan = blockPlanValid(dungeon, (i) => corridor.has(i), seeds.layoutSeed);
      drawn = !!plan;
      return plan ? roomSizes(plan.rooms) : rooms.map(() => undefined);
    },
  });
  if (!drawn) die(`seed ${seed} did not draw; pick another`);
  return draft;
}

interface Result {
  seed: number;
  writer: string;
  reviewer: string;
  firstTry: boolean;
  repairs: number;
  /** what the checks objected to on the way, each attempt */
  failures: string[];
  proposed: PolishEdit[];
  kept: boolean;
  rolledBack?: string;
  outlineDraft?: Outline;
  outlineFinal?: Outline;
  refused: boolean;
  /** set when the pass never produced an outline */
  error?: string;
  /** everything spent on this run, failed calls included */
  cost: number;
  seconds: number;
}

/** Every paid call, success or failure, counted as it lands. */
let spent = 0;

async function runCombination(
  seed: number,
  draft: OutlineDraft,
  pass: DungeonPassResponse,
  writer: string,
  reviewer: string
): Promise<Result> {
  const started = Date.now();
  const spentBefore = spent;
  const failures: string[] = [];
  let refused = false;
  const onAttemptFailed = (r: FailedAttempt) => {
    if (r.message.includes("refusal")) refused = true;
    failures.push(r.issues.length ? r.issues.map((i) => i.message).join("; ") : r.message);
  };
  const result: Result = {
    seed,
    writer,
    reviewer,
    firstTry: false,
    repairs: 0,
    failures,
    proposed: [],
    kept: false,
    refused: false,
    cost: 0,
    seconds: 0,
  };
  try {
    const written = await writeOutline(draft, pass, { model: writer, onAttemptFailed });
    result.firstTry = written.attempts === 1;
    result.repairs = written.attempts - 1;
    result.outlineDraft = written.outline;
    result.outlineFinal = written.outline;

    const polished = await polishOutline(draft, pass, written.outline, { model: reviewer, onAttemptFailed });
    result.proposed = polished.proposed;
    result.kept = polished.kept;
    if (polished.rolledBack) result.rolledBack = polished.rolledBack;
    result.outlineFinal = polished.outline;
  } catch (e) {
    result.error = e instanceof Error ? e.message : String(e);
  }
  result.refused = refused;
  result.cost = spent - spentBefore;
  result.seconds = (Date.now() - started) / 1000;
  return result;
}

const money = (n: number) => `$${n.toFixed(3)}`;

function renderSeed(seed: number, draft: OutlineDraft, pass: DungeonPassResponse, results: readonly Result[]): string {
  const g = draft.blueprint.goalSeed;
  const L: string[] = [
    `# Seed ${seed}: ${g.reward} + ${g.mission}`,
    "",
    `**${pass.name}.** ${pass.theme}`,
    "",
    `**History.** ${pass.history}`,
    "",
    `**Goal the player is told.** ${pass.goal.summary}`,
    "",
    `**Goal spec.** ${pass.goal.spec}`,
    "",
    `**Opening.** ${pass.openingProse}`,
    "",
    "## The dice",
    "",
    "```",
    renderOutlinePrompt(draft, pass).split("=== ROOMS")[1] ? `=== ROOMS${renderOutlinePrompt(draft, pass).split("=== ROOMS")[1]}` : "",
    "```",
  ];
  const ids = draft.blueprint.inhabitants.map((x) => x.id);
  for (const r of results) {
    L.push("", `## ${SHORT[r.writer]} writes, ${SHORT[r.reviewer]} reviews`, "");
    L.push(
      `${r.firstTry ? "Passed first try" : `${r.repairs} repair(s)`}. ${r.proposed.length} edit(s) proposed, ` +
        `${r.kept ? "kept" : r.rolledBack ? "rolled back" : "none kept"}. ` +
        `${money(r.cost)}, ${r.seconds.toFixed(0)}s.`
    );
    if (r.error) L.push("", `**FAILED:** ${r.error}`);
    if (r.refused) L.push("", "**A call was refused.**");
    if (r.failures.length) L.push("", "Objections:", ...r.failures.map((f) => `- ${f}`));
    if (r.rolledBack) L.push("", `Rolled back because: ${r.rolledBack}`);
    if (r.outlineDraft) L.push("", "### Draft", "", "```", renderOutlineForReview(r.outlineDraft), "```");
    if (r.proposed.length) {
      L.push("", "### Edits proposed", "");
      for (const e of r.proposed) {
        const named = [e.roomA, e.roomB, e.fiction, e.way, e.field, e.group, e.challenge].filter((v) => v !== "none");
        L.push(`- ${e.op} ${named.join(" ")}: ${e.why}${e.text !== "none" ? `\n  > ${e.text}` : ""}`);
      }
    }
    if (r.kept && r.outlineFinal) L.push("", "### After polish", "", "```", renderOutlineForReview(r.outlineFinal), "```");
    if (r.outlineFinal?.fictionChanges.length) {
      const next = changedFiction(pass, ids, r.outlineFinal.fictionChanges);
      if (next.history !== pass.history) L.push("", `History as changed: ${next.history}`);
      if (next.openingProse !== pass.openingProse) L.push("", `Opening as changed: ${next.openingProse}`);
    }
  }
  return L.join("\n");
}

function renderSummary(results: readonly Result[], dungeonPassCost: number): string {
  const L = [
    "# Outline measurement",
    "",
    "| Seed | Writer | Reviewer | First try | Repairs | Edits | Kept | Refused | Cost | Seconds |",
    "|---|---|---|---|---|---|---|---|---|---|",
  ];
  for (const r of results) {
    L.push(
      `| ${r.seed} | ${SHORT[r.writer]} | ${SHORT[r.reviewer]} | ${r.error ? "FAILED" : r.firstTry ? "yes" : "no"} | ${r.repairs} | ` +
        `${r.proposed.length} | ${r.kept ? "yes" : r.rolledBack ? "rolled back" : "-"} | ${r.refused ? "yes" : "-"} | ` +
        `${money(r.cost)} | ${r.seconds.toFixed(0)} |`
    );
  }
  L.push("", `Dungeon passes: ${money(dungeonPassCost)}. Total: ${money(spent)}.`);
  return L.join("\n");
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const get = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? undefined : argv[i + 1];
  };
  const seeds = get("seeds")?.split(",").map(Number) ?? DEFAULT_SEEDS;
  if (seeds.some((s) => !Number.isFinite(s))) die("--seeds must be comma-separated numbers");
  const outDir = resolve(get("out") ?? "out/outline");

  if (argv.includes("--dry")) {
    for (const seed of seeds) {
      const draft = draftFor(seed);
      const ids = draft.blueprint.inhabitants.map((g) => g.id);
      console.log(`\n========== seed ${seed} ==========\n`);
      console.log(renderOutlinePrompt(draft, fakeDungeonPass(ids)));
    }
    console.error(`\n[dry] ${seeds.length} seed(s). No calls made. Live: ${seeds.length * COMBINATIONS.length} outlines.`);
    return;
  }

  configureTransport({
    baseUrl: "https://api.anthropic.com",
    headers: { "x-api-key": loadApiKey(), "anthropic-version": "2023-06-01" },
    meter: {
      before: async () => {},
      after: async ({ model, usage }) => {
        spent += textCost(model, usage);
        console.error(`    call: ${usage.outputTokens} tokens out`);
      },
    },
  });
  mkdirSync(outDir, { recursive: true });

  const all: Result[] = [];
  let dungeonPassCost = 0;
  for (const seed of seeds) {
    const draft = draftFor(seed);
    console.error(`seed ${seed}: dungeon pass`);
    const payload = buildDungeonPassPayload(draft.blueprint);
    const spentBefore = spent;
    let pass: DungeonPassResponse;
    try {
      const answer = await callForJson({
        task: "dungeon-pass",
        schema: dungeonPassToolSchema,
        toolName: "establish_dungeon",
        toolDescription: "Record the dungeon's name, theme, history, goal, opening prose, and the standing identity of each inhabitant group.",
        messages: [{ role: "user", content: renderDungeonPassPrompt(payload) }],
      });
      pass = fromDungeonPassTool(answer.value);
    } catch (e) {
      console.error(`  dungeon pass FAILED, skipping this seed: ${e instanceof Error ? e.message : String(e)}`);
      dungeonPassCost += spent - spentBefore;
      continue;
    }
    dungeonPassCost += spent - spentBefore;

    const results: Result[] = [];
    for (const { writer, reviewer } of COMBINATIONS) {
      console.error(`seed ${seed}: ${SHORT[writer]} writes, ${SHORT[reviewer]} reviews`);
      const r = await runCombination(seed, draft, pass, writer, reviewer);
      results.push(r);
      all.push(r);
      console.error(`  ${r.error ? `FAILED: ${r.error}` : `${r.firstTry ? "first try" : `${r.repairs} repair(s)`}, ${money(r.cost)}, ${r.seconds.toFixed(0)}s`}`);
    }
    writeFileSync(join(outDir, `seed-${seed}.md`), renderSeed(seed, draft, pass, results));
    writeFileSync(join(outDir, "summary.md"), renderSummary(all, dungeonPassCost));
  }
  writeFileSync(join(outDir, "summary.md"), renderSummary(all, dungeonPassCost));
  console.error(`\nWrote ${outDir}`);
  console.log(renderSummary(all, dungeonPassCost));
}

await main();
