/**
 * What jsdom does not implement, filled in.
 *
 * Nothing here is a fixture or a convenience — every line stands for a browser
 * API the component legitimately calls and jsdom legitimately does not have.
 * Keep it that way: the moment this file starts faking behaviour rather than
 * supplying a missing entry point, the tests stop being about the component.
 */

/**
 * POINTER CAPTURE. jsdom ships `PointerEvent` but not the capture methods on
 * `Element`, so `DungeonMap`'s pointerdown — which captures so a drag survives
 * the cursor leaving the svg — throws before the drag ever starts.
 *
 * The stub is a no-op rather than a real capture implementation because the map
 * only ever calls it; nothing reads the capture state back. A component that
 * did would need this replaced, not extended.
 */
for (const name of ["setPointerCapture", "releasePointerCapture"] as const) {
  if (Element.prototype[name] === undefined) {
    Object.defineProperty(Element.prototype, name, {
      value: () => {},
      writable: true,
      configurable: true,
    });
  }
}

if ((Element.prototype as { hasPointerCapture?: unknown }).hasPointerCapture === undefined) {
  Object.defineProperty(Element.prototype, "hasPointerCapture", {
    value: () => false,
    writable: true,
    configurable: true,
  });
}

/**
 * THE TWO OBSERVERS. jsdom implements neither, and react-tooltip keeps a card
 * pinned to its anchor with floating-ui's `autoUpdate`, which watches the anchor
 * for resizes and for layout shifts — a `ResizeObserver` and an
 * `IntersectionObserver` respectively. Without them, mounting a tooltip throws.
 *
 * They observe nothing and never fire, which is honest rather than lazy: jsdom
 * has no layout, so there is no resize and no shift to report. The tooltip's
 * POSITION is therefore not under test here and could not be — what is under
 * test is which anchor opens which card, and what the card says.
 */
for (const name of ["ResizeObserver", "IntersectionObserver"] as const) {
  if ((globalThis as Record<string, unknown>)[name] === undefined) {
    (globalThis as Record<string, unknown>)[name] = class {
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords() {
        return [];
      }
    };
  }
}

/**
 * React's own switch for `act`. Without it every update warns that it was not
 * wrapped, which is noise that would train the reader to ignore the warning
 * that matters.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
