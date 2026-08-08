/**
 * Planarity — can this graph be drawn on a flat plane with no crossings, and
 * if so, in what order do a room's neighbours sit around it?
 *
 * The dungeon is drawn on one flat plane with nothing overlapping (stairs and
 * shafts are flavour inside the room that names them; nothing in the model has
 * a z). So the floorplan must be a planar embedding of the Phase A graph, and
 * Phase A has to reject the graphs that have no such drawing.
 *
 * The answer is more than a boolean. What comes back is the **rotation
 * system** — each vertex's incident edges in cyclic order around it — which is
 * the embedding itself, and which is what turns placement from a blind search
 * into a guided one: it says which side of a room each neighbour belongs on.
 *
 * Method: Demoucron path addition. Start from a cycle, then repeatedly take a
 * piece of the graph not yet drawn and thread a path of it through a face that
 * can hold all of its attachment points. A piece with no such face means no
 * drawing exists. Faces are kept as *directed* cycles throughout, which is
 * what makes the rotation fall straight out at the end and what keeps every
 * vertex's cyclic order consistently oriented with every other's.
 *
 * Demoucron needs a biconnected graph and the dungeon graph is not one — a
 * sixth of its rooms are dead ends. So the graph is split into blocks first,
 * each block is embedded on its own, and the results are concatenated at the
 * cut vertices. That is legal because a block hanging off a cut vertex can be
 * nested inside any face that touches it, and it is why "two K5s glued at a
 * cut vertex" is in the test set: the split must not lose a non-planarity.
 *
 * Everything here is pure and unseeded. Sizes are tiny (30 rooms, 36 edges),
 * so nothing is optimised.
 */

export type Pair = readonly [number, number];

export interface PlanarityResult {
  planar: boolean;
  /**
   * For each vertex, its incident edges in cyclic order around it — indices
   * into the `edges` array that was handed in. Empty when `planar` is false.
   *
   * Consistently oriented across the whole graph (all clockwise or all
   * counter-clockwise; which one is arbitrary, since a drawing and its mirror
   * are the same drawing). An edge index appears once at each of its two
   * endpoints, or twice at the one endpoint of a self-loop.
   */
  rotation: number[][];
}

const NOT_PLANAR: PlanarityResult = { planar: false, rotation: [] };

/** Simple edge, plus the original edges it stands in for. */
interface SimpleEdge {
  a: number;
  b: number;
  /** indices into the caller's `edges`; more than one means parallel edges */
  originals: number[];
}

export function checkPlanarity(n: number, edges: readonly Pair[]): PlanarityResult {
  // Collapse to a simple graph. Neither parallel edges nor self-loops can make
  // a graph non-planar — a duplicate is drawn alongside its twin, a loop is a
  // small circle — so they are set aside here and slotted back in at the end.
  const index = new Map<string, number>();
  const simple: SimpleEdge[] = [];
  const loops: number[][] = Array.from({ length: n }, () => []);

  edges.forEach(([a, b], i) => {
    if (a === b) {
      loops[a].push(i);
      return;
    }
    const key = a < b ? `${a}:${b}` : `${b}:${a}`;
    let si = index.get(key);
    if (si === undefined) {
      si = simple.length;
      index.set(key, si);
      simple.push({ a, b, originals: [] });
    }
    simple[si].originals.push(i);
  });

  // Per-vertex cyclic order of SIMPLE edge indices, accumulated block by block.
  const perVertex: number[][] = Array.from({ length: n }, () => []);

  for (const block of biconnectedComponents(n, simple)) {
    if (block.length === 1) {
      // A bridge. One edge, no choice about how to draw it.
      const e = simple[block[0]];
      perVertex[e.a].push(block[0]);
      perVertex[e.b].push(block[0]);
      continue;
    }

    // Relabel the block's vertices 0..m-1 so Demoucron works on a dense range.
    const local = new Map<number, number>();
    const global: number[] = [];
    const localOf = (v: number) => {
      let l = local.get(v);
      if (l === undefined) {
        l = global.length;
        local.set(v, l);
        global.push(v);
      }
      return l;
    };
    const be: Pair[] = block.map((si) => [localOf(simple[si].a), localOf(simple[si].b)] as const);

    const faces = demoucron(global.length, be);
    if (!faces) return NOT_PLANAR;

    const rot = rotationFromFaces(global.length, faces, be);
    if (!rot) return NOT_PLANAR;

    // Concatenate this block's order onto whatever earlier blocks contributed.
    // At a cut vertex that is the nesting: each block occupies its own wedge.
    rot.forEach((order, lv) => {
      for (const localEdge of order) perVertex[global[lv]].push(block[localEdge]);
    });
  }

  // Expand simple edges back into the caller's edges. Parallels sit together,
  // and **in opposite order at the two ends** — the sliver of face between two
  // parallel edges is bounded by one of them in each direction, so an
  // orientation that reads e, e' at one end has to read e', e at the other.
  // Getting this backwards produces a rotation that looks right and traces to
  // the wrong face count, which is what the Euler test is for.
  const rotation = perVertex.map((order, v) => {
    const out: number[] = [];
    for (const si of order) {
      const e = simple[si];
      out.push(...(e.a === v ? e.originals : [...e.originals].reverse()));
    }
    for (const li of loops[v]) out.push(li, li);
    return out;
  });

  return { planar: true, rotation };
}

