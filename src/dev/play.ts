/**
 * A WHOLE RUN, IN A TERMINAL
 * ==========================
 *
 * The same runtime the browser plays, with no browser: one `GameSession`,
 * driven from stdin, writing its journal to `out/runs/<run id>/`.
 *
 * Started by `cli-play.ts`, which is a way in and nothing else — this file is
 * imported rather than run, so that the raw-markdown hook is registered before
 * the playbook is reached.
 *
 * This is the proof that came out of Phase 9 rather than a convenience. Until
 * the store and the journal stopped being module singletons and the run
 * lifecycle came out of `App.tsx`, the only way to play a turn was to render a
 * component — which meant the runtime could not be exercised from a script, a
 * test harness, or a server handler. If this file works, a request handler
 * will.
 *
 * It is also the fastest way to read a run's prose. `PlayScreen` is the wrong
 * tool for judging whether an arrival is any good; a terminal you can scroll is
 * the right one.
 *
 * THE KEY. Like `cli-generate.ts`, this process reads ANTHROPIC_API_KEY out of
 * .env.local and calls the API directly, because there is no dev server here to
 * proxy through. The rule is that the key never reaches the BROWSER, and this
 * is Node.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { configureTransport } from "../runtime/llm/client.ts";
import { createGameSession } from "../runtime/session.ts";
import { generateOffline, testCharacter } from "../runtime/__fixtures__/offline.ts";
import { stubReferee } from "../runtime/__fixtures__/stub-referee.ts";
import { isTerminal, type Stage } from "../runtime/types.ts";
import type { GenerationProgress } from "../runtime/generate.ts";
import type { LogEntry } from "../store/game.ts";
import { dirFor, fileSink } from "./journal-fs.ts";
import type { Size } from "../engine/index.ts";

// ---------------------------------------------------------------------------
// ARGS
// ---------------------------------------------------------------------------

interface Args {
  seed: number;
  size: Size;
  level: number;
  /** the fixture dungeon AND the fixture referee — spends nothing, calls nothing */
  offline: boolean;
  /** the stub referee on a real dungeon. Generation still costs. */
  stub: boolean;
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

  const size = num("size", 1);
  if (![1, 2, 3, 4, 5].includes(size)) die(`--size must be 1-5, got ${size}`);

  const offline = argv.includes("--offline");
  return {
    seed: num("seed", 1005),
    size: size as Size,
    level: num("level", 1),
    offline,
    // OFFLINE MEANS OFFLINE. It used to swap only the generator in the browser,
    // and the first room entry then called the model before the player had
    // typed anything. Same reasoning, same rule — see `switches.ts`.
    stub: offline || argv.includes("--stub"),
  };
}

function die(msg: string): never {
  console.error(`cli-play: ${msg}`);
  process.exit(1);
}

