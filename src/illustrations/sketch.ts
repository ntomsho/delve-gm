/**
 * A room illustration's GUIDE IMAGE: the composition as plain line work.
 *
 * The same `IllustrationView` the prompt is written from, projected through a pinhole
 * at the chosen eye. It is drawn to be handed to an image model as a reference,
 * and a reference gets copied — so it carries only what should be copied:
 *
 *   - the ARCHITECTURE as line art: floor line, ceiling line, a vertical at each
 *     corner, doorways as outlined openings. No floor grid and no seam every
 *     five feet of wall; the grid is how the room was built, not how it looks.
 *   - each FEATURE as a dashed outline of its footprint on the floor with a
 *     numbered tag, and each doorway with a lettered tag (`illustrationTags`). Never a
 *     solid: a box drawn where the altar goes comes back as a box. The prompt
 *     says what each tag is and that no mark is to be drawn (`ILLUSTRATION_GUIDE_NOTE`, src/illustrations/prompt.ts).
 *
 * `marks: false` draws the architecture alone, for comparing against a model
 * that copies the marks anyway.
 *
 * Nothing the camera cannot see is drawn or tagged. Framework-free, so the dev
 * scripts can call it under plain node. Painter's algorithm, far to near.
 */

import { CELL_FEET } from "../generation/floorplan/geometry.ts";
import {
  connectedCells,
  ILLUSTRATION_ASPECT,
  ILLUSTRATION_DOOR_FT,
  ILLUSTRATION_EYE_FT,
  ILLUSTRATION_HALF_FOV_DEG,
  ILLUSTRATION_WALL_FT,
  illustrationSight,
} from "./view.ts";
import { stageOutline } from "./figures.ts";
import { type Point } from "../generation/floorplan/floorplan.ts";
import { traceOutline } from "../generation/floorplan/map-layout.ts";
import { illustrationTags, type RoomIllustration } from "./room-illustration.ts";

const INK = "#000000";
const PAPER = "#FFFFFF";

/**
 * Tag lettering as strokes, not `<text>`. The guide is rasterised by sharp on
 * the server, and a serverless function has no fonts installed: `<text>` there
 * comes out as empty boxes or nothing. A path needs no font, so the guide is
 * the same on the author's machine and on Vercel.
 *
 * Capitals and digits on a 4 × 6 grid, y down. 0 is slashed so it is not O.
 */
const GLYPHS: Record<string, string> = {
  "0": "M0 0H4V6H0ZM4 0L0 6", "1": "M1 1L2 0V6M1 6H3", "2": "M0 0H4V3H0V6H4", "3": "M0 0H4V6H0M1 3H4",
  "4": "M0 0V3H4M4 0V6", "5": "M4 0H0V3H4V6H0", "6": "M4 0H0V6H4V3H0", "7": "M0 0H4L1 6",
  "8": "M0 0H4V6H0ZM0 3H4", "9": "M4 3H0V0H4V6H0",
  A: "M0 6L2 0L4 6M1 3.5H3", B: "M0 0V6H3L4 5V4L3 3H0M0 0H3L4 1V2L3 3", C: "M4 0H0V6H4",
  D: "M0 0V6H2.5L4 4.5V1.5L2.5 0Z", E: "M4 0H0V6H4M0 3H3", F: "M4 0H0V6M0 3H3", G: "M4 0H0V6H4V3H2",
  H: "M0 0V6M4 0V6M0 3H4", I: "M1 0H3M2 0V6M1 6H3", J: "M4 0V6H0V4", K: "M0 0V6M4 0L0 3.5M1.5 2.5L4 6",
  L: "M0 0V6H4", M: "M0 6V0L2 3L4 0V6", N: "M0 6V0L4 6V0", O: "M0 0H4V6H0Z", P: "M0 6V0H4V3H0",
  Q: "M0 0H4V6H0ZM2.5 4.5L4 6", R: "M0 6V0H4V3H0M2 3L4 6", S: "M4 0H0V3H4V6H0", T: "M0 0H4M2 0V6",
  U: "M0 0V6H4V0", V: "M0 0L2 6L4 0", W: "M0 0L1 6L2 3L3 6L4 0", X: "M0 0L4 6M4 0L0 6",
  Y: "M0 0L2 3L4 0M2 3V6", Z: "M0 0H4L0 6H4",
};

