/**
 * The CLI behind `dev/cli-illustration-views.ts`, which teaches Node `?raw` first and then
 * imports this. Usage is in that file.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  exitWhere,
  featureWhere,
  ILLUSTRATION_HALF_FOV_DEG,
  unseenReason,
} from "../../illustrations/view.ts";
import { touches } from "../../shared/world/entities.ts";
import type { Point } from "../../shared/utils/grid.ts";
import type { Size } from "../../generation/content/blueprint.ts";
import { generateOffline } from "../../fixtures/offline.ts";
import type { GeneratedDungeon } from "../../generation/generate.ts";
import { traceOutline } from "../../generation/floorplan/map-layout.ts";
import { illustrationSketchSvg } from "../../illustrations/sketch.ts";
import { hotspotMarks } from "./illustration-overlay.ts";
import { illustrationBrief, illustrationEntries, illustrationTags, roomIllustration, type RoomIllustration } from "../../illustrations/room-illustration.ts";

interface Args {
  dungeon?: string;
  seed: number;
  size: Size;
  out?: string;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { seed: 1005, size: 1 };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const next = () => argv[++i];
    if (flag === "--dungeon") a.dungeon = next();
    else if (flag === "--seed") a.seed = Number(next());
    else if (flag === "--size") a.size = Number(next()) as Size;
    else if (flag === "--out") a.out = next();
    else if (flag === "--offline") continue; // the default; accepted so it can be said
    else throw new Error(`unknown flag ${flag}`);
  }
  return a;
}

const INK = "#22201C";
const PAPER = "#F6F2E8";
const FAINT = "#B9B1A2";
const TORCH = "#B4521E";
const HIDDEN = "#9A9A9A";
const CELL_PX = 26;

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The room from above, north up, with the eye and its field of view on it. */
function topDownSvg(d: GeneratedDungeon, p: RoomIllustration): string {
  const tags = illustrationTags(p);
  const tagOf = (id: string) => tags.get(id) ?? "–";
  const floor = p.input.floor;
  const all = [...floor, p.input.entry.outside, ...p.input.exits.map((x) => x.outside)];
  const minX = Math.min(...all.map((c) => c.x));
  const minY = Math.min(...all.map((c) => c.y));
  const maxX = Math.max(...all.map((c) => c.x));
  const maxY = Math.max(...all.map((c) => c.y));
  const pad = 14;
  const W = (maxX - minX + 1) * CELL_PX + pad * 2;
  const H = (maxY - minY + 1) * CELL_PX + pad * 2;
  /** grid units (cells, fractional) to pixels */
  const at = (x: number, y: number) => ({ x: pad + (x - minX) * CELL_PX, y: pad + (y - minY) * CELL_PX });
  const mid = (c: Point) => at(c.x + 0.5, c.y + 0.5);
  /** feet to pixels */
  const atFt = (q: Point) => at(q.x / 5, q.y / 5);

  const out: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">`,
    `<rect width="${W}" height="${H}" fill="#EDE7DA"/>`,
  ];
  for (const c of floor) {
    const o = at(c.x, c.y);
    out.push(`<rect x="${o.x}" y="${o.y}" width="${CELL_PX}" height="${CELL_PX}" fill="${PAPER}" stroke="#E2DBCB" stroke-width="0.6"/>`);
  }
  const { outer, holes } = traceOutline(floor);
  const ring = (pts: Point[]) => `M ${pts.map((q) => { const s = at(q.x, q.y); return `${s.x} ${s.y}`; }).join(" L ")} Z`;
  out.push(`<path d="${[outer, ...holes].map(ring).join(" ")}" fill="none" stroke="${INK}" stroke-width="1.6" fill-rule="evenodd"/>`);

  // Field of view: two rays from the eye at the half-angle, out to the far wall.
  const { eye, deep } = p.view;
  const reach = Math.max(deep, 10) * 1.1;
  const ray = (sign: number) => {
    const t = (ILLUSTRATION_HALF_FOV_DEG * Math.PI) / 180;
    const fx = eye.forward.x * Math.cos(t) + sign * eye.right.x * Math.sin(t);
    const fy = eye.forward.y * Math.cos(t) + sign * eye.right.y * Math.sin(t);
    return atFt({ x: eye.x + fx * reach, y: eye.y + fy * reach });
  };
  const e = atFt(eye);
  const l = ray(-1);
  const r = ray(1);
  out.push(`<polygon points="${e.x},${e.y} ${l.x},${l.y} ${r.x},${r.y}" fill="${TORCH}" fill-opacity="0.08" stroke="${TORCH}" stroke-width="0.8" stroke-dasharray="4 3"/>`);

  const doorMark = (inside: Point, outside: Point, colour: string, text?: string) => {
    const a = mid(inside);
    const b = mid(outside);
    const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const vertical = inside.x !== outside.x;
    const len = CELL_PX * 0.75;
    const rect = vertical
      ? `x="${m.x - 3}" y="${m.y - len / 2}" width="6" height="${len}"`
      : `x="${m.x - len / 2}" y="${m.y - 3}" width="${len}" height="6"`;
    out.push(`<rect ${rect} fill="${colour}" stroke="${INK}" stroke-width="0.8"/>`);
    if (text) {
      const lx = m.x + (b.x - a.x) * 0.45;
      const ly = m.y + (b.y - a.y) * 0.45 + 4;
      out.push(`<text x="${lx}" y="${ly}" font-size="11" font-weight="700" font-family="sans-serif" text-anchor="middle" fill="${colour === "#FFFFFF" ? INK : colour}">${text}</text>`);
    }
  };

  doorMark(p.input.entry.inside, p.input.entry.outside, TORCH, `in ${tags.get(p.entryId) ?? ""}`.trim());
  p.input.exits.forEach((x) => doorMark(x.inside, x.outside, "#FFFFFF", tagOf(x.id)));

  // Concealed ways, grey: the filter should have kept them out of everything else.
  const roomIndex = d.graph.rooms.findIndex((rm) => rm.entityId === p.roomId);
  for (const c of d.entities.connectors.filter((x) => touches(x, p.roomId) && x.isHidden === true)) {
    const edge = d.graph.edges.find((g) => g.entityId === c.id);
    const door = edge && d.blockplan?.doors.find((x) => (x.a === edge.a && x.b === edge.b) || (x.a === edge.b && x.b === edge.a));
    if (!door) continue;
    const [inside, outside] = door.a === roomIndex ? [door.from, door.to] : [door.to, door.from];
    doorMark(inside, outside, HIDDEN, "secret");
  }

  p.input.features.forEach((f, i) => {
    // Every cell labelled: a row of coffins is one feature, and an unlabelled
    // dot cannot be matched to the list.
    for (const c of f.cells) {
      const m = mid(c);
      out.push(`<circle cx="${m.x}" cy="${m.y}" r="${CELL_PX / 5}" fill="${INK}"/>`);
      out.push(`<text x="${m.x}" y="${m.y - CELL_PX / 4}" font-size="10" font-weight="700" font-family="sans-serif" text-anchor="middle" fill="${INK}" stroke="${PAPER}" stroke-width="2.5" paint-order="stroke">${tagOf(f.id)}</text>`);
    }
  });
  for (const f of d.entities.features.filter((x) => x.roomId === p.roomId && x.isHidden === true)) {
    for (const c of f.place?.cells ?? []) {
      const m = mid(c);
      out.push(`<circle cx="${m.x}" cy="${m.y}" r="${CELL_PX / 5}" fill="none" stroke="${HIDDEN}" stroke-width="1.2"/>`);
    }
  }

  out.push(`<circle cx="${e.x}" cy="${e.y}" r="4" fill="${TORCH}"/>`);
  out.push(`<text x="${W - 6}" y="12" font-size="10" font-family="sans-serif" text-anchor="end" fill="${FAINT}">N ↑</text>`);
  out.push("</svg>");
  return out.join("\n");
}

