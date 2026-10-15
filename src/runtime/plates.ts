/**
 * ROOM PLATES — what goes into one
 * ================================
 *
 * The join between a generated dungeon and `plateView`. This is where a room's
 * entities become cells and doors, and where CONCEALMENT IS FILTERED OUT: a
 * plate is a picture for the player, and a hidden feature or a secret door fed
 * to an image model is a picture of the secret (BUILD-PLAN, Illustrations).
 *
 * Reads the dungeon as GENERATED, never the run, so a room's plate does not
 * depend on what one player has found — it is the dungeon's, and every player
 * entering by the same door gets the same one.
 *
 * No creatures and no loose items: they move, die and get picked up, and a
 * picture of them is stale the moment they do.
 */

import {
  exitWhere,
  featurePresence,
  featureWhere,
  isSurfaceExit,
  drawableCreatures,
  plateFigures,
  plateHotspots,
  plateStage,
  roomClusters,
  type ICreature,
  type PlateFigure,
  plateView,
  resolveBase,
  touches,
  unseenReason,
  type Hotspot,
  type HotspotEdge,
  type IRoomConnector,
  type PlateView,
  type Presence,
  type PlateViewInput,
  type Point,
  type ViewDoor,
} from "../engine/index.ts";
import type { GeneratedDungeon } from "./generate.ts";

/** A way out or a feature, with what the prompt needs to name it. */
export interface PlateSubject {
  id: string;
  name: string;
  /** the entity's base prose — what it looks like, as generated */
  base: string;
  /** fixture kind for a feature that came off the menu */
  kind?: string;
  /** the way out of the dungeon rather than a door to another room */
  surface?: boolean;
  /** features only: a thing in a place, a treatment of the whole room, or not visible at all */
  presence?: Presence;
  /** features only: the position word the content pass chose */
  position?: string;
}

export interface RoomPlate {
  roomId: string;
  roomName: string;
  roomBase: string;
  /** the connector the viewer came in by */
  entryId: string;
  /** that connector, which may be in the picture when the camera turns back toward it */
  entry: PlateSubject;
  input: PlateViewInput;
  view: PlateView;
  exits: PlateSubject[];
  /**
   * Features that can be drawn — objects and surfaces — in the same order as
   * `input.features` and `view.features`.
   */
  features: PlateSubject[];
  /** features that are heard or smelled, not seen: not in the view, the guide or the hotspots */
  senses: PlateSubject[];
  /** where every way out and drawable feature lands on the plate, for the page's buttons */
  hotspots: Hotspot[];
  /**
   * The floor kept clear for creatures, in feet: marked in the guide, named in
   * the prompt, and where the first cluster stands (`plateFigures`). Absent
   * when the room has nowhere in the frame that will do.
   */
  stage?: Point;
}

const pairKey = (a: number, b: number) => `${Math.min(a, b)}-${Math.max(a, b)}`;

/**
 * Where a connector cuts this room's wall, as the plan drew it.
 *
 * Undefined when the plan has no door for it — a dungeon with no block plan,
 * or an edge the plan found no shared wall for. Either way there is nothing
 * honest to put in a picture.
 */
function doorOf(d: GeneratedDungeon, c: IRoomConnector, roomIndex: number): ViewDoor | undefined {
  const plan = d.blockplan;
  if (!plan) return undefined;
  if (isSurfaceExit(c)) {
    const s = plan.surface;
    return s && s.room === roomIndex ? { id: c.id, inside: s.from, outside: s.to } : undefined;
  }
  const edge = d.graph.edges.find((e) => e.entityId === c.id);
  if (!edge || (edge.a !== roomIndex && edge.b !== roomIndex)) return undefined;
  const door = plan.doors.find((x) => pairKey(x.a, x.b) === pairKey(edge.a, edge.b));
  if (!door) return undefined;
  return door.a === roomIndex
    ? { id: c.id, inside: door.from, outside: door.to }
    : { id: c.id, inside: door.to, outside: door.from };
}

/**
 * The ways in a viewer could arrive by: every connector touching the room that
 * is not concealed and that the plan drew.
 */
