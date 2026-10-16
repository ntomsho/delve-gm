import { ILLUSTRATION_GUIDE_NOTE, ILLUSTRATION_OPEN_FLOOR_NOTE, ILLUSTRATION_PLAIN_GUIDE_NOTE, ILLUSTRATION_STYLE } from "../prompts/loader.ts";
/**
 * ILLUSTRATION PROMPTS
 * =============
 *
 * The words a room illustration is drawn from, assembled by code. Two prompts live
 * here, both pure:
 *
 *   the VISUAL REQUEST  what Haiku is asked, to cut a room's fiction down to
 *                       what an illustrator would draw. The fiction is written
 *                       to be read — smells, history, "as though the stone
 *                       rejected the geometry" — and an image model given all
 *                       of it draws the wrong things, or loses the placement
 *                       list under it.
 *   the IMAGE PROMPT    what the image model is given: a fixed style, the role
 *                       of the guide image, the dungeon's look, the room's look,
 *                       and every thing in the frame with WHERE it goes.
 *
 * WHERE is never the model's: positions, distances and counts all come from
 * `illustrationView` as words, and the visual request forbids numbers outright. What
 * Haiku contributes is what each thing LOOKS like.
 *
 * Nothing the player could not see reaches either prompt: the caller passes
 * only what `roomIllustration` kept — concealment filtered, senses dropped, and only
 * what is in the frame.
 */

/**
 * Bumped whenever the style text changes. It is part of an illustration's cache key,
 * so a new style redraws everything from then on rather than mixing two looks
 * in one dungeon.
 */
export const ILLUSTRATION_STYLE_VERSION = 2;

/** How the guide image was drawn, which decides what the prompt says about it. */
export type GuideMode = "marks" | "plain" | "none";

/**
 * What the style references are for. A reference is copied as readily as a
 * guide, so the prompt says which image is which and that only the manner of
 * drawing may be taken from the references — never their rooms or framing.
 */
export function illustrationReferenceNote(count: number, afterGuide: boolean): string {
  const which = afterGuide
    ? `The first image is the guide. The other ${count} images are style references only`
    : `The ${count} images are style references only`;
  return (
    `${which}: draw in exactly their manner — the same line weight, the same sparing hatching, the same ` +
    "amount of white paper. Take nothing else from them: not their rooms, objects, layout or viewpoint."
  );
}

// ---------------------------------------------------------------------------
// THE VISUAL REQUEST
// ---------------------------------------------------------------------------

/** One thing in the frame, as the visual request sees it. */
export interface VisualSubject {
  /** a short handle the response keys on — "A", "1" — not an entity id */
  ref: string;
  /** a doorway, a thing standing in the room, or a treatment of the whole room */
  kind: "doorway" | "object" | "surface";
  name: string;
  /** the entity's base prose, as generated */
  base: string;
}

/** The user message for the per-room visual request. */
export function illustrationVisualMessage(roomName: string, roomBase: string, subjects: VisualSubject[]): string {
  const L = [`ROOM: ${roomName}`, roomBase, "", "THINGS IN VIEW (give each a look, keyed by ref):"];
  for (const s of subjects) L.push(`- ref ${s.ref} (${s.kind}) ${s.name}: ${s.base}`);
  if (!subjects.length) L.push("(none)");
  return L.join("\n");
}

/** The user message for the per-dungeon setting request. */
export function illustrationSettingMessage(theme: string): string {
  return `THEME:\n${theme}`;
}

// ---------------------------------------------------------------------------
// THE IMAGE PROMPT
// ---------------------------------------------------------------------------

/** One thing the picture must contain, where the camera put it. */
export interface DrawnThing {
  /** the guide's tag for it; absent when the guide carries no marks */
  tag?: string;
  look: string;
  /** where it is, as words from `illustrationView` */
  where: string;
  doorway: boolean;
}

export interface RoomPromptParts {
  guide: GuideMode;
  /** how many style reference images ride along after the guide; 0 or absent for none */
  references?: number;
  /** the style text; ILLUSTRATION_STYLE unless a trial is comparing another */
  style?: string;
  /** the dungeon's look, one line, shared by every illustration in it */
  setting: string;
  /** the room's shell, one line */
  room: string;
  /** where the camera stands and how much room is in front of it */
  viewpoint: string;
  drawn: DrawnThing[];
  /** treatments of the whole room: stains, haze, growth */
  surfaces: { look: string; where: string }[];
  /** the guide marks a patch of floor to keep clear (marked guide only) */
  openFloor?: boolean;
}

export function roomIllustrationPrompt(p: RoomPromptParts): string {
  const L: string[] = ["STYLE", p.style ?? ILLUSTRATION_STYLE, ""];
  if (p.references) L.push("STYLE REFERENCES", illustrationReferenceNote(p.references, p.guide !== "none"), "");
  if (p.guide === "marks") L.push("GUIDE", ILLUSTRATION_GUIDE_NOTE, "");
  if (p.guide === "plain") L.push("GUIDE", ILLUSTRATION_PLAIN_GUIDE_NOTE, "");
  L.push("SETTING", p.setting, "", "ROOM", p.room, "", "VIEW", p.viewpoint);
  if (p.drawn.length) {
    L.push("", "MUST BE DRAWN, EACH WHERE STATED");
    for (const d of p.drawn) {
      const tag = p.guide === "marks" && d.tag ? `[${d.tag}] ` : "";
      L.push(`- ${tag}${d.doorway ? "Doorway: " : ""}${d.look} — ${d.where}`);
    }
  }
  if (p.surfaces.length) {
    L.push("", "OVER THE WALLS, FLOOR OR AIR");
    for (const s of p.surfaces) L.push(`- ${s.look} — ${s.where}`);
  }
  if (p.openFloor && p.guide === "marks") L.push("", "OPEN FLOOR", ILLUSTRATION_OPEN_FLOOR_NOTE);
  return L.join("\n");
}

export interface ExteriorPromptParts {
  /** the style text; ILLUSTRATION_STYLE unless a trial is comparing another */
  style?: string;
  /** the place and its way in, seen from outside */
  scene: string;
}

export function exteriorIllustrationPrompt(p: ExteriorPromptParts): string {
  return [
    "STYLE",
    p.style ?? ILLUSTRATION_STYLE,
    "",
    "VIEW",
    "An exterior view of the place from outside, at a distance, with its way in clearly visible.",
    "",
    "SCENE",
    p.scene,
  ].join("\n");
}

