/**
 * LLM CLIENT
 * ==========
 *
 * Everything goes through the dev proxy at `/api/anthropic`, which attaches the
 * API key server-side (see vite.config.ts). Nothing here knows the key exists,
 * which is the point: swapping the proxy for a real backend later changes
 * nothing on this side.
 *
 * Phase 0 ships the non-streaming path only. Streaming, tool use, and
 * retry-on-invalid arrive with the turn loop in Phase 4.
 */

import { MAX_TOKENS, modelFor, type Task } from "./models.ts";

const ENDPOINT = "/api/anthropic/v1/messages";

export interface Message {
  role: "user" | "assistant";
  content: string;
}

export interface CallOptions {
  task: Task;
  system?: string;
  messages: Message[];
  maxTokens?: number;
}

export interface CallResult {
  text: string;
  stopReason: string | null;
  usage: { inputTokens: number; outputTokens: number };
}

export class LlmError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** 429 and 5xx are worth another go; 4xx generally is not. */
    readonly retryable: boolean
  ) {
    super(message);
    this.name = "LlmError";
  }
}

export async function callModel(opts: CallOptions): Promise<CallResult> {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: modelFor(opts.task),
      max_tokens: opts.maxTokens ?? MAX_TOKENS[opts.task],
      ...(opts.system ? { system: opts.system } : {}),
      messages: opts.messages,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new LlmError(
      `${res.status} ${res.statusText}${body ? ` — ${body.slice(0, 500)}` : ""}`,
      res.status,
      res.status === 429 || res.status >= 500
    );
  }

  const json = (await res.json()) as {
    content: { type: string; text?: string }[];
    stop_reason: string | null;
    usage: { input_tokens: number; output_tokens: number };
  };

  return {
    text: json.content
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join(""),
    stopReason: json.stop_reason,
    usage: {
      inputTokens: json.usage.input_tokens,
      outputTokens: json.usage.output_tokens,
    },
  };
}