// ---------------------------------------------------------------- blocks

/**
 * Tarjan's biconnected components, as a partition of the edges. Recursive;
 * depth is bounded by the vertex count, which is 30 for a dungeon and small
 * for every graph in the test set.
 */
function biconnectedComponents(n: number, se: SimpleEdge[]): number[][] {
  const adj: number[][] = Array.from({ length: n }, () => []);
  se.forEach((e, i) => {
    adj[e.a].push(i);
    adj[e.b].push(i);
  });

  const disc = new Array<number>(n).fill(-1);
  const low = new Array<number>(n).fill(0);
  const stack: number[] = [];
  const out: number[][] = [];
  let timer = 0;

  const dfs = (u: number, parentEdge: number) => {
    disc[u] = low[u] = timer++;
    for (const ei of adj[u]) {
      if (ei === parentEdge) continue;
      const v = se[ei].a === u ? se[ei].b : se[ei].a;
      if (disc[v] === -1) {
        stack.push(ei);
        dfs(v, ei);
        low[u] = Math.min(low[u], low[v]);
        if (low[v] >= disc[u]) {
          const comp: number[] = [];
          for (;;) {
            const e = stack.pop()!;
            comp.push(e);
            if (e === ei) break;
          }
          out.push(comp);
        }
      } else if (disc[v] < disc[u]) {
        stack.push(ei);
        low[u] = Math.min(low[u], disc[v]);
      }
    }
  };

  for (let v = 0; v < n; v++) if (disc[v] === -1) dfs(v, -1);
  return out;
}

// ---------------------------------------------------------------- demoucron

/** A piece of the graph not yet drawn, and where it touches what has been. */
interface Fragment {
  edges: number[];
  attach: number[];
}

/**
 * Embed a biconnected simple graph of m >= 3 vertices. Returns its faces as
 * directed vertex cycles, consistently oriented, or null if no drawing exists.
 */
function demoucron(m: number, be: Pair[]): number[][] | null {
  const adj: number[][] = Array.from({ length: m }, () => []);
  const edgeAt = new Map<string, number>();
  const key = (u: number, v: number) => (u < v ? `${u}:${v}` : `${v}:${u}`);
  be.forEach(([a, b], i) => {
    adj[a].push(i);
    adj[b].push(i);
    edgeAt.set(key(a, b), i);
  });
  const inH = new Array<boolean>(be.length).fill(false);
  const vH = new Set<number>();

  const cycle = findCycle(m, be, adj);
  if (!cycle) return null; // 2-connected with m >= 3 always has one
  for (let i = 0; i < cycle.length; i++) {
    const u = cycle[i], v = cycle[(i + 1) % cycle.length];
    inH[edgeAt.get(key(u, v))!] = true;
    vH.add(u);
  }
  // The cycle drawn on a plane makes two faces: inside and outside. They are
  // the same cycle walked in opposite directions, which is what sets the
  // orientation convention every later face inherits.
  const faces: number[][] = [cycle, [...cycle].reverse()];

  while (inH.some((x) => !x)) {
    let chosen: { frag: Fragment; face: number[] } | null = null;

    for (const frag of fragments(m, be, adj, inH, vH)) {
      const admissible = faces.filter((f) => {
        const s = new Set(f);
        return frag.attach.every((v) => s.has(v));
      });
      // Nowhere to put this piece: the graph has no flat drawing.
      if (admissible.length === 0) return null;
      if (!chosen) chosen = { frag, face: admissible[0] };
      // A piece with exactly one home has to go there, so take it and stop
      // looking — that is the whole of Demoucron's choice rule.
      if (admissible.length === 1) {
        chosen = { frag, face: admissible[0] };
        break;
      }
    }
    if (!chosen) return null; // edges left but no fragment: unreachable

    const path = fragmentPath(chosen.frag, be, vH);
    if (!path) return null;

    // Thread the path through the face, splitting it in two. Both halves keep
    // the face's direction on the arc they inherit and traverse the new path
    // in opposite directions, which is exactly what an oriented embedding
    // requires of the two faces either side of an edge.
    const f = chosen.face;
    const i = f.indexOf(path[0]);
    const j = f.indexOf(path[path.length - 1]);
    const arc = (from: number, to: number) => {
      const out: number[] = [];
      for (let k = from; ; k = (k + 1) % f.length) {
        out.push(f[k]);
        if (k === to) break;
      }
      return out;
    };
    const interior = path.slice(1, -1);
    const split = [
      [...arc(i, j), ...[...interior].reverse()],
      [...arc(j, i), ...interior],
    ];
    faces.splice(faces.indexOf(f), 1, ...split);

    for (let k = 0; k + 1 < path.length; k++) inH[edgeAt.get(key(path[k], path[k + 1]))!] = true;
    for (const v of interior) vH.add(v);
  }

  return faces;
}

