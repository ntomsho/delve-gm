/**
 * THE DOOR, with two ways through it. What is worth pinning is that the guest
 * button really is one click — no Turnstile key configured means no token and
 * no wait — that a refusal lands beside the button that was pressed, that
 * "Log in" is Google, and that the pictures from recent runs reach the page
 * with their creatures stood in them.
 */

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement as h } from "react";
import { renderDom, press } from "../test-utils/dom.ts";
import { Landing } from "./Landing.tsx";
import type { ShowcaseIllustration } from "../../api-client/showcase.ts";

const buttons = (page: ReturnType<typeof renderDom>, text: string) =>
  page.all("button").filter((b) => b.textContent?.toLowerCase().includes(text.toLowerCase()));

const ROOM: ShowcaseIllustration = {
  kind: "room",
  url: "https://cdn/room.png",
  roomTitle: "Flooded nave",
  dungeonTitle: "The Drowned Reliquary",
  figures: [{ sprite: "acolyte", x: 0.5, y: 0.8, perFoot: 0.05, flop: false, url: "https://cdn/acolyte.png", size: "medium" }],
};

function answering(pictures: ShowcaseIllustration[] | "down") {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      pictures === "down" ? new Response("no", { status: 500 }) : new Response(JSON.stringify(pictures), { status: 200 })
    )
  );
}

/** Let the pictures' fetch land. */
const landed = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));

describe("Landing", () => {
  // Whatever `.env.local` says, these tests are about a page with no captcha.
  beforeEach(() => vi.stubEnv("VITE_TURNSTILE_SITE_KEY", ""));
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("lets a guest in with one click and no captcha when none is configured", async () => {
    answering([]);
    const calls: (string | undefined)[] = [];
    const page = renderDom(h(Landing, { onSignIn: async () => {}, onGuest: async (token?: string) => void calls.push(token) }));

    await press(buttons(page, "Play as a guest")[1]);
    expect(calls).toEqual([undefined]);
  });

  it("shows a refused guest sign-in beside the button that was pressed", async () => {
    answering([]);
    const page = renderDom(
      h(Landing, {
        onSignIn: async () => {},
        onGuest: async () => {
          throw new Error("Anonymous sign-ins are disabled");
        },
      })
    );

    const closing = buttons(page, "Play as a guest").at(-1)!;
    await press(closing);
    expect(closing.parentElement!.textContent).toContain("Anonymous sign-ins are disabled");
    expect((closing as HTMLButtonElement).disabled).toBe(false);
  });

  it("logs in with Google", async () => {
    answering([]);
    const onSignIn = vi.fn(async () => {});
    const page = renderDom(h(Landing, { onSignIn, onGuest: async () => {} }));

    await press(buttons(page, "Log in")[0]);
    expect(onSignIn).toHaveBeenCalledOnce();
  });

  it("shows recent rooms in the gallery, with their creatures", async () => {
    answering([ROOM]);
    const page = renderDom(h(Landing, { onSignIn: async () => {}, onGuest: async () => {} }));
    await landed();

    expect(page.container.textContent).toContain("Latest from runs");
    expect(page.container.textContent).toContain("Flooded nave");
    expect(page.one('[aria-label="A drawing of Flooded nave"]')).toBeTruthy();
  });

  it("shows the style references as examples when no run has pictures", async () => {
    answering("down");
    const page = renderDom(h(Landing, { onSignIn: async () => {}, onGuest: async () => {} }));
    await landed();

    expect(page.container.textContent).toContain("Example rooms");
    expect(page.container.textContent).not.toContain("Latest from runs");
    expect(page.one('img[alt="A drawing of Flooded nave"]')).toBeTruthy();
  });
});
