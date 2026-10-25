/**
 * THE SHOWCASE: pictures from recent runs, for the landing page.
 *
 * What `GET /api/illustrations/recent` answers (`server/illustrations/showcase.ts`)
 * and the landing page reads. Shared so both ends say the same shape.
 *
 * Only pictures that are already drawn. The landing page never asks for a
 * drawing: it shows what players have paid for already.
 */

import type { FigureSize, IllustrationFigure } from "./figures.ts";

/** One creature stood in a showcased room, with its sprite already drawn. */
export interface ShowcaseFigure extends IllustrationFigure {
  url: string;
  size: FigureSize;
}

/**
 * A room's interior, or a dungeon's cover (its exterior). A room carries the
 * creatures generation put there whose sprites some player has met, placed as
 * the game places them; a cover carries none.
 */
export interface ShowcaseIllustration {
  kind: "room" | "cover";
  url: string;
  /** the room's name; absent on a cover */
  roomTitle?: string;
  dungeonTitle: string;
  figures: ShowcaseFigure[];
}