/** The page's buttons over the unmarked guide: what the final image would carry. */
function hotspotSvg(p: RoomIllustration, width = 480): string {
  const H = Math.round(width / 1.5);
  return illustrationSketchSvg(p, { marks: false, width }).replace("</svg>", hotspotMarks(p, width, H) + "\n</svg>");
}

function row(d: GeneratedDungeon, p: RoomIllustration, entryName: string): string {
  const tags = illustrationTags(p);
  const tagOf = (id: string) => tags.get(id) ?? "–";
  const things: string[] = [];
  p.exits.forEach((x, i) => {
    const s = p.view.exits[i];
    const why = unseenReason(s);
    things.push(
      `<li${why ? ' class="unseen"' : ""}><b>${tagOf(x.id)}</b> ${esc(x.name)}${x.surface ? " <i>(way out)</i>" : ""} — ` +
        `${esc(why ?? exitWhere(s))}</li>`
    );
  });
  {
    const why = unseenReason(p.view.entry);
    things.push(
      `<li${why ? ' class="unseen"' : ""}><b>${tagOf(p.entryId)}</b> ${esc(p.entry.name || "the way in")} <i>(way in)</i> — ` +
        `${esc(why ?? exitWhere(p.view.entry))}</li>`
    );
  }
  p.features.forEach((f, i) => {
    const s = p.view.features[i];
    const why = unseenReason(s);
    things.push(
      `<li${why ? ' class="unseen"' : ""}><b>${tagOf(f.id)}</b> ${esc(f.name)}${f.kind ? ` <i>(${f.kind})</i>` : ""}${f.presence === "surface" ? " <i>[surface]</i>" : ""} — ` +
        `${esc(why ?? featureWhere(s))}${s.placed ? "" : " <b>[no footprint]</b>"}</li>`
    );
  });
  for (const x of p.senses) things.push(`<li class="unseen"><b>–</b> ${esc(x.name)} <i>[sound or smell: not drawn]</i></li>`);
  const hiddenCount =
    d.entities.features.filter((x) => x.roomId === p.roomId && x.isHidden === true).length +
    d.entities.connectors.filter((x) => touches(x, p.roomId) && x.isHidden === true).length;

  return `
<section>
  <h2>${esc(p.roomName)} <small>entered by ${esc(entryName)} · standing ${p.view.standing}, facing ${p.view.facing}, score ${p.view.score}${hiddenCount ? ` · ${hiddenCount} hidden, excluded` : ""}</small></h2>
  <div class="grid">
    <figure>${topDownSvg(d, p)}<figcaption>From above, north up</figcaption></figure>
    <figure>${illustrationSketchSvg(p)}<figcaption>Guide image, with marks</figcaption></figure>
    <figure>${hotspotSvg(p)}<figcaption>Buttons, on the guide without marks</figcaption></figure>
    <div class="text">
      <ul>${things.join("")}</ul>
      <details><summary>Brief</summary><pre>${esc(illustrationBrief(p))}</pre></details>
      <details><summary>Room prose</summary><p>${esc(p.roomBase)}</p>
        ${[...p.exits.map((x) => [tagOf(x.id), x] as const), [`${tagOf(p.entryId)} (way in)`, p.entry] as const, ...p.features.map((f) => [tagOf(f.id), f] as const)]
          .map(([k, x]) => `<p><b>${k}</b> ${esc(x.base)}</p>`)
          .join("")}
      </details>
    </div>
  </div>
</section>`;
}

