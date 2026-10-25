/**
 * The LLM client: the only file that calls the Anthropic API.
 *
 * It has no URL or key of its own. Each process sets them once at startup
 * with `configureTransport`: the server (`configureAnthropic` in
 * `src/server/app.ts`) and the dev CLIs do. The browser never does, because
 * it only talks to our API and never holds the key.
 *
 * There are two ways to call the model:
 *
 * - `callForJson` forces the model to call one tool and returns the tool's
 *   input, validated. The generation passes use it. Forcing a tool call means
 *   the answer is always structured data, never prose like "Sure! Here's...".
 *
 * - `callWithTools` is for gameplay. A generation pass is one question and one
 *   answer, but a game master turn is a conversation: it narrates, asks for a
 *   batch of dice, reads the results, and only then commits. So this makes one
 *   exchange and returns it raw (the text, the tool calls, and the assistant
 *   content to send back), and the caller runs the loop.
 *   `src/gameplay/game-master/game-master.ts` owns that loop and decides when
 *   it stops.
 *
 * Responses are not streamed. Narration isn't shown until the commit has been
 * validated and applied (docs/ARCHITECTURE.md section 5.3), so streaming would
 * gain nothing.
 */

import { z } from "zod";
import { MAX_TOKENS, modelFor, type Task } from "./models.ts";
import { ResponseFormatError, validate } from "./json.ts";
import type { ValidationIssue } from "./validation.ts";
import { canBeStrict, fitStrict, toolSchema, type ToolSchema } from "./tool-schema.ts";

const PATH = "/v1/messages";

/**
 * Where requests go and which headers they carry, set by `configureTransport`.
 *
 * There is no default URL. A call made before `configureTransport` throws
 * instead of guessing one, because a wrong guess fails as a 404 partway
 * through a generation and looks like a network problem, not a missing
 * setting. `configureAnthropic` in `src/server/app.ts`, the dev CLIs and the
 * live tests each set it with the key from their own environment.
 */
let baseUrl: string | undefined;
let extraHeaders: Record<string, string> = {};
let meter: Meter | undefined;

/**
 * Optional hooks called around every paid model call, which can also refuse
 * a call.
 *
 * The server's meter (`src/server/spend.ts`) records each call in the spend
 * ledger and refuses calls once the day's spending reaches the limit. The dev
 * CLIs don't set a meter, so their calls aren't counted. It is a hook rather
 * than a database call because this module must run under vitest with no
 * environment, and doesn't know which player a call is for.
 */
export interface Meter {
  /** Called before each request is sent, including retries. Throwing refuses the call. */
  before(call: { task: Task; model: string }): Promise<void>;
  /**
   * Called after each successful (and so paid-for) response. It is awaited,
   * but if it fails the error is only logged: failing to record a call is no
   * reason to throw away an answer that has already been paid for.
   */
  after(call: { task: Task; model: string; usage: Usage }): Promise<void>;
}

export function configureTransport(opts: { baseUrl?: string; headers?: Record<string, string>; meter?: Meter }): void {
  if (opts.baseUrl !== undefined) baseUrl = opts.baseUrl.replace(/\/$/, "");
  if (opts.headers) extraHeaders = { ...extraHeaders, ...opts.headers };
  if (opts.meter) meter = opts.meter;
}

export interface Message {
  role: "user" | "assistant";
  /**
   * Plain text, or a list of content blocks. Blocks are used for tool
   * exchanges: the assistant message holds a `tool_use` block and the next
   * user message holds the matching `tool_result`. They are passed to the API
   * as they are, so this file doesn't need types for every block shape.
   */
  content: string | unknown[];
}

/**
 * One piece of a system prompt. Splitting the prompt into pieces lets a cache
 * breakpoint (`cache_control`) go between them.
 *
 * Order matters for caching: the API reuses a cached prefix only if it matches
 * byte for byte, so the parts that stay the same must come before the parts
 * that change. `src/gameplay/game-master/assemble.ts` puts the main prompt and
 * the dungeon's background before the breakpoint, and the step file for this
 * call after it.
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
  /** cancels the request; the CLI uses it for a per-call timeout */
  signal?: AbortSignal;
}

