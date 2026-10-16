/**
 * THE ONE THING A CLICK OFFERS, as a table rather than as a rendered click.
 *
 * `DungeonMap.test.tsx` and `hover.test.tsx` cover the pill — that it opens above
 * the thing, that a press sends what the button showed, that clicking away is
 * free. None of that has to be paid again for every branch of the table, and the
 * branches are where the rules actually live: what a way out offers, what a
 * blocked way offers, what a room offers when you are standing in it.
 *
 * The sentences are asserted whole. They are the entire interface between a click
 * and the game master — the game master answers text and nothing else — so "contains the
 * word examine" would pass on a sentence no player would have typed.
 */

import { describe, expect, it } from "vitest";
import { definite, roomVerb, thingVerb, wayVerb, type Wayish } from "./verbs.ts";
import type { MapRoomView } from "../../gameplay/view/map.ts";

const room = (over: Partial<MapRoomView> = {}): MapRoomView => ({
  id: "r1",
  shape: { kind: "circle", at: { x: 0, y: 0 }, r: 4 },
  centre: { x: 0, y: 0 },
  chunk: 0,
  known: true,
  mapped: false,
  current: false,
  name: "Kennel",
  composed: "Straw, and the smell of dog.",
  ...over,
});

const way = (over: Partial<Wayish> = {}): Wayish => ({
  name: "an iron door",
  surface: false,
  blocked: false,
  toUnknown: false,
  ...over,
});

// ===========================================================================
// THE ARTICLE
// ===========================================================================
//
// Names are written to read well standing alone — "an iron door" under a marker
// — and a sentence naming one wants the definite form. Getting this wrong is not
// cosmetic: the sentence goes to the game master as the player's own words, and
// "I examine an iron door" reads like a different door from the one on the map.

describe("naming a thing inside a sentence", () => {
  it("turns an indefinite article definite", () => {
    expect(definite("an iron door")).toBe("the iron door");
    expect(definite("a cracked font")).toBe("the cracked font");
  });

  // Names are capitalised at the mint (8f), so a name that carries its own
  // article carries a capital one, and the sentence wants it lower. Only the
  // article moves — "Sunken Vestibule" is somebody's name for the place.
  it("lowers the article on a name that brought its own", () => {
    expect(definite("The stair up")).toBe("the stair up");
    expect(definite("The Sunken Vestibule")).toBe("the Sunken Vestibule");
    expect(definite("the stair up")).toBe("the stair up");
  });

  it("gives an article to a name with none", () => {
    expect(definite("Kennel")).toBe("the Kennel");
  });

  it("is not fooled by a name that merely starts with those letters", () => {
    expect(definite("Anvil")).toBe("the Anvil");
    expect(definite("theatre mask")).toBe("the theatre mask");
  });
});

// ===========================================================================
// ROOMS
// ===========================================================================

describe("a room", () => {
  it("offers to be walked to", () => {
    expect(roomVerb(room())).toEqual({
      label: "Go To?",
      sentence: "I make my way to the Kennel.",
    });
  });

  it("offers a look around when the player is already standing in it", () => {
    // Not "I examine the Kennel": there is nowhere to go and examining a place
    // you are standing in is looking around it.
    expect(roomVerb(room({ current: true }))).toEqual({
      label: "Examine?",
      sentence: "I look around the Kennel.",
    });
  });

  it("still says something when the room has no name", () => {
    expect(roomVerb(room({ name: undefined })).sentence).toBe("I make my way to this place.");
  });
});

// ===========================================================================
// WAYS THROUGH
// ===========================================================================

describe("a way through", () => {
  it("offers to be gone through when the far side has not been seen", () => {
    expect(wayVerb(way({ toUnknown: true }), true)).toEqual({
      label: "Go Through?",
      sentence: "I go through the iron door.",
    });
  });

  it("offers only a look when both rooms it joins have been seen", () => {
    // The room is the clearer statement of intent, and it is drawn and clickable
    // — so travel through a known door is the room's offer, not the door's.
    expect(wayVerb(way(), true).label).toBe("Examine?");
  });

  it("offers only a look when it is not a way out of the room they stand in", () => {
    expect(wayVerb(way({ toUnknown: true }), false).label).toBe("Examine?");
  });

  it("offers a look when something is in the way, with the travel shown greyed", () => {
    // The reversal of `TravelConfirm`, which offered travel through anything and
    // let the game master say no. A pill sends immediately, so this would spend a
    // turn to be told what the room card already says — but the door still
    // shows it is a way through.
    expect(wayVerb(way({ toUnknown: true, blocked: true }), true)).toEqual({
      label: "Examine?",
      sentence: "I examine the iron door.",
      blocked: "Go Through?",
    });
    // Nothing greyed where travel would not be offered anyway.
    expect(wayVerb(way({ toUnknown: true, blocked: true }), false).blocked).toBeUndefined();
    expect(wayVerb(way({ blocked: true }), true).blocked).toBeUndefined();
  });

  it("offers to leave the dungeon through the way out", () => {
    // The override, and the only one: `toUnknown` is false for a way out by
    // construction — `mapView` calls its far side known when the near side is —
    // and there is no room on the other side to click instead.
    expect(wayVerb(way({ surface: true, name: "the stair up" }), true)).toEqual({
      label: "Leave the Dungeon?",
      sentence: "I leave the dungeon through the stair up.",
    });
  });

  it("will not offer to leave through a way out that is shut", () => {
    expect(wayVerb(way({ surface: true, blocked: true }), true)).toMatchObject({
      label: "Examine?",
      blocked: "Leave the Dungeon?",
    });
  });

  it("falls back to a phrase when the connector has no name", () => {
    // `mapView` writes "" when the entity behind a connector is missing, and
    // "I examine the ." is worse than a generic phrase.
    expect(wayVerb(way({ name: "" }), true).sentence).toBe("I examine the way through.");
    expect(wayVerb(way({ name: "", surface: true }), false).sentence).toBe(
      "I examine the way out."
    );
  });
});

// ===========================================================================
// EVERYTHING ELSE
// ===========================================================================

describe("anything standing in a room", () => {
  it("offers a look at it, whatever it is", () => {
    // One verb for creatures, items, features and hazards alike. Everything past
    // this is a sentence the player types — see the file header of `verbs.ts`.
    expect(thingVerb("a cracked font")).toEqual({
      label: "Examine?",
      sentence: "I examine the cracked font.",
    });
  });

  it("still says something about a thing with no name", () => {
    expect(thingVerb("").sentence).toBe("I examine it.");
  });
});
