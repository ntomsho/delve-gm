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

/**
 * Version 2, "sparse". Version 1 asked for cross-hatching and stippling and got
 * exactly that: dense, dark engraving that turned busy or black at 1-bit. This
 * asks for mostly white paper and shading only where a shadow is deepest, and
 * says "no border" more than one way because klein drew one anyway.
 */
export const ILLUSTRATION_STYLE =
  "Clean black ink line art in the manner of a 1970s-80s fantasy adventure module's illustration " +
  "booklet. Mostly white paper. Crisp, confident outlines define every form. Shading is sparing: a few " +
  "hatched strokes only in the deepest shadows, no dense cross-hatching, no stippled texture, no large " +
  "areas of solid black. Walls, floors and sky stay largely white. No grey, no colour. The picture fills " +
  "the whole image edge to edge, with no frame, no border line, no box and no vignette around it. No " +
  "lettering. No people, no creatures, no loose objects.";

/** How the guide image was drawn, which decides what the prompt says about it. */
export type GuideMode = "marks" | "plain" | "none";

/**
 * What the marks in the guide image mean. The marks say WHERE; the prose says
 * WHAT; and none of them may survive into the drawing.
 */
export const ILLUSTRATION_GUIDE_NOTE =
  "The guide image fixes the room's walls and the camera. Each dashed outline on the floor, " +
  "tagged with a number, marks where the numbered feature stands; each lettered tag marks a " +
  "doorway. Draw the thing described in place of each mark. Do not draw the dashed outlines, " +
  "the tags, or any numbers or letters.";

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

/** The same, for a guide drawn with no marks: architecture only. */
export const ILLUSTRATION_PLAIN_GUIDE_NOTE =
  "The guide image fixes the room's walls, doorways and the camera: follow its perspective " +
  "and wall layout exactly. It shows no objects; draw the features listed below where stated.";

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

export const ILLUSTRATION_VISUAL_SYSTEM = [
  "You turn a room's written description into notes for an illustrator who draws in black ink.",
  "",
  "Write only what can be SEEN: materials, shapes, surfaces, condition, light and shadow.",
  "Leave out sounds, smells, temperature, history, purpose, feelings, and anything a person or creature is doing.",
  "Never write a number, a size, a distance, a count, or a direction (left, north, far end): where things are is decided elsewhere.",
  "Never mention people or creatures.",
  "",
  "`room` describes only the room's shell — walls, floor, ceiling, air, light, condition — in one sentence of at most 30 words. Do not mention any doorway or any of the listed things in it.",
  "`things` gives each listed thing a look: a noun phrase of at most 14 words saying what it looks like, with no name, no position and no number.",
].join("\n");

export const ILLUSTRATION_SETTING_SYSTEM = [
  "You turn a dungeon's written theme into one line for an illustrator who draws in black ink.",
  "Write one sentence of at most 25 words: what the place is built from or carved out of, its condition, and its light.",
  "Only what can be seen. No sounds, smells, history, people or creatures. No numbers.",
].join("\n");

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

/** What Haiku is asked for an exterior: the place and its entrance, from outside. */
export const ILLUSTRATION_EXTERIOR_SYSTEM = [
  "You turn a written description of a dungeon's surroundings and entrance into notes for an illustrator who draws in black ink.",
  "Write two or three sentences, at most 60 words, describing what someone approaching would SEE: the landscape, the structure, its condition, and the entrance.",
  "If the description gives the time of day, the sky or the weather, open with them in plain words (\"At night, under a full moon, ...\"): they change the whole picture.",
  "Keep anything it says about how many there are or what is absent (\"a single building, nothing else in sight\"): an illustrator adds what is not ruled out.",
  "Leave out sounds, smells, history, purpose and feelings. No people or creatures. No numbers.",
].join("\n");
