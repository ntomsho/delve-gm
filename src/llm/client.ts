/**
 * LLM CLIENT
 * ==========
 *
 * Everything goes through the dev proxy at `/api/anthropic`, which attaches the
 * API key server-side (see vite.config.ts). Nothing here knows the key exists,
 * which is the point: swapping the proxy for a real backend later changes
 * nothing on this side.
 *
 * Three paths. `callModel` returns text. `callForJson` forces a tool call and
 * returns a validated object — the generation passes use that one, because a
 * forced tool call removes an entire class of "the model said 'Sure!' first"
 * failure. `extractJson` remains as a fallback for anything that has to parse
 * prose.
 *
 * `callWithTools` is the third, and it is the runtime's. The generation passes
 * ask one question and get one answer; a turn is a conversation — the referee
 * narrates, asks the dice for a batch, reads what came back, and only then
 * commits. So this one hands back the raw turn (text, tool calls, and the
 * assistant content verbatim for echoing) and lets the caller drive the loop.
 * See game-master.ts, which owns that loop and the stopping rules.
 *
 * No streaming, deliberately: prose is held back until the commit validates,
 * per BUILD-PLAN §6.
 */

import { z } from "zod";
import { MAX_TOKENS, modelFor, type Task } from "./models.ts";
import { ResponseFormatError, validate } from "./json.ts";
import type { ValidationIssue } from "./schemas.ts";
import { canBeStrict, fitStrict, toolSchema, type ToolSchema } from "./tool-schema.ts";

const PATH = "/v1/messages";

/**
 * Where requests go, and what rides along.
 *
 * In the browser this stays empty, so the URL is relative — `/api/anthropic/...`
 * — and the Vite dev proxy attaches the key. The bundle never holds it.
 *
 * `dev/cli-generate.ts` is the one caller that overrides this. It runs in Node,
 * outside the browser and outside the dev server, so there is no proxy to go
 * through and it reads the key from .env.local itself. That is not a loophole in
 * the rule: the rule is that the key never reaches the *browser*, and a Node
 * script is exactly where a key is supposed to live.
 */
let baseUrl = "/api/anthropic";
let extraHeaders: Record<string, string> = {};

export function configureTransport(opts: { baseUrl?: string; headers?: Record<string, string> }): void {
  if (opts.baseUrl !== undefined) baseUrl = opts.baseUrl.replace(/\/$/, "");
  if (opts.headers) extraHeaders = { ...extraHeaders, ...opts.headers };
}

export interface Message {
  role: "user" | "assistant";
  /**
   * Prose, or content blocks. Blocks are what a tool exchange is made of — the
   * assistant turn holding a `tool_use` and the user turn holding the matching
   * `tool_result` — and they are passed through unread, so nothing here needs
   * to model the block shapes the API accepts.
   */
  content: string | unknown[];
}

/**
 * A system prompt in pieces, so a cache breakpoint can go between them.
 *
 * Order is what makes caching work: the prefix is matched byte for byte, so
 * everything stable has to come before anything that moves. See assemble.ts,
 * which puts the playbook and the dungeon's fiction ahead of the breakpoint and
 * the per-call step file behind it.
 */
export interface SystemBlock {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral" };
}

export interface CallOptions {
  task: Task;
  system?: string | SystemBlock[];
  messages: Message[];
  maxTokens?: number;
  /** aborts the request; the CLI wires this to a per-call timeout */
  signal?: AbortSignal;
}

/**
 * WHAT A CALL WAS BILLED FOR, all four ways.
 *
 * `inputTokens` is only the input that was neither written to nor read from the
 * prompt cache — the API reports those two apart, and before they were copied
 * here every cached call looked cheaper than it was and the cache's own effect
 * was invisible. Priced at 1×, 1.25× (write) and 0.1× (read) input.
 */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
}

export const NO_USAGE: Usage = { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 };

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
  };
}

/** The wire's usage, read into ours. The cache fields are absent when nothing was cached. */
function usageOf(u: ApiResponse["usage"]): Usage {
  return {
    inputTokens: u.input_tokens,
    outputTokens: u.output_tokens,
    cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
  };
}

export interface CallResult {
  text: string;
  stopReason: string | null;
  usage: Usage;
}

