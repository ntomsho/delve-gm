/**
 * Rendering a component into a DOM, and poking it.
 *
 * About twenty lines instead of a testing library, on the same reasoning that
 * kept this project off a component library: what these tests actually assert is
 * `container.querySelectorAll("path")`, because the map is SVG and has almost no
 * roles or text to query by. `render` and `fireEvent` are the whole of what a
 * library would have added, and they are the two functions below.
 *
 * `src/ui/app/screens.test.ts` stays on `renderToStaticMarkup` and should. A static
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

// Left mounted, a component keeps its window listeners — react-tooltip's
// click-outside handler among them — and the next test in the file gets a
// tooltip answering to events it did not fire.
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

/**
 * Let the page catch up: a frame, the timers due within it, and the effects
 * they schedule.
 *
 * A TOOLTIP IS NOT INSTANT, in three separate places, and none of them are
 * arbitrary: react-tooltip refreshes its document-wide register of anchors on
 * `requestAnimationFrame`, waits 10ms after opening so the card is in the DOM
 * before it is shown, and runs closing through a timer so the cursor can cross
 * the gap between an anchor and the card without it vanishing. Floating-ui then
 * settles the position over a promise. 25ms clears all four.
 *
 * The alternative was fake timers, which would have meant every test that
 * hovers something also knowing which of those four it is waiting on.
 */
const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 25));
  });

/**
 * The cursor arriving on something, and leaving it.
 *
 * TWO EVENTS ON ARRIVAL, because two listeners are watching for two different
 * things and a real pointer produces both:
 *
 *   mouseover    the one that opens a tooltip and lights a row. Both sides
 *                listen for it rather than for `mouseenter` — React derives
 *                `onMouseEnter` from it at the root, the same indirection
 *                `leave` below documents for pointerout, and react-tooltip
 *                delegates from the document. Neither hears an enter dispatched
 *                straight at the element.
 *   pointermove  where the cursor is. A tooltip that follows it — the map's
 *                does — has nothing to position itself against until a move has
 *                said, and stays mounted but never shown.
 */
export async function hover(target: Element, at: Point = { x: 40, y: 40 }): Promise<void> {
  // Before, so a component that has only just mounted has been noticed.
  await settle();
  fire(target, "mouseover", { relatedTarget: null, clientX: at.x, clientY: at.y });
  fire(target, "pointermove", { clientX: at.x, clientY: at.y, pointerId: 1 });
  await settle();
}

export async function unhover(target: Element): Promise<void> {
  // `relatedTarget: null` — the cursor left for nowhere, so nothing can be
  // mistaken for a move within the anchor. Same reason as `leave` above.
  fire(target, "mouseout", { relatedTarget: null });
  await settle();
}

/**
 * A click, with the page given time either side of it.
 *
 * The same waiting `hover` needs and for the same reasons — react-tooltip finds
 * its anchors on a frame and opens on a timer — plus one of its own: the pill
 * mounts against `[data-verb]`, and an anchor rendered in the same tick as the
 * tooltip has not been noticed yet when the click arrives.
 */
export async function press(target: Element): Promise<void> {
  await settle();
  fire(target, "click");
  await settle();
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