/** `text` centred on (cx, cy), about the size the old 11px bold label was. */
function strokeText(text: string, cx: number, cy: number): string {
  const k = 8 / 6;
  const advance = 4 * k + 2;
  const chars = [...text.toUpperCase()].filter((ch) => GLYPHS[ch]);
  const x0 = cx - (chars.length * advance - 2) / 2;
  const strokes = chars
    .map(
      (ch, i) =>
        `<path d="${GLYPHS[ch]}" transform="translate(${(x0 + i * advance).toFixed(1)} ${(cy - 4).toFixed(1)}) scale(${k.toFixed(3)})" ` +
        `fill="none" stroke="${INK}" stroke-width="${(1.7 / k).toFixed(2)}" stroke-linecap="round" stroke-linejoin="round"/>`
    )
    .join("");
  return `<g data-tag="${text}">${strokes}</g>`;
}

const WALL_FT = ILLUSTRATION_WALL_FT;
const DOOR_FT = ILLUSTRATION_DOOR_FT;
/** Nothing nearer the eye than this is drawn; polygons are cut at it. */
const NEAR_FT = 0.3;
/** How far a footprint outline is drawn inside its cells, so it clears the wall line. */
const FOOTPRINT_INSET_FT = 0.75;
/** Length of the pieces a footprint outline is cut into to test each for sight, in feet. */
const OUTLINE_STEP_FT = 0.25;

interface P3 {
  x: number;
  y: number;
  z: number;
}

export interface SketchOptions {
  /** the height follows from ILLUSTRATION_ASPECT, so the frame is the one the search scored */
  width?: number;
  /** footprints and tags; on by default */
  marks?: boolean;
}