/**
 * The tokens a call was billed for, in the four categories the API reports.
 *
 * `inputTokens` counts only input that was neither written to nor read from
 * the prompt cache; the API reports cache writes and cache reads separately.
 * Cache writes cost 1.25× the normal input price and cache reads 0.1×
 * (`src/llm/cost.ts` does the arithmetic). Recording all four is what makes
 * cached calls cost the right amount and shows how much the cache saves.
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

/** Converts the API's usage fields to `Usage`. The API leaves out the cache fields when nothing was cached. */
function usageOf(u: ApiResponse["usage"]): Usage {
  return {
    inputTokens: u.input_tokens,
    outputTokens: u.output_tokens,
    cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
  };
}

// The fields are declared explicitly rather than as constructor parameter
// properties, because Node's built-in TypeScript type stripping can't handle
// those, and `npm run generate` runs `src/dev/cli-generate.ts` with plain
// `node`.
export class LlmError extends Error {
  readonly status: number;
  /** true for 429 and 5xx responses, which are worth retrying; other 4xx errors are not */
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

async function post(task: Task, body: { model: string; [field: string]: unknown }, signal?: AbortSignal): Promise<ApiResponse> {
  if (baseUrl === undefined) {
    throw new Error("LLM transport not configured: call configureTransport before calling the model.");
  }
  const call = { task, model: body.model };
  let lastError: unknown;

  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    if (attempt > 0) await sleep(BASE_DELAY_MS * 2 ** (attempt - 1));
    await meter?.before(call);

    let res: Response;
    try {
      res = await fetch(`${baseUrl}${PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...extraHeaders },
        body: JSON.stringify(body),
        signal,
      });
    } catch (e) {
      // The request didn't reach the server. Retry, unless the caller cancelled it.
      if (signal?.aborted) throw e;
      lastError = e;
      continue;
    }

    if (res.ok) {
      const json = (await res.json()) as ApiResponse;
      try {
        await meter?.after({ ...call, usage: usageOf(json.usage) });
      } catch (e) {
        console.warn("[llm] the meter could not record a call; keeping the answer:", e);
      }
      return json;
    }

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
// STRUCTURED
// ---------------------------------------------------------------------------

/**
 * A tool definition as the API expects it. Build one with `toolFor`, which
 * generates the JSON schema from the zod schema that will validate the
 * model's call.
 */
export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: ToolSchema;
  strict?: boolean;
}

/**
 * Builds a tool definition. `strict: true` here only means the tool's schema
 * is simple enough for strict mode on its own. Strict mode has a limit per
 * request, not per tool, so whether it stays strict depends on the other
 * tools sent with it. `callWithTools` decides that with `fitStrict` in
 * `tool-schema.ts`.
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
 * How the model may use tools: `auto` (if it wants), `any` (it must call some
 * tool) or `tool` (it must call the named one).
 *
 * Gameplay normally uses `any`, and that matters. If the game master ended a
 * turn without calling `commit_state`, the game would be stuck in its current
 * stage with nothing running. With `any`, the model can still write text, but
 * it can't end its response on text alone.
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
  /** all the text blocks in the response, joined together */
  text: string;
  toolUses: ToolUse[];
  /** the assistant message exactly as received, to send back along with the tool results */
  content: unknown[];
  stopReason: string | null;
  usage: Usage;
}

/**
 * One request to the model with tools available. It doesn't loop: only the
 * caller knows whether the response finishes the turn.
 */
export async function callWithTools(opts: ToolCallOptions): Promise<ToolTurn> {
  const json = await post(
    opts.task,
    {
      model: modelFor(opts.task),
      max_tokens: opts.maxTokens ?? MAX_TOKENS[opts.task],
      ...(opts.system ? { system: opts.system } : {}),
      messages: opts.messages,
      // Strict mode's limit applies to the whole request, so it is decided
      // here, where all the tools are known. See `fitStrict`.
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
 * Builds one user message holding the results of several tool calls.
 *
 * All the results go in one message, however many calls there were. Spreading
 * them across messages teaches the model to stop making calls together, and
 * making them together is why the `roll` tool takes a list.
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
   * Whether to retry once, telling the model what was wrong (docs/ARCHITECTURE.md
   * section 3.2). Defaults to true. If the retry fails too, the error is thrown;
   * a partial answer is never used.
   */
  retryOnInvalid?: boolean;
  /**
   * An extra check that the response answers everything that was asked, which
   * the schema can't check.
   *
   * Zod only checks the response's shape. If the request asked about six
   * connectors and the response describes five, it is still a valid object.
   * Only the caller knows what was asked, so the caller supplies this check.
   * It runs inside the call, not afterwards, so a failure can still use the
   * one retry.
   *
   * Any issues it returns are treated exactly like a schema failure: the same
   * retry, the same feedback to the model, and an error if the retry fails
   * too.
   */
  check?: (value: T) => ValidationIssue[];
  /**
   * Called for each failed attempt: before the retry, and again before the
   * final error is thrown.
   *
   * This keeps a record of a pass that never succeeds. Generation events are
   * only written when a pass succeeds, so without this hook the only trace of
   * a failed pass would be the exception's message. (Before this existed, a
   * content-pass chunk that failed validation twice ended a generation, and
   * the journal's last entry was just the word "shape".)
   *
   * It is a hook rather than a journal parameter because this module shouldn't
   * know about the journal, and only the caller knows which pass and chunk
   * failed.
   *
   * It must not throw. If it does, the error is logged and ignored, so that
   * the original error isn't lost.
   */
  onAttemptFailed?: (report: FailedAttempt) => void;
}

export interface FailedAttempt {
  /** 1 for the first call, 2 for the retry */
  attempt: number;
  /** whether another call is about to be made */
  willRetry: boolean;
  message: string;
  /** the problems zod or `check` found */
  issues: ValidationIssue[];
  /** the tool input as received, cut to 2,000 characters; undefined if the model made no tool call */
  raw: string | undefined;
}

export interface JsonResult<T> {
  value: T;
  usage: Usage;
  /** how many calls it took: 1, or 2 if it needed the retry */
  attempts: number;
}

/**
 * Forces the model to call one tool and returns its input, validated against
 * `schema` and `check`, with one retry on failure. See the file header.
 */
export async function callForJson<T>(opts: JsonCallOptions<T>): Promise<JsonResult<T>> {
  const retry = opts.retryOnInvalid ?? true;
  const messages = [...opts.messages];
  const schema = toolSchema(opts.schema);
  const strict = canBeStrict(schema);
  let usage: Usage = NO_USAGE;

  for (let attempt = 1; ; attempt++) {
    const json = await post(
      opts.task,
      {
        model: modelFor(opts.task),
        max_tokens: opts.maxTokens ?? MAX_TOKENS[opts.task],
        ...(opts.system ? { system: opts.system } : {}),
        messages,
        tools: [
          {
            name: opts.toolName,
            description: opts.toolDescription,
            // The full schema, generated from the same zod schema that
            // validates the reply. A loose schema would leave the model
            // guessing the field names. See tool-schema.ts.
            input_schema: schema,
            // If the schema is simple enough for strict mode, the API
            // guarantees the input matches it. If not, the schema still
            // guides the model and zod still checks the result. See
            // `canBeStrict`.
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
        // If the report itself fails, log that and keep the original error.
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

      // The one retry continues the failed tool exchange. The assistant
      // message goes back exactly as received, with its `tool_use` block, and
      // the problem is sent as that call's `tool_result`. `game-master.ts`
      // handles a refused commit the same way. The model then sees its own
      // call and a reply to it, which is a conversation shape it handles well.
      //
      // The retry must not repeat the call as text. An earlier version sent
      // `JSON.stringify(call.input)`, cut to 4,000 characters, as an assistant
      // text message, and that went wrong in two ways:
      //
      //   - A content-pass response is about 14 kB, so the cut came mid-string
      //     and the model was shown invalid JSON as its previous answer.
      //   - Shown JSON as text and asked for "the corrected JSON", the model
      //     called the tool with `rooms` set to a string containing the array.
      //     Seen on 2026-08-20 with seed 454434, size 2: attempt 1 left out one
      //     `ref`, attempt 2 came back `{"rooms":"[{\"ref\":\"room_0\"…"}`,
      //     and the generation failed. The API couldn't catch it: the content
      //     pass has about 35 optional fields, more than strict mode's limit
      //     of 24, so it is sent without strict mode and the API doesn't check
      //     that `rooms` is an array.
      //
      // So repeating the call as text turned one missing field, which the
      // retry should have fixed, into a failure it couldn't recover from.
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
        // There is no tool call to reply to. The API rejects an empty
        // assistant message, so the assistant message is sent back only if it
        // had content (text, or a refusal), and the problem goes as an
        // ordinary user message.
        if (json.content.length > 0) messages.push({ role: "assistant", content: json.content });
        messages.push({ role: "user", content: objection });
      }
    }
  }
}
