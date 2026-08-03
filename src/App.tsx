import { useState } from "react";
import { callModel, LlmError } from "./runtime/llm/client.ts";
import { generateBlueprintSeed, rollSheet } from "./engine/index.ts";

/**
 * Phase 0 scaffold. Two buttons: one proves the seeded engine runs in the
 * browser, one proves a request reaches the API through the dev proxy with a
 * key this bundle has never seen. Both get replaced in Phase 1.
 */
type Status = { kind: "idle" } | { kind: "busy" } | { kind: "ok"; text: string } | { kind: "err"; text: string };

export default function App() {
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  async function ping() {
    setStatus({ kind: "busy" });
    try {
      const res = await callModel({
        task: "turn-loop",
        maxTokens: 32,
        messages: [{ role: "user", content: "Reply with exactly: the proxy works" }],
      });
      setStatus({ kind: "ok", text: `${res.text}\n\n(${res.usage.inputTokens} in / ${res.usage.outputTokens} out)` });
    } catch (e) {
      const msg =
        e instanceof LlmError
          ? `${e.message}${e.status === 401 ? "\n\nIs ANTHROPIC_API_KEY set in .env.local?" : ""}`
          : e instanceof Error
            ? e.message
            : String(e);
      setStatus({ kind: "err", text: msg });
    }
  }

  function roll() {
    const seed = Math.floor(Math.random() * 100000);
    setStatus({ kind: "ok", text: rollSheet(generateBlueprintSeed(2, seed)) });
  }

  return (
    <main className="mx-auto max-w-3xl p-8 font-mono text-sm">
      <h1 className="mb-1 text-lg font-bold">Dungeon Crawler</h1>
      <p className="mb-6 text-neutral-500">Phase 0 — scaffold</p>

      <div className="mb-6 flex gap-3">
        <button
          onClick={roll}
          className="border border-neutral-400 px-3 py-1.5 hover:bg-neutral-100"
        >
          Roll a blueprint
        </button>
        <button
          onClick={ping}
          disabled={status.kind === "busy"}
          className="border border-neutral-400 px-3 py-1.5 hover:bg-neutral-100 disabled:opacity-40"
        >
          {status.kind === "busy" ? "Calling…" : "Ping the model"}
        </button>
      </div>

      {status.kind === "err" && (
        <pre className="whitespace-pre-wrap border-l-2 border-red-500 pl-3 text-red-700">{status.text}</pre>
      )}
      {status.kind === "ok" && (
        <pre className="whitespace-pre-wrap border-l-2 border-neutral-300 pl-3">{status.text}</pre>
      )}
    </main>
  );
}
