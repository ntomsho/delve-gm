/**
 * ROOM PLATES — the words
 * =======================
 *
 * The Haiku calls that cut a room's fiction down to what an illustrator would
 * draw, and the assembly of the image prompt from their answers and the
 * camera's. The request text and the prompt layout are pure and live in
 * `src/engine/plate-prompt.ts`; this is the part that talks to the model.
 *
 * Three calls, each cached by the caller with what it describes:
 *
 *   setting   once per dungeon — what the place is built from, and its light
 *   visual    once per plate — the room's shell, and a look per thing in view
 *   exterior  once per dungeon — the place and its way in, from outside
 *
 * Only what `plateInView` kept is sent: concealment filtered, sounds and smells
 * dropped, nothing out of frame. The model writes no positions and no numbers;
 * the prompt's WHERE comes from code.
 */

import { z } from "zod";
import {
  exteriorPlatePrompt,
  PLATE_EXTERIOR_SYSTEM,
  PLATE_SETTING_SYSTEM,
  PLATE_VISUAL_SYSTEM,
  plateSettingMessage,
  plateVisualMessage,
  roomPlatePrompt,
  type GuideMode,
  type VisualSubject,
} from "../engine/index.ts";
import { callForJson, type Usage } from "./llm/client.ts";
import { plateInView, type RoomPlate } from "./plates.ts";

const nonEmpty = z.string().trim().min(1);

const visualSchema = z.object({
  room: nonEmpty,
  things: z.array(z.object({ ref: nonEmpty, look: nonEmpty })),
});
const lineSchema = z.object({ text: nonEmpty });

export interface PlateVisual {
  room: string;
  /** look by `VisualSubject.ref` */
  looks: Record<string, string>;
}

/**
 * The refs the visual request keys on: the guide's tag where there is one,
 * and S1, S2… for surfaces, which carry none. Short on purpose — they are
 * echoed back once per thing.
 */
export function visualSubjects(p: RoomPlate): { subjects: VisualSubject[]; refOf: Map<string, string> } {
  const { drawn, surfaces } = plateInView(p);
  const refOf = new Map<string, string>();
  const subjects: VisualSubject[] = [];
  for (const x of drawn) {
    const ref = x.tag ?? `T${subjects.length + 1}`;
    refOf.set(x.subject.id, ref);
    subjects.push({ ref, kind: x.doorway ? "doorway" : "object", name: x.subject.name, base: x.subject.base });
  }
  surfaces.forEach((x, i) => {
    const ref = `S${i + 1}`;
    refOf.set(x.subject.id, ref);
    subjects.push({ ref, kind: "surface", name: x.subject.name, base: x.subject.base });
  });
  return { subjects, refOf };
}

export async function requestPlateVisual(p: RoomPlate): Promise<{ value: PlateVisual; usage: Usage }> {
  const { subjects } = visualSubjects(p);
  const want = new Set(subjects.map((s) => s.ref));
  const res = await callForJson({
    task: "plate-visual",
    system: PLATE_VISUAL_SYSTEM,
    messages: [{ role: "user", content: plateVisualMessage(p.roomName, p.roomBase, subjects) }],
    schema: visualSchema,
    toolName: "plate_visual",
    toolDescription: "The room's shell in one sentence, and a look for every listed thing, keyed by ref.",
    check: (v) =>
      [...want]
        .filter((ref) => !v.things.some((t) => t.ref === ref))
        .map((ref) => ({ path: "things", message: `no look for ref ${ref}` })),
  });
  return {
    value: { room: res.value.room, looks: Object.fromEntries(res.value.things.map((t) => [t.ref, t.look])) },
    usage: res.usage,
  };
}

async function requestLine(system: string, message: string): Promise<{ value: string; usage: Usage }> {
  const res = await callForJson({
    task: "plate-visual",
    system,
    messages: [{ role: "user", content: message }],
    schema: lineSchema,
    toolName: "plate_line",
    toolDescription: "The text asked for.",
  });
  return { value: res.value.text, usage: res.usage };
}

export function requestPlateSetting(theme: string): Promise<{ value: string; usage: Usage }> {
  return requestLine(PLATE_SETTING_SYSTEM, plateSettingMessage(theme));
}

export function requestPlateExterior(description: string): Promise<{ value: string; usage: Usage }> {
  return requestLine(PLATE_EXTERIOR_SYSTEM, description);
}

/**
 * The image prompt for a room plate. `visual` may come from the model or —
 * for comparing against it — be built from the raw fiction; the prompt does
 * not care which.
 */
export function plateImagePrompt(
  p: RoomPlate,
  guide: GuideMode,
  setting: string,
  visual: PlateVisual,
  style?: string,
  references = 0
): string {
  const { viewpoint, drawn, surfaces } = plateInView(p);
  const { refOf } = visualSubjects(p);
  const look = (id: string, fallback: string) => visual.looks[refOf.get(id) ?? ""] ?? fallback;
  return roomPlatePrompt({
    guide,
    style,
    references,
    setting,
    room: visual.room,
    viewpoint,
    drawn: drawn.map((x) => ({ tag: x.tag, look: look(x.subject.id, x.subject.name), where: x.where, doorway: x.doorway })),
    surfaces: surfaces.map((x) => ({ look: look(x.subject.id, x.subject.name), where: x.where })),
  });
}

/**
 * The same prompt with the fiction passed through uncut: the room's whole base
 * as ROOM and each thing's whole base as its look. The control the condensing
 * call is measured against.
 */
export function rawVisual(p: RoomPlate): PlateVisual {
  const { subjects } = visualSubjects(p);
  return { room: p.roomBase, looks: Object.fromEntries(subjects.map((s) => [s.ref, s.base])) };
}

export { exteriorPlatePrompt };
