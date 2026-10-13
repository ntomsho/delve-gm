/**
 * THE DOOR, with two ways through it. What is worth pinning is that the guest
 * button really is one click — no Turnstile key configured means no token and
 * no wait — and that a refusal lands on the card rather than vanishing.
 */

import { describe, expect, it } from "vitest";
import { createElement as h } from "react";
import { renderDom, press } from "./__fixtures__/dom.ts";
import { SignIn } from "./SignIn.tsx";

const byText = (page: ReturnType<typeof renderDom>, text: string) => {
  const found = page.all("button").find((b) => b.textContent?.includes(text));
  if (!found) throw new Error(`no button saying ${text}`);
  return found;
};

describe("SignIn", () => {
  it("lets a guest in with one click and no captcha when none is configured", async () => {
    const calls: (string | undefined)[] = [];
    const page = renderDom(
      h(SignIn, {
        onSignIn: async () => {},
        onGuest: async (token?: string) => void calls.push(token),
      })
    );

    await press(byText(page, "PLAY AS A GUEST"));
    expect(calls).toEqual([undefined]);
  });

  it("shows a refused guest sign-in on the card", async () => {
    const page = renderDom(
      h(SignIn, {
        onSignIn: async () => {},
        onGuest: async () => {
          throw new Error("Anonymous sign-ins are disabled");
        },
      })
    );

    await press(byText(page, "PLAY AS A GUEST"));
    expect(page.container.textContent).toContain("Anonymous sign-ins are disabled");
    expect((byText(page, "PLAY AS A GUEST") as HTMLButtonElement).disabled).toBe(false);
  });
});
