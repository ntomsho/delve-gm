/**
 * BUTTONS ON WHAT WAS DRAWN
 * =========================
 *
 * `illustrationSpots` puts each button where the guide told the image model to
 * draw its thing. The image model does not always listen, so a door's button
 * can land on a blank wall a hand's width from the door. Once the picture is
 * drawn, Haiku looks at it and moves each button in the picture onto the thing
 * as drawn.
 *
 * Only the buttons that are in the picture (`shown`) are sent. Corner arrows
 * and dashed buttons for things out of sight stay where the geometry put them;
 * Haiku is told only where they are, so it puts nothing on top of them, and
 * `applyPlacement` refuses a move that does anyway. Edge arrows sit off the
 * picture and are not mentioned.
 *
 * Positions on a picture are not game numbers (ARCHITECTURE §1): nothing is
 * rolled, nothing reaches the game master or a state change. The model reads
 * where something is drawn; code checks the answer and keeps the geometry's
 * point wherever the answer is missing, off the picture or crowding another
 * button.
 */

import { z } from "zod";
import { callForJson, type Usage } from "../llm/client.ts";
import { ILLUSTRATION_PLACE_SYSTEM } from "../prompts/loader.ts";
import type { IllustrationSpot, RoomIllustration } from "./room-illustration.ts";

/**
 * How near, as a fraction of the picture's width, a moved button may come to a
 * corner arrow or a dashed button. About the width of two buttons.
 */
export const PLACEMENT_CLEARANCE = 0.03;

/** A picture's size in pixels: what Haiku's answers are measured in. */
export interface PictureSize {
  width: number;
  height: number;
}

const answerSchema = z.object({
  buttons: z.array(
    z.object({
      ref: z.string(),
      found: z.boolean(),
      x: z.number(),
      y: z.number(),
      on: z.string().describe("a few words: what in the picture the button now sits on"),
    })
  ),
});
export type PlacementAnswer = z.infer<typeof answerSchema>["buttons"];

/** The ref a button is asked and answered by: its index among the spots. */
const refOf = (i: number) => `b${i}`;

const taken = (spots: readonly IllustrationSpot[]) =>
  spots.flatMap((s) => (s.how === "behind-wall" || s.how === "around" ? [{ x: s.x, y: s.y }] : []));

/** What Haiku is sent with the picture: the buttons in it, and the spots it must keep off. */
export function placementMessage(p: RoomIllustration, spots: readonly IllustrationSpot[], size: PictureSize): string {
  const subjects = [...p.exits, p.entry, ...p.features];
  const doors = new Set([...p.exits, p.entry].map((x) => x.id));
  const px = (q: { x: number; y: number }) => ({ x: Math.round(q.x * size.width), y: Math.round(q.y * size.height) });
  const buttons = spots.flatMap((s, i) => {
    if (s.how !== "shown") return [];
    const subject = subjects.find((x) => x.id === s.id);
    return [
      {
        ref: refOf(i),
        kind: doors.has(s.id) ? "way out" : "feature",
        name: subject?.name || "the way in",
        looks: subject?.base ?? "",
        estimate: px(s),
      },
    ];
  });
  return [
    `Room: ${p.roomName}`,
    `The picture is ${size.width}x${size.height} pixels.`,
    "",
    "Buttons:",
    JSON.stringify(buttons, null, 1),
    "",
    "Taken spots:",
    JSON.stringify(taken(spots).map(px)),
  ].join("\n");
}

/**
 * The spots with Haiku's answer applied. A `shown` spot moves to its answered
 * point; it stays where it was when the answer is missing, says not found,
 * falls off the picture or sits on a taken spot. Every other spot is returned
 * as it came.
 */
export function applyPlacement(
  spots: readonly IllustrationSpot[],
  answer: PlacementAnswer,
  size: PictureSize
): IllustrationSpot[] {
  const avoid = taken(spots);
  const aspect = size.height / size.width;
  return spots.map((s, i) => {
    if (s.how !== "shown") return s;
    const a = answer.find((b) => b.ref === refOf(i));
    if (!a?.found) return s;
    const x = a.x / size.width;
    const y = a.y / size.height;
    if (!(x >= 0 && x <= 1 && y >= 0 && y <= 1)) return s;
    if (avoid.some((q) => Math.hypot(q.x - x, (q.y - y) * aspect) < PLACEMENT_CLEARANCE)) return s;
    return { ...s, x, y };
  });
}

/**
 * Ask Haiku where the buttons in the picture belong, and apply its answer.
 * `jpeg` is the finished picture at `size`, base64. Spots with nothing in the
 * picture are returned unchanged without a call.
 */
export async function requestButtonPlacement(
  p: RoomIllustration,
  spots: readonly IllustrationSpot[],
  jpeg: string,
  size: PictureSize
): Promise<{ value: IllustrationSpot[]; usage?: Usage }> {
  const want = spots.flatMap((s, i) => (s.how === "shown" ? [refOf(i)] : []));
  if (!want.length) return { value: [...spots] };
  const res = await callForJson({
    task: "illustration-place",
    system: ILLUSTRATION_PLACE_SYSTEM,
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: jpeg } },
          { type: "text", text: placementMessage(p, spots, size) },
        ],
      },
    ],
    schema: answerSchema,
    toolName: "place_buttons",
    toolDescription: "Where each listed button belongs on the picture, in pixels, keyed by ref.",
    check: (v) =>
      want
        .filter((ref) => !v.buttons.some((b) => b.ref === ref))
        .map((ref) => ({ path: "buttons", message: `no answer for ref ${ref}` })),
  });
  return { value: applyPlacement(spots, res.value.buttons, size), usage: res.usage };
}
