/**
 * THE ONE TEST THAT SPENDS MONEY
 * ==============================
 *
 * Everything else in this repo proves the referee behaves correctly when the
 * model answers the way the test says it does. That is most of what is worth
 * checking, and it is not the same as knowing a real model can play the game.
 * A tool schema the API rejects, a prompt that produces a commit naming ids
 * that do not exist, a playbook that reads well and instructs badly — none of
 * those fail a canned test.
 *
 * So: skipped unless asked for. This is a Windows project — PowerShell has no
 * inline env-var prefix, so the bash form of these lines does not run here.
 *
 *     PowerShell:  $env:LIVE = "1"; npx vitest run src/gameplay/sessions/live.test.ts
 *     bash:        LIVE=1 npx vitest run src/gameplay/sessions/live.test.ts
 *
 * `$env:` persists for the rest of the shell session; `$env:LIVE = $null` clears it.
 *
 * The dungeon is the offline fixture, so the only calls are the turns —
 * generation is proved out separately and costs a minute of real work.
 *
 * It asserts the shape of what came back and prints the prose, because whether
 * the prose is any GOOD is a judgement no assertion can make. Read it.
 *
 *     $env:LIVE = "1"; $env:LIVE_OUT = "out/turn.md"
 *     npx vitest run src/gameplay/sessions/live.test.ts
 *
 * `LIVE_OUT` writes the transcript to a file, which is worth knowing about
 * because vitest captures stdout and a passing test shows you none of it —
 * exactly the output you ran this for.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { configureTransport } from "../../llm/client.ts";
import { dirFor, fileSink } from "../../dev/lib/journal-fs.ts";
import { createGameSession } from "./session.ts";
import { generateOffline, testCharacter } from "../../fixtures/offline.ts";

const LIVE = process.env.LIVE === "1";
const SEED = 1005;
let journalDir = "";

/** No dev server here to proxy through, so this process holds the key. Node. */
function apiKey(): string {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  const text = readFileSync(resolve(process.cwd(), ".env.local"), "utf8");
  const m = text.match(/^\s*ANTHROPIC_API_KEY\s*=\s*(.*?)\s*$/m);
  const value = m?.[1].replace(/^["']|["']$/g, "");
  if (!value) throw new Error(".env.local has no usable ANTHROPIC_API_KEY");
  return value;
}

describe.skipIf(!LIVE)("a real model refereeing a real turn", () => {
  beforeAll(() => {
    configureTransport({
      baseUrl: "https://api.anthropic.com",
      headers: { "x-api-key": apiKey(), "anthropic-version": "2023-06-01" },
    });
  });

  /**
   * A whole run in one object, exactly as the app and the CLI build one: the
   * fixture dungeon so only the turns cost anything, the real referee, and the
   * journal on disk — which is also the only automated check that the journal
   * survives a real turn.
   */
  const session = createGameSession({
    offline: true,
    generate: async ({ seed, size }) => generateOffline(seed, size),
    sink: (id) => fileSink((journalDir = dirFor(id))),
  });

  it("walks into a room, then acts in it", { timeout: 180_000 }, async () => {
    const state = () => session.store.getState().run!;

    const report: string[] = [];
    const say = (s: string) => {
      report.push(s);
      console.log(s);
      if (process.env.LIVE_OUT) writeFileSync(process.env.LIVE_OUT, report.join("\n\n"));
    };

    // Generates (from the fixture), starts the run, and describes the room.
    await session.begin({ seed: SEED, size: 1, level: 1, character: testCharacter() });

    const room = () => state().entities.rooms.find((r) => r.id === state().currentRoomId)!;

    say(
      "=== ROOM ENTRY ===\n" +
        state().log.map((l) => `[${l.kind}] ${l.text}`).join("\n\n") +
        `\n\n--- what was written onto the room ---\ncomposed: ${room().composed}\nstate: ${room().state}`
    );

    expect(state().stage).not.toBe("error");
    // Entry writes prose and nothing else, and hands the turn straight back.
    expect(state().stage).toBe("awaiting_action");
    expect(state().pc.hp.current).toBe(testCharacter().hp.current);
    expect(room().composed, "the room the player is standing in was not described").toBeTruthy();
    // The arrival has to reach the SCREEN, not just the entity. A room entry
    // that writes `composed` and says nothing leaves the player looking at an
    // empty column.
    expect(state().log.length, "the player was told nothing on arrival").toBeGreaterThan(0);

    const before = state().log.length;
    await session.submit("I look carefully around the room, taking my time.");

    say(
      "=== THE TURN ===\n" +
        state().log.slice(before).map((l) => `[${l.kind}] ${l.text}`).join("\n\n")
    );
    expect(state().stage).not.toBe("error");
    expect(state().log.length).toBeGreaterThan(before);

    // --- something with stakes ------------------------------------------
    // The whole roll cycle: the referee puts terms on the table, the interface
    // throws the dice, and the referee resolves what they said. This is the
    // path with the most moving parts and the one worth spending a call on.
    const beforeRoll = state().log.length;
    await session.submit("I climb down into the chasm, as far as I can get.");

    say(
      "=== A RISKY ACTION ===\n" +
        `stage: ${state().stage}\n\n` +
        state().log.slice(beforeRoll).map((l) => `[${l.kind}] ${l.text}`).join("\n\n") +
        (state().pendingRoll ? `\n\n--- on the table ---\n${JSON.stringify(state().pendingRoll, null, 2)}` : "")
    );
    expect(state().stage).not.toBe("error");

    if (state().stage === "roll_offered") {
      const spec = state().pendingRoll!;
      // The terms the player is shown, and the difficulty they are not.
      expect(spec.description).toBeTruthy();
      expect(spec.dc).toBeGreaterThan(0);

      const beforeResolve = state().log.length;
      await session.roll();

      say(
        "=== RESOLVED ===\n" +
          `stage: ${state().stage}\n\n` +
          state().log.slice(beforeResolve).map((l) => `[${l.kind}] ${l.text}`).join("\n\n")
      );
      expect(state().stage).not.toBe("error");
      // A resolution always writes at least the state of what it touched, so
      // the turn should have closed and the clock moved.
      expect(state().rngDraws).toBeGreaterThan(0);
      expect(state().log.some((l) => l.kind === "roll")).toBe(true);
    }

    say(
      "=== CALLS ===\n" +
        state()
          .callLog.map((c) => `${c.step} · ${c.model} · ${c.inputTokens}→${c.outputTokens} · ${c.ms}ms`)
          .join("\n")
    );
    expect(state().callLog.every((c) => c.error === undefined)).toBe(true);

    // The journal is the thing you read afterwards, so it had better exist.
    const journal = readFileSync(join(journalDir, "journal.jsonl"), "utf8").trim().split("\n");
    const kinds = new Set(journal.map((l) => JSON.parse(l).kind));
    say(`=== JOURNAL ===\n${journalDir}\n${journal.length} events: ${[...kinds].join(", ")}`);

    for (const required of ["run", "dungeon", "system", "prompt", "response", "narration", "commit"]) {
      expect(kinds.has(required), `no ${required} event in the journal`).toBe(true);
    }
    expect(readFileSync(join(journalDir, "transcript.md"), "utf8").length).toBeGreaterThan(500);
  });
});