export function plateEntries(d: GeneratedDungeon, roomId: string): string[] {
  const i = d.graph.rooms.findIndex((r) => r.entityId === roomId);
  if (i < 0) return [];
  return d.entities.connectors
    .filter((c) => touches(c, roomId) && c.isHidden !== true)
    .filter((c) => doorOf(d, c, i) !== undefined)
    .map((c) => c.id);
}

/**
 * The room as seen from `entryId`, or undefined when it cannot be drawn: no
 * block plan, an unknown room, or a door the plan does not have.
 */
export function roomPlate(d: GeneratedDungeon, roomId: string, entryId: string): RoomPlate | undefined {
  const i = d.graph.rooms.findIndex((r) => r.entityId === roomId);
  const room = d.entities.rooms.find((r) => r.id === roomId);
  const floor = d.blockplan?.rooms[i];
  if (i < 0 || !room || !floor?.length) return undefined;

  const registry = d.entities.registry;
  const entryConn = d.entities.connectors.find((c) => c.id === entryId);
  const entry = entryConn && doorOf(d, entryConn, i);
  if (!entry) return undefined;

  const exitConns = d.entities.connectors.filter(
    (c) => c.id !== entryId && touches(c, roomId) && c.isHidden !== true
  );
  const exits: PlateSubject[] = [];
  const exitDoors: ViewDoor[] = [];
  for (const c of exitConns) {
    const door = doorOf(d, c, i);
    if (!door) continue;
    exitDoors.push(door);
    exits.push({ id: c.id, name: c.name, base: resolveBase(c, registry) ?? "", surface: isSurfaceExit(c) });
  }

  const subjects: PlateSubject[] = d.entities.features
    .filter((f) => f.roomId === roomId && f.isHidden !== true)
    .map((f) => ({
      id: f.id,
      name: f.name,
      base: resolveBase(f, registry) ?? "",
      kind: f.place?.fixture,
      presence: featurePresence(f.keywords, f.place?.position),
      position: f.place?.position,
    }));
  // A sound has nowhere to be in a picture, so it is not scored, framed or marked.
  const features = subjects.filter((x) => x.presence !== "sense");
  const senses = subjects.filter((x) => x.presence === "sense");
  const cellsOf = new Map(d.entities.features.map((f) => [f.id, f.place?.cells ?? []]));

  const input: PlateViewInput = {
    floor: floor as Point[],
    entry,
    exits: exitDoors,
    features: features.map((f) => ({ id: f.id, cells: cellsOf.get(f.id) ?? [] })),
  };
  const view = plateView(input);
  const stage = plateStage(input, view);

  return {
    roomId,
    roomName: room.name,
    roomBase: resolveBase(room, registry) ?? "",
    entryId,
    entry: {
      id: entryConn.id,
      name: entryConn.name,
      base: resolveBase(entryConn, registry) ?? "",
      surface: isSurfaceExit(entryConn),
    },
    input,
    view,
    exits,
    features,
    senses,
    hotspots: plateHotspots(input, view),
    ...(stage ? { stage } : {}),
  };
}

/**
 * The tag each thing carries in the guide image and the brief: letters for
 * ways out (the way in last), numbers for features. Only things in the picture
 * are tagged — a tag on something the camera cannot see would be a promise the
 * picture cannot keep.
 */
export function plateTags(p: RoomPlate): Map<string, string> {
  const tags = new Map<string, string>();
  const doors = [...p.view.exits, p.view.entry].filter((s) => s.visible);
  doors.forEach((s, i) => tags.set(s.id, String.fromCharCode(65 + i)));
  // Surfaces are drawn over the whole room, not at a spot, so they get no mark.
  p.view.features
    .filter((s, i) => s.visible && p.features[i].presence === "object")
    .forEach((s, i) => tags.set(s.id, String(i + 1)));
  return tags;
}

/** A thing in the picture, with where the camera put it. */
export interface InView {
  subject: PlateSubject;
  /** the guide's tag; surfaces have none */
  tag?: string;
  /** where it is, as words from `plateView` */
  where: string;
  doorway: boolean;
}

/**
 * Everything the chosen camera shows, as the prompt needs it: the viewpoint,
 * the doorways and objects with their tags and positions, and the surfaces.
 *
 * Only what is in the picture. A thing named in a prompt only to say "do not
 * draw this" tends to get drawn, so what the camera cannot see is left out
 * entirely; the page still has a hotspot for it.
 */
