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
 * See referee.ts, which owns that loop and the stopping rules.
 *
 * No streaming, deliberately: prose is held back until the commit validates,
 * per BUILD-PLAN §6.
 */

import { z } from "zod";
import { MAX_TOKENS, modelFor, type Task } from "./models.ts";
import { ResponseFormatError, validate } from "./json.ts";
import { canBeStrict, toolSchema, type ToolSchema } from "./tool-schema.ts";

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

export interface Usage {
  inputTokens: number;
  outputTokens: number;
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
  usage: { input_tokens: number; output_tokens: number };
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
    usage: { inputTokens: json.usage.input_tokens, outputTokens: json.usage.output_tokens },
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
      tools: opts.tools,
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
    usage: { inputTokens: json.usage.input_tokens, outputTokens: json.usage.output_tokens },
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
  let usage: Usage = { inputTokens: 0, outputTokens: 0 };

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

    usage = {
      inputTokens: usage.inputTokens + json.usage.input_tokens,
      outputTokens: usage.outputTokens + json.usage.output_tokens,
    };

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
      return { value: validate(opts.schema, call.input), usage, attempts: attempt };
    } catch (e) {
      const isFormat = e instanceof ResponseFormatError;
      if (!isFormat || !retry || attempt > 1) throw e;

      // One retry, with the specific failures in front of it.
      messages.push(
        { role: "assistant", content: JSON.stringify(call?.input ?? {}).slice(0, 4000) },
        { role: "user", content: e.feedback }
      );
    }
  }
}
