/**
 * THE PORTRAIT THUMBNAIL: on the sheet it opens the whole figure, and closes
 * on a press or Escape; inside a pressable row it is only a picture.
 */

import { act, createElement as h } from "react";
import { describe, expect, it } from "vitest";
import type { Portrait } from "../../rules/knave/character.ts";
import { renderDom } from "../test-utils/dom.ts";
import { PortraitThumb } from "./portrait.tsx";

const drawn: Portrait = { id: "p1", url: "https://cdn.test/p1.png", thumbUrl: "https://cdn.test/p1-thumb.png", source: "drawn" };
const uploaded: Portrait = { ...drawn, source: "uploaded", url: "https://cdn.test/u.webp", thumbUrl: "https://cdn.test/u-thumb.webp" };

describe("PortraitThumb", () => {
  it("opens the whole figure and closes it again", () => {
    const r = renderDom(h(PortraitThumb, { portrait: drawn, name: "Odo", size: 52, expandable: true }));
    expect(r.all("[role='dialog']")).toHaveLength(0);
    act(() => (r.one("button[aria-label=\"See Odo's portrait\"]") as HTMLElement).click());
    const dialog = r.one("[role='dialog']");
    expect(dialog.querySelector("[aria-label=\"Odo's portrait\"]")?.getAttribute("style")).toContain("p1.png");

    act(() => void window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(r.all("[role='dialog']")).toHaveLength(0);

    act(() => (r.one("button") as HTMLElement).click());
    act(() => (r.one("[role='dialog']") as HTMLElement).click());
    expect(r.all("[role='dialog']")).toHaveLength(0);
  });

  it("is only a picture when not expandable, and shows an upload as it is", () => {
    const r = renderDom(h(PortraitThumb, { portrait: uploaded, name: "Odo", size: 40 }));
    expect(r.all("button")).toHaveLength(0);
    expect(r.one("img").getAttribute("src")).toBe("https://cdn.test/u-thumb.webp");
  });
});