export function illustrationSketchSvg(p: RoomIllustration, opts: SketchOptions = {}): string {
  const W = opts.width ?? 480;
  const H = Math.round(W / ILLUSTRATION_ASPECT);
  const marks = opts.marks ?? true;
  const { eye } = p.view;
  const focal = W / 2 / Math.tan((ILLUSTRATION_HALF_FOV_DEG * Math.PI) / 180);
  const tags = illustrationTags(p);

  /** World feet to camera space: ahead, across, up. */
  const cam = (q: P3) => ({
    a: (q.x - eye.x) * eye.forward.x + (q.y - eye.y) * eye.forward.y,
    c: (q.x - eye.x) * eye.right.x + (q.y - eye.y) * eye.right.y,
    u: q.z - ILLUSTRATION_EYE_FT,
  });
  type C = ReturnType<typeof cam>;
  const screen = (q: C) => ({ x: W / 2 + (q.c / q.a) * focal, y: H / 2 - (q.u / q.a) * focal });
  const fmt = (s: { x: number; y: number }) => `${s.x.toFixed(1)},${s.y.toFixed(1)}`;

  /** Cut a camera-space polygon at the near plane (Sutherland–Hodgman, one plane). */
  const clip = (poly: C[], closed: boolean): C[] => {
    const out: C[] = [];
    const n = closed ? poly.length : poly.length - 1;
    for (let i = 0; i < n; i++) {
      const s = poly[i];
      const e = poly[(i + 1) % poly.length];
      const sIn = s.a >= NEAR_FT;
      const eIn = e.a >= NEAR_FT;
      if (sIn) out.push(s);
      if (sIn !== eIn) {
        const t = (NEAR_FT - s.a) / (e.a - s.a);
        out.push({ a: NEAR_FT, c: s.c + (e.c - s.c) * t, u: s.u + (e.u - s.u) * t });
      }
    }
    if (!closed && poly[n].a >= NEAR_FT) out.push(poly[n]);
    return out;
  };
  const polygon = (pts: P3[], attrs: string): string => {
    const c = clip(pts.map(cam), true);
    return c.length < 3 ? "" : `<polygon points="${c.map(screen).map(fmt).join(" ")}" ${attrs}/>`;
  };
  const line = (a: P3, b: P3, attrs: string): string => {
    const c = clip([cam(a), cam(b)], false);
    return c.length < 2 ? "" : `<polyline points="${c.map(screen).map(fmt).join(" ")}" fill="none" ${attrs}/>`;
  };
  /** An open polyline in the room, cut at the near plane where it passes behind the eye. */
  const line3 = (pts: P3[], attrs: string): string => {
    const runs: C[][] = [[]];
    for (let i = 0; i < pts.length - 1; i++) {
      const seg = clip([cam(pts[i]), cam(pts[i + 1])], false);
      if (seg.length < 2) {
        if (runs[runs.length - 1].length) runs.push([]);
        continue;
      }
      const run = runs[runs.length - 1];
      if (!run.length) run.push(seg[0]);
      run.push(seg[1]);
    }
    return runs
      .filter((r) => r.length > 1)
      .map((r) => `<polyline points="${r.map(screen).map(fmt).join(" ")}" fill="none" ${attrs}/>`)
      .join("");
  };
  const dist = (q: Point) => Math.hypot(q.x - eye.x, q.y - eye.y);
  const at3 = (q: Point, z: number): P3 => ({ x: q.x, y: q.y, z });

  const out: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">`,
    `<rect width="${W}" height="${H}" fill="${PAPER}"/>`,
  ];
  const STROKE = `stroke="${INK}" stroke-width="1.4" stroke-linecap="round"`;

  // WALLS: one face per floor edge with rock beyond it, facing the eye. Drawn
  // as a paper fill with only its floor and ceiling lines, plus a vertical where
  // the wall turns — so a run of faces reads as one wall, not a row of panels.
  const floorKey = new Set(p.input.floor.map((c) => `${c.x},${c.y}`));
  const isFloor = (x: number, y: number) => floorKey.has(`${x},${y}`);
  const visibleDoors = new Set<string>();
  const doorEdges = [...p.input.exits.map((d, i) => [d, p.view.exits[i]] as const), [p.input.entry, p.view.entry] as const];
  for (const [d, s] of doorEdges) {
    if (s.visible) visibleDoors.add(`${d.inside.x},${d.inside.y}>${d.outside.x},${d.outside.y}`);
  }

  interface Face {
    from: Point;
    to: Point;
    d: number;
    cornerFrom: boolean;
    cornerTo: boolean;
    door?: boolean;
  }
  const faces: Face[] = [];
  const STEPS: [number, number][] = [[0, -1], [1, 0], [0, 1], [-1, 0]];
  for (const c of p.input.floor) {
    for (const [dx, dy] of STEPS) {
      if (isFloor(c.x + dx, c.y + dy)) continue;
      const mid = { x: (c.x + 0.5 + dx / 2) * CELL_FEET, y: (c.y + 0.5 + dy / 2) * CELL_FEET };
      // Along the wall, from one end to the other.
      const t = { x: -dy, y: dx };
      const from = { x: mid.x - (t.x * CELL_FEET) / 2, y: mid.y - (t.y * CELL_FEET) / 2 };
      const to = { x: mid.x + (t.x * CELL_FEET) / 2, y: mid.y + (t.y * CELL_FEET) / 2 };
      // Back-face: the wall's room side is toward the cell.
      if ((eye.x - mid.x) * -dx + (eye.y - mid.y) * -dy <= 0) continue;
      // The wall runs on past an end when the next cell along is floor with rock beyond it too.
      const runs = (s: number) => isFloor(c.x + s * t.x, c.y + s * t.y) && !isFloor(c.x + s * t.x + dx, c.y + s * t.y + dy);
      const key = `${c.x},${c.y}>${c.x + dx},${c.y + dy}`;
      faces.push({
        from,
        to,
        d: dist(mid),
        cornerFrom: !runs(-1),
        cornerTo: !runs(1),
        door: visibleDoors.has(key),
      });
    }
  }
  faces.sort((a, b) => b.d - a.d);

  // TAGS go exactly where the page's buttons go: the hotspot points, which
  // are fractions of the frame. One per visible door, one per visible piece of
  // an object; surfaces and senses get none.
  const tagMarks: string[] = [];
  const tag = (q: Point, text: string) => {
    const s = { x: q.x * W, y: q.y * H };
    tagMarks.push(
      `<circle cx="${s.x.toFixed(1)}" cy="${s.y.toFixed(1)}" r="9" fill="${PAPER}" stroke="${INK}" stroke-width="1.2"/>` +
        strokeText(text, s.x, s.y)
    );
  };

  for (const f of faces) {
    out.push(
      polygon([at3(f.from, 0), at3(f.to, 0), at3(f.to, WALL_FT), at3(f.from, WALL_FT)], `fill="${PAPER}" stroke="${PAPER}" stroke-width="0.8"`),
      line(at3(f.from, 0), at3(f.to, 0), STROKE),
      line(at3(f.from, WALL_FT), at3(f.to, WALL_FT), STROKE)
    );
    if (f.cornerFrom) out.push(line(at3(f.from, 0), at3(f.from, WALL_FT), STROKE));
    if (f.cornerTo) out.push(line(at3(f.to, 0), at3(f.to, WALL_FT), STROKE));
    if (f.door) {
      const lerp = (s: number): Point => ({ x: f.from.x + (f.to.x - f.from.x) * s, y: f.from.y + (f.to.y - f.from.y) * s });
      const a = lerp(0.15);
      const b = lerp(0.85);
      out.push(polygon([at3(a, 0), at3(b, 0), at3(b, DOOR_FT), at3(a, DOOR_FT)], `fill="${PAPER}" ${STROKE}`));
    }
  }

  // FEATURES: the dashed outline of each visible OBJECT's footprint, inset from
  // its cells, one outline per connected piece — four niches round the walls are
  // one feature, and a single outline round them would enclose the floor between.
  //
  // Only the parts of an outline the eye can see are drawn. Walls run floor to
  // ceiling, so a mark on the floor is hidden exactly when the line of sight to
  // it in plan crosses rock: the outline is cut into short pieces and each is
  // kept or dropped on that test. No painter's ordering can get this right for
  // an outline that is half round a corner; the test does.
  if (marks) {
    const sees = illustrationSight(p.input, eye);
    p.input.features.forEach((f, i) => {
      if (!p.view.features[i].visible || p.features[i].presence !== "object") return;
      for (const piece of connectedCells(f.cells)) {
        const { outer, holes } = traceOutline(piece);
        for (const ring of [outer, ...holes]) {
          const pts = inset(ring, FOOTPRINT_INSET_FT / CELL_FEET).map((q) => ({ x: q.x * CELL_FEET, y: q.y * CELL_FEET }));
          for (const run of visibleRuns(pts, sees)) {
            out.push(line3(run.map((q) => at3(q, 0.05)), `stroke="${INK}" stroke-width="1.2" stroke-dasharray="5 4"`));
          }
        }
      }
    });
    // THE OPEN FLOOR: the patch kept clear for creatures, dotted so it reads
    // as neither a wall nor a feature's dashes. Only on floor in sight.
    if (p.stage) {
      for (const run of stageOutline(p.input, p.view, p.stage)) {
        out.push(
          line3(
            run.map((q) => at3(q, 0.05)),
            `stroke="${INK}" stroke-width="1.6" stroke-linecap="round" stroke-dasharray="0.1 4"`
          )
        );
      }
    }
    for (const h of p.hotspots) {
      const t = tags.get(h.id);
      if (h.status === "shown" && t) for (const q of h.points) tag(q, t);
    }
  }

  out.push(...tagMarks, "</svg>");
  return out.filter(Boolean).join("\n");
}