const pct = ([yes, no]: number[]) => `${yes}/${yes + no} (${Math.round((100 * yes) / Math.max(1, yes + no))}%)`;

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const d: GeneratedDungeon = args.dungeon
    ? (JSON.parse(readFileSync(resolve(args.dungeon), "utf8")) as GeneratedDungeon)
    : generateOffline(args.seed, args.size);
  if (!d.blockplan) throw new Error("this dungeon has no block plan; there is no floor to look at");

  const rows: string[] = [];
  let count = 0;
  /** [drawable, not] across every view */
  const tally = { exits: [0, 0], features: [0, 0] };
  for (const gr of d.graph.rooms) {
    for (const entryId of illustrationEntries(d, gr.entityId)) {
      const p = roomIllustration(d, gr.entityId, entryId);
      if (!p) continue;
      const conn = d.entities.connectors.find((c) => c.id === entryId)!;
      const name = conn.name || "an unnamed door";
      rows.push(row(d, p, conn.endpointB === null ? `${name} (from outside)` : name));
      count++;
      for (const s of p.view.exits) tally.exits[unseenReason(s) ? 1 : 0]++;
      for (const s of p.view.features) tally.features[unseenReason(s) ? 1 : 0]++;
    }
  }

  const title = `${d.pass.name} — illustration compositions`;
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
  body { font: 14px/1.45 Georgia, serif; background: ${PAPER}; color: ${INK}; margin: 24px; }
  h1 { font-size: 22px; } h2 { font-size: 17px; margin: 28px 0 8px; } h2 small { font-weight: normal; color: #6b655a; font-size: 13px; }
  .grid { display: grid; grid-template-columns: auto auto auto minmax(260px, 1fr); gap: 16px; align-items: start; }
  figure { margin: 0; } figcaption { font-size: 12px; color: #6b655a; }
  svg { display: block; border: 1px solid #d6cfbf; max-width: 100%; height: auto; }
  ul { padding-left: 18px; margin: 0 0 8px; } li.unseen { color: #8a8478; }
  pre { white-space: pre-wrap; font-size: 12px; background: #fff; padding: 8px; border: 1px solid #e0d9c9; }
  details p { font-size: 13px; margin: 6px 0; }
  section { border-top: 1px solid #d6cfbf; }
</style></head><body>
<h1>${esc(title)}</h1>
<p>Seed ${d.seeds.dungeonSeed} · size ${d.size} · ${count} views. Orange dot and wedge: the eye and its ${ILLUSTRATION_HALF_FOV_DEG * 2}° field of view. Orange door: the way in. Grey: hidden, kept out of the brief.</p>
<p><b>In the picture:</b> ${pct(tally.features)} of features, ${pct(tally.exits)} of other exits, across all views.</p>
${rows.join("\n")}
</body></html>`;

  const outPath = resolve(args.out ?? `out/illustrations/views-${args.dungeon ? d.id : `offline-${args.seed}-s${args.size}`}.html`);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, html);
  console.error(`[illustrations] ${count} views of ${d.graph.rooms.length} rooms -> ${outPath}`);
}

main();