function loadApiKey(): string {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;

  const path = resolve(process.cwd(), ".env.local");
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    die(
      `no ANTHROPIC_API_KEY in the environment and no .env.local at ${path}\n` +
        `         copy .env.local.example and fill it in, or run with --offline`
    );
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
// THE PAGE
// ---------------------------------------------------------------------------

const RULE = "─".repeat(72);

const STAGE_LABEL: Record<GenerationProgress["stage"], string> = {
  layout: "Laying out the dungeon",
  inhabitants: "Deciding what lives here",
  history: "Writing its history",
  stocking: "Stocking the rooms",
  writing: "Writing the rooms",
  joining: "Writing the ways between regions",
  keys: "Writing the keys",
};

/** Wrap to something a terminal can read. The prose is paragraphs, not lines. */
function wrap(text: string, width = 72): string {
  return text
    .split("\n")
    .map((para) => {
      const out: string[] = [];
      let line = "";
      for (const word of para.split(/\s+/).filter(Boolean)) {
        if (line && line.length + word.length + 1 > width) {
          out.push(line);
          line = word;
        } else {
          line = line ? `${line} ${word}` : word;
        }
      }
      if (line) out.push(line);
      return out.join("\n");
    })
    .join("\n");
}

function show(entry: LogEntry, roomName: (id: string) => string): void {
  switch (entry.kind) {
    case "opening":
      console.log(`\n${RULE}\n${wrap(entry.text)}\n${RULE}`);
      break;
    case "arrival":
      console.log(`\n── ${entry.roomId ? roomName(entry.roomId) : "Somewhere"} ──\n`);
      console.log(wrap(entry.text));
      break;
    case "player":
      console.log(`\n> ${entry.text}`);
      break;
    case "roll":
      console.log(`\n  🎲 ${entry.text}`);
      break;
    default:
      console.log(`\n${wrap(entry.text)}`);
  }
}

/** What the player is being asked for, if anything. */
function prompt(stage: Stage): string | undefined {
  switch (stage) {
    case "awaiting_action":
      return "\nWhat do you do? ";
    case "clarifying":
    case "rejected":
      return "\n> ";
    case "roll_offered":
      return "\n[enter] to roll, or say something else: ";
    case "error":
      return "\n[enter] to try that again, or say something else: ";
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (!args.offline) {
    configureTransport({
      baseUrl: "https://api.anthropic.com",
      headers: { "x-api-key": loadApiKey(), "anthropic-version": "2023-06-01" },
    });
  }

  let dir = "";
  let lastStage = "";
  const session = createGameSession({
    sink: (id) => fileSink((dir = dirFor(id))),
    ...(args.stub ? { referee: () => stubReferee } : {}),
    ...(args.offline
      ? { offline: true, generate: async ({ seed, size }) => generateOffline(seed, size) }
      : {}),
    onProgress: (p: GenerationProgress) => {
      const line =
        p.chunksTotal !== undefined
          ? `${STAGE_LABEL[p.stage]} — ${p.chunksDone} of ${p.chunksTotal} regions`
          : STAGE_LABEL[p.stage];
      if (line === lastStage) return;
      lastStage = line;
      console.error(`  ${line}`);
    },
  });

  console.error(
    `seed ${args.seed}, size ${args.size}, level ${args.level}` +
      `${args.offline ? " — OFFLINE, nothing will be called" : args.stub ? " — stub referee" : ""}`
  );

  const state = () => session.store.getState();
  /** How much of the scrollback has reached the terminal. */
  let printed = 0;
  const roomName = (id: string) =>
    state().run?.entities.rooms.find((r) => r.id === id)?.name ?? "Somewhere";

  const flush = () => {
    const log = state().run?.log ?? [];
    for (const entry of log.slice(printed)) show(entry, roomName);
    printed = log.length;
  };

  await session.begin({
    seed: args.seed,
    size: args.size,
    level: args.level,
    character: testCharacter(),
  });
  flush();

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  // Lines are PULLED rather than asked for. `rl.question` drops buffered input
  // when stdin is a pipe: the second line of a piped script never arrives, and
  // the promise waiting for it never settles either. So the prompt is written
  // by hand and the iterator hands over one line at a time — which behaves the
  // same at a terminal, the case that has to keep feeling normal.
  const lines = rl[Symbol.asyncIterator]();

  for (;;) {
    const run = state().run;
    if (!run || isTerminal(run.stage)) break;

    const ask = prompt(run.stage);
    if (ask === undefined) {
      // A stage nobody can answer — the machine is mid-turn, or something went
      // wrong that `error` did not catch. Saying so beats spinning.
      console.error(`\ncli-play: nothing to do at stage "${run.stage}".`);
      break;
    }

    process.stdout.write(ask);
    const line = await lines.next();
    if (line.done) break; // stdin closed
    const text = line.value.trim();

    if (text === "quit" || text === "exit") break;

    if (text === "" && run.stage === "roll_offered") await session.roll();
    else if (text === "" && run.stage === "error") await session.retry();
    else if (text !== "") await session.submit(text);

    flush();
  }

  rl.close();

  const run = state().run;
  if (run && isTerminal(run.stage)) {
    console.log(`\n${RULE}\n  ${run.stage.replace("_", " ").toUpperCase()} — ${run.turnCount} turns\n${RULE}`);
  }

  const spent = run?.callLog.reduce(
    (a, c) => ({
      in: a.in + c.inputTokens,
      out: a.out + c.outputTokens,
      write: a.write + c.cacheWriteTokens,
      read: a.read + c.cacheReadTokens,
    }),
    { in: 0, out: 0, write: 0, read: 0 }
  );
  if (spent && spent.in + spent.out > 0) {
    console.error(
      `\n${run!.callLog.length} calls · ${spent.in.toLocaleString()} in / ${spent.out.toLocaleString()} out` +
        ` · cache ${spent.write.toLocaleString()} written / ${spent.read.toLocaleString()} read`
    );
  }
  if (dir) console.error(`journal: ${dir}`);
}

await main();
