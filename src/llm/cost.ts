/**
 * What a model call cost, in US dollars, worked out from the prices in
 * `models.ts`.
 *
 * The provider's invoice is the real figure. This is the running estimate
 * that `src/server/spend.ts` checks against the daily budget and limit, so it
 * needs to be close, and if it is wrong it should be too high rather than too
 * low.
 */

import { IMAGE_PRICES, TEXT_PRICES, type ImageModel } from "./models.ts";
import type { Usage } from "./client.ts";

const PER_MILLION = 1_000_000;

/**
 * The cost of a text call. Throws if the model has no price, because a call
 * that can't be priced can't be counted against the daily limit.
 * `cost.test.ts` checks that every model in `MODELS` has a price, so this
 * should never throw in the game.
 */
export function textCost(model: string, usage: Usage): number {
  const price = TEXT_PRICES[model];
  if (!price) throw new Error(`no price for ${model}; add it to TEXT_PRICES in src/llm/models.ts`);
  return (
    (usage.inputTokens * price.input +
      usage.outputTokens * price.output +
      usage.cacheWriteTokens * price.cacheWrite +
      usage.cacheReadTokens * price.cacheRead) /
    PER_MILLION
  );
}

/** The cost of an image call: `images` pictures at the size and quality the game uses. */
export function imageCost(model: ImageModel, images = 1): number {
  return IMAGE_PRICES[model] * images;
}
