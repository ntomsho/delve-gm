/**
 * LLM CLIENT
 * ==========
 *
 * Everything goes through the dev proxy at `/api/anthropic`, which attaches the
 * API key server-side (see vite.config.ts). Nothing here knows the key exists,
 * which is the point: swapping the proxy for a real backend later changes
 * nothing on this side.
 *
 * Two paths. `callModel` returns text. `callForJson` forces a tool call and
 * returns a validated object — the generation passes use that one, because a
 * forced tool call removes an entire class of "the model said 'Sure!' first"
 * failure. `extractJson` remains as a fallback for anything that has to parse
 * prose.
 *
 * Streaming and the runtime's dice/commit tools arrive with the turn loop.
 */

import { z } from "zod";
import { MAX_TOKENS, modelFor, type Task } from "./models.ts";
import { ResponseFormatError, validate } from "./json.ts";

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
  content: string;
}

export interface CallOptions {
  task: Task;
  system?: string;
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
            // The prompt carries the real shape; a permissive schema here keeps
            // the two from disagreeing, and zod is the thing that actually
            // enforces it on the way back.
            input_schema: { type: "object", additionalProperties: true },
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