export function plateInView(p: RoomPlate): { viewpoint: string; drawn: InView[]; surfaces: InView[] } {
  const v = p.view;
  const tags = plateTags(p);
  const viewpoint =
    `Standing ${v.standing} of the room at eye height, looking ${v.facing}. ` +
    `The floor runs about ${Math.round(v.deep / 5) * 5} ft ahead and ${Math.round(v.wide / 5) * 5} ft across.`;
  const drawn: InView[] = [];
  const surfaces: InView[] = [];
  const doors = [...p.exits.map((x, i) => [x, v.exits[i]] as const), [p.entry, v.entry] as const];
  for (const [x, s] of doors) {
    if (s.visible) drawn.push({ subject: x, tag: tags.get(x.id), where: exitWhere(s), doorway: true });
  }
  p.features.forEach((f, i) => {
    const s = v.features[i];
    if (!s.visible) return;
    if (f.presence === "surface") {
      surfaces.push({ subject: f, where: f.position === "throughout" ? "throughout the room" : featureWhere(s), doorway: false });
    } else drawn.push({ subject: f, tag: tags.get(f.id), where: featureWhere(s), doorway: false });
  });
  return { viewpoint, drawn, surfaces };
}

/**
 * The spatial half of the prompt, as text for reading: what `plateInView`
 * keeps, plus — for the person checking it, never the model — what was left
 * out and why.
 */
export function plateBrief(p: RoomPlate): string {
  const { viewpoint, drawn, surfaces } = plateInView(p);
  const L = [`Viewpoint: ${viewpoint}`];
  const name = (x: InView) =>
    x.subject.surface ? `${x.subject.name} (the way out to daylight)` : x.subject.kind ? `${x.subject.name} (${x.subject.kind})` : x.subject.name;
  if (drawn.length) {
    L.push("", "Must be drawn, each where stated:");
    for (const x of drawn) {
      const came = x.subject.id === p.entryId ? ", the way the viewer came in" : "";
      L.push(`- [${x.tag}] ${x.doorway ? "Doorway or opening — " : ""}${name(x)}${came}: ${x.where}`);
    }
  }
  if (surfaces.length) L.push("", "Over the walls, floor or air of the room (no single spot):", ...surfaces.map((x) => `- ${name(x)}: ${x.where}`));

  const unseen: string[] = [];
  const doors = [...p.exits.map((x, i) => [x, p.view.exits[i]] as const), [p.entry, p.view.entry] as const];
  for (const [x, s] of doors) {
    const why = unseenReason(s);
    if (why) unseen.push(`- ${x.name}${x.id === p.entryId ? " (the way in)" : ""}: ${why}`);
  }
  p.features.forEach((f, i) => {
    const why = unseenReason(p.view.features[i]);
    if (why) unseen.push(`- ${f.name}: ${why}`);
  });
  for (const x of p.senses) unseen.push(`- ${x.name}: heard or smelled, not seen`);
  if (unseen.length) L.push("", "Left out of the prompt:", ...unseen);
  return L.join("\n");
}

/**
 * Which way in a run's plate of `roomId` is drawn from, or undefined when the
 * run has not been there (a plate of an unentered room shows the player that
 * room) or the room cannot be drawn.
 *
 * The door is the one the FIRST arrival was logged with, since the plate sits
 * at that arrival. An arrival logged before `via` was kept falls back to the
 * run's `arrivedVia` while they are still in the room, then to the way out of
 * the dungeon if the room has it, then to the first door the plan drew.
 */
export function plateEntryFor(
  d: GeneratedDungeon,
  run: { log: { kind: string; roomId?: string; via?: string }[]; currentRoomId: string; arrivedVia?: string },
  roomId: string
): string | undefined {
  const first = run.log.find((e) => e.kind === "arrival" && e.roomId === roomId);
  const here = run.currentRoomId === roomId;
  if (!first && !here) return undefined;
  const entries = plateEntries(d, roomId);
  const wanted = first?.via ?? (here ? run.arrivedVia : undefined);
  if (wanted && entries.includes(wanted)) return wanted;
  const surface = d.entities.connectors.find((c) => entries.includes(c.id) && isSurfaceExit(c));
  return surface?.id ?? entries[0];
}

