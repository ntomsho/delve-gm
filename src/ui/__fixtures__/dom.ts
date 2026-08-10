/**
 * Rendering a component into a DOM, and poking it.
 *
 * About twenty lines instead of a testing library, on the same reasoning that
 * kept this project off a component library: what these tests actually assert is
 * `container.querySelectorAll("path")`, because the map is SVG and has almost no
 * roles or text to query by. `render` and `fireEvent` are the whole of what a
 * library would have added, and they are the two functions below.
 *
 * `src/ui/screens.test.ts` stays on `renderToStaticMarkup` and should. A static
 * render is the cheaper instrument and it answers "does this component body run
 * and put the right words on the page". These exist for the other question —
 * state, refs, and what happens when you click.
 */

import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach } from "vitest";

export interface Rendered {
  container: HTMLElement;
  /** re-render the same root with new props, so state survives the update */
  update(el: ReactElement): void;
  unmount(): void;
  /** everything matching, as an array — `querySelectorAll` returns a NodeList */
  all(selector: string): Element[];
  /** the one match, or a failure naming the selector rather than `null.foo` */
  one(selector: string): Element;
}

const open: Array<{ root: Root; container: HTMLElement }> = [];

// Left mounted, a component keeps its window listeners — TravelConfirm's Escape
// handler among them — and the next test in the file gets called twice.
afterEach(() => {
  while (open.length > 0) {
    const { root, container } = open.pop()!;
    act(() => root.unmount());
    container.remove();
  }
});

export function renderDom(el: ReactElement): Rendered {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const entry = { root, container };
  open.push(entry);

  act(() => root.render(el));

  return {
    container,
    update: (next) => act(() => root.render(next)),
    unmount: () => {
      const i = open.indexOf(entry);
      if (i >= 0) open.splice(i, 1);
      act(() => root.unmount());
      container.remove();
    },
    all: (selector) => [...container.querySelectorAll(selector)],
    one: (selector) => {
      const found = container.querySelector(selector);
      if (found === null) throw new Error(`nothing matched ${selector}`);
      return found;
    },
  };
}

/**
 * Dispatch a real event and let React flush.
 *
 * React 19 listens at the root for the native type, so a `MouseEvent` named
 * "pointerdown" reaches an `onPointerDown` handler. Everything must bubble:
 * the handler is rarely on the element the test is aiming at.
 */
export function fire(
  target: Element | Window,
  type: string,
  init: EventInit & Record<string, unknown> = {}
): void {
  const Ctor =
    type.startsWith("pointer") ? PointerEvent
    : type === "wheel" ? WheelEvent
    : type.startsWith("key") ? KeyboardEvent
    : type.startsWith("mouse") || type === "click" || type === "dblclick" ? MouseEvent
    : Event;

  act(() => {
    target.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, ...init }));
  });
}

/**
 * The cursor leaving an element.
 *
 * NOT a `pointerleave` event. Leave does not bubble, so React does not listen
 * for it; it derives `onPointerLeave` from `pointerout` at the root, comparing
 * the target against `relatedTarget` to work out what was left. A dispatched
 * `pointerleave` reaches nothing at all and the test passes for the wrong
 * reason — which it did, until this existed.
 *
 * `relatedTarget: null` means the cursor went outside the document entirely, so
 * leave fires for the target and everything above it.
 */
export function leave(target: Element): void {
  fire(target, "pointerout", { relatedTarget: null });
}

/** A pointer press, drag and release, as three events on the same element. */
export function drag(target: Element, from: Point, to: Point): void {
  fire(target, "pointerdown", { clientX: from.x, clientY: from.y, pointerId: 1 });
  fire(target, "pointermove", { clientX: to.x, clientY: to.y, pointerId: 1 });
  fire(target, "pointerup", { clientX: to.x, clientY: to.y, pointerId: 1 });
}

interface Point {
  x: number;
  y: number;
}
