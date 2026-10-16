import { describe, expect, it } from "vitest";
import { imageCost, textCost } from "./cost.ts";
import { IMAGE_PRICES, MODELS, TEXT_PRICES } from "./models.ts";

describe("textCost", () => {
  it("prices every token kind at its own rate", () => {
    const model = MODELS["turn-loop"];
    const price = TEXT_PRICES[model]!;
    const cost = textCost(model, {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheWriteTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(price.input + price.output + price.cacheWrite + price.cacheRead, 10);
  });

  it("has a price for every model a task can call", () => {
    for (const model of new Set(Object.values(MODELS))) expect(TEXT_PRICES[model], model).toBeDefined();
  });

  it("refuses a model it cannot price", () => {
    expect(() =>
      textCost("no-such-model", { inputTokens: 1, outputTokens: 1, cacheWriteTokens: 0, cacheReadTokens: 0 })
    ).toThrow(/no price/);
  });
});

describe("imageCost", () => {
  it("is the per-image price times the count", () => {
    expect(imageCost("gpt-image-2", 2)).toBeCloseTo(IMAGE_PRICES["gpt-image-2"] * 2, 10);
  });
});