// NOTE: written as explicit fields rather than constructor parameter
// properties. Node's strip-only type stripping cannot compile those, and
// `dev/cli-generate.ts` runs under plain `node` with no transpiler.
export class LlmError extends Error {
  readonly status: number;
  /** 429 and 5xx are worth another go; 4xx generally is not. */
  readonly retryable: boolean;

  constructor(message: string, status: number, retryable: boolean) {
    super(message);
    this.name = "LlmError";
    this.status = status;
    this.retryable = retryable;
  }
}

// ---------------------------------------------------------------------------
// TRANSPORT
// ---------------------------------------------------------------------------

interface ContentBlock {
  type: string;
  text?: string;
  /** tool_use only */
  id?: string;
  name?: string;
  input?: unknown;
}

interface ApiResponse {
  content: ContentBlock[];
  stop_reason: string | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number | null;
    cache_read_input_tokens?: number | null;
  };
}

const RETRIES = 3;
const BASE_DELAY_MS = 1000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function post(body: unknown, signal?: AbortSignal): Promise<ApiResponse> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    if (attempt > 0) await sleep(BASE_DELAY_MS * 2 ** (attempt - 1));

    let res: Response;
    try {
      res = await fetch(`${baseUrl}${PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...extraHeaders },
        body: JSON.stringify(body),
        signal,
      });
    } catch (e) {
      // Network-level failure. Worth retrying unless the caller gave up.
      if (signal?.aborted) throw e;
      lastError = e;
      continue;
    }

    if (res.ok) return (await res.json()) as ApiResponse;

    const detail = await res.text().catch(() => "");
    const err = new LlmError(
      `${res.status} ${res.statusText}${detail ? ` — ${detail.slice(0, 500)}` : ""}`,
      res.status,
      res.status === 429 || res.status >= 500
    );
    if (!err.retryable) throw err;
    lastError = err;
  }

  throw lastError instanceof Error
    ? lastError
    : new LlmError(String(lastError), 0, false);
}

// ---------------------------------------------------------------------------
// TEXT
// ---------------------------------------------------------------------------

export async function callModel(opts: CallOptions): Promise<CallResult> {
  const json = await post(
    {
      model: modelFor(opts.task),
      max_tokens: opts.maxTokens ?? MAX_TOKENS[opts.task],
      ...(opts.system ? { system: opts.system } : {}),
      messages: opts.messages,
    },
    opts.signal
  );

  return {
    text: json.content.filter((b) => b.type === "text").map((b) => b.text ?? "").join(""),
    stopReason: json.stop_reason,
    usage: usageOf(json.usage),
  };
}

// ---------------------------------------------------------------------------
// STRUCTURED
// ---------------------------------------------------------------------------

/**
 * A tool as it goes on the wire. Build one with `toolFor`, which derives the
 * schema from the zod that will validate the call coming back.
 */
export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: ToolSchema;
  strict?: boolean;
}

/**
 * `strict` here is provisional: it says this tool could be guaranteed on its
 * own. Whether it actually is depends on what else is on the table, and only
 * the request knows that — `callWithTools` settles it with `fitStrict`.
 */
export function toolFor(name: string, description: string, schema: z.ZodType): ToolDefinition {
  const input_schema = toolSchema(schema);
  return {
    name,
    description,
    input_schema,
    ...(canBeStrict(input_schema) ? { strict: true } : {}),
  };
}

/**
 * `any` is the runtime's normal setting, and it is load-bearing. A turn that
 * ends without `commit_state` leaves the game in whatever stage it was in with
 * nothing running — so the model is not permitted to simply stop talking. It
 * may still write prose; it may not end the turn on it.
 */
export type ToolChoice = { type: "auto" } | { type: "any" } | { type: "tool"; name: string };

export interface ToolUse {
  id: string;
  name: string;
  input: unknown;
}

export interface ToolCallOptions extends CallOptions {
  tools: ToolDefinition[];
  toolChoice?: ToolChoice;
}

export interface ToolTurn {
  /** everything the model said in the open, concatenated */
  text: string;
  toolUses: ToolUse[];
  /** the assistant turn verbatim, to append when answering its tool calls */
  content: unknown[];
  stopReason: string | null;
  usage: Usage;
}

/**
 * One exchange with tools on the table. Does NOT loop — the caller decides
 * whether what came back finishes the turn, and only the caller knows that.
 */
export async function callWithTools(opts: ToolCallOptions): Promise<ToolTurn> {
  const json = await post(
    {
      model: modelFor(opts.task),
      max_tokens: opts.maxTokens ?? MAX_TOKENS[opts.task],
      ...(opts.system ? { system: opts.system } : {}),
      messages: opts.messages,
      // The strict budget is spent per request, so it is settled here rather
      // than by whoever built the tools — see fitStrict.
      tools: fitStrict(opts.tools),
      tool_choice: opts.toolChoice ?? { type: "auto" },
    },
    opts.signal
  );

  return {
    text: json.content.filter((b) => b.type === "text").map((b) => b.text ?? "").join(""),
    toolUses: json.content
      .filter((b) => b.type === "tool_use")
      .map((b) => ({ id: b.id ?? "", name: b.name ?? "", input: b.input })),
    content: json.content,
    stopReason: json.stop_reason,
    usage: usageOf(json.usage),
  };
}

/**
 * The answers to a batch of tool calls, as one user turn.
 *
 * One turn, however many calls: splitting results across messages teaches the
 * model to stop asking for them together, and asking for them together is the
 * whole point of the dice tool taking a list.
 */
export function toolResults(results: { id: string; content: string; isError?: boolean }[]): Message {
  return {
    role: "user",
    content: results.map((r) => ({
      type: "tool_result",
      tool_use_id: r.id,
      content: r.content,
      ...(r.isError ? { is_error: true } : {}),
    })),
  };
}

export interface JsonCallOptions<T> extends CallOptions {
  schema: z.ZodType<T>;
  /** the tool the model is forced to call */
  toolName: string;
  toolDescription: string;
  /**
   * Retry once with the validation errors appended, per BUILD-PLAN §5. A second
   * failure surfaces; there is no partial-content fallback.
   */
  retryOnInvalid?: boolean;
  /**
   * THE CHECK THE SCHEMA CANNOT MAKE: did the response answer what was asked?
   *
   * Zod validates shape, and it is handed the response alone — so a payload
   * asking about six connectors and a response carrying five is a valid object
   * and passes. Only the caller holds the payload, so only the caller can ask
   * the completeness question, and it asks it here rather than after the call so
   * the answer arrives while the one retry is still unspent.
   *
   * Anything returned is raised as a `ResponseFormatError`, which is to say it
   * is treated exactly as a schema failure: the same retry, the same feedback
   * channel, and the same "no partial content" ending if it fails twice.
   */
  check?: (value: T) => ValidationIssue[];
  /**
   * EVERY ATTEMPT THAT FAILED, AS IT FAILS.
   *
   * Called before the retry and again before the final throw, so a pass that
   * never succeeds still leaves a record of what it was told and what came
   * back. Without it the only survivor is the message on the exception, and a
   * dungeon that failed to generate is a dungeon nobody can look at: the
   * generation events are written on success, so a pass that never succeeded
   * writes nothing at all.
   *
   * Observed 2026-08-14 on `?stub=1`: one content-pass chunk failed zod twice
   * and took the whole generation with it, and the journal held four events, of
   * which the last was the word "shape". See CODING-PLAN §6.7.
   *
   * A reporting hook rather than a journal parameter on purpose — this module
   * has no business knowing what a journal is, and the caller is the one that
   * knows which pass and which chunk is in flight.
   *
   * It must not throw. Whatever is wrong, it is less wrong than losing the
   * error underneath it.
   */
  onAttemptFailed?: (report: FailedAttempt) => void;
}

export interface FailedAttempt {
  /** 1 for the first call, 2 for the retry */
  attempt: number;
  /** whether another call is about to be made */
  willRetry: boolean;
  message: string;
  /** what zod, or the completeness check, objected to */
  issues: ValidationIssue[];
  /** the tool input as it arrived, truncated — undefined if there was no call */
  raw: string | undefined;
}

export interface JsonResult<T> {
  value: T;
  usage: Usage;
  /** how many calls it took — 1 unless a retry was needed */
  attempts: number;
}

export async function callForJson<T>(opts: JsonCallOptions<T>): Promise<JsonResult<T>> {
  const retry = opts.retryOnInvalid ?? true;
  const messages = [...opts.messages];
  const schema = toolSchema(opts.schema);
  const strict = canBeStrict(schema);
  let usage: Usage = NO_USAGE;

  for (let attempt = 1; ; attempt++) {
    const json = await post(
      {
        model: modelFor(opts.task),
        max_tokens: opts.maxTokens ?? MAX_TOKENS[opts.task],
        ...(opts.system ? { system: opts.system } : {}),
        messages,
        tools: [
          {
            name: opts.toolName,
            description: opts.toolDescription,
            // The real schema, derived from the same zod that validates the
            // reply. A permissive schema here leaves the model guessing at the
            // parameter names — see tool-schema.ts.
            input_schema: schema,
            // Where the schema is simple enough to compile, the API guarantees
            // the input matches it. Where it is not, the schema still shapes
            // the call and zod still checks the result. See canBeStrict.
            ...(strict ? { strict: true } : {}),
          },
        ],
        tool_choice: { type: "tool", name: opts.toolName },
      },
      opts.signal
    );

    usage = addUsage(usage, usageOf(json.usage));

    const call = json.content.find((b) => b.type === "tool_use" && b.name === opts.toolName);

    try {
      if (!call) {
        throw new ResponseFormatError(
          `the model did not call ${opts.toolName} (stop_reason: ${json.stop_reason})`
        );
      }
      if (json.stop_reason === "max_tokens") {
        throw new ResponseFormatError(
          "the response was cut off at max_tokens; the object is incomplete"
        );
      }
      const value = validate(opts.schema, call.input);
      const missing = opts.check?.(value) ?? [];
      if (missing.length > 0) {
        throw new ResponseFormatError(
          "the response is well-formed but does not answer everything it was asked",
          missing,
          JSON.stringify(call.input).slice(0, 2000)
        );
      }
      return { value, usage, attempts: attempt };
    } catch (e) {
      const isFormat = e instanceof ResponseFormatError;
      const willRetry = isFormat && retry && attempt <= 1;

      if (isFormat && opts.onAttemptFailed) {
        // Reporting must not be able to lose the error it is reporting.
        try {
          opts.onAttemptFailed({
            attempt,
            willRetry,
            message: e.message,
            issues: e.issues,
            raw: e.raw ?? (call ? JSON.stringify(call.input).slice(0, 2000) : undefined),
          });
        } catch (reporting) {
          console.warn("[llm] onAttemptFailed threw; ignoring it:", reporting);
        }
      }

      if (!willRetry) throw e;

      // ONE RETRY, INSIDE THE TOOL EXCHANGE THAT FAILED.
      //
      // The assistant turn goes back VERBATIM — the `tool_use` block as it
      // arrived — and the objection comes back as its `tool_result`. That is
      // the same repair `game-master.ts` has always made (see the refused-commit
      // branch), and it is the only one that leaves the conversation in a
      // shape the model recognises as its own.
      //
      // It used to re-type the call as prose: `JSON.stringify(call.input)`,
      // truncated to 4000 characters, pushed as an assistant TEXT turn. Both
      // halves of that were wrong and the pair was worse than either.
      //
      //   - A content-pass response is ~14 kB, so the cut landed mid-string and
      //     what the model was shown as its previous answer was invalid JSON.
      //   - Shown JSON as text and asked for "the corrected JSON", the model
      //     answered in the register it was addressed in: it called the tool
      //     with `rooms` set to a STRING containing the array. Observed
      //     2026-08-20, seed 454434 size 2 — attempt 1 missed one `ref` on one
      //     encounter, attempt 2 came back `{"rooms":"[{\"ref\":\"room_0\"…"}`,
      //     and a one-field slip took the whole generation with it. Nothing on
      //     the wire could have caught it: the content pass carries ~35
      //     optionals against a strict budget of 24, so it goes out
      //     unguaranteed and the API is not checking that `rooms` is an array.
      //
      // So the retry that exists to recover from a single missing field was
      // reliably converting it into an unrecoverable failure.
      const objection =
        `${e.feedback}\n\nCall \`${opts.toolName}\` again with the whole input, ` +
        `corrected. Every field must be a real JSON value — an array field is an ` +
        `array, not a string containing one.`;

      if (call?.id) {
        messages.push(
          { role: "assistant", content: json.content },
          toolResults([{ id: call.id, content: objection, isError: true }])
        );
      } else {
        // No tool call to answer. An assistant turn with no content is not a
        // turn the API will accept, so it is echoed only if there was something
        // in it (prose, a refusal) and the objection goes as an ordinary reply.
        if (json.content.length > 0) messages.push({ role: "assistant", content: json.content });
        messages.push({ role: "user", content: objection });
      }
    }
  }
}
