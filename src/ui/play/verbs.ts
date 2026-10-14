/**
 * ONE THING TO DO WITH THE THING YOU CLICKED.
 *
 * A click on the map or on a room card row raises a small question above it —
 * "Go Through?" — and answering it sends a sentence as the player's action. This
 * file is the whole of what that question is and what it sends. No React, so
 * every branch of the table is a unit test rather than a rendered click.
 *
 * WHY ONE VERB AND NOT A MENU. A menu of quick actions was the plan, and the
 * shortlist collapsed under its own weight: outside of examining a thing, almost
 * everything worth doing to it depends on what the thing specifically IS, not on
 * its type — so the menu was one reliable row plus a scattering of type-gated
 * ones. What survives is the part that never needed clarification. Anything else
 * is a sentence the player types, which is the interface this game already has.
 *
 * THE TABLE, and the field that decides each row:
 *
 *   room, elsewhere        `current` false      Go To?
 *   room, standing in it   `current`            Examine?   (look around)
 *   way out, reachable     `surface`            Leave the Dungeon?
 *   way, reachable, open,
 *     far side unseen      `toUnknown`          Go Through?
 *   anything else                               Examine?
 *
 * WHY "GO THROUGH" IS NARROW. A way whose both ends the player has already seen
 * is two clicks for one move — the door, or the room it leads to — and the room
 * is the clearer statement of intent, so the door stops offering it and the
 * player clicks the room. That leaves doors offering travel in exactly the case
 * a room cannot: the far side is undiscovered, so there is no room drawn to
 * click. The way OUT of the dungeon is the same case in the extreme — its far
 * side is not a room and never will be — and it is why `surface` is checked
 * before `toUnknown`, which is always false for a way out (`mapView` sets the
 * far side known when the near side is).
 *
 * A BLOCKED WAY GETS EXAMINE. It is the one place this reverses `TravelConfirm`,
 * which offered travel through anything and let the game master say no. The pill
 * sends immediately, so "go through the barred door" would spend a turn on an
 * answer the player has already been given in the room card; examining the bar
 * is the move that gets them somewhere, and it is one keystroke to type the
 * other. See `wayVerb`.
 */

import type { MapRoomView } from "../../gameplay/view/selectors.ts";

/** A question, and what is sent if they say yes. */
export interface Verb {
  /** the pill: "Go Through?" */
  label: string;
  /** the action, phrased as the player would have typed it */
  sentence: string;
}

const EXAMINE = "Examine?";

/**
 * A name with a definite article, whatever it arrived with.
 *
 * Names are written by the content pass in the form they read best standing
 * alone — "An iron door", "The stair up", "Kennel" — and an action naming one
 * wants the definite form of it: "I examine the iron door", never "an iron
 * door". Whichever article a name brought, it leaves with a lower-case "the";
 * a name with none is given one.
 *
 * THE ARTICLE'S CASE IS THE PART THAT MOVES, and only the article. Names are
 * capitalised where they are minted (8f, `properName`), so "the pillars" is
 * stored as "The pillars" and dropping it into a sentence verbatim would read
 * "I examine The pillars." The rest of the name is never touched: which of its
 * words are part of somebody's actual name is not knowable here, and "I examine
 * the wendy wilberforce" is a worse sentence than the one this fixes.
 *
 * `theRoom` in `selectors.ts` is the display-side half of this and deliberately
 * leaves an indefinite article alone, because a LABEL should read as it was
 * written; a sentence should not.
 */
export function definite(name: string): string {
  const whole = name.trim();
  const article = /^(an?|the)\s+/i.exec(whole);
  return article === null ? `the ${whole}` : `the ${whole.slice(article[0].length)}`;
}

/**
 * What to call it in a sentence, or what to call it when it has no name.
 *
 * A connector's name comes out of `mapView` as `""` when the entity behind it is
 * missing, and "I examine the ." is worse than a generic phrase.
 */
function named(name: string | undefined, fallback: string): string {
  return name === undefined || name.trim() === "" ? fallback : definite(name);
}

/**
 * A room: somewhere to go, unless they are already standing in it.
 *
 * Only known rooms are drawn at all, so there is no fog case here — an
 * undiscovered room has nothing to click.
 */
export function roomVerb(room: MapRoomView): Verb {
  const what = named(room.name, "this place");
  // Standing in it, there is nowhere to go and "examine" means look around.
  if (room.current) return { label: EXAMINE, sentence: `I look around ${what}.` };
  // A MAPPED ROOM IS SOMEWHERE THEY HAVE READ ABOUT, NOT SOMEWHERE THEY CAN
  // WALK TO. `shortestPath` refuses a room the player has never entered, so
  // "Go To?" here would offer an action the game is about to turn away. Offering
  // the chart instead is both honest and the thing they would actually do.
  if (room.mapped) {
    return { label: "Recall?", sentence: `I think back to what the chart showed of ${what}.` };
  }
  return { label: "Go To?", sentence: `I make my way to ${what}.` };
}

/**
 * The half of a way through that decides what to offer, from either panel.
 *
 * The map has `MapConnectorView` and the room card has `ExitView`, and they name
 * the far side differently — `toUnknown` there, `toKnown` here. Both can state
 * these four things, and travel only ever fires when the far side is unseen, so
 * the fields that differ between the two views are exactly the fields no verb
 * needs.
 */
export interface Wayish {
  name: string;
  /** out of the dungeon entirely */
  surface: boolean;
  /** something stands in the way */
  blocked: boolean;
  /** the room on the far side has not been discovered */
  toUnknown: boolean;
}

/**
 * A way through.
 *
 * `reachable` is the caller's answer to "is this a way out of the room the
 * player is standing in" — a door across the map is a route rather than a step,
 * and the runtime is only tested for a step into the unknown from where the
 * player stands (`travel.test.ts`). A far door still examines.
 */
export function wayVerb(way: Wayish, reachable: boolean): Verb {
  const what = named(way.name, way.surface ? "the way out" : "the way through");

  if (reachable && !way.blocked) {
    if (way.surface) {
      return { label: "Leave the Dungeon?", sentence: `I leave the dungeon through ${what}.` };
    }
    if (way.toUnknown) return { label: "Go Through?", sentence: `I go through ${what}.` };
  }

  return { label: EXAMINE, sentence: `I examine ${what}.` };
}

/** Everything that is not a room and not a way out of one. */
export function thingVerb(name: string): Verb {
  return { label: EXAMINE, sentence: `I examine ${named(name, "it")}.` };
}