/**
 * The creatures in a room, stood in its plate: who stands where, as the page
 * lays the sprites down. Live — from the run's entities as they stand now — so
 * a creature slain is gone and a pack worn down shows fewer. The plate is the
 * same one the server drew (`plateEntryFor`, `roomPlate`), so the first
 * cluster stands on the floor it kept clear. Empty when the room has no plate
 * or no one in it.
 */
export function roomFigures(
  d: GeneratedDungeon,
  run: Parameters<typeof plateEntryFor>[1] & { entities: { creatures: ICreature[] } },
  roomId: string
): PlateFigure[] {
  const creatures = drawableCreatures(run.entities.creatures, roomId);
  if (!creatures.length) return [];
  const entryId = plateEntryFor(d, run, roomId);
  const p = entryId ? roomPlate(d, roomId, entryId) : undefined;
  return p ? plateFigures(p.input, p.view, roomClusters(creatures)) : [];
}

/**
 * One button on a plate: what it is, and where, as fractions of the plate from
 * its top-left — or, for something out of the picture, which edge it is off.
 *
 * - shown: on the thing, where the guide put its tag.
 * - behind-wall: where the thing would be, walled off.
 * - around: at the corner in the picture to go round, and which way to turn.
 * - edge: off the left, right or bottom of the picture; `along` (0 to 1) orders
 *   the buttons sharing an edge.
 */
export type PlateSpot =
  | { id: string; how: "shown"; x: number; y: number }
  | { id: string; how: "behind-wall"; x: number; y: number }
  | { id: string; how: "around"; x: number; y: number; turn: "left" | "right" }
  | { id: string; how: "edge"; edge: HotspotEdge; along: number };

/**
 * The plate's buttons: every door and every object, in the picture or not.
 * One in the picture sits at each point where the guide put a tag, so a button
 * sits on the thing the image model was told to draw there. Surfaces have
 * none: they are drawn over the room, not at a spot, so there is nowhere to
 * put one and nothing for an arrow to point at.
 */
export function plateSpots(p: RoomPlate): PlateSpot[] {
  const surfaces = new Set(p.features.filter((f) => f.presence !== "object").map((f) => f.id));
  return p.hotspots
    .filter((h) => !surfaces.has(h.id))
    .flatMap((h): PlateSpot[] => {
      switch (h.status) {
        case "shown":
          return h.points.map((q) => ({ id: h.id, how: "shown", x: q.x, y: q.y }));
        case "behind-wall":
          return h.points.map((q) => ({ id: h.id, how: "behind-wall", x: q.x, y: q.y }));
        case "around":
          return h.around ? [{ id: h.id, how: "around", x: h.around.x, y: h.around.y, turn: h.around.turn }] : [];
        case "off-frame":
          return h.edge ? [{ id: h.id, how: "edge", edge: h.edge, along: h.along ?? 0.5 }] : [];
      }
    });
}

/**
 * What the server says about a room's plate. `pending`: somebody's request is
 * drawing it, ask again shortly. `none`: there is not going to be one. A room's
 * ready plate carries its buttons; a cover has none.
 */
export type PlateAnswer =
  | { status: "ready"; url: string; spots?: PlateSpot[] }
  | { status: "pending" }
  | { status: "none" };

/**
 * What a dungeon's cover is drawn from: the opening the player reads, and the
 * way in that brings them to the first room — the place and its entrance as
 * someone approaching would see them.
 *
 * Not the theme: that is about the inside, and in the spike it put ceilings
 * into an outside view. Concealment does not arise; the way in from the surface
 * is never hidden. Undefined for a dungeon with no way in from the surface.
 */
export function coverDescription(d: GeneratedDungeon): string | undefined {
  const entrance = d.stocked.entranceRoomId;
  const way = d.entities.connectors.find((c) => isSurfaceExit(c) && touches(c, entrance));
  if (!way) return undefined;
  const base = resolveBase(way, d.entities.registry) ?? "";
  return [`THE PLACE: ${d.pass.name}`, d.pass.openingProse, "", `THE WAY IN: ${way.name}. ${base}`].join("\n");
}
