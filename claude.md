Read docs/BUILD-PLAN.md before starting work.

src/engine/ never imports React. It must stay runnable under vitest.
Entity base is immutable. Never writable at runtime, by any path.
The model never generates a number. All randomness comes from seeded RNG in code.
The API key lives in .env.local and is injected by the Vite dev proxy. It never reaches the browser.
applyContentPass runs serially in chunk order even when generation is parallel.
Model strings live only in src/runtime/llm/models.ts.

Propose a plan before writing code. One build phase per session; don't run ahead.