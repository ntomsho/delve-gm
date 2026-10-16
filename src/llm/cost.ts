/**
 * WHAT A CALL COST
 * ================
 *
 * Dollars, worked out in code from the prices in `models.ts`. The provider's
 * invoice is the truth; this is the running estimate the daily budget and
 * ceiling are checked against (`src/server/spend.ts`), so it has to be close
 * and it has to err high rather than low.
 */

import { IMAGE_PRICES, TEXT_PRICES, type ImageModel } from "./models.ts";
import type { Usage } from "./client.ts";

const PER_MILLION = 1_000_000;

/**
 * A text call's cost. Throws on a model with no price: a call that cannot be
 * priced is a call the ceiling cannot see, and `cost.test.ts` keeps every model
 * in `MODELS` priced so this never fires in the game.
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

/** An image call's cost: one picture, at the size and quality the game draws. */
export function imageCost(model: ImageModel, images = 1): number {
  return IMAGE_PRICES[model] * images;
}