/**
 * The stretches of a closed ring, in feet, whose every short piece passes the
 * sight test — as open polylines ready to draw.
 */
function visibleRuns(ring: Point[], sees: (p: Point) => boolean): Point[][] {
  const runs: Point[][] = [];
  let run: Point[] = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / OUTLINE_STEP_FT));
    for (let k = 0; k < steps; k++) {
      const p0 = { x: a.x + ((b.x - a.x) * k) / steps, y: a.y + ((b.y - a.y) * k) / steps };
      const p1 = { x: a.x + ((b.x - a.x) * (k + 1)) / steps, y: a.y + ((b.y - a.y) * (k + 1)) / steps };
      if (sees({ x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 })) {
        if (!run.length) run.push(p0);
        run.push(p1);
      } else if (run.length) {
        runs.push(run);
        run = [];
      }
    }
  }
  if (run.length) runs.push(run);
  return runs;
}

/**
 * A rectilinear ring moved inward by `d` cells. `traceOutline` winds the outer
 * ring clockwise on screen (y down), so the inside is to the right of travel.
 */
function inset(ring: Point[], d: number): Point[] {
  const n = ring.length;
  return ring.map((v, i) => {
    const prev = ring[(i - 1 + n) % n];
    const next = ring[(i + 1) % n];
    const inward = (a: Point, b: Point) => {
      const dx = Math.sign(b.x - a.x);
      const dy = Math.sign(b.y - a.y);
      return { x: -dy, y: dx };
    };
    const n1 = inward(prev, v);
    const n2 = inward(v, next);
    return { x: v.x + (n1.x + n2.x) * d, y: v.y + (n1.y + n2.y) * d };
  });
}
