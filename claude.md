Read docs/BUILD-PLAN.md before starting work.

Nothing outside src/ui/ imports React. Everything outside the shells (ui/, server/, dev/, api-client/) touches no environment global and must stay runnable under vitest.
Entity base is immutable. Never writable at runtime, by any path.
The model never generates a number. All randomness comes from seeded RNG in code.
The Anthropic key lives in the server's environment (.env.local in development). The browser talks only to our API and never holds it.
applyContentPass runs serially in chunk order even when generation is parallel.
Model strings live only in src/llm/models.ts.

Propose a plan before writing code. One build phase per session; don't run ahead.