/** A cycle through the graph, as a vertex list. */
function findCycle(m: number, be: Pair[], adj: number[][]): number[] | null {
  const state = new Array<number>(m).fill(0); // 0 unseen, 1 on stack, 2 done
  const parent = new Array<number>(m).fill(-1);
  const path: number[] = [];
  let found: number[] | null = null;

  const dfs = (u: number, parentEdge: number) => {
    if (found) return;
    state[u] = 1;
    path.push(u);
    for (const ei of adj[u]) {
      if (found) return;
      if (ei === parentEdge) continue;
      const v = be[ei][0] === u ? be[ei][1] : be[ei][0];
      if (state[v] === 1) {
        found = path.slice(path.indexOf(v));
        return;
      }
      if (state[v] === 0) {
        parent[v] = u;
        dfs(v, ei);
      }
    }
    state[u] = 2;
    path.pop();
  };

  for (let v = 0; v < m && !found; v++) if (state[v] === 0) dfs(v, -1);
  return found;
}

/**
 * The pieces of the graph not yet drawn: each connected clump of undrawn
 * vertices with the edges reaching it, plus every undrawn edge whose two ends
 * are already drawn (a chord is a piece all by itself).
 */
function fragments(
  m: number,
  be: Pair[],
  adj: number[][],
  inH: boolean[],
  vH: Set<number>,
): Fragment[] {
  const out: Fragment[] = [];

  be.forEach(([a, b], i) => {
    if (!inH[i] && vH.has(a) && vH.has(b)) out.push({ edges: [i], attach: [a, b] });
  });

  const seen = new Set<number>();
  for (let v = 0; v < m; v++) {
    if (vH.has(v) || seen.has(v)) continue;
    const comp: number[] = [v];
    seen.add(v);
    const edgeSet = new Set<number>();
    const attach = new Set<number>();
    for (let h = 0; h < comp.length; h++) {
      for (const ei of adj[comp[h]]) {
        edgeSet.add(ei);
        const w = be[ei][0] === comp[h] ? be[ei][1] : be[ei][0];
        if (vH.has(w)) {
          attach.add(w);
        } else if (!seen.has(w)) {
          seen.add(w);
          comp.push(w);
        }
      }
    }
    out.push({ edges: [...edgeSet], attach: [...attach] });
  }

  return out;
}

/** A path across a fragment from one attachment point to another. */
function fragmentPath(frag: Fragment, be: Pair[], vH: Set<number>): number[] | null {
  if (frag.edges.length === 1 && frag.attach.length === 2) {
    return [frag.attach[0], frag.attach[1]];
  }

  const start = frag.attach[0];
  const inFrag = new Set(frag.edges);
  const adj = new Map<number, number[]>();
  for (const ei of frag.edges) {
    for (const v of [be[ei][0], be[ei][1]]) {
      if (!adj.has(v)) adj.set(v, []);
      adj.get(v)!.push(ei);
    }
  }

  const prev = new Map<number, number>();
  const queue = [start];
  const seen = new Set([start]);
  for (let h = 0; h < queue.length; h++) {
    const u = queue[h];
    for (const ei of adj.get(u) ?? []) {
      if (!inFrag.has(ei)) continue;
      const v = be[ei][0] === u ? be[ei][1] : be[ei][0];
      if (seen.has(v)) continue;
      seen.add(v);
      prev.set(v, u);
      if (vH.has(v)) {
        const path = [v];
        for (let w = u; w !== start; w = prev.get(w)!) path.push(w);
        path.push(start);
        return path.reverse();
      }
      queue.push(v);
    }
  }
  return null;
}

// ---------------------------------------------------------------- rotation

/**
 * Read the rotation off the faces. Every corner of a face — arrive at v from
 * u, leave towards w — says that w follows u around v. Collected over all
 * faces those corners form one permutation per vertex, and walking it gives
 * the cyclic order. Anything other than a single cycle means the faces were
 * not a proper embedding, which is a bug rather than a non-planar graph, but
 * it is refused rather than trusted.
 */
function rotationFromFaces(m: number, faces: number[][], be: Pair[]): number[][] | null {
  const next: Array<Map<number, number>> = Array.from({ length: m }, () => new Map());
  for (const f of faces) {
    for (let i = 0; i < f.length; i++) {
      const from = f[(i - 1 + f.length) % f.length];
      const v = f[i];
      const to = f[(i + 1) % f.length];
      next[v].set(from, to);
    }
  }

  const edgeAt = new Map<string, number>();
  be.forEach(([a, b], i) => edgeAt.set(a < b ? `${a}:${b}` : `${b}:${a}`, i));

  const out: number[][] = [];
  for (let v = 0; v < m; v++) {
    const step = next[v];
    if (step.size === 0) {
      out.push([]);
      continue;
    }
    const start: number = step.keys().next().value!;
    const order = [start];
    for (let cur = step.get(start)!; cur !== start; cur = step.get(cur)!) {
      if (cur === undefined) return null;
      order.push(cur);
      if (order.length > step.size) return null;
    }
    if (order.length !== step.size) return null;
    out.push(order.map((u) => edgeAt.get(u < v ? `${u}:${v}` : `${v}:${u}`)!));
  }
  return out;
}
