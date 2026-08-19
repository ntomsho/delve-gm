import { Hono } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { createMiddleware } from "hono/factory";
import { z } from "zod";
import { createStore } from "zustand/vanilla";
import { createHash } from "node:crypto";
import postgres from "postgres";
//#region src/server/auth.ts
/**
* WHO IS ASKING
* =============
*
* One middleware, one job: turn an `Authorization: Bearer <jwt>` header into a
* user id on the context, or refuse the request. Nothing below this file reads a
* header, and nothing above it trusts anything the client said about itself.
*
* THE TOKEN IS VERIFIED LOCALLY, NOT ASKED ABOUT. Supabase offers
* `GET /auth/v1/user` for this, which is a network round trip on every single
* request — on a turn that is fine and on the twelve parallel chunk requests of
* a size-5 generation it is twelve. The project signs with ASYMMETRIC ES256
* keys, so verification is a signature check against the public JWKS and needs
* no secret at all: there is no `SUPABASE_JWT_SECRET` to leak, rotate, or
* forget to set in an environment.
*
* `createRemoteJWKSet` caches the key set and refetches only when it sees a
* `kid` it does not know, which is what makes key rotation a non-event. The set
* is module state, deliberately, for the same reason the pool in `db.ts` is: it
* holds no per-user state, and one per request would spend a fetch on every
* turn.
*
* WHAT A FAILURE LOOKS LIKE. Every rejection is a bare 401 with the same short
* message. A caller learns that it is not signed in and nothing else — not
* whether the token was expired rather than forged, not whether the user exists.
* That is also why ownership lives in the WHERE clause in `repo.ts` and a
* stranger's run is a 404: the API does not confirm the existence of things you
* may not have.
*
* Node only.
*/
var jwks;
/**
* Where the public keys live.
*
* Derived from the project URL rather than named separately: they are the same
* project and two environment variables that must agree is one that can
* disagree.
*/
function keySet() {
	if (jwks) return jwks;
	const url = process.env.SUPABASE_URL;
	if (!url) throw new Error("SUPABASE_URL is not set, so no token can be verified. It is the project URL from the Supabase dashboard (Project Settings → API).");
	return jwks = createRemoteJWKSet(new URL(`${url.replace(/\/$/, "")}/auth/v1/.well-known/jwks.json`));
}
/**
* Verify a bearer token and hand back who it belongs to.
*
* Exported so tests can exercise verification without standing up an app, and
* so the failure is one function rather than one per caller.
*/
async function verifyToken(token) {
	const { payload } = await jwtVerify(token, keySet(), { audience: "authenticated" });
	if (typeof payload.sub !== "string" || payload.sub === "") throw new Error("token carries no subject");
	return { id: payload.sub };
}
var UNAUTHORIZED = "sign in first";
/**
* The gate. Everything under `/api` except `/api/health` goes through it.
*
* `health` is exempt because it is what the Vercel cron hits twice a week to
* keep Supabase from pausing the project (CODING-PLAN §7.8), and a cron has no
* account. It reads nothing and writes nothing.
*/
var requireUser = createMiddleware(async (c, next) => {
	const header = c.req.header("authorization") ?? "";
	const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
	if (token === "") throw new HTTPException(401, { message: UNAUTHORIZED });
	let user;
	try {
		user = await verifyToken(token);
	} catch {
		throw new HTTPException(401, { message: UNAUTHORIZED });
	}
	c.set("user", user);
	await next();
});
/**
* The current user, for a handler that has been through `requireUser`.
*
* A getter rather than `c.get("user")` at each site so that the one place which
* would break if the middleware were ever detached is this function, and it
* says so out loud rather than handing a handler `undefined` to write into an
* `owner_id` column.
*/
function currentUser(c) {
	const user = c.get("user");
	if (!user) throw new Error("no user on the context — is `requireUser` mounted on this route?");
	return user;
}
//#endregion
//#region src/engine/dungeon-planarity.ts
var NOT_PLANAR = {
	planar: false,
	rotation: []
};
function checkPlanarity(n, edges) {
	const index = /* @__PURE__ */ new Map();
	const simple = [];
	const loops = Array.from({ length: n }, () => []);
	edges.forEach(([a, b], i) => {
		if (a === b) {
			loops[a].push(i);
			return;
		}
		const key = a < b ? `${a}:${b}` : `${b}:${a}`;
		let si = index.get(key);
		if (si === void 0) {
			si = simple.length;
			index.set(key, si);
			simple.push({
				a,
				b,
				originals: []
			});
		}
		simple[si].originals.push(i);
	});
	const perVertex = Array.from({ length: n }, () => []);
	for (const block of biconnectedComponents(n, simple)) {
		if (block.length === 1) {
			const e = simple[block[0]];
			perVertex[e.a].push(block[0]);
			perVertex[e.b].push(block[0]);
			continue;
		}
		const local = /* @__PURE__ */ new Map();
		const global = [];
		const localOf = (v) => {
			let l = local.get(v);
			if (l === void 0) {
				l = global.length;
				local.set(v, l);
				global.push(v);
			}
			return l;
		};
		const be = block.map((si) => [localOf(simple[si].a), localOf(simple[si].b)]);
		const faces = demoucron(global.length, be);
		if (!faces) return NOT_PLANAR;
		const rot = rotationFromFaces(global.length, faces, be);
		if (!rot) return NOT_PLANAR;
		rot.forEach((order, lv) => {
			for (const localEdge of order) perVertex[global[lv]].push(block[localEdge]);
		});
	}
	return {
		planar: true,
		rotation: perVertex.map((order, v) => {
			const out = [];
			for (const si of order) {
				const e = simple[si];
				out.push(...e.a === v ? e.originals : [...e.originals].reverse());
			}
			for (const li of loops[v]) out.push(li, li);
			return out;
		})
	};
}
/**
* Tarjan's biconnected components, as a partition of the edges. Recursive;
* depth is bounded by the vertex count, which is 30 for a dungeon and small
* for every graph in the test set.
*/
function biconnectedComponents(n, se) {
	const adj = Array.from({ length: n }, () => []);
	se.forEach((e, i) => {
		adj[e.a].push(i);
		adj[e.b].push(i);
	});
	const disc = new Array(n).fill(-1);
	const low = new Array(n).fill(0);
	const stack = [];
	const out = [];
	let timer = 0;
	const dfs = (u, parentEdge) => {
		disc[u] = low[u] = timer++;
		for (const ei of adj[u]) {
			if (ei === parentEdge) continue;
			const v = se[ei].a === u ? se[ei].b : se[ei].a;
			if (disc[v] === -1) {
				stack.push(ei);
				dfs(v, ei);
				low[u] = Math.min(low[u], low[v]);
				if (low[v] >= disc[u]) {
					const comp = [];
					for (;;) {
						const e = stack.pop();
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
/**
* Embed a biconnected simple graph of m >= 3 vertices. Returns its faces as
* directed vertex cycles, consistently oriented, or null if no drawing exists.
*/
function demoucron(m, be) {
	const adj = Array.from({ length: m }, () => []);
	const edgeAt = /* @__PURE__ */ new Map();
	const key = (u, v) => u < v ? `${u}:${v}` : `${v}:${u}`;
	be.forEach(([a, b], i) => {
		adj[a].push(i);
		adj[b].push(i);
		edgeAt.set(key(a, b), i);
	});
	const inH = new Array(be.length).fill(false);
	const vH = /* @__PURE__ */ new Set();
	const cycle = findCycle(m, be, adj);
	if (!cycle) return null;
	for (let i = 0; i < cycle.length; i++) {
		const u = cycle[i], v = cycle[(i + 1) % cycle.length];
		inH[edgeAt.get(key(u, v))] = true;
		vH.add(u);
	}
	const faces = [cycle, [...cycle].reverse()];
	while (inH.some((x) => !x)) {
		let chosen = null;
		for (const frag of fragments(m, be, adj, inH, vH)) {
			const admissible = faces.filter((f) => {
				const s = new Set(f);
				return frag.attach.every((v) => s.has(v));
			});
			if (admissible.length === 0) return null;
			if (!chosen) chosen = {
				frag,
				face: admissible[0]
			};
			if (admissible.length === 1) {
				chosen = {
					frag,
					face: admissible[0]
				};
				break;
			}
		}
		if (!chosen) return null;
		const path = fragmentPath(chosen.frag, be, vH);
		if (!path) return null;
		const f = chosen.face;
		const i = f.indexOf(path[0]);
		const j = f.indexOf(path[path.length - 1]);
		const arc = (from, to) => {
			const out = [];
			for (let k = from;; k = (k + 1) % f.length) {
				out.push(f[k]);
				if (k === to) break;
			}
			return out;
		};
		const interior = path.slice(1, -1);
		const split = [[...arc(i, j), ...[...interior].reverse()], [...arc(j, i), ...interior]];
		faces.splice(faces.indexOf(f), 1, ...split);
		for (let k = 0; k + 1 < path.length; k++) inH[edgeAt.get(key(path[k], path[k + 1]))] = true;
		for (const v of interior) vH.add(v);
	}
	return faces;
}
/** A cycle through the graph, as a vertex list. */
function findCycle(m, be, adj) {
	const state = new Array(m).fill(0);
	const parent = new Array(m).fill(-1);
	const path = [];
	let found = null;
	const dfs = (u, parentEdge) => {
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
function fragments(m, be, adj, inH, vH) {
	const out = [];
	be.forEach(([a, b], i) => {
		if (!inH[i] && vH.has(a) && vH.has(b)) out.push({
			edges: [i],
			attach: [a, b]
		});
	});
	const seen = /* @__PURE__ */ new Set();
	for (let v = 0; v < m; v++) {
		if (vH.has(v) || seen.has(v)) continue;
		const comp = [v];
		seen.add(v);
		const edgeSet = /* @__PURE__ */ new Set();
		const attach = /* @__PURE__ */ new Set();
		for (let h = 0; h < comp.length; h++) for (const ei of adj[comp[h]]) {
			edgeSet.add(ei);
			const w = be[ei][0] === comp[h] ? be[ei][1] : be[ei][0];
			if (vH.has(w)) attach.add(w);
			else if (!seen.has(w)) {
				seen.add(w);
				comp.push(w);
			}
		}
		out.push({
			edges: [...edgeSet],
			attach: [...attach]
		});
	}
	return out;
}
/** A path across a fragment from one attachment point to another. */
function fragmentPath(frag, be, vH) {
	if (frag.edges.length === 1 && frag.attach.length === 2) return [frag.attach[0], frag.attach[1]];
	const start = frag.attach[0];
	const inFrag = new Set(frag.edges);
	const adj = /* @__PURE__ */ new Map();
	for (const ei of frag.edges) for (const v of [be[ei][0], be[ei][1]]) {
		if (!adj.has(v)) adj.set(v, []);
		adj.get(v).push(ei);
	}
	const prev = /* @__PURE__ */ new Map();
	const queue = [start];
	const seen = /* @__PURE__ */ new Set([start]);
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
				for (let w = u; w !== start; w = prev.get(w)) path.push(w);
				path.push(start);
				return path.reverse();
			}
			queue.push(v);
		}
	}
	return null;
}
/**
* Read the rotation off the faces. Every corner of a face — arrive at v from
* u, leave towards w — says that w follows u around v. Collected over all
* faces those corners form one permutation per vertex, and walking it gives
* the cyclic order. Anything other than a single cycle means the faces were
* not a proper embedding, which is a bug rather than a non-planar graph, but
* it is refused rather than trusted.
*/
function rotationFromFaces(m, faces, be) {
	const next = Array.from({ length: m }, () => /* @__PURE__ */ new Map());
	for (const f of faces) for (let i = 0; i < f.length; i++) {
		const from = f[(i - 1 + f.length) % f.length];
		const v = f[i];
		const to = f[(i + 1) % f.length];
		next[v].set(from, to);
	}
	const edgeAt = /* @__PURE__ */ new Map();
	be.forEach(([a, b], i) => edgeAt.set(a < b ? `${a}:${b}` : `${b}:${a}`, i));
	const out = [];
	for (let v = 0; v < m; v++) {
		const step = next[v];
		if (step.size === 0) {
			out.push([]);
			continue;
		}
		const start = step.keys().next().value;
		const order = [start];
		for (let cur = step.get(start); cur !== start; cur = step.get(cur)) {
			if (cur === void 0) return null;
			order.push(cur);
			if (order.length > step.size) return null;
		}
		if (order.length !== step.size) return null;
		out.push(order.map((u) => edgeAt.get(u < v ? `${u}:${v}` : `${v}:${u}`)));
	}
	return out;
}
//#endregion
//#region src/engine/dungeon-phase-a.ts
/**
* Entity id. Deliberately NOT drawn from the seeded rng — ids are identity,
* not content, so they're fresh on every run and consume no seed draws.
*/
function makeEntityId() {
	const c = globalThis.crypto;
	if (c?.randomUUID) return c.randomUUID();
	return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (ch) => {
		const r = Math.random() * 16 | 0;
		return (ch === "x" ? r : r & 3 | 8).toString(16);
	});
}
function makeRng(seed) {
	let h = 1779033703 ^ seed.length;
	for (let i = 0; i < seed.length; i++) {
		h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
		h = h << 13 | h >>> 19;
	}
	let a = h >>> 0;
	return () => {
		a = a + 1831565813 | 0;
		let t = Math.imul(a ^ a >>> 15, 1 | a);
		t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
		return ((t ^ t >>> 14) >>> 0) / 4294967296;
	};
}
var pick = (rng, xs) => xs[Math.floor(rng() * xs.length)];
function weightedPick(rng, xs, weights) {
	const total = weights.reduce((s, w) => s + w, 0);
	let r = rng() * total;
	for (let i = 0; i < xs.length; i++) {
		r -= weights[i];
		if (r <= 0) return xs[i];
	}
	return xs[xs.length - 1];
}
function shuffle(rng, xs) {
	const out = xs.slice();
	for (let i = out.length - 1; i > 0; i--) {
		const j = Math.floor(rng() * (i + 1));
		[out[i], out[j]] = [out[j], out[i]];
	}
	return out;
}
function adjacency(n, edges) {
	const adj = Array.from({ length: n }, () => []);
	edges.forEach((e, i) => {
		adj[e.a].push(i);
		adj[e.b].push(i);
	});
	return adj;
}
var other = (e, v) => e.a === v ? e.b : e.a;
/**
* Tarjan, restricted to `allowed` vertices. Parent tracked by EDGE INDEX so
* parallel edges are handled correctly (matters for the C=2 double link).
*/
function findBridgesAndArticulations(n, edges, allowed) {
	const ok = (v) => !allowed || allowed.has(v);
	const adj = adjacency(n, edges);
	const disc = new Array(n).fill(-1);
	const low = new Array(n).fill(0);
	const bridges = [];
	const arts = /* @__PURE__ */ new Set();
	let timer = 0;
	const dfs = (u, parentEdge) => {
		disc[u] = low[u] = timer++;
		let children = 0;
		for (const ei of adj[u]) {
			if (ei === parentEdge) continue;
			const v = other(edges[ei], u);
			if (!ok(v)) continue;
			if (disc[v] !== -1) low[u] = Math.min(low[u], disc[v]);
			else {
				children++;
				dfs(v, ei);
				low[u] = Math.min(low[u], low[v]);
				if (low[v] > disc[u]) bridges.push(ei);
				if (parentEdge !== -1 && low[v] >= disc[u]) arts.add(u);
			}
		}
		if (parentEdge === -1 && children > 1) arts.add(u);
	};
	for (let v = 0; v < n; v++) if (ok(v) && disc[v] === -1) dfs(v, -1);
	return {
		bridges,
		articulations: [...arts]
	};
}
/** Iteratively strip degree-1 vertices. What remains is the 2-core. */
function twoCore(n, edges) {
	const deg = new Array(n).fill(0);
	for (const e of edges) {
		deg[e.a]++;
		deg[e.b]++;
	}
	const alive = new Set(Array.from({ length: n }, (_, i) => i));
	const adj = adjacency(n, edges);
	let changed = true;
	while (changed) {
		changed = false;
		for (const v of [...alive]) {
			if (deg[v] > 1) continue;
			alive.delete(v);
			changed = true;
			for (const ei of adj[v]) {
				const w = other(edges[ei], v);
				if (alive.has(w)) deg[w]--;
			}
		}
	}
	return alive;
}
function bfsDistances(n, edges, src) {
	const adj = adjacency(n, edges);
	const dist = new Array(n).fill(Infinity);
	dist[src] = 0;
	const q = [src];
	for (let h = 0; h < q.length; h++) {
		const u = q[h];
		for (const ei of adj[u]) {
			const v = other(edges[ei], u);
			if (dist[v] === Infinity) {
				dist[v] = dist[u] + 1;
				q.push(v);
			}
		}
	}
	return dist;
}
/**
* 6 rooms, exactly 6 edges: a cycle of length 3-6 plus tree spurs off it.
* cycleLen edges + (6 - cycleLen) spur edges = 6, always.
*/
function buildChunkInterior(index, baseId, rng, rooms, edges, weights, minCycleLen = 3) {
	const floorLen = Math.min(6, Math.max(3, minCycleLen));
	const options = [
		3,
		4,
		5,
		6
	].filter((n) => n >= floorLen);
	const optionWeights = options.map((n) => weights[n - 3]);
	const cycleLen = optionWeights.some((w) => w > 0) ? weightedPick(rng, options, optionWeights) : options[0];
	const ids = Array.from({ length: 6 }, (_, i) => baseId + i);
	for (let i = 0; i < 6; i++) rooms.push({
		id: ids[i],
		entityId: makeEntityId(),
		chunk: index,
		onCycle: i < cycleLen,
		cycleIndex: i < cycleLen ? i : -1,
		pos: {
			x: 0,
			y: 0
		},
		degree: 0
	});
	for (let i = 0; i < cycleLen; i++) edges.push({
		a: ids[i],
		b: ids[(i + 1) % cycleLen],
		entityId: makeEntityId(),
		kind: "interior"
	});
	const hosts = ids.slice(0, cycleLen);
	for (let i = cycleLen; i < 6; i++) {
		const host = pick(rng, hosts);
		edges.push({
			a: host,
			b: ids[i],
			entityId: makeEntityId(),
			kind: "interior"
		});
		hosts.push(ids[i]);
	}
	return {
		index,
		roomIds: ids,
		cycleIds: ids.slice(0, cycleLen),
		cycleLen,
		center: {
			x: 0,
			y: 0
		}
	};
}
/** Chunks reachable from `src` when edge `skip` is removed. */
function chunkComponent(C, pairs, src, skip = -1) {
	const adj = Array.from({ length: C }, () => []);
	pairs.forEach(([a, b], i) => {
		if (i === skip) return;
		adj[a].push(b);
		adj[b].push(a);
	});
	const seen = /* @__PURE__ */ new Set([src]);
	const stack = [src];
	while (stack.length) {
		const v = stack.pop();
		for (const w of adj[v]) if (!seen.has(w)) {
			seen.add(w);
			stack.push(w);
		}
	}
	return seen;
}
/**
* Indices of chunk edges whose removal disconnects the chunk graph.
* Brute force (C is tiny) because it handles parallel edges correctly,
* which vertex-parent Tarjan does not.
*/
function chunkBridgeIndices(C, pairs) {
	const out = [];
	for (let i = 0; i < pairs.length; i++) if (chunkComponent(C, pairs, 0, i).size < C) out.push(i);
	return out;
}
function chunkDegrees(C, pairs) {
	const deg = new Array(C).fill(0);
	for (const [a, b] of pairs) {
		deg[a]++;
		deg[b]++;
	}
	return deg;
}
/**
* Chunk-level multigraph. Repeated pairs are allowed: a chunk may reach the
* same neighbour twice. Guarantees:
*   - connected (every chunk reachable from every other, hence from any entrance)
*   - every chunk has inter-chunk degree >= 2
*   - no single chunk edge is a bridge (a doubled pair counts as two routes)
*
* Built as a random spanning tree, then each bridge is repaired by either
* doubling it (a lobe you enter and leave through the same neighbour) or
* adding a chord across it (weaving it into a longer cycle).
*/
function buildChunkMultigraph(C, targetL, doubleChance, maxChunkDegree, rng) {
	if (C <= 1) return [];
	if (C === 2) return [[0, 1], [0, 1]];
	const pairs = [];
	const attached = [0];
	for (const v of shuffle(rng, Array.from({ length: C - 1 }, (_, i) => i + 1))) {
		const deg = chunkDegrees(C, pairs);
		const hosts = attached.filter((h) => deg[h] < maxChunkDegree - 1);
		const host = pick(rng, hosts.length ? hosts : attached);
		pairs.push([host, v]);
		attached.push(v);
	}
	const roomy = (deg, xs) => {
		const free = xs.filter((x) => deg[x] < maxChunkDegree);
		return free.length ? free : xs;
	};
	for (let guard = 0; guard < 500; guard++) {
		const bridges = chunkBridgeIndices(C, pairs);
		if (!bridges.length) break;
		const idx = pick(rng, bridges);
		const [a, b] = pairs[idx];
		const deg = chunkDegrees(C, pairs);
		const canChord = deg[a] < maxChunkDegree || deg[b] < maxChunkDegree;
		if (rng() < doubleChance || !canChord) {
			pairs.push([a, b]);
			continue;
		}
		const sideA = [...chunkComponent(C, pairs, a, idx)];
		const sideB = [...Array(C).keys()].filter((x) => !sideA.includes(x));
		if (!sideB.length) {
			pairs.push([a, b]);
			continue;
		}
		const x = pick(rng, roomy(deg, sideA));
		const y = pick(rng, roomy(deg, sideB));
		pairs.push(x === y ? [a, b] : [x, y]);
	}
	let guard = 0;
	while (pairs.length < targetL && guard++ < 500) {
		const deg = chunkDegrees(C, pairs);
		const open = [...Array(C).keys()].filter((x) => deg[x] < maxChunkDegree);
		if (open.length < 2) break;
		if (rng() < doubleChance) {
			const existing = pairs.filter(([a, b]) => deg[a] < maxChunkDegree && deg[b] < maxChunkDegree);
			if (existing.length) {
				pairs.push(pick(rng, existing));
				continue;
			}
		}
		const a = pick(rng, open);
		const b = pick(rng, open.filter((x) => x !== a));
		if (b === void 0) break;
		pairs.push([a, b]);
	}
	return pairs;
}
/**
* Choose which room in a chunk carries a stub. Must be on the interior cycle,
* must be distinct from this chunk's other stub rooms, and spread around the
* cycle so the two disjoint arcs are both meaningful.
*/
function pickStubRoom(chunk, used, roomById, maxDegree, rng) {
	const usedIdx = used.get(chunk.index) ?? [];
	const free = chunk.cycleIds.filter((id) => {
		const r = roomById.get(id);
		return !usedIdx.includes(r.cycleIndex) && r.degree < maxDegree;
	});
	const pool = free.length ? free : chunk.cycleIds.filter((id) => roomById.get(id).degree < maxDegree);
	if (!pool.length) return pick(rng, chunk.cycleIds);
	let best = pool[0];
	let bestScore = -1;
	for (const id of shuffle(rng, pool)) {
		const idx = roomById.get(id).cycleIndex;
		let score = chunk.cycleLen;
		for (const u of usedIdx) {
			const d = Math.abs(idx - u);
			score = Math.min(score, Math.min(d, chunk.cycleLen - d));
		}
		if (score > bestScore) {
			bestScore = score;
			best = id;
		}
	}
	return best;
}
function initialPositions(chunks, rooms, rng) {
	const C = chunks.length;
	const ringRadius = C === 1 ? 0 : 130 + 42 * C;
	const chunkRadius = 95;
	chunks.forEach((c, i) => {
		const theta = 2 * Math.PI * i / Math.max(C, 1) + rng() * .25;
		c.center = {
			x: Math.cos(theta) * ringRadius,
			y: Math.sin(theta) * ringRadius
		};
		const placed = [];
		for (const id of c.roomIds) {
			let best = null;
			for (let attempt = 0; attempt < 40; attempt++) {
				const r = chunkRadius * Math.sqrt(rng());
				const t = rng() * 2 * Math.PI;
				const p = {
					x: c.center.x + Math.cos(t) * r,
					y: c.center.y + Math.sin(t) * r
				};
				if (placed.every((q) => Math.hypot(p.x - q.x, p.y - q.y) > 46)) {
					best = p;
					break;
				}
				if (!best) best = p;
			}
			placed.push(best);
			rooms.find((rm) => rm.id === id).pos = best;
		}
	});
}
function relax(rooms, edges, iterations) {
	if (iterations <= 0) return;
	const idx = new Map(rooms.map((r, i) => [r.id, i]));
	const restInterior = 72;
	const restInter = 140;
	const repel = 9e3;
	for (let step = 0; step < iterations; step++) {
		const cool = 1 - step / iterations;
		const fx = new Array(rooms.length).fill(0);
		const fy = new Array(rooms.length).fill(0);
		for (let i = 0; i < rooms.length; i++) for (let j = i + 1; j < rooms.length; j++) {
			let dx = rooms[i].pos.x - rooms[j].pos.x;
			let dy = rooms[i].pos.y - rooms[j].pos.y;
			let d2 = dx * dx + dy * dy;
			if (d2 < 1) {
				d2 = 1;
				dx = rooms[i].id - rooms[j].id || 1;
				dy = 1;
			}
			const d = Math.sqrt(d2);
			const f = repel / d2;
			fx[i] += dx / d * f;
			fy[i] += dy / d * f;
			fx[j] -= dx / d * f;
			fy[j] -= dy / d * f;
		}
		for (const e of edges) {
			const i = idx.get(e.a), j = idx.get(e.b);
			const dx = rooms[j].pos.x - rooms[i].pos.x;
			const dy = rooms[j].pos.y - rooms[i].pos.y;
			const d = Math.hypot(dx, dy) || 1;
			const f = (d - (e.kind === "interior" ? restInterior : restInter)) * .055;
			fx[i] += dx / d * f;
			fy[i] += dy / d * f;
			fx[j] -= dx / d * f;
			fy[j] -= dy / d * f;
		}
		for (let i = 0; i < rooms.length; i++) {
			const step2 = 6 * cool;
			const m = Math.hypot(fx[i], fy[i]) || 1;
			const s = Math.min(step2, m) / m;
			rooms[i].pos.x += fx[i] * s;
			rooms[i].pos.y += fy[i] * s;
		}
	}
}
function chooseEntrances(rooms, edges, C, rng) {
	const n = rooms.length;
	const cx = rooms.reduce((s, r) => s + r.pos.x, 0) / n;
	const cy = rooms.reduce((s, r) => s + r.pos.y, 0) / n;
	const count = C === 1 ? 1 : Math.min(C, rng() < .4 ? 3 : 2);
	const candidates = rooms.slice().sort((a, b) => Math.hypot(b.pos.x - cx, b.pos.y - cy) - Math.hypot(a.pos.x - cx, a.pos.y - cy)).slice(0, Math.max(6, Math.floor(n / 2)));
	const chosen = [candidates[0].id];
	while (chosen.length < count) {
		const dists = chosen.map((s) => bfsDistances(n, edges, s));
		let best = -1, bestScore = -1;
		for (const c of candidates) {
			if (chosen.includes(c.id)) continue;
			const sameChunk = chosen.some((s) => rooms.find((r) => r.id === s).chunk === c.chunk);
			const score = Math.min(...dists.map((d) => d[c.id])) - (sameChunk ? 3 : 0);
			if (score > bestScore) {
				bestScore = score;
				best = c.id;
			}
		}
		if (best < 0) break;
		chosen.push(best);
	}
	return chosen;
}
function validate$1(d, chunks, maxDegree) {
	const fails = [];
	const n = d.rooms.length;
	const C = d.chunkCount;
	for (const c of chunks) {
		const interior = d.edges.filter((e) => e.kind === "interior" && d.rooms[e.a].chunk === c.index).length;
		if (interior !== 6) fails.push(`chunk ${c.index}: ${interior} interior edges, expected 6`);
	}
	if (C > 1) {
		const interDeg = new Array(C).fill(0);
		const cPairs = [];
		for (const e of d.edges) {
			if (e.kind !== "inter-chunk") continue;
			const ca = d.rooms[e.a].chunk, cb = d.rooms[e.b].chunk;
			interDeg[ca]++;
			interDeg[cb]++;
			cPairs.push([ca, cb]);
		}
		interDeg.forEach((deg, i) => {
			if (deg < 2) fails.push(`chunk ${i}: inter-chunk degree ${deg} < 2`);
		});
		if (chunkComponent(C, cPairs, 0).size < C) fails.push("chunk graph is disconnected");
		const cbr = chunkBridgeIndices(C, cPairs);
		if (cbr.length) fails.push(`chunk graph has ${cbr.length} bridge(s)`);
		const perChunk = /* @__PURE__ */ new Map();
		for (const e of d.edges) {
			if (e.kind !== "inter-chunk") continue;
			for (const v of [e.a, e.b]) {
				const ch = d.rooms[v].chunk;
				if (!perChunk.has(ch)) perChunk.set(ch, /* @__PURE__ */ new Set());
				const s = perChunk.get(ch);
				if (s.has(v)) fails.push(`chunk ${ch}: room ${v} carries two stubs (cut vertex)`);
				s.add(v);
			}
		}
		for (const e of d.edges) {
			if (e.kind !== "inter-chunk") continue;
			for (const v of [e.a, e.b]) if (!d.rooms[v].onCycle) fails.push(`room ${v}: stub on a non-cycle room`);
		}
	}
	const core = twoCore(n, d.edges);
	const { bridges, articulations } = findBridgesAndArticulations(n, d.edges, core);
	const coreBridges = bridges.filter((i) => core.has(d.edges[i].a) && core.has(d.edges[i].b));
	if (coreBridges.length) fails.push(`2-core has ${coreBridges.length} bridge(s)`);
	if (articulations.length) fails.push(`2-core has ${articulations.length} articulation point(s)`);
	if (bfsDistances(n, d.edges, 0).some((x) => x === Infinity)) fails.push("graph is disconnected");
	for (const e of d.entrances) {
		const dist = bfsDistances(n, d.edges, e);
		const missed = /* @__PURE__ */ new Set();
		d.rooms.forEach((r, i) => {
			if (dist[i] === Infinity) missed.add(r.chunk);
		});
		if (missed.size) fails.push(`entrance ${e}: cannot reach chunk(s) ${[...missed].join(", ")}`);
	}
	if (!d.embedding) fails.push("graph has no crossing-free drawing (non-planar)");
	if (d.stats.maxDegree > maxDegree) fails.push(`max degree ${d.stats.maxDegree} > ${maxDegree}`);
	if (d.stats.circuitRank !== d.stats.interChunkEdges + 1) fails.push("circuit rank != L + 1");
	return fails;
}
function generate(seed, params) {
	const C = Math.max(1, params.chunks);
	const maxDegree = params.maxDegree ?? 4;
	const weights = params.cycleLengthWeights ?? [
		1,
		2,
		4,
		3
	];
	const L = params.interChunkEdges ?? (C <= 1 ? 0 : C + Math.floor(C / 4));
	const doubleChance = params.doubleChance ?? .3;
	const maxChunkDegree = Math.min(6, params.maxChunkDegree ?? 4);
	const rng = makeRng(seed);
	const rooms = [];
	const edges = [];
	const chunks = [];
	const pairs = buildChunkMultigraph(C, L, doubleChance, maxChunkDegree, rng);
	const stubCount = chunkDegrees(C, pairs);
	for (let i = 0; i < C; i++) chunks.push(buildChunkInterior(i, i * 6, rng, rooms, edges, weights, stubCount[i]));
	const roomById = new Map(rooms.map((r) => [r.id, r]));
	const bump = (id) => {
		roomById.get(id).degree++;
	};
	for (const e of edges) {
		bump(e.a);
		bump(e.b);
	}
	const usedCycleIdx = /* @__PURE__ */ new Map();
	for (const [ca, cbIdx] of pairs) {
		const A = chunks[ca], B = chunks[cbIdx];
		const ra = pickStubRoom(A, usedCycleIdx, roomById, maxDegree, rng);
		const rb = pickStubRoom(B, usedCycleIdx, roomById, maxDegree, rng);
		usedCycleIdx.set(ca, [...usedCycleIdx.get(ca) ?? [], roomById.get(ra).cycleIndex]);
		usedCycleIdx.set(cbIdx, [...usedCycleIdx.get(cbIdx) ?? [], roomById.get(rb).cycleIndex]);
		edges.push({
			a: ra,
			b: rb,
			entityId: makeEntityId(),
			kind: "inter-chunk"
		});
		bump(ra);
		bump(rb);
	}
	initialPositions(chunks, rooms, rng);
	relax(rooms, edges, params.relaxIterations ?? 400);
	const hist = {};
	for (const r of rooms) hist[r.degree] = (hist[r.degree] ?? 0) + 1;
	const n = rooms.length;
	const stats = {
		rooms: n,
		edges: edges.length,
		edgesPerRoom: edges.length / n,
		circuitRank: edges.length - n + 1,
		interChunkEdges: edges.filter((e) => e.kind === "inter-chunk").length,
		degreeHistogram: hist,
		deadEndShare: (hist[1] ?? 0) / n,
		corridorShare: (hist[2] ?? 0) / n,
		junctionShare: rooms.filter((r) => r.degree >= 3).length / n,
		maxDegree: Math.max(...rooms.map((r) => r.degree)),
		cycleLengths: chunks.map((c) => c.cycleLen)
	};
	const planarity = checkPlanarity(n, edges.map((e) => [e.a, e.b]));
	const dungeon = {
		seed,
		chunkCount: C,
		rooms,
		edges,
		entrances: [],
		stats,
		valid: false,
		failures: [],
		...planarity.planar ? { embedding: planarity.rotation } : {}
	};
	dungeon.entrances = chooseEntrances(rooms, edges, C, rng);
	dungeon.failures = validate$1(dungeon, chunks, maxDegree);
	dungeon.valid = dungeon.failures.length === 0;
	return dungeon;
}
/**
* Project the internal graph onto the entity model that content generation
* consumes. Phase A only knows structure, so name/base/state/composed are
* emitted blank and everything else is left for later passes to fill.
*/
function toBlueprint(d) {
	return {
		rooms: d.rooms.map((r) => ({
			name: "",
			id: r.entityId,
			type: "Room"
		})),
		roomConnectors: d.edges.map((e) => ({
			name: "",
			id: e.entityId,
			type: "RoomConnector",
			endpointA: d.rooms[e.a].entityId,
			endpointB: d.rooms[e.b].entityId,
			...e.conditional !== void 0 ? { conditional: e.conditional } : {}
		}))
	};
}
function generateBlueprint(seed, params, withDungeon = false) {
	const { dungeon, attempts } = generateValid(seed, params);
	const blueprint = toBlueprint(dungeon);
	return withDungeon ? {
		blueprint,
		dungeon,
		attempts
	} : blueprint;
}
/** Generate, advancing the seed until a dungeon passes validation. */
function generateValid(seed, params, maxAttempts = 50) {
	for (let i = 0; i < maxAttempts; i++) {
		const d = generate(i === 0 ? seed : `${seed}#${i}`, params);
		if (d.valid) return {
			dungeon: d,
			attempts: i + 1
		};
	}
	return {
		dungeon: generate(seed, params),
		attempts: maxAttempts
	};
}
//#endregion
//#region src/engine/dungeon-blueprint.ts
/**
* dungeon-blueprint.ts
*
* Procedural generation of the top-level dungeon blueprint: everything that is
* decided BEFORE the rooms loop runs.
*
* Sources:
*   - Maze Rats v4.3 by Ben Milton (CC BY 4.0)
*   - Cairn 2e "Dungeon Seeds", Yochai Gal (CC BY-SA 4.0)
*
* Pipeline:
*   1. procgen  -> rolls the seed bundle (this file)
*   2. synthesis -> one LLM pass emitting theme -> history -> goal spec -> starting prose
*   3. rooms loop -> binds entrances, goal entity, and concrete room contents (later)
*
* Conventions:
*   - Maze Rats tables are 36 entries (2d6: first die = group of 6, second = item).
*     We sample uniformly across all 36, which is equivalent.
*   - Bolded MR entries are "cascades": they point at another table. They are
*     encoded here with {Braces} and resolved by resolveCascades().
*   - Entity cascades ({NPC}, {faction}, {monster}) do NOT re-enter the pipeline.
*     They emit a stub for the LLM to bind or briefly write up. This caps recursion.
*
* NOTE: a couple of tables were transcribed from the PDF's column layout and are
* one entry short or contain a duplicate (flagged inline). Sampling is by array
* length, so this is harmless; correct at leisure.
*/
function mulberry32(a) {
	return function() {
		a |= 0;
		a = a + 1831565813 | 0;
		let t = Math.imul(a ^ a >>> 15, 1 | a);
		t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
		return ((t ^ t >>> 14) >>> 0) / 4294967296;
	};
}
var Rng = class {
	f;
	seed;
	constructor(seed) {
		this.seed = seed;
		this.f = mulberry32(seed);
	}
	next() {
		return this.f();
	}
	/** 1..n inclusive */
	d(n) {
		return Math.floor(this.f() * n) + 1;
	}
	/** inclusive range */
	range(lo, hi) {
		return lo + Math.floor(this.f() * (hi - lo + 1));
	}
	pick(arr) {
		return arr[Math.floor(this.f() * arr.length)];
	}
	/** n distinct picks */
	pickN(arr, n) {
		const pool = [...arr];
		const out = [];
		while (out.length < n && pool.length) out.push(pool.splice(Math.floor(this.f() * pool.length), 1)[0]);
		return out;
	}
	chance(p) {
		return this.f() < p;
	}
	coin() {
		return this.f() < .5;
	}
};
var t$2 = (s) => s.split("|");
var DUNGEON_FORMS = t$2("Arena|Asylum|Aviary|Bank|Baths|Body|{Building Room}|Casino|Catacombs|Cave|Court|{Dungeon Room}|Forge|Garden|Hideout|Hotel|{L. Cl. Building}|Laboratory|Library|Market|Mine|Monastery|Museum|Nursery|Orphanage|Palace|Prison|Sewer|Ship|Slave pit|Temple|Theater|{U. Cl. Building}|University|Vault|Zoo");
var DUNGEON_REWARDS = t$2("Ancient lore|Animal ally|Army|Blessing|Blueprints|Cultural artifact|Enemy weakness|Faction ally|Forewarning|Guide|Holy relic|Influential ally|Instructions|Jewels|Key|Lost formula|Machine|Magic item|Magical ally|Map|Marital ally|Masterpiece|{Monster} ally|Oracle|Piles of loot|Planar portal|Prophecy|Renown|Spell|Transformation|Transport|{Treasure Item}|Uncovered plot|{Val. Material}|Vision|Weapon");
var BUILDING_ROOMS = t$2("Arboretum|Atrium|Attic|Aviary|Ballroom|Baths|Bed chamber|Cabinet|Chapel|Cloakroom|Dining room|Dressing room|{Dungeon Room}|Garden|Garret|Greenhouse|Junk room|Kitchen|Larder|Library|Map room|Menagerie|Mews|Nursery|Pantry|Parlor|Privy|Root cellar|Saucery|Scullery|Smoking room|Spicery|Still room|Study|Trophy room|Wardrobe");
var DUNGEON_ROOMS = t$2("Armory|Banquet hall|Barracks|{Building Room}|Catacombs|Cavern|Chasm|Courtyard|Crypt|Dormitory|Fighting pit|Forge|Fountain|Gate house|Guard room|Kennel|{L. Cl. Building}|Laboratory|Mess hall|Mine shaft|Museum|Oubliette|Pool|Prison|Record room|Shrine|Slaughterhouse|Stables|Storeroom|Throne room|Torture room|Treasury|{U. Cl. Building}|Vault|Well|Workshop");
var LOWER_CLASS_BUILDINGS = t$2("Apothecary|Asylum|Baker|Brewery|Butcher|Candlemaker|Catacombs|Cheesemaker|Criminal den|Curiosity shop|Dock|Fighting pit|Forge|Fortuneteller|Gambling hall|Leatherworks|Marketplace|Mason|Mill|Moneylender|Orphanage|Outfitter|Prison|Sewers|Shipyards|Shrine|Stockyard|Stonecarver|Tattooist|Tavern|Theater|Veterinarian|Warehouse|Watchtower|Weaver|Workshop");
var UPPER_CLASS_BUILDINGS = t$2("Academy|Alchemist|Archive|Art dealer|Barber|Bookbinder|Bookseller|Castle|Clockmaker|Clothier|Courthouse|Furrier|Gallery|Garden|Haberdashery|Jeweler|Law office|Locksmith|Lounge|Manor|Museum|Observatory|Opera house|Park|Physician|Printer|Public baths|Restaurant|Salon|Stables|Taxidermist|Temple|Tobacconist|Townhouse|Winery|Zoo");
/**
* Corridors are rooms whose identity is a passage. A room designated a corridor
* during stocking rolls `identity` here instead of on DUNGEON_ROOMS; `detail`
* still rolls on the shared Dungeon Room Detail table, so it swaps one table
* and changes no fields.
*
* Twenty entries against the house format of thirty-six. Deliberate and final --
* `roll` uses `rng.pick`, so any length works. Flagged so a later reader does
* not "fix" it.
*
* `Bridge` implies crossing something a flat plane cannot show, and shares the
* flavour-only status of stairs and shafts: it matters inside the room it names
* and nowhere else.
*/
var DUNGEON_CORRIDORS = t$2("Antechamber|Atrium|Bridge|Burrow|Chute|Cloister|Concourse|Corridor|Gallery|Hallway|Hollow wall|Passageway|Ramp|Sewer|Shaft|Stairwell|Steps|Tunnel|Walkway|Waterway");
var DUNGEON_ENTRANCES = t$2("All libraries|Beaver dam|Behind waterfall|Chalk rectangle|Chest bottom|Chimney|Cupboard|Dolmen shadow|Down a well|Fiery pit|Fog road|Forest spring|Giant book|Gypsy wagon|Hollow tree|Huge keyhole|Iron maiden|Living tattoo|Magic painting|Man-shape hole|Maze potion|Mirror|Monster mouth|Monster wound|Narrow alley|Rain door|Sewer grate|Sudden rift|Tidal cave|Tower top|Tree roots|Under the bed|Unfolded map|Up a tree|Whirlpool|Wine barrel");
var DUNGEON_ROOM_DETAILS = t$2("Bas-relief|Blood trail|Bones|Chains|Chalk marks|Claw marks|Corpses|Cracked beams|Crumbling walls|Decaying food|Decaying nest|Dripping water|Fading murals|Faint breeze|Faint footsteps|Fallen pillars|Fungus|Furniture|Graffiti|Mosaics|Recent repairs|Rotting books|Rubble|Shed skin|Slime trails|Spider webs|Stalactites|Stench|Smoke stains|Thick dust|Torn clothes|Tree roots|Unusual smell|Vibrations|Vines|Whispers");
var DUNGEON_TRICKS = t$2("Absorption|Activation|Animation|Blessings|Communication|Confusion|Consumption|Creation|Curses|Deception|Duplication|{Ethereal Effect}|Exchange|Imprisonment|Instructions|Interrogation|Mind-control|{Mission}|Mood-alteration|Nullification|{Physical Effect}|Planeshift|Protection|Rejuvenation|Release|Reversal|Rotation|Scrying|Size-alteration|Summoning|Theft|Time-alteration|Transformation|Transmutation|Transportation|Wonder");
var DUNGEON_HAZARDS = t$2("Acid drip|Bloodsuckers|Cave-in|Choking dust|Crude oil|Crystal shards|Deafening noise|Dense fog|Ensnaring vines|Fallen floor|Flooding|Freezing|Geysers|Magma|Magnetic field|Mud flow|Narrow ledge|Narrow passage|Poison goo|Poison plants|Precipice|Quicksand|Radiation|Rockslide|Rotten ceiling|Rotten floor|Sinkhole|Slippery slope|Spider webs|Spores|Steam vents|Strong winds|Tar pit|Tight passage|Toppling object|Toxic fumes");
/**
* Maze Rats prints these as separate Trap Effects / Trap Triggers tables. A good
* trap should have a fairly obvious trigger -- the challenge is avoiding the
* effect, avoiding the trigger, or finding a way to deactivate it.
*/
var TRAP_EFFECTS = t$2("Acid pool|Adhesive|Alarm|Armor melts|Bear trap|Blinding spray|Blunt pendulum|Boiling tar|Collapsing floor|Crocodile pit|Crushing walls|Deep pit|Falling cage|Falling ceiling|Fills with sand|Flooding|Giant magnet|Hard vacuum|Lava flow|Lightning|Living statues|Missile fire|{Monster} freed|Net trap|Pendulum blade|Poison gas|Poison needle|Quicksand|Rage gas|Rolling boulder|Room freezes|Room on fire|Sleeping gas|Spiked pit|Tombs open|Wall spikes");
var TRAP_TRIGGERS = t$2("Blow|Break|Burn|Choice|Countdown|Darkness|Drain|Eat|Insert|Kill|Knock|Light|Magic|Melody|Noise|Open|Phrase|Pour|Press|Proximity|Pull|Read|Reflect|Release|Remove|Retrieve|Rudeness|Shut|Sit|Sleep|Slide|Touch|Turn|Unbalance|Unearth|Write");
var CAIRN_BUILT_BY = t$2("A Fallen Hero|A Fanatical Cult|A Forgotten Empire|A Long-Dead Poet|A Militant Order|A Renowned Alchemist|A Royal Dynasty|A Secret Society|A Tyrannical Ruler|A Warrior Tribe|A Wealthy Recluse|Desperate Rebels|Heretical Alchemists|Heretical Monks|Immoral Sorcerers|Inverted Astrologers|Mob Families|Opulent Merchants|Pilgrims to a Dead God|Rogue Scholars");
var CAIRN_RUIN_CONDITION = t$2("Corpse|Crumbling|Cursed|Desecrated|Devoured|Displaced|Divided|Frozen|Haunted|Infested|Overgrown|Overpopulated|Petrified|Plundered|Poisoned|Scorched|Shrouded in Mist|Submerged|Unending|Warped");
var CAIRN_RUIN_CAUSE = t$2("Alchemical Accident|Ancient Curse|Cataclysmic Flood|Civil War|Competing Rituals|Consumed by a Beast|Disease|Hedonism|Invasion|Long-Term Abandonment|Magic Gone Awry|Magical Seal|Natural Disaster|Natural Erosion|Obfuscation|Overrun with Monsters|Sudden Change in Climate|Teleported to Another Realm|Turned to Stone|Unresolved Spirits");
var CAIRN_COMPOSITION = t$2("Bone|Coral|Crystal|Earth|Ethereal Fabric|Flesh|Floating Platforms|Fungi|Glass|Ice|Living Plants|Marble|Metal|Obsidian|Petrified Wood|Sand|Shadow Material|Stone|Webs|Wood");
var FACTIONS = t$2("Art movement|Beggar's guild|Black market|Brotherhood|City guard|Conspiracy|Craft guild|Crime family|Crime ring|Dark cult|Explorer's club|Free company|Gourmand club|Heist crew|Heretical sect|High council|Hired killers|Local militia|National church|Noble house|Outlander clan|Outlaw gang|Political party|Religious order|Religious sect|Resistance|Royal army|Royal house|Scholar's circle|Secret society|Spy network|Street artists|Street gang|Street musicians|Theater troupe|Trade company");
var FACTION_TRAITS = t$2("Bankrupt|Bureaucratic|Charitable|Confused|Connected|Corrupt|Decadent|Decaying|Delusional|Divided|Dwindling|Efficient|Esoteric|Expanding|Hunted|Incompetent|Incorruptible|Insane|Insular|Manipulative|Martial|{Personality}|Pious|Popular|Righteous|Ruthless|Secret|Subversive|Suppressed|Threatened|Thriving|Unpopular|Up-and-coming|Wealthy|Well-prepared|Xenophobic");
var FACTION_GOALS = t$2("Advise leader|Avoid detection|Awaken being|Collect artifacts|Construct base|Control {faction}|Control politics|Create artifact|Create {monster}|Defeat {faction}|Defend borders|Defend leader|Destroy artifacts|Destroy being|Destroy villain|Enforce law|Enrich members|Entertain|Exchange goods|Hear rumors|Indulge tastes|Infiltrate {faction}|Map the wild|Overthrow order|Preserve lineage|Preserve lore|Produce goods|Promote arts|Promote craft|Purge traitors|Sell services|Share knowledge|Spread beliefs|Summon evil|Survive|Transport goods");
var AERIAL_ANIMALS = t$2("Albatross|Bat|Beetle|Bird of Paradise|Butterfly|Condor|Crane|Crow|Dragonfly|Eagle|Falcon|Firefly|Flamingo|Fly|Flying Squirrel|Goose|Gull|Hummingbird|Kingfisher|Locust|Magpie|Mantis|Mockingbird|Mosquito|Moth|Owl|Parrot|Peacock|Pelican|Pteranodon|Rooster|Sparrow|Swan|Vulture|Wasp|Woodpecker");
var TERRESTRIAL_ANIMALS = t$2("Ant|Ape|Armadillo|Badger|Bear|Boar|Caterpillar|Centipede|Chameleon|Cockroach|Deer|Elephant|Ferret|Fox|Giraffe|Goat|Horse|Human|Mole|Ostrich|Ox|Porcupine|Rabbit|Raccoon|Rat|Rhinoceros|Scorpion|Sheep|Slug|Snail|Snake|Spider|Squirrel|Tiger|Wolf|Wolverine");
var AQUATIC_ANIMALS = t$2("Alligator|Amoeba|Anglerfish|Beaver|Clam|Crab|Dolphin|Eel|Frog|Hippopotamus|Jellyfish|Leech|Lobster|Manatee|Manta Ray|Muskrat|Narwhal|Newt|Octopus|Otter|Penguin|Platypus|Pufferfish|Salamander|Sea Anemone|Sea Urchin|Seahorse|Seal|Shark|Shrimp|Squid|Swordfish|Tadpole|Turtle|Walrus|Whale");
var MONSTER_TRAITS = t$2("Amphibious|Bloated|Brittle|Cannibal|Clay-like|Colossal|Crystalline|Decaying|{Ether. Element}|Ethereal|Ever-young|Eyeless|Fearless|Fluffy|Fungal|Gelatinous|Geometric|Hardened|Illusory|Intelligent|Iridescent|Luminous|Many-headed|Mechanical|{Phys. Element}|Planar|Reflective|Rubbery|Shadowy|Sharp|Skeletal|Slimy|Sticky|Stinking|Tiny|Translucent");
var MONSTER_ABILITIES = t$2("Absorbing|Acid blood|Anti-magic|Blinding|Breath weapon|Camouflaging|Duplicating|Electric|Entangling|{Ethereal Effect}|Exploding|Flying|Gaze weapon|Hypnotizing|Impervious|Invisible|Life-draining|Magnetic|Mimicking|Mind-Reading|Paralyzing|Phasing|{Physical Effect}|Poisonous|Radioactive|Reflective|Regenerating|Shapeshifting|Spell-casting|Stealthy|Strangling|Super-strength|Telekinetic|Teleporting|Vampiric|Wall-Crawling");
var MONSTER_FEATURES = t$2("Antlers|Beak|Carapace|Claws|Compound eyes|Eye Stalks|Fangs|Fins|Fur|Gills|Hooves|Horns|Legless|Long tongue|Many-eyed|Many-limbed|Mucus|Pincers|Plates|Plumage|Proboscis|Scales|Segments|Shaggy hair|Shell|Spikes|Spinnerets|Spines|Stinger|Suction cups|Tail|Talons|Tentacles|Trunk|Tusks|Wings");
var MUTATIONS = t$2("Ages|Attracts birds|Child-form|Corpulence|Covered in hair|{Animal} arms|{Animal} eyes|{Animal} head|{Animal} legs|{Animal} mouth|{Animal} skin|{Animal}-form|Cyclops|Extra arms|Extra eyes|Extra legs|Forked tongue|Gender swap|Hunchback|{Item}-form|Long arms|Lose all hair|Loses teeth|{Monster Feature}|{Monster Trait}|No eyes|No mouth|{P. Element}-skin|Second face|Sheds skin|Shrinks|Shrivels|Skin boils|Slime trail|Translucent skin|Weeps blood");
var MONSTER_TACTICS = t$2("Ambush|Call for support|Capture|Charge|Climb foes|Compel worship|Create barrier|Deceive|Demand duel|Disorient|Encircle|Evade|Gang up|Gather strength|Go berserk|Harry|Hurl foes|Immobilize|Manipulate|Mock|Monologue|Order minion|Protect leader|Protect self|Scatter foes|Stalk|Steal from|Swarm|Target insolent|Target leader|Target nearest|Target richest|Target strongest|Target weakest|Toy with|Use terrain");
var MONSTER_WEAKNESS = t$2("Bells|Birdsong|Children|Cold|Cold Iron|Competition|Conversation|Deformity|Flattery|Flowers|Gifts|Gold|Heat|Holy Icon|Holy Water|Home Cooking|{Insanities}|Mirrors|Mistletoe|Moonlight|Music|{Methods}|Phylactery|{Phys. Elements}|Puzzles|Riddles|Rituals|Silver|Sunlight|Tears|True Name|{Val. Materials}|Weak Spot|{Weapon Items}|Wine|Wormwood");
var MONSTER_PERSONALITY = t$2("Alien|Aloof|Bored|Cautious|Cowardly|Curious|Devious|Distractable|Educated|Embittered|Envious|Erudite|Fanatical|Forgetful|Generous|Hateful|Honorable|Humble|Jaded|Jovial|Legalistic|Manipulative|Megalomaniac|Melancholy|Meticulous|Mystical|Obsessive|Out of Touch|Paranoid|Polite|Psychopathic|Sophisticated|Touchy|Unimpressed|Vain|Xenophobic");
var CIVILIZED_NPCS = t$2("Acolyte|Actor|Apothecary|Baker|Barber|Blacksmith|Brewer|Bureaucrat|Butcher|Carpenter|Clockmaker|Courier|Courtier|Diplomat|Fishmonger|Guard|Haberdasher|Innkeeper|Item-seller|Jeweler|Knight|Locksmith|Mason|Miller|Musician|Noble|Painter|Priest|Scholar|Scribe|Sculptor|Shipwright|Soldier|Tailor|Taxidermist|Wigmaker");
var UNDERWORLD_NPCS = t$2("Alchemist|Beggar-prince|Blackmailer|Bounty-hunter|Chimney sweep|Coin-clipper|Contortionist|Counterfeiter|Cultist|Cutpurse|Debt-collector|Deserter|Fence|Fortuneteller|Galley slave|Gambler|Gravedigger|Headsman|Hedge knight|Highwayman|Housebreaker|Kidnapper|Mad prophet|Mountebank|Peddler|Pit-fighter|Poisoner|Rat-catcher|Scrivener|Sellsword|Slave|Smuggler|Street performer|Tattooist|Urchin|Usurer");
var WILDERNESS_NPCS = t$2("Apiarist|Bandit|Caravan Guard|Caravaneer|Druid|Exile|Explorer|Farmer|Fisherman|Forager|Fugitive|Hedge wizard|Hermit|Hunter|Messenger|Minstrel|Monk|Monster hunter|Outlander|Tinker|Pilgrim|Poacher|Raider|Ranger|Sage|Scavenger|Scout|Seer|Shepherd|Surveyor|Tinker|Tomb raider|Trader|Trapper|Witch|Woodcutter");
/** MR character-creation Background table is identical to the Underworld NPC list. */
var BACKGROUNDS = UNDERWORLD_NPCS;
var FEMALE_NAMES = t$2("Adelaide|Alma|Barsaba|Beatrix|Bianca|Cleopha|Clover|Constance|Damaris|Daphne|Demona|Elsbeth|Esme|Fern|Hester|Hippolyta|Jessamine|Jilly|Morgot|Minerva|Nerissa|Odette|Olga|Orchid|Pepper|Phoebe|Piety|Poppy|Silence|Sybil|Trillby|Tuesday|Ursula|Vivian|Wendy|Zora");
var MALE_NAMES = t$2("Balthazar|Basil|Bertram|Blaxton|Chadwick|Clovis|Destrian|Ellis|Erasmus|Faustus|Finn|Fitzhugh|Florian|Fox|Godwin|Hannibal|Jasper|Jiles|Jules|Leopold|Merrick|Mortimer|Ogden|Orion|Oswald|Percival|Peregrine|Quentin|Redmaine|Reinhold|Silas|Stilton|Stratford|Tenpiece|Waverly|Webster");
var UPPER_SURNAMES = t$2("Belvedere|Bithesea|Calaver|Carvolo|De Rippe|Droll|Dunlow|Edevane|Erelong|Febland|Fernsby|Fisk|Gastrell|Girdwood|Gorgon|Grimeson|Gruger|Hitheryon|La Marque|Malmora|Miter|Oblington|Onymous|Phillifent|Portendorfer|Romatet|Rothery|Skorbeck|Slora|Southwark|Stavish|Vandermeer|Wellbelove|Westergren|Wexley|Wilberforce");
var LOWER_SURNAMES = t$2("Barrow|Beetleman|Berrycloth|Birdwhistle|Bobich|Chips|Coffin|Crumpling|Culpepper|Dankworth|Digworthy|Dreggs|Gimble|Graveworm|Greelish|Hardwick|Hatman|Hovel|Knibbs|Midnighter|Needle|Nethercoat|Pestle|Relish|Rumbold|Rummage|Sallow|Saltmarsh|Silverless|Skitter|Slee|Slitherly|Stoker|Tarwater|Tumbler|Villin");
var ASSETS = t$2("Authority|Avoids detection|Calls in favors|Charming|Cooks the books|Erases evidence|Excellent liar|Extremely rich|Faction-leader|Faction-member|Fortified base|Interrogator|Gorgeous|Hears rumors|Huge family|Huge library|Impersonator|Knows a guy|Knows a way in|Launders money|Learned|Local celebrity|Local knowledge|Loyal henchmen|Middling oracle|Nothing to lose|Owns the guards|Powerful spouse|Procures gear|Pulls the strings|Secret lab|Sells contraband|Smuggles goods|Spy network|War hero");
var LIABILITIES = t$2("Addiction|Alcoholic|Corrupt ally|Coward|Decadent|Forbidden love|Gambler|Glutton|Greedy|Heretic|Huge debts|Imposter|{Insanity}|Jealous|Leaves evidence|Many enemies|Misinformed|Money trail|Narcissist|Needs medicine|OCD|Paranoid|Partyer|Poor equipment|Protective|Scandalous|Softhearted|Strict routines|Superstitious|Suspicious|Temper|Trusting|Vulnerable base|Wanted|Weak-willed|Widely despised");
var METHODS = t$2("Alchemy|Blackmail|Bluster|Bribery|Bullying|Bureaucracy|Charm|Commerce|Cronies|Debate|Deduction|Eloquence|Espionage|Fast-talking|Favors|Hard Work|Humor|Investigation|Legal maneuvers|Manipulation|Misdirection|Money|Nagging|Negotiation|Persistence|Piety|Preparation|Quick Wit|Research|Rumors|Sabotage|Teamwork|Theft|Threats|Violence");
var APPEARANCES = t$2("Aquiline|Athletic|Barrel-chested|Boney|Brawny|Brutish|Bullnecked|Chiseled|Coltish|Corpulent|Craggy|Delicate|Furrowed|Gaunt|Gorgeous|Grizzled|Haggard|Handsome|Hideous|Lanky|Pudgy|Ripped|Rosy|Scrawny|Sinewy|Slender|Slumped|Solid|Square-jawed|Statuesque|Towering|Trim|Weathered|Willowy|Wiry|Wrinkled");
var PERSONALITIES = t$2("Bitter|Brave|Cautious|Chipper|Contrary|Cowardly|Cunning|Driven|Entitled|Gregarious|Grumpy|Heartless|Honor-bound|Hotheaded|Inquisitive|Irascible|Jolly|Know-it-all|Lazy|Loyal|Menacing|Mopey|Nervous|Protective|Righteous|Rude|Sarcastic|Savage|Scheming|Serene|Spacey|Stoic|Stubborn|Stuck-up|Suspicious|Wisecracking");
var NPC_GOALS = t$2("A better life|Acceptance|Acquire {item}|Craft {item}|Destroy {faction}|Destroy {item}|Enlightenment|Fame|Found {faction}|Freedom|Glory|Impress {NPC}|Infamy|Infiltrate {faction}|Justice|Kidnap {NPC}|Lead {faction}|Learning|Locate {NPC}|Love|Mastery|Power|Reach location|Rescue {NPC}|Resolve dispute|Restore {faction}|Reveal a secret|Revenge|Sabotage {faction}|Serve a deity|Serve evil|Serve {faction}|Serve ideology|Serve leader|Serve the needy|Wealth");
var PHYSICAL_DETAILS = t$2("Acid scars|Battle scars|Birthmark|Braided hair|Brand mark|Broken nose|Bronze skinned|Burn scars|Bushy eyebrows|Curly hair|Dark skinned|Dreadlocks|Exotic accent|Flogging scars|Freckles|Gold tooth|Hoarse voice|Huge beard|Long hair|Matted hair|Missing ear|Missing teeth|Mustache|Muttonchops|Nine fingers|Oiled hair|One-eyed|Pale skinned|Piercings|Ritual scars|Sallow skin|Shaved head|Sunburned|Tangled hair|Tattoos|Topknot");
var CLOTHING$1 = t$2("Antique|Battle-torn|Bedraggled|Blood-stained|Ceremonial|Dated|Decaying|Eccentric|Elegant|Embroidered|Exotic|Fashionable|Flamboyant|Food-stained|Formal|Frayed|Frumpy|Garish|Grimy|Haute couture|Lacey|Livery|Mud-stained|Ostentatious|Oversized|Patched|Patterned|Perfumed|Practical|Rumpled|Sigils|Singed|Tasteless|Undersized|Wine-stained|Worn out");
var MANNERISMS = t$2("Anecdotes|Breathy|Chuckles|Clipped|Cryptic|Deep voice|Drawl|Enunciates|Flowery speech|Gravelly voice|Highly formal|Hypnotic|Interrupts|Laconic|Laughs|Long pauses|Melodious|Monotone|Mumbles|Narrates|Overly casual|Quaint sayings|Rambles|Random facts|Rapid-fire|Rhyming|Robotic|Slow speech|Speechifies|Squeaky|Street slang|Stutters|Talks to self|Trails off|Very loud|Whispers");
var SECRETS = t$2("Addicted|Artificial|Assassin|Bankrupt|Beholden|Counterspy|Cultist|Demigod|Evil lineage|Exile|Fence|Fugitive|Ghost|Has a child|Heretic|High born|Huge fortune|Illusion|Insurrectionist|Low born|Married|Mind-controlled|{Misfortune}|Monster hunter|Non-human|{NPC}|Polygamist|Protects relic|Scandalous birth|Secret police|Serial killer|Smuggler|Spy|Time traveler|Transformed|War criminal");
var REPUTATIONS = t$2("Ambitious|Authoritative|Boor|Borrower|Celebrity|Charitable|Cheat|Dangerous|Entertainer|Gossip|Hardworking|Holy|Honest|Hypochondriac|Idiot|Influential|Layabout|Leader|Misanthrope|Miser|Neighborly|Nutjob|Obnoxious|Overeducated|Partier|Pious|Proper|Prophet of doom|Repulsive|Respected|Riffraff|Scandalous|Slime ball|Terrifying|Weirdo|Wise");
var HOBBIES = t$2("Archaeology|Art collecting|Bad fiction|Calligraphy|Card games|Clockwork|Collecting cats|Cuisine|Dark lore|Dog breeding|Embroidery|Exercise|Falconry|Fashion|Fishing|Foreign cultures|Gardening|History|Horseracing|Hunting|Instrument|Knitting|Lawn games|Mountaineering|Opera|Painting|Poetry|Puzzle-solving|Riddling|Science|Sculpture|Sketching|Smoking|Theater|Weaving|Whiskey");
var MISFORTUNES$1 = t$2("Abandoned|Addicted|Arrested|Blackmailed|Burgled|Challenged|Condemned|Crippled|Cursed|Defrauded|Demoted|Depressed|Discredited|Dismissed|Disowned|Exiled|Famished|Forgotten|Framed|Haunted|Humiliated|Impoverished|Kidnapped|Lost|Mobbed|Mutilated|Overworked|Poisoned|Pursued|Rejected|Replaced|Robbed|Sick|Sued|Suspected|Transformed");
var RELATIONSHIPS = t$2("Adviser|Blackmailer|Business partner|Business rival|Buyer|Captor|Client|Confidant|Debtor|Disciple|Guardian|Henchman|Idol|Informant|Master|Mentor|Nemesis|Offspring|Parent|Patron|Political rival|Prisoner|Protege|Quarry|Right hand|Romantic rival|Servant|Sibling|Social rival|Spouse|Stalker|Suitor|Supplicant|Supplier|Sweetheart|Unrequited love");
var MISSIONS = t$2("Apprehend|Assassinate|Blackmail|Burgle|Chart|Convince|Deface|Defraud|Deliver|Destroy|Discredit|Escort|Exfiltrate|Extort|Follow|Frame|Impersonate|Impress|Infiltrate|Interrogate|Investigate|Kidnap|Locate|Plant|Protect|Raid|Replace|Retrieve|Rob|Ruin|Sabotage|Smuggle|Surveil|Take Over|Terrorize|Threaten");
var PHYSICAL_ELEMENTS = t$2("Acid|Amber|Bark|Blood|Bone|Brine|Clay|Crow|Crystal|Ember|Flesh|Fungus|Glass|Honey|Ice|Insect|Wood|Lava|Moss|Obsidian|Oil|Poison|Rat|Salt|Sand|Sap|Serpent|Slime|Stone|Tar|Thorn|Vine|Water|Wine|Wood|Worm");
var ETHEREAL_ELEMENTS = t$2("Ash|Chaos|Distortion|Dream|Dust|Echo|Ectoplasm|Fire|Fog|Ghost|Harmony|Heat|Light|Lightning|Memory|Mind|Mutation|Negation|Plague|Plasma|Probability|Rain|Rot|Shadow|Smoke|Snow|Soul|Star|Stasis|Steam|Thunder|Time|Void|Warp|Whisper|Wind");
var PHYSICAL_EFFECTS = t$2("Animating|Attracting|Binding|Blossoming|Consuming|Creeping|Crushing|Diminishing|Dividing|Duplicating|Enveloping|Expanding|Fusing|Grasping|Hastening|Hindering|Illuminating|Imprisoning|Levitating|Opening|Petrifying|Phasing|Piercing|Pursuing|Reflecting|Regenerating|Rending|Repelling|Resurrecting|Screaming|Sealing|Shapeshifting|Shielding|Spawning|Transmuting|Transporting");
var ETHEREAL_EFFECTS = t$2("Avenging|Banishing|Bewildering|Blinding|Charming|Communicating|Compelling|Concealing|Deafening|Deceiving|Deciphering|Disguising|Dispelling|Emboldening|Encoding|Energizing|Enlightening|Enraging|Excruciating|Foreseeing|Intoxicating|Maddening|Mesmerizing|Mindreading|Nullifying|Paralyzing|Revealing|Revolting|Scrying|Silencing|Soothing|Summoning|Terrifying|Warding|Wearying|Withering");
var INSANITIES = t$2("Always lies|Always polite|{Animal}-form|Cannot count|Cannot lie|Faceblind|Fears birds|Fears blood|Fears books|Fears darkness|Fears fire|Fears gold|Fears horses|Fears iron|Fears music|Fears own hand|Fears PC|Fears rain|Fears rivers|Fears silence|Fears sleep|Fears sunlight|Fears the moon|Fears trees|Genius|Gorgeous|Hates violence|Invisible|{Monster Ability}|{Monster Feature}|{Monster Trait}|Must sing|New {Personality}|Says thoughts|Sees dead people|Translucent");
var VALUABLE_MATERIALS = t$2("Alabaster|Amber|Aquamarine|Azurite|Beryl|Black Pearl|Bloodstone|Bone China|Chalcedony|Cinnabar|Coral|Diamond|Ebony|Emerald|Fire Agate|Garnet|Gold|Ivory|Jade|Jasper|Jet|Lapis Lazuli|Malachite|Moonstone|Onyx|Opal|Pearl|Platinum|Porcelain|Ruby|Sapphire|Serpentine|Silver|Star Iron|Topaz|Turquoise");
var WEAPON_ITEMS = t$2("Arming sword|Backsword|Battleaxe|Blowpipe|Claymore|Club|Crossbow|Cutlass|Dagger|Flail|Flanged mace|Glaive|Halberd|Hammer|Hatchet|Horsebow|Hunting knife|Lance|Longbow|Longsword|Mace|Maul|Morningstar|Pike|Scimitar|Shortbow|Sickle|Sling|Spear|Staff|Stake|Stiletto|Throwing axe|Warhammer|Warpick|Whip");
var TREASURE_ITEMS = t$2("Alchemy recipe|Amulet|Astrolabe|Blueprints|Calligraphy|Carpet|Compass|Contract|Crown|Crystal|Deed|Embroidery|Fine china|Fine liquor|Instrument|Magical book|Microscope|Music box|Orrery|Painting|Perfume|Prayer book|Printing block|Rare textile|Royal robes|Saint's relic|Scrimshaw|Sextant|Sheet music|Signet ring|Silverware|Spices|Spyglass|Tapestry|Telescope|Treasure map");
/**
* WHAT A BOOK IS ABOUT — Maze Rats.
*
* Rolled once, when the book is made, and it is the whole of what the book IS:
* how much is in it is not decided here but found out by reading it, one d6 at
* a time. See `BookFacts` and `consultRoll`.
*
* The referee reads the subject generously — a heading, not a boundary — which
* is what makes a book worth the slot it costs. Step 3 of the playbook owns
* that rule.
*/
var BOOK_SUBJECTS = [
	"Alchemy",
	"Art",
	"Astrology",
	"Blackmail",
	"Charts & Maps",
	"Conspiracies",
	"Cookbook",
	"Criminals",
	"Divination",
	"Etiquette",
	"Fashion",
	"Genealogy",
	"Hagiography",
	"History",
	"Journal",
	"Language",
	"Laws",
	"Letters",
	"Lost empires",
	"Lost places",
	"Love poems",
	"Monsters",
	"Mythology",
	"Odd customs",
	"Oratory",
	"Propaganda",
	"Prophecies",
	"Siegecraft",
	"Songs",
	"State secrets",
	"Sword fighting",
	"Theology",
	"Treasures",
	"War chronicle",
	"Who's who",
	"Witch-hunting"
];
/** Empty string only if the table is ever emptied — a book with no subject is legal. */
function rollBookSubject(rng) {
	return BOOK_SUBJECTS.length ? rng.pick(BOOK_SUBJECTS) : "";
}
/**
* Content cascades resolve inline (capped depth).
* Entity cascades emit a stub -- they never re-enter the pipeline, which is what
* caps recursion. The synthesis pass binds them to an existing entity or writes
* a brief new one.
*/
var CONTENT_CASCADES = {
	"Building Room": BUILDING_ROOMS,
	"Dungeon Room": DUNGEON_ROOMS,
	"L. Cl. Building": LOWER_CLASS_BUILDINGS,
	"U. Cl. Building": UPPER_CLASS_BUILDINGS,
	"Monster Feature": MONSTER_FEATURES,
	"Mon. Feature": MONSTER_FEATURES,
	"Monster Ability": MONSTER_ABILITIES,
	"Mon. Ability": MONSTER_ABILITIES,
	"Monster Trait": MONSTER_TRAITS,
	"Phys. Element": PHYSICAL_ELEMENTS,
	"Phys. Elements": PHYSICAL_ELEMENTS,
	"P. Element": PHYSICAL_ELEMENTS,
	"Ether. Element": ETHEREAL_ELEMENTS,
	"Physical Effect": PHYSICAL_EFFECTS,
	"Ethereal Effect": ETHEREAL_EFFECTS,
	Insanity: INSANITIES,
	Insanities: INSANITIES,
	Methods: METHODS,
	Personality: PERSONALITIES,
	Misfortune: MISFORTUNES$1,
	"Val. Material": VALUABLE_MATERIALS,
	"Val. Materials": VALUABLE_MATERIALS,
	"Weapon Items": WEAPON_ITEMS,
	Mission: MISSIONS,
	"Treasure Item": TREASURE_ITEMS,
	item: TREASURE_ITEMS
};
var ENTITY_CASCADES$1 = /* @__PURE__ */ new Set([
	"NPC",
	"faction",
	"monster",
	"Monster"
]);
var MAX_CASCADE_DEPTH$1 = 2;
function rollAnimal(rng) {
	const d = rng.d(6);
	const tbl = d <= 2 ? AERIAL_ANIMALS : d <= 4 ? TERRESTRIAL_ANIMALS : AQUATIC_ANIMALS;
	return rng.pick(tbl);
}
function resolveCascades$1(entry, rng, depth = 0) {
	return entry.replace(/\{([^}]+)\}/g, (_m, token) => {
		if (token === "Animal") return rollAnimal(rng);
		if (ENTITY_CASCADES$1.has(token)) return token === "NPC" ? "an NPC" : token.toLowerCase() === "faction" ? "a faction" : "a monster";
		const tbl = CONTENT_CASCADES[token];
		if (!tbl) return token;
		const pickRaw = rng.pick(tbl);
		if (depth >= MAX_CASCADE_DEPTH$1) return pickRaw.replace(/[{}]/g, "");
		return resolveCascades$1(pickRaw, rng, depth + 1);
	});
}
function roll$1(table, rng) {
	return resolveCascades$1(rng.pick(table), rng);
}
/** n distinct entries from one table, each cascade-resolved */
function rollDistinct(table, n, rng) {
	return rng.pickN(table, n).map((raw) => resolveCascades$1(raw, rng));
}
/** Unique id. Not drawn from the seeded rng — identity, not content. */
function makeId() {
	const c = globalThis.crypto;
	if (c?.randomUUID) return c.randomUUID();
	return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (ch) => {
		const r = Math.random() * 16 | 0;
		return (ch === "x" ? r : r & 3 | 8).toString(16);
	});
}
var TIER_COMPLEXITY = {
	Solo: "major",
	Band: "complex",
	Horde: "simple"
};
function genMonster(complexity, rng) {
	const silhouette = rng.coin() ? "humanoid" : "beastlike";
	let animals;
	let humanoidSeed;
	if (silhouette === "beastlike") animals = rng.coin() ? [rollAnimal(rng)] : [rollAnimal(rng), rollAnimal(rng)];
	else {
		const pick = rng.d(3);
		if (pick === 1) humanoidSeed = {
			table: "Mutation",
			result: roll$1(MUTATIONS, rng)
		};
		else if (pick === 2) humanoidSeed = {
			table: "Feature",
			result: roll$1(MONSTER_FEATURES, rng)
		};
		else humanoidSeed = {
			table: "Trait",
			result: roll$1(MONSTER_TRAITS, rng)
		};
	}
	const taCount = complexity === "simple" ? 1 : 2;
	const traitsAndAbilities = [];
	for (let i = 0; i < taCount; i++) if (rng.coin()) traitsAndAbilities.push({
		table: "Trait",
		result: roll$1(MONSTER_TRAITS, rng)
	});
	else traitsAndAbilities.push({
		table: "Ability",
		result: roll$1(MONSTER_ABILITIES, rng)
	});
	if (complexity === "major") traitsAndAbilities.push({
		table: "Ability",
		result: roll$1(MONSTER_ABILITIES, rng)
	});
	const fmCount = complexity === "major" ? 2 : 1;
	const featuresAndMutations = [];
	for (let i = 0; i < fmCount; i++) if (rng.coin()) featuresAndMutations.push({
		table: "Feature",
		result: roll$1(MONSTER_FEATURES, rng)
	});
	else featuresAndMutations.push({
		table: "Mutation",
		result: roll$1(MUTATIONS, rng)
	});
	let weaknessCount = 0;
	if (complexity === "simple") weaknessCount = rng.chance(.25) ? 1 : 0;
	else if (complexity === "complex") weaknessCount = rng.chance(.75) ? 1 : 0;
	else weaknessCount = rng.coin() ? 1 : 2;
	const weaknesses = rollDistinct(MONSTER_WEAKNESS, weaknessCount, rng);
	return {
		complexity,
		silhouette,
		animals,
		humanoidSeed,
		traitsAndAbilities,
		featuresAndMutations,
		tactic: roll$1(MONSTER_TACTICS, rng),
		weaknesses,
		personality: roll$1(MONSTER_PERSONALITY, rng)
	};
}
var FLAVOR_TABLES = [
	{
		name: "Physical Details",
		table: PHYSICAL_DETAILS
	},
	{
		name: "Clothing",
		table: CLOTHING$1
	},
	{
		name: "Mannerisms",
		table: MANNERISMS
	},
	{
		name: "Secrets",
		table: SECRETS
	},
	{
		name: "Reputations",
		table: REPUTATIONS
	},
	{
		name: "Hobbies",
		table: HOBBIES
	},
	{
		name: "Misfortunes",
		table: MISFORTUNES$1
	},
	{
		name: "Relationships",
		table: RELATIONSHIPS
	},
	{
		name: "Missions",
		table: MISSIONS
	}
];
function genNpc(isFactionMember, isLeader, rng, usedNames) {
	let origin;
	if (isFactionMember) origin = {
		kind: "background",
		result: roll$1(BACKGROUNDS, rng)
	};
	else {
		const d = rng.d(6);
		origin = {
			kind: "role",
			result: roll$1(d === 1 ? CIVILIZED_NPCS : d <= 3 ? UNDERWORLD_NPCS : WILDERNESS_NPCS, rng)
		};
	}
	const presentingGender = rng.coin() ? "male" : "female";
	const namePool = presentingGender === "male" ? MALE_NAMES : FEMALE_NAMES;
	let name = rng.pick(namePool);
	let nameTries = 0;
	while (usedNames?.has(name) && nameTries++ < 20) name = rng.pick(namePool);
	usedNames?.add(name);
	const flavorCount = rng.d(6);
	const flavor = rng.pickN(FLAVOR_TABLES, flavorCount).map((c) => ({
		table: c.name,
		result: roll$1(c.table, rng)
	}));
	return {
		id: makeId(),
		isLeader,
		origin,
		name,
		presentingGender,
		surnameOptions: {
			upper: rng.pick(UPPER_SURNAMES),
			lower: rng.pick(LOWER_SURNAMES)
		},
		asset: roll$1(ASSETS, rng),
		liability: roll$1(LIABILITIES, rng),
		method: roll$1(METHODS, rng),
		appearance: roll$1(APPEARANCES, rng),
		personality: roll$1(PERSONALITIES, rng),
		goal: roll$1(NPC_GOALS, rng),
		flavor
	};
}
/**
* Named NPCs a Band produces. Every one of these is a person with a background,
* asset, liability, method, appearance, personality, and goal, so the count is
* really "how much apparatus is this encounter worth". Residents can carry more
* of it than something met in a corridor.
*/
var BAND_NPC_WEIGHTS = {
	inhabitant: [
		[2, .25],
		[3, .5],
		[4, .25]
	],
	wanderer: [
		[2, .5],
		[3, .35],
		[4, .15]
	]
};
function bandNpcCount(origin, rng) {
	const weights = BAND_NPC_WEIGHTS[origin];
	let x = rng.next();
	for (const [n, p] of weights) {
		x -= p;
		if (x <= 0) return n;
	}
	return weights[weights.length - 1][0];
}
function genPeopleGroup(tier, rng, origin = "inhabitant") {
	const traits = rollDistinct(FACTION_TRAITS, rng.coin() ? 1 : 2, rng);
	const branchRoll = rng.d(3);
	const goalBranch = branchRoll === 1 ? "same" : branchRoll === 2 ? "opposed" : "own";
	const ownGoal = goalBranch === "own" ? roll$1(FACTION_GOALS, rng) : void 0;
	let npcCount;
	let undefinedUnderlings = false;
	if (tier === "Solo") npcCount = 1;
	else if (tier === "Band") npcCount = bandNpcCount(origin, rng);
	else {
		npcCount = 1;
		undefinedUnderlings = true;
	}
	const npcs = [];
	const usedNames = /* @__PURE__ */ new Set();
	for (let i = 0; i < npcCount; i++) npcs.push(genNpc(true, i === 0, rng, usedNames));
	return {
		id: makeId(),
		kind: "people",
		tier,
		faction: roll$1(FACTIONS, rng),
		traits,
		goalBranch,
		ownGoal,
		npcs,
		undefinedUnderlings
	};
}
function monsterBaseKey(m) {
	return m.silhouette === "beastlike" ? `beast:${[...m.animals ?? []].sort().join("+")}` : `humanoid:${m.humanoidSeed?.result}`;
}
function genMonsterGroup(tier, rng, usedKeys) {
	let monster = genMonster(TIER_COMPLEXITY[tier], rng);
	let attempts = 0;
	while (usedKeys?.has(monsterBaseKey(monster)) && attempts++ < 12) monster = genMonster(TIER_COMPLEXITY[tier], rng);
	usedKeys?.add(monsterBaseKey(monster));
	let biggerSpecimen;
	if (tier === "Horde") {
		biggerSpecimen = genMonster(rng.coin() ? "complex" : "major", rng);
		biggerSpecimen.silhouette = monster.silhouette;
		biggerSpecimen.animals = monster.animals;
		biggerSpecimen.humanoidSeed = monster.humanoidSeed;
	}
	return {
		id: makeId(),
		kind: "monsters",
		tier,
		monster,
		biggerSpecimen
	};
}
function groupCountForSize(size, rng) {
	if (size === 1) return 1;
	if (size === 2 || size === 3) return rng.range(1, 2);
	return rng.range(2, 3);
}
function generateBlueprintSeed(size, seed, level) {
	const rng = new Rng(seed);
	const dungeonId = `dungeon_${seed.toString(36)}`;
	const form = roll$1(DUNGEON_FORMS, rng);
	const builtBy = rng.pick(CAIRN_BUILT_BY);
	const ruination = rng.chance(.75) ? {
		ruined: true,
		condition: rng.pick(CAIRN_RUIN_CONDITION),
		cause: rng.pick(CAIRN_RUIN_CAUSE)
	} : {
		ruined: false,
		secondaryForm: roll$1(DUNGEON_FORMS, rng),
		composition: rng.pick(CAIRN_COMPOSITION)
	};
	const count = groupCountForSize(size, rng);
	const inhabitants = [];
	const usedMonsterKeys = /* @__PURE__ */ new Set();
	for (let i = 0; i < count; i++) {
		const tier = rng.pick([
			"Solo",
			"Band",
			"Horde"
		]);
		if (rng.coin()) inhabitants.push(genMonsterGroup(tier, rng, usedMonsterKeys));
		else inhabitants.push(genPeopleGroup(tier, rng));
	}
	const goalSeed = {
		reward: roll$1(DUNGEON_REWARDS, rng),
		mission: roll$1(MISSIONS, rng)
	};
	return {
		id: dungeonId,
		seed,
		size,
		level,
		purpose: {
			form,
			builtBy
		},
		ruination,
		inhabitants,
		goalSeed
	};
}
var r = (x) => x;
function monsterSheet(m, indent = "    ") {
	const L = [];
	L.push(`${indent}Complexity: ${m.complexity}`);
	L.push(`${indent}Silhouette: ${m.silhouette}`);
	if (m.animals) L.push(`${indent}Reference animal${m.animals.length > 1 ? "s (both, not either)" : ""}: ${m.animals.join(" / ")}`);
	if (m.humanoidSeed) L.push(`${indent}Humanoid seed (${m.humanoidSeed.table}): ${r(m.humanoidSeed.result)}`);
	L.push(`${indent}Traits/Abilities: ${m.traitsAndAbilities.map((x) => `${x.table}: ${r(x.result)}`).join("; ")}`);
	L.push(`${indent}Features/Mutations: ${m.featuresAndMutations.map((x) => `${x.table}: ${r(x.result)}`).join("; ")}`);
	L.push(`${indent}Tactic: ${r(m.tactic)}`);
	L.push(`${indent}Weakness: ${m.weaknesses.length ? m.weaknesses.map(r).join("; ") : "(none)"}`);
	L.push(`${indent}Personality: ${r(m.personality)}  (discard if not intelligent enough)`);
	return L;
}
function npcSheet(n, indent = "      ") {
	const L = [];
	const role = n.origin.kind === "role" ? "Current role" : "Background (past)";
	L.push(`${indent}${n.isLeader ? "[LEADER] " : ""}${n.name} (${n.presentingGender}) [${n.id}] -- surname: ${n.surnameOptions.upper} (upper) / ${n.surnameOptions.lower} (lower)`);
	L.push(`${indent}  ${role}: ${r(n.origin.result)}`);
	L.push(`${indent}  Asset: ${r(n.asset)} | Liability: ${r(n.liability)} | Method: ${r(n.method)}`);
	L.push(`${indent}  Appearance: ${r(n.appearance)} | Personality: ${r(n.personality)} | Goal: ${r(n.goal)}`);
	if (n.flavor.length) L.push(`${indent}  Flavor (${n.flavor.length}): ${n.flavor.map((f) => `${f.table}: ${r(f.result)}`).join("; ")}`);
	return L;
}
function rollSheet(bp) {
	const L = [];
	L.push(`=== DUNGEON BLUEPRINT SEED ===`);
	L.push(`id: ${bp.id}   seed: ${bp.seed}   size: ${bp.size}${bp.level ? `   level: ${bp.level}` : ""}`);
	L.push("");
	L.push(`PURPOSE`);
	L.push(`  Form (original purpose): ${r(bp.purpose.form)}`);
	L.push(`  Built by: ${bp.purpose.builtBy}`);
	L.push("");
	L.push(`RUINATION`);
	if (bp.ruination.ruined) {
		L.push(`  Ruined: YES`);
		L.push(`  Condition: ${bp.ruination.condition}   (also seeds initial dungeon state)`);
		L.push(`  Cause: ${bp.ruination.cause}   (seeds history)`);
	} else {
		L.push(`  Ruined: NO -- intact, with a secondary use / notable component`);
		L.push(`  Secondary form: ${r(bp.ruination.secondaryForm)}`);
		L.push(`  Composition: ${bp.ruination.composition}`);
	}
	L.push("");
	L.push(`INHABITANTS (${bp.inhabitants.length} group${bp.inhabitants.length > 1 ? "s" : ""})`);
	bp.inhabitants.forEach((g, i) => {
		L.push(`  --- Group ${i + 1}: ${g.kind.toUpperCase()} / Tier: ${g.tier}  [${g.id}] ---`);
		if (g.kind === "monsters") {
			L.push(...monsterSheet(g.monster));
			if (g.biggerSpecimen) {
				L.push(`    -- bigger specimen (same base, higher tier) --`);
				L.push(...monsterSheet(g.biggerSpecimen, "      "));
			}
		} else {
			L.push(`    Faction: ${r(g.faction)}`);
			L.push(`    Traits: ${g.traits.map(r).join("; ")}`);
			const branch = g.goalBranch === "same" ? "SAME as player goal -- ally or rival, lean rival (break on traits)" : g.goalBranch === "opposed" ? "OPPOSED to player goal -- enemies" : `OWN goal: ${r(g.ownGoal)}`;
			L.push(`    Goal branch: ${branch}`);
			if (g.undefinedUnderlings) L.push(`    Plus an undefined mass of underlings`);
			L.push(`    NPCs (${g.npcs.length}):`);
			g.npcs.forEach((n) => L.push(...npcSheet(n)));
		}
	});
	L.push("");
	L.push(`PLAYER GOAL SEED`);
	L.push(`  Dungeon Reward: ${r(bp.goalSeed.reward)}`);
	L.push(`  Mission: ${r(bp.goalSeed.mission)}`);
	L.push(`  (pick one, discard the other, or combine -- whichever reads best)`);
	return L.join("\n");
}
//#endregion
//#region src/engine/dungeon-entities.ts
function isWeapon(i) {
	return i.itemKind === "weapon" && i.weapon !== void 0;
}
function isArmor(i) {
	return i.itemKind === "armor" && i.armor !== void 0;
}
function isBook(i) {
	return i.itemKind === "book" && i.book !== void 0;
}
/**
* What it is worth, in copper.
*
* Through a helper because `value` arrived after the first characters were
* saved, and a sheet written before it is a sheet with no prices on it rather
* than a sheet that should crash the panel adding them up.
*/
function itemValue(i) {
	return i.value ?? 0;
}
/** Effective ability bonus: HD plus any stored deviation. */
function abilityBonus(s, a) {
	return s.hitDice + (s.modifiers[a] ?? 0);
}
/** Knave: a defense is always its bonus + 10. */
function abilityDefense(s, a) {
	return abilityBonus(s, a) + 10;
}
function attackBonus(s) {
	return s.hitDice + (s.modifiers.attack ?? 0);
}
function maxHp(s) {
	return s.hitDice * 4;
}
function armorDefense$1(s) {
	return s.armorDefense ?? 11;
}
function damageDie(s) {
	return s.damage ?? "1d6";
}
/**
* A way out of the dungeon rather than a way between two of its rooms.
*
* Everything that walks the graph has to ask this first. A surface exit joins
* one room to nothing, so a router that treats it as an edge walks into null,
* and a map that draws it has nowhere to draw it to.
*/
function isSurfaceExit(c) {
	return c.endpointB === null;
}
/** True when this connector is a way out of `roomId`. */
function touches(c, roomId) {
	return c.endpointA === roomId || c.endpointB === roomId;
}
/**
* The far side of a connector, seen from `roomId`. Null means the surface.
*
* Callers that cannot cope with the surface must check `isSurfaceExit` rather
* than testing the result, because `null` here is a real answer — "outside" —
* and not a failure to resolve.
*/
function farSide(c, roomId) {
	return c.endpointA === roomId ? c.endpointB : c.endpointA;
}
/**
* An entity's standing prose identity, wherever it happens to live.
*
* Three storage sites, because three kinds of thing share identity differently:
*
*   inline `base`          a one-off -- a room, a connector, a named person who
*                          is nobody but themselves
*   registry.groups[id]    one of a rolled population; every instance shares it
*   registry.creatures[id] a one-off creature template -- an elite, a loose
*   registry.hazards[id]   seed, the goal creature; a hazard's shared effect
*
* Inline wins, so a named member of a people group keeps their own identity
* rather than the group's. Returns undefined only when generation left the
* entity unwritten, which `validateWritten` treats as a hard failure.
*/
function resolveBase(e, reg) {
	if (e.base !== void 0) return e.base;
	const blueprintId = e.narrative?.blueprintId ?? e.blueprintId;
	if (blueprintId === void 0) return void 0;
	if (e.type === "Hazard") return reg.hazards[blueprintId]?.base;
	return reg.groups[blueprintId]?.base ?? reg.creatures[blueprintId]?.base;
}
/**
* A player-visible name, in the case a player-visible name is written in.
*
* Names are minted by a model in two places — the content pass when it writes
* the dungeon, and the referee when it creates something mid-run — and both
* produce whatever register the surrounding sentence was in. One R2 dungeon
* held "The Residue", "The Cutlass", "The ledger" and "unmarked ledger" at the
* same time. A name is a label, and a label is capitalised.
*
* FIRST LETTER ONLY, and the rest is left exactly as written. "an iron door"
* becomes "An iron door" and not "An Iron Door": title case would have to know
* which words are part of a proper name, and it is wrong more often than the
* lower-case first letter it set out to fix. Normalised where names are MINTED
* rather than where they are drawn, because `definite()` in `verbs.ts` rewrites
* a name into the middle of a sentence and a display-side fix would have to
* fight it.
*/
function properName(name) {
	const s = name.trim();
	return s === "" ? s : s[0].toUpperCase() + s.slice(1);
}
/**
* `composed` is derived, so anything that mutates state must mark it stale and
* let the render pass regenerate it. (That it is derived does not make it
* ignorable — see the note on the three lifetimes at the top of this file:
* what the player has been told outranks a state that has fallen behind.)
*
* The old description is left in place until it is actually rewritten — see the
* note on `needUpdate`.
*/
function setState(e, state) {
	e.state = state;
	e.needUpdate = true;
}
/** The description has been rewritten from the current base + state. */
function setComposed(e, composed) {
	e.composed = composed;
	e.needUpdate = false;
}
/**
* Conceal or reveal, settling what that means for the description.
*
* `composed` is prose for the player. A concealed thing owes them none, so
* hiding something settles its description debt; revealing it opens one, and
* the next composition pass picks it up. That is why a hidden thing can sit
* with `state` written and `composed` empty without looking perpetually stale.
*/
function setIsHidden(e, hidden) {
	e.isHidden = hidden;
	e.needUpdate = !hidden;
}
/**
* Whether this owes the player fresh prose.
*
* `undefined` means never described, and so yes. `false` is a settled state,
* reached either by writing a description or by concealing the thing. `true`
* means the description is out of date.
*/
function needsComposition$1(e) {
	return e.needUpdate !== false;
}
//#endregion
//#region src/engine/dungeon-room-size.ts
/**
* class -> [min area, max area], measured on FLOOR AREA and not on the bounding
* box. A cross fills perhaps 40% of its box, so the two numbers come apart badly
* on the shaped families and only one of them is what the fiction means. The box
* is capped separately, by `BOX_CAP`.
*
* THE BANDS ARE CONTIGUOUS, so a range of classes is a single interval of areas
* and there is no hole for a room's only achievable area to fall into.
*
* FOUR BANDS, AND THEY ARE TIGHT. These describe what the block plan actually
* draws — rooms of ten to forty cells, on zones of twenty to forty — rather than
* an idealised spread. `large` is the top band and open-ended in intent; the
* number is only the largest footprint that can be drawn at all. An earlier
* five-band spread ran to 196 and put three of its five bands out of reach,
* which made the size a worse signal than no size at all.
*/
var AREA = {
	tiny: [4, 9],
	small: [10, 25],
	medium: [26, 35],
	large: [36, 576]
};
var CLASSES = [
	"tiny",
	"small",
	"medium",
	"large"
];
var classRank = (c) => CLASSES.indexOf(c) + 1;
/** The class an area falls in. Total, because the bands are contiguous. */
function classOf(area) {
	for (const c of CLASSES) if (area <= AREA[c][1]) return c;
	return "large";
}
/**
* `identity` rolls on DUNGEON_ROOMS, whose three nested references reach
* BUILDING_ROOMS, LOWER_CLASS_BUILDINGS and UPPER_CLASS_BUILDINGS — about 130
* distinct nouns. A complete mapping would be a chore that rots, so only the
* nouns that genuinely imply a geometry are annotated and the other ~90 fall
* through to a default that **still rolls among the classes**: monotony is the
* failure mode to design against, not inaccuracy.
*
* Every key here is asserted reachable from those four tables (see the tests) —
* an annotation keyed on a noun that never rolls is dead weight that looks
* live. `Silo`, `Tidal cave` and `Sinkhole` were cut from an earlier draft for
* exactly that reason: the first is on no table, the second is a Dungeon
* Entrance and the third a Dungeon Hazard.
*/
var ARCHETYPES = {
	"Banquet hall": { proportion: "long" },
	Ballroom: { proportion: "long" },
	Gallery: { proportion: "long" },
	Barracks: { proportion: "long" },
	Dormitory: { proportion: "long" },
	Stables: { proportion: "long" },
	Kennel: { proportion: "long" },
	Catacombs: { proportion: "long" },
	Sewers: { proportion: "long" },
	Well: {
		family: ["round"],
		maxRelief: 1,
		sizeClass: "tiny"
	},
	Fountain: {
		family: ["round"],
		maxRelief: 1
	},
	Pool: {
		family: ["round"],
		maxRelief: 1
	},
	"Fighting pit": {
		family: ["round"],
		maxRelief: 1
	},
	Oubliette: {
		family: ["round"],
		maxRelief: 1
	},
	Observatory: {
		family: ["round"],
		maxRelief: 1
	},
	Cavern: { relief: 2 },
	Chasm: { relief: 2 },
	"Mine shaft": { relief: 2 },
	Chapel: {
		family: ["T", "cross"],
		proportion: "long",
		maxRelief: 1
	},
	Shrine: {
		family: ["T", "cross"],
		proportion: "long",
		maxRelief: 1
	},
	Temple: {
		family: ["T", "cross"],
		proportion: "long",
		maxRelief: 1
	},
	"Throne room": {
		family: ["T", "cross"],
		proportion: "long",
		maxRelief: 1
	},
	Courthouse: {
		family: ["T", "cross"],
		proportion: "long",
		maxRelief: 1
	},
	"Opera house": {
		family: ["T", "cross"],
		proportion: "long",
		maxRelief: 1
	},
	Courtyard: {
		minClass: "large",
		relief: 0
	},
	Garden: {
		minClass: "large",
		relief: 0
	},
	Marketplace: {
		minClass: "large",
		relief: 0
	},
	Park: {
		minClass: "large",
		relief: 0
	},
	Theater: {
		minClass: "large",
		relief: 0
	},
	Warehouse: {
		minClass: "large",
		relief: 0
	},
	Privy: {
		sizeClass: "tiny",
		relief: 0
	},
	Cabinet: {
		sizeClass: "tiny",
		relief: 0
	},
	Cloakroom: {
		sizeClass: "tiny",
		relief: 0
	},
	Wardrobe: {
		sizeClass: "tiny",
		relief: 0
	},
	Pantry: {
		sizeClass: "tiny",
		relief: 0
	},
	Larder: {
		sizeClass: "tiny",
		relief: 0
	}
};
/**
* May a room of this size be this thing?
*
* Read the other way round from how 6a used it. There, an archetype's size pin
* was an instruction to the packer — a Well had to come out tiny — and the
* packer frequently could not oblige, because a room's size is decided by the
* ground available and not by what it rolled. Here the geometry is already
* settled and the pin is a CONDITION ON THE ROLL: a four-cell closet does not
* get to be a banquet hall, and a hall the size of a courtyard does not get to
* be a privy.
*
* Everything unannotated passes at every size, which is most of the table.
*/
function sizeAllows(identity, cls) {
	const arch = ARCHETYPES[identity];
	if (!arch) return true;
	if (arch.sizeClass && arch.sizeClass !== cls) return false;
	if (arch.minClass && classRank(cls) < classRank(arch.minClass)) return false;
	return true;
}
//#endregion
//#region src/engine/dungeon-rooms-loop.ts
/**
* dungeon-rooms-loop.ts
*
* Phase C -- the rooms loop. Takes the Phase A graph (pure topology) plus the
* dungeon blueprint seed (the genome) and stocks every room, producing the
* bundles that the LLM composition pass turns into prose.
*
* Sources:
*   - Maze Rats v4.3 by Ben Milton (CC BY 4.0)          -- THE MAZE tables
*   - Cairn 2e "Dungeon Seeds", Yochai Gal (CC BY-SA 4.0) -- Special/Feature/Clue
*
* PIPELINE
*   0.  structural pre-pass  -- entrance pick, BFS depth, dead ends, eccentricity,
*                               core/secret selection, connector promotion
*   1.  load-bearing         -- entrance features, goal entity, one base room per
*                               inhabitant group
*   2.  identity             -- every room gets a name/function. No blank rooms.
*   3.  headline quota       -- target mix over ALL rooms, minus load-bearing
*                               claims. The remainder is a conserved budget.
*   4.  headline placement   -- assign the budget by depth fit, then local swaps
*                               to break up same-category neighbours (pacing)
*   5.  danger scoring       -- per room, from headline + occupancy + depth
*   6.  reward distribution  -- fixed budget K. Guarantees off the top, remainder
*                               by weighted draw. Conserved, so an empty monster
*                               room pushes its share elsewhere.
*   7.  content layers       -- details, hazards/specials, clues-with-pointers
*   8.  emit                 -- room bundles + mobile entity list
*
* DESIGN INVARIANTS
*   - Headlines and rewards are BUDGETS, not per-room rolls. Load-bearing
*     placement has already skewed the pool; only subtraction can correct it.
*   - Headline mix is level-agnostic. Level moves reward GRADE only.
*   - Creatures are mobile entities referencing a room via locationRoomId. They
*     are never children of the room.
*   - Everything is seeded. Same seed in, same dungeon out.
*
* NOTE ON TABLES: the MAZE / Cairn tables live inline here for convenience while
* we test this phase. They are destined for their own module(s) alongside the
* blueprint tables -- nothing here should assume they stay local.
*
* NOTE ON IMPORTS: this expects `genMonster`, `genNpc`, `Rng` and the treasure
* tables to be exported from dungeon-blueprint.ts (a one-word change each in the
* source; they are currently module-private).
*/
var t$1 = (s) => s.split("|");
var DUNGEON_ACTIVITIES = t$1("Besiege|Capture|City Activity|Collect|Construct|Control|Deliver|Demolish|Escape|Feed|Fortify|Guard|Hide|Hunt|Loot|Map|Mine|{Monster} Tactic|Negotiate|Patrol|Perform ritual|Purge|Question|Raid|Repair|Rescue|Research|Revive|Riddle|Scavenge|Seize|Tunnel|Unearth|Vandalize|Wild. Activity|Worship");
var CAIRN_SPECIAL = t$1("Books|Bridge|Contraption|Creature|Door|Flames|Furniture|Hole|Liquid|Mirror|Mural|Pool|Shadows|Smoke|Statue|Surface|Treasure|Voices|Wheel|Writing");
var CAIRN_FEATURE = t$1("Ages|Alarms|Animates|Attracts|Charges|Closes|Falls|Glows|Grows|Illusion|Levitates|Locks|Opens|Reflects|Repels|Reveals|Shifts|Silences|Teleport|Transforms");
var CAIRN_CLUE = t$1("Decay|Decor|Draft|Echoes|Footprints|Leavings|Light|Markings|Moisture|Noise|Paraphernalia|Residue|Scurrying|Signs|Smell|Stains|Tapping|Temperature|Vibrations|Writing");
var REWARD_SIGNIFICANT = t$1("Ancient lore|Cultural artifact|Holy relic|Lost formula|Machine|Magic item|Magical ally|Masterpiece|Oracle|Prophecy|Spell|Transformation|Vision|{Treasure Item}");
var REWARD_KNOWLEDGE = t$1("Enemy weakness|Forewarning|Blueprints|Instructions|Map fragment|Uncovered plot|Ancient lore|Faction secret|Location of a hidden way|Password or phrase");
var REWARD_LEVERAGE = t$1("Defensible chokepoint|Safe place to rest|Shortcut lever|Concealed hiding spot|Barricade materials|Vantage point|Working door bar|Escape route");
var REWARD_BOON = t$1("Blessing|Healing draught|Clean water and food|Restorative spring|Warm fire|Ward against the dungeon's affliction|Temporary strength|Removed condition");
var REWARD_COIN = t$1("Loose coin|Coin purse|Small strongbox|Buried cache|Pouch of trade bars|Tithe box");
var REWARD_EQUIPMENT = t$1("Rations|Rope and hooks|Lantern and oil|Torches|Tools|Spare armor|Bandages|Climbing gear|Antidote|Chalk and spikes");
var CASCADE_TABLES = {
	"Building Room": BUILDING_ROOMS,
	"Dungeon Room": DUNGEON_ROOMS,
	"L. Cl. Building": LOWER_CLASS_BUILDINGS,
	"U. Cl. Building": UPPER_CLASS_BUILDINGS,
	"Treasure Item": TREASURE_ITEMS,
	"Val. Material": VALUABLE_MATERIALS,
	"Weapon Item": WEAPON_ITEMS
};
/** Entity cascades emit a stub for the LLM instead of recursing. */
var ENTITY_CASCADES = /* @__PURE__ */ new Set([
	"Monster",
	"NPC",
	"faction",
	"monster"
]);
var MAX_CASCADE_DEPTH = 2;
function resolveCascades(entry, rng, depth = 0) {
	return entry.replace(/\{([^}]+)\}/g, (_m, key) => {
		if (ENTITY_CASCADES.has(key)) return key;
		const table = CASCADE_TABLES[key];
		if (!table || depth >= MAX_CASCADE_DEPTH) return key;
		return resolveCascades(rng.pick(table), rng, depth + 1);
	});
}
function roll(table, rng) {
	return resolveCascades(rng.pick(table), rng);
}
function buildAdjacency(rooms, edges) {
	const adj = rooms.map(() => []);
	for (const e of edges) {
		adj[e.a].push(e.b);
		adj[e.b].push(e.a);
	}
	return adj;
}
function bfsDepth(adj, from) {
	const dist = new Array(adj.length).fill(-1);
	dist[from] = 0;
	const q = [from];
	for (let i = 0; i < q.length; i++) {
		const u = q[i];
		for (const v of adj[u]) if (dist[v] === -1) {
			dist[v] = dist[u] + 1;
			q.push(v);
		}
	}
	return dist;
}
function structuralPrePass(d, rng) {
	const adj = buildAdjacency(d.rooms, d.edges);
	const entrance = d.entrances.length ? d.entrances[0] : 0;
	const depth = bfsDepth(adj, entrance);
	const maxDepth = Math.max(...depth);
	const deadEnds = /* @__PURE__ */ new Set();
	d.rooms.forEach((r, i) => {
		if (adj[i].length <= 1 && i !== entrance) deadEnds.add(i);
	});
	let goal = entrance;
	let best = -1;
	d.rooms.forEach((_r, i) => {
		if (i === entrance) return;
		const score = depth[i] * 10 + adj[i].length;
		if (score > best) {
			best = score;
			goal = i;
		}
	});
	let secret = null;
	let secretDepth = -1;
	for (const i of deadEnds) {
		if (i === goal) continue;
		if (depth[i] > secretDepth) {
			secretDepth = depth[i];
			secret = i;
		}
	}
	return {
		entrance,
		depth,
		maxDepth,
		deadEnds,
		goal,
		secret,
		adj
	};
}
/**
* Gate a share of connectors. Cairn distinguishes "hidden" from "conditional",
* but they are the same mechanism wearing two hats: a connection that demands
* something of the player before it can be used. So they share one budget.
*
* Cairn gives no number, so: between 1/6 and 1/4 of all connectors, spread
* more or less evenly rather than clumped.
*
* Two structural guards. A room may never have ALL of its connectors gated --
* that turns a gate into a wall -- with one deliberate exception: the secret
* room, where being wholly behind a gate is the entire point. And the entrance
* always keeps an open way in.
*/
function gateConnectors(d, s, rng) {
	const E = d.edges.length;
	const gated = d.edges.map(() => false);
	const lo = Math.ceil(E / 6);
	const hi = Math.max(lo, Math.floor(E / 4));
	const target = rng.range(lo, hi);
	const incident = d.rooms.map(() => []);
	d.edges.forEach((e, i) => {
		incident[e.a].push(i);
		incident[e.b].push(i);
	});
	const ungated = d.rooms.map((_r, i) => incident[i].length);
	const gatedTouching = d.rooms.map(() => 0);
	const canGate = (ei) => {
		const e = d.edges[ei];
		for (const v of [e.a, e.b]) {
			if (v === s.secret) continue;
			if (ungated[v] - 1 < 1) return false;
		}
		return true;
	};
	let placed = 0;
	while (placed < target) {
		let bestIdx = -1;
		let bestScore = Infinity;
		for (let i = 0; i < E; i++) {
			if (gated[i]) continue;
			if (!canGate(i)) continue;
			const e = d.edges[i];
			const touchesSecret = s.secret !== null && (e.a === s.secret || e.b === s.secret);
			const score = gatedTouching[e.a] + gatedTouching[e.b] - (touchesSecret ? 5 : 0) + rng.next() * .5;
			if (score < bestScore) {
				bestScore = score;
				bestIdx = i;
			}
		}
		if (bestIdx === -1) break;
		const e = d.edges[bestIdx];
		gated[bestIdx] = true;
		ungated[e.a]--;
		ungated[e.b]--;
		gatedTouching[e.a]++;
		gatedTouching[e.b]++;
		placed++;
	}
	const hidden = d.edges.map(() => false);
	const stillGated = [...gated];
	for (let i = 0; i < E; i++) {
		if (!gated[i]) continue;
		const roll = rng.next();
		if (roll < .25) {
			hidden[i] = true;
			stillGated[i] = false;
		} else if (roll < .35) hidden[i] = true;
	}
	return d.edges.map((e, i) => ({
		id: e.entityId,
		a: d.rooms[e.a].entityId,
		b: d.rooms[e.b].entityId,
		gated: stillGated[i],
		hidden: hidden[i]
	}));
}
var BASE_MIX = {
	creature: .34,
	special: .33,
	quiet: .33
};
function computeQuota(totalRooms, claimed, unclaimedCount) {
	const pool = totalRooms - 1;
	const target = {
		creature: Math.round(pool * BASE_MIX.creature),
		special: Math.round(pool * BASE_MIX.special),
		quiet: Math.round(pool * BASE_MIX.quiet)
	};
	const remainder = {
		creature: Math.max(0, target.creature - claimed.creature),
		special: Math.max(0, target.special - claimed.special),
		quiet: Math.max(0, target.quiet - claimed.quiet)
	};
	let sum = remainder.creature + remainder.special + remainder.quiet;
	const order = [
		"creature",
		"special",
		"quiet"
	];
	while (sum > unclaimedCount) {
		const biggest = order.reduce((a, b) => remainder[a] >= remainder[b] ? a : b);
		if (remainder[biggest] === 0) break;
		remainder[biggest]--;
		sum--;
	}
	while (sum < unclaimedCount) {
		remainder.quiet++;
		sum++;
	}
	return remainder;
}
/** Preferred normalised depth per category. */
var DEPTH_FIT = {
	creature: .75,
	special: .6,
	quiet: .25
};
function placeHeadlines(unclaimed, quota, s, rng) {
	const norm = (i) => s.maxDepth ? s.depth[i] / s.maxDepth : 0;
	const pool = [];
	[
		"creature",
		"special",
		"quiet"
	].forEach((c) => {
		for (let i = 0; i < quota[c]; i++) pool.push(c);
	});
	const rooms = [...unclaimed].sort((a, b) => norm(a) - norm(b));
	pool.sort((a, b) => DEPTH_FIT[a] - DEPTH_FIT[b]);
	const assign = /* @__PURE__ */ new Map();
	rooms.forEach((r, i) => assign.set(r, pool[i]));
	const cost = (r, c) => {
		const fit = Math.abs(norm(r) - DEPTH_FIT[c]);
		let clash = 0;
		for (const n of s.adj[r]) if (assign.get(n) === c) clash++;
		return fit + clash * .45;
	};
	for (let pass = 0; pass < 6; pass++) {
		let improved = false;
		for (let i = 0; i < rooms.length; i++) for (let j = i + 1; j < rooms.length; j++) {
			const ri = rooms[i];
			const rj = rooms[j];
			const ci = assign.get(ri);
			const cj = assign.get(rj);
			if (ci === cj) continue;
			const before = cost(ri, ci) + cost(rj, cj);
			assign.set(ri, cj);
			assign.set(rj, ci);
			if (cost(ri, cj) + cost(rj, ci) < before) improved = true;
			else {
				assign.set(ri, ci);
				assign.set(rj, cj);
			}
		}
		if (!improved) break;
	}
	return assign;
}
function scoreDanger(room, mobiles, maxDepth) {
	let d = 0;
	switch (room.headline) {
		case "creature":
			d += .5;
			break;
		case "special":
			d += room.special?.kind === "hazard" ? .45 : .2;
			break;
		case "quiet":
			d += .05;
			break;
		case "none": return 0;
	}
	if (room.stacked === "special") d += .15;
	if (room.stacked === "creature") d += .2;
	const here = mobiles.filter((m) => m.locationRoomId === room.roomId);
	for (const m of here) {
		const tierBonus = m.tier === "Horde" ? .22 : m.tier === "Band" ? .15 : .1;
		d += m.isBase ? tierBonus : tierBonus * .6;
		if (m.disposition === "friendly") d -= .12;
		if (m.disposition === "neutral") d -= .06;
	}
	const depthNorm = maxDepth ? room.depth / maxDepth : 0;
	d += depthNorm * .35;
	if (room.role === "goal") d += .25;
	return Math.max(0, Math.min(1, d));
}
function rewardBudget(V) {
	return Math.max(3, Math.round(.55 * V));
}
/**
* Target share of parcels that should be actual loot. MR's Rewards table leans
* hard away from the mundane, and the guarantee set (dead ends + puzzle rooms)
* biases to leverage/knowledge, so without a floor material gets crowded out
* entirely. Tracked across the whole distribution, not per room.
*/
var MATERIAL_TARGET_SHARE = .45;
function parcelTypeFor(room, rng, grade, ledger) {
	if (grade === "significant") return "relic";
	const want = MATERIAL_TARGET_SHARE * ledger.K;
	const remaining = Math.max(1, ledger.K - ledger.placed);
	const deficit = Math.max(0, want - ledger.material);
	const boost = 1 + 3 * Math.min(1, deficit / remaining);
	const w = [];
	if (room.headline === "creature") w.push(["material", 5 * boost], ["knowledge", 3], ["boon", 2], ["leverage", 1]);
	else if (room.headline === "special") if (room.special?.kind === "obstacle") w.push(["leverage", 4], ["knowledge", 4], ["material", 2 * boost], ["boon", 1]);
	else w.push(["material", 4 * boost], ["knowledge", 2], ["boon", 2], ["leverage", 2]);
	else w.push(["knowledge", 4], ["boon", 3], ["leverage", 3], ["material", 2 * boost]);
	const total = w.reduce((s, [, n]) => s + n, 0);
	let r = rng.next() * total;
	for (const [type, n] of w) {
		r -= n;
		if (r <= 0) return type;
	}
	return w[w.length - 1][0];
}
function gradeFor(room, level, maxDepth, rng) {
	const depthNorm = maxDepth ? room.depth / maxDepth : 0;
	const g = room.danger * .45 + depthNorm * .3 + level / 10 * .15 + (room.isDeadEnd ? .1 : 0) + rng.next() * .15;
	if (g > .78) return "significant";
	if (g > .48) return "notable";
	return "mundane";
}
function parcelContent(type, grade, rng) {
	switch (type) {
		case "relic": return roll(REWARD_SIGNIFICANT, rng);
		case "knowledge": return roll(REWARD_KNOWLEDGE, rng);
		case "leverage": return roll(REWARD_LEVERAGE, rng);
		case "boon": return roll(REWARD_BOON, rng);
		default: {
			const pools = grade === "mundane" ? [
				REWARD_COIN,
				REWARD_EQUIPMENT,
				REWARD_COIN,
				WEAPON_ITEMS
			] : grade === "notable" ? [
				TREASURE_ITEMS,
				VALUABLE_MATERIALS,
				WEAPON_ITEMS,
				REWARD_COIN
			] : [TREASURE_ITEMS, VALUABLE_MATERIALS];
			return roll(rng.pick(pools), rng);
		}
	}
}
function distributeRewards(rooms, level, maxDepth, mobiles, rng) {
	const K = rewardBudget(rooms.length);
	const ledger = {
		placed: 0,
		material: 0,
		K
	};
	const eligible = rooms.filter((r) => r.role !== "entrance");
	const guaranteedRooms = eligible.filter((r) => r.isDeadEnd || r.headline === "special" && r.special?.kind === "obstacle" || r.stacked === "special" && r.special?.kind === "obstacle");
	const give = (room, guaranteed) => {
		const grade = gradeFor(room, level, maxDepth, rng);
		const type = parcelTypeFor(room, rng, grade, ledger);
		ledger.placed++;
		if (type === "material") ledger.material++;
		const content = parcelContent(type, grade, rng);
		const parcel = {
			type,
			grade,
			content,
			guaranteed
		};
		if (type === "knowledge" && content === "Enemy weakness") {
			const withWeakness = mobiles.filter((m) => m.monster && m.monster.weaknesses.length > 0);
			const bases = withWeakness.filter((m) => m.isBase && !m.minion);
			const standalone = withWeakness.filter((m) => !m.minion);
			const pool = bases.length ? bases : standalone.length ? standalone : withWeakness;
			if (pool.length) parcel.aboutMobileId = rng.pick(pool).id;
		}
		room.reward = parcel;
	};
	let spent = 0;
	for (const r of guaranteedRooms) {
		if (spent >= K) break;
		give(r, true);
		spent++;
	}
	const guaranteed = spent;
	const pool = eligible.filter((r) => !r.reward);
	const weights = pool.map((r) => {
		const depthNorm = maxDepth ? r.depth / maxDepth : 0;
		return Math.max(.02, r.danger * (.5 + .5 * depthNorm));
	});
	while (spent < K && pool.length) {
		const total = weights.reduce((s, w) => s + w, 0);
		if (total <= 0) break;
		let x = rng.next() * total;
		let idx = 0;
		for (; idx < pool.length; idx++) {
			x -= weights[idx];
			if (x <= 0) break;
		}
		if (idx >= pool.length) idx = pool.length - 1;
		give(pool[idx], false);
		pool.splice(idx, 1);
		weights.splice(idx, 1);
		spent++;
	}
	return {
		K,
		guaranteed,
		contested: spent - guaranteed
	};
}
function resolveClueTargets(rooms, byIndex, s, connectors, mobiles, rng) {
	const hiddenRoomIds = /* @__PURE__ */ new Set();
	for (const c of connectors) if (c.gated) {
		hiddenRoomIds.add(c.a);
		hiddenRoomIds.add(c.b);
	}
	for (const room of rooms) {
		if (!room.clue) continue;
		const scored = s.adj[room.index].map((i) => byIndex.get(i)).filter((r) => !!r).map((n) => {
			let score = .1;
			if (n.special?.kind === "hazard") score += 1;
			if (n.headline === "creature") score += .8;
			if (n.role === "goal") score += 1.2;
			if (hiddenRoomIds.has(n.roomId)) score += 1;
			if (n.reward) score += .5;
			if (n.headline === "quiet" && !n.reward) score -= .05;
			return {
				n,
				score
			};
		});
		scored.sort((a, b) => b.score - a.score);
		const target = scored.length ? scored[0].n : void 0;
		if (target) {
			room.clue.targetRoomId = target.roomId;
			const occ = mobiles.filter((m) => m.locationRoomId === target.roomId);
			if (occ.length) room.clue.targetMobileId = rng.pick(occ).id;
			room.clue.about = target.role === "goal" ? "the objective" : target.special?.kind === "hazard" ? "a hazard in an adjoining room" : occ.length ? "creatures in an adjoining room" : hiddenRoomIds.has(target.roomId) ? "a way that is not obvious" : "an adjoining room";
		} else room.clue.about = "the dungeon at large";
	}
}
/**
* Mobile ids are derived from the stocking seed and a counter that resets at
* the top of every stockDungeon() call, so stocking the same seed twice in one
* process yields the same ids. A bare module-level counter did not: the second
* run continued from wherever the first stopped, which quietly broke
* same-seed-twice assertions and any snapshot of a payload carrying mob refs.
*/
var mobilePrefix = "mob";
var mobileCounter = 0;
function resetMobileIds(seed) {
	mobilePrefix = `mob_${(seed >>> 0).toString(36)}`;
	mobileCounter = 0;
}
function mobileId() {
	return `${mobilePrefix}_${(++mobileCounter).toString(36)}`;
}
/**
* Pick the rooms that are passages rather than places.
*
* Count is N-1 / N / N+1 at 25 / 50 / 25 where N is the size, which comes to
* roughly a sixth of the rooms. Size 1 is a coin flip between 0 and 1.
*
* Eligibility is **degree >= 2** and nothing else. A corridor connects
* somewhere, so dead ends are out; the goal room is never one. Dropping every
* further degree preference removes the one degenerate case -- a size-1 chunk
* whose 3-cycle carries three spurs has degrees 3,3,3,1,1,1 and therefore no
* degree-2 rooms at all, which under "exactly 2" would yield none and under
* ">= 2" yields three.
*
* Two corridors are never adjacent: that is one hallway with a pointless door
* in it. Picks are spread across **depth** bands rather than chunks, because
* `RoomStock.chunk` is a batching unit and never a content input, and because
* corridors are about rhythm along the path inward.
*/
function designateCorridors(rooms, s, size, rng) {
	const target = size === 1 ? rng.coin() ? 1 : 0 : Math.max(0, size + rng.pick([
		-1,
		0,
		0,
		1
	]));
	if (target === 0) return;
	const BANDS = 3;
	const bandOf = (r) => s.maxDepth > 0 ? Math.min(2, Math.floor(r.depth / s.maxDepth * BANDS)) : 0;
	const byIndex = new Map(rooms.map((r) => [r.index, r]));
	const pools = Array.from({ length: BANDS }, () => []);
	for (const r of rooms) {
		if (r.degree < 2 || r.role === "goal") continue;
		pools[bandOf(r)].push(r);
	}
	const taken = new Array(BANDS).fill(0);
	for (let n = 0; n < target; n++) {
		let band = -1;
		for (let b = 0; b < BANDS; b++) {
			if (!pools[b].some(free)) continue;
			if (band < 0 || taken[b] < taken[band]) band = b;
		}
		if (band < 0) return;
		const choice = rng.pick(pools[band].filter(free));
		choice.isCorridor = true;
		taken[band]++;
	}
	function free(r) {
		return !r.isCorridor && !s.adj[r.index].some((n) => byIndex.get(n)?.isCorridor);
	}
}
function stockDungeon(dungeon, blueprint, opts = {}) {
	const level = opts.level ?? blueprint.level ?? 1;
	const seed = opts.seed ?? blueprint.seed + 7919;
	const rng = new Rng(seed);
	resetMobileIds(seed);
	const cohesion = .55 + rng.next() * .35;
	const s = structuralPrePass(dungeon, rng);
	const connectors = gateConnectors(dungeon, s, rng);
	const rooms = dungeon.rooms.map((r, i) => ({
		roomId: r.entityId,
		index: i,
		chunk: r.chunk,
		role: i === s.entrance ? "entrance" : i === s.goal ? "goal" : "normal",
		headline: "quiet",
		claimed: false,
		isCorridor: false,
		identity: "",
		depth: s.depth[i],
		degree: s.adj[i].length,
		isDeadEnd: s.deadEnds.has(i),
		danger: 0,
		occupants: []
	}));
	const byIndex = new Map(rooms.map((r) => [r.index, r]));
	const mobiles = [];
	const wandererGroups = [];
	const entranceRoom = byIndex.get(s.entrance);
	entranceRoom.headline = "none";
	entranceRoom.claimed = true;
	entranceRoom.entranceFeature = roll(DUNGEON_ENTRANCES, rng);
	const goalRoom = byIndex.get(s.goal);
	goalRoom.claimed = true;
	goalRoom.headline = "special";
	goalRoom.goalDirective = {
		reward: blueprint.goalSeed.reward,
		mission: blueprint.goalSeed.mission,
		instruction: "Create one entity in this room that embodies the dungeon goal. Read the dungeon context and decide what type it needs to be -- a creature, a person, an object, a feature of the room itself, or something else the fiction demands. It must be a thing the party can act on, and reaching or resolving it must plausibly satisfy the mission below."
	};
	const groupImplicatesGoal = (g) => g.kind === "people" && (g.goalBranch === "same" || g.goalBranch === "opposed");
	const available = rooms.filter((r) => r.role !== "entrance").map((r) => r.index);
	const takenBases = /* @__PURE__ */ new Set();
	let goalGroupAssigned = false;
	blueprint.inhabitants.forEach((group, gi) => {
		let baseIdx;
		if (!goalGroupAssigned && groupImplicatesGoal(group)) {
			baseIdx = s.goal;
			goalGroupAssigned = true;
		} else {
			const pool = available.filter((i) => !takenBases.has(i) && i !== s.entrance);
			baseIdx = pool.length ? rng.pick(pool) : rng.pick(available);
		}
		takenBases.add(baseIdx);
		const baseRoom = byIndex.get(baseIdx);
		baseRoom.claimed = true;
		baseRoom.headline = "creature";
		const m = makeGroupMobile(group, gi, baseRoom.roomId, true, rng);
		mobiles.push(m);
		baseRoom.occupants.push(m.id);
	});
	designateCorridors(rooms, s, blueprint.size, rng);
	if (opts.layout) {
		const sizes = opts.layout(rooms);
		rooms.forEach((r, i) => {
			r.sizeClass = sizes[i];
		});
	}
	for (const r of rooms) {
		const table = r.isCorridor ? DUNGEON_CORRIDORS : DUNGEON_ROOMS;
		let id = roll(table, rng);
		for (let t = 0; t < 12 && r.sizeClass && !sizeAllows(id, r.sizeClass); t++) id = roll(table, rng);
		r.identity = id;
	}
	const claimedCounts = {
		creature: 0,
		special: 0,
		quiet: 0
	};
	for (const r of rooms) {
		if (!r.claimed || r.headline === "none") continue;
		claimedCounts[r.headline]++;
	}
	const unclaimed = rooms.filter((r) => !r.claimed).map((r) => r.index);
	const quota = computeQuota(rooms.length, claimedCounts, unclaimed.length);
	const assignment = placeHeadlines(unclaimed, quota, s, rng);
	for (const [idx, cat] of assignment) byIndex.get(idx).headline = cat;
	const stackCap = rooms.length >= 18 ? 2 : 1;
	let stacked = 0;
	for (const r of rooms) {
		if (stacked >= stackCap) break;
		if (r.role === "entrance") continue;
		if ((s.maxDepth ? r.depth / s.maxDepth : 0) < .6) continue;
		if (r.headline === "creature" && rng.chance(.3)) {
			r.stacked = "special";
			stacked++;
		}
	}
	for (const r of rooms) {
		if (r.headline !== "creature" || r.claimed) continue;
		const m = makeMinionOrWanderer(blueprint, r.roomId, cohesion, wandererGroups, rng);
		mobiles.push(m);
		r.occupants.push(m.id);
	}
	for (const m of mobiles) {
		if (!m.activity) m.activity = roll(DUNGEON_ACTIVITIES, rng);
		if (!m.disposition) m.disposition = rollDisposition(blueprint, m, rng);
	}
	for (const r of rooms) {
		if (!(r.headline === "special" || r.stacked === "special")) continue;
		if (r.role === "goal" && r.headline === "special" && !r.stacked) continue;
		r.special = rollSpecial(rng);
	}
	for (const r of rooms) {
		if (r.headline !== "quiet") continue;
		if (!rng.chance(.5)) continue;
		r.clue = {
			keyword: roll(CAIRN_CLUE, rng),
			about: ""
		};
	}
	for (const r of rooms) if (rng.chance(.5)) r.detail = roll(DUNGEON_ROOM_DETAILS, rng);
	for (const r of rooms) r.danger = scoreDanger(r, mobiles, s.maxDepth);
	const rewardStats = distributeRewards(rooms, level, s.maxDepth, mobiles, rng);
	resolveClueTargets(rooms, byIndex, s, connectors, mobiles, rng);
	return {
		seed,
		size: blueprint.size,
		level,
		entranceRoomId: entranceRoom.roomId,
		goalRoomId: goalRoom.roomId,
		maxDepth: s.maxDepth,
		rooms,
		mobiles,
		wandererGroups,
		connectors,
		cohesion,
		quota: {
			...quota,
			none: 1
		},
		rewardBudget: rewardStats
	};
}
/**
* A Creature entity is a STACK, not an individual: a statblock template, a
* count, and a location. Any group of creatures sharing a room and a statline
* is one entity. It splits when part of the group is sent elsewhere and merges
* back when they reunite, so entity identity is not stable over play.
*
* DEFERRED -- counts and split/merge live in `state` for now rather than being
* modelled here. Two things to pick up if that stops being good enough:
*   - merging needs a stable key (same template + same room), so templates want
*     an id rather than being compared structurally
*   - a split produces a new entity that shares its parent's immutable `base`
*     while diverging in `state`; base is template-level, state is stack-level
*
* The blueprint already carries the template split this implies: people Hordes
* get one named leader plus `undefinedUnderlings`, monster Hordes get `monster`
* (simple minions) alongside `biggerSpecimen` (same silhouette, higher tier).
* Named NPCs are just count-1 stacks whose stats happen to be unique, so they
* never merge with anything.
*/
function groupLabel(g, gi) {
	return g.kind === "monsters" ? `Group ${gi + 1} (${g.tier} ${g.monster.silhouette} monsters)` : `Group ${gi + 1} (${g.tier} ${g.faction})`;
}
function makeGroupMobile(group, gi, roomId, isBase, rng) {
	const m = {
		id: mobileId(),
		kind: "group-member",
		name: `${groupLabel(group, gi)}${isBase ? " -- BASE" : " -- outpost"}`,
		locationRoomId: roomId,
		groupIndex: gi,
		groupId: group.id,
		isBase,
		tier: group.tier
	};
	if (group.kind === "monsters") m.monster = group.monster;
	return m;
}
/**
* Downgrade a Solo's statline to something a satellite can carry: same creature,
* fewer moving parts. Matches what genMonster would have produced at "simple"
* (one trait/ability line, one feature/mutation line).
*
* The weakness is deliberately INHERITED rather than trimmed. Young share the
* parent's flaw, so a party that fights the brood can learn how to kill the
* thing that spawned it -- which is the same cross-link the knowledge parcels
* lean on, arrived at from the other direction.
*/
function downgradeToSimple(m) {
	return {
		...m,
		complexity: "simple",
		traitsAndAbilities: m.traitsAndAbilities.slice(0, 1),
		featuresAndMutations: m.featuresAndMutations.slice(0, 1),
		weaknesses: m.weaknesses.slice(0, 1)
	};
}
/**
* A Solo is one creature and cannot literally appear twice, but it can have a
* minions. For people, that is a handful of hirelings under their command. For
* monsters, a knot of simple creatures related to it by blood, thrall, or
* ecology.
*/
function makeMinion(group, gi, roomId, rng) {
	const base = {
		id: mobileId(),
		kind: "group-member",
		name: "",
		locationRoomId: roomId,
		groupIndex: gi,
		groupId: group.id,
		isBase: false,
		tier: group.tier
	};
	if (group.kind === "people") return {
		...base,
		name: `${groupLabel(group, gi)} -- hirelings`,
		minion: "hirelings",
		notes: "A handful of hired hands under the Solo's command. Undefined as individuals unless one of them earns a name in play."
	};
	const kind = rng.pick([
		"young",
		"thrall",
		"ecology"
	]);
	if (kind === "young") return {
		...base,
		name: `${groupLabel(group, gi)} -- young`,
		minion: "young",
		monster: downgradeToSimple(group.monster),
		notes: "The Solo's brood. Same creature, scaled down; shares its weakness."
	};
	if (kind === "thrall") return {
		...base,
		name: `${groupLabel(group, gi)} -- thralls`,
		minion: "thrall",
		monster: genMonster("simple", rng),
		notes: "Simple creatures held under the Solo's control, not its kin."
	};
	return {
		...base,
		name: `${groupLabel(group, gi)} -- attendant creatures`,
		minion: "ecology",
		monster: genMonster("simple", rng),
		notes: "Tied to the Solo by ecology rather than obedience or blood. Composition pass establishes the relationship (prey, scavenger, symbiote, parasite...)."
	};
}
/**
* Spend one unit of Creature budget. With probability `cohesion` the encounter
* belongs to the roster; otherwise it is unaffiliated. Cohesion is rolled once
* per dungeon, so some dungeons read as tightly populated by their inhabitants
* and others as a menagerie of unrelated things -- which is its own valid vibe,
* not a failure mode.
*
* Solos now participate, but through minions rather than by duplicating
* themselves, and they weight lower than Bands and Hordes so they still mostly
* stay home.
*/
function makeMinionOrWanderer(bp, roomId, cohesion, wandererGroups, rng) {
	const eligible = bp.inhabitants.map((g, gi) => ({
		g,
		gi
	}));
	if (eligible.length && rng.chance(cohesion)) {
		const weights = eligible.map(({ g }) => g.tier === "Horde" ? 3 : g.tier === "Band" ? 1.5 : .6);
		const total = weights.reduce((a, b) => a + b, 0);
		let x = rng.next() * total;
		let k = 0;
		for (; k < eligible.length; k++) {
			x -= weights[k];
			if (x <= 0) break;
		}
		if (k >= eligible.length) k = eligible.length - 1;
		const { g, gi } = eligible[k];
		return g.tier === "Solo" ? makeMinion(g, gi, roomId, rng) : makeGroupMobile(g, gi, roomId, false, rng);
	}
	const tier = rng.pick([
		"Solo",
		"Band",
		"Horde"
	]);
	if (rng.chance(.5)) {
		const group = genMonsterGroup(tier, rng);
		wandererGroups.push(group);
		return {
			id: mobileId(),
			kind: "wanderer-monster",
			name: "Unaffiliated creature",
			locationRoomId: roomId,
			tier,
			groupId: group.id,
			monster: group.monster
		};
	}
	const group = genPeopleGroup(tier, rng, "wanderer");
	wandererGroups.push(group);
	return {
		id: mobileId(),
		kind: "wanderer-npc",
		name: "Unaffiliated person",
		locationRoomId: roomId,
		tier,
		groupId: group.id,
		npc: group.npcs[0]
	};
}
/**
* Disposition is a property of the encounter, not of the category. Inhabitants
* are usually hostile but genuinely need not be -- a faction whose goal aligns
* with the party's has obvious reason to parley.
*/
function rollDisposition(bp, m, rng) {
	if (m.groupIndex !== void 0) {
		const g = bp.inhabitants[m.groupIndex];
		if (g.kind === "people") {
			if (g.goalBranch === "opposed") return rng.chance(.85) ? "hostile" : "neutral";
			if (g.goalBranch === "same") {
				const r = rng.next();
				return r < .45 ? "hostile" : r < .8 ? "neutral" : "friendly";
			}
			const r = rng.next();
			return r < .55 ? "hostile" : r < .85 ? "neutral" : "friendly";
		}
		return rng.chance(.8) ? "hostile" : "neutral";
	}
	const r = rng.next();
	return r < .6 ? "hostile" : r < .88 ? "neutral" : "friendly";
}
function rollSpecial(rng) {
	if (rng.coin()) {
		if (rng.coin()) return {
			kind: "hazard",
			hazard: roll(DUNGEON_HAZARDS, rng)
		};
		return {
			kind: "hazard",
			trapTrigger: roll(TRAP_TRIGGERS, rng),
			trapEffect: roll(TRAP_EFFECTS, rng)
		};
	}
	const useTrick = rng.chance(.4);
	return {
		kind: "obstacle",
		subject: roll(CAIRN_SPECIAL, rng),
		behaviour: useTrick ? roll(DUNGEON_TRICKS, rng) : roll(CAIRN_FEATURE, rng),
		behaviourSource: useTrick ? "mr-trick" : "cairn-feature"
	};
}
//#endregion
//#region src/engine/equipment.ts
/**
* STANDARD EQUIPMENT
* ==================
*
* One table of everything a shop sells, a gear roll can hand you, or a
* character walks in carrying. The gear tables in `knave-tables.ts` and the
* shop's sections both index into it, so a rope is one object with one price
* and one description however a player came by it.
*
* IT WAS TWO LISTS. Knave prints its starting-gear tables on p.2 and its Item
* Costs on p.3, and they overlap without agreeing: 155 rows between them for
* 113 distinct things, 42 of which were the same name twice, and another 16 the
* same object under two labels — Torches and Torch, Padlock and Padlock and
* key, Instrument and Musical instrument. Prose written per row would have been
* written twice and drifted, which is the thing `knave-tables.ts` opens by
* refusing. So the rows became keys into this, and the two places that print a
* name print the same one.
*
* A TEMPLATE IS AN ITEM, minus the three things only a minted copy can know:
* its id, who is holding it, and whatever its kind rolls for. There is no
* separate shape for "the description of a rope" — an item is an entity and
* carries what every entity carries, so `base`, `state` and `composed` are
* written here, on the entry, in the fields they will end up in.
*
* WHY THE PROSE IS WRITTEN AND NOT GENERATED. `composed` is the only one of the
* three the player has read, and for a gambeson it is the same paragraph in
* every run of every dungeon — a call spent writing it is a call spent
* reproducing a description of a quilted coat. Filling an entry in here retires
* that call forever. An entry left blank is not broken: it mints exactly what
* it minted before this file existed, prose-less, and the runtime writes one
* when it first has to.
*
* WHAT `amount` IS FOR. A count or a measure — "50 feet", "5", "4 hours". The
* Item Costs page also used it for variants (Book *blank*, Spike *iron*, Tent
* *3 man*), which is a different kind of fact entirely; those are folded into
* the name here, so `amount` means one thing.
*
* The cycle between this file and `knave-tables.ts` is types only — the tables
* take `EquipmentKey`, this takes `Spell` — so nothing of it survives to
* runtime.
*/
/**
* Every standard thing, keyed. Prices are Knave's Item Costs page in copper
* pennies, which is also what the thing is WORTH — a shop that sold at one
* number and valued at another would be two tables again.
*
* Armor and weapons are here rather than in a stat table of their own: their
* numbers are item fields, and a gambeson's price, slots, quality and defense
* are four facts about one object.
*/
var STANDARD_EQUIPMENT = {
	gambeson: {
		name: "Gambeson",
		slots: 1,
		quality: 3,
		value: 60,
		itemKind: "armor",
		armor: {
			armorType: "body",
			defense: 12
		},
		base: "A thick quilted jacket of linen or wool, dense enough to provide protection against cuts, scrapes, and impacts.",
		state: "Fresh from the shop.",
		composed: "A thick quilted jacket of linen or wool, dense enough to provide protection against cuts, scrapes, and impacts."
	},
	brigandine: {
		name: "Brigandine",
		slots: 2,
		quality: 4,
		value: 500,
		itemKind: "armor",
		armor: {
			armorType: "body",
			defense: 13
		},
		base: "Protective armor made of small steel plates riveted to a fabric or leather garment.",
		state: "Fresh from the shop.",
		composed: "Protective armor made of small steel plates riveted to a fabric or leather garment."
	},
	chain_armor: {
		name: "Chain",
		slots: 3,
		quality: 5,
		value: 1200,
		itemKind: "armor",
		armor: {
			armorType: "body",
			defense: 14
		},
		base: "A suit of interlocking metal rings, flexible and protective.",
		state: "Fresh from the shop.",
		composed: "A suit of interlocking metal rings, flexible and protective."
	},
	half_plate: {
		name: "Half plate",
		slots: 4,
		quality: 6,
		value: 4e3,
		itemKind: "armor",
		armor: {
			armorType: "body",
			defense: 15
		},
		base: "A partial suit of plated mail, covering the torso and upper legs.",
		state: "Fresh from the shop.",
		composed: "A partial suit of plated mail, covering the torso and upper legs."
	},
	full_plate: {
		name: "Full plate",
		slots: 5,
		quality: 7,
		value: 8e3,
		itemKind: "armor",
		armor: {
			armorType: "body",
			defense: 16
		},
		base: "A full suit of plated mail, covering the torso, arms, and legs. The armor of knights.",
		state: "Fresh from the shop.",
		composed: "A full suit of plated mail, covering the torso, arms, and legs. The armor of knights."
	},
	helmet: {
		name: "Helmet",
		slots: 1,
		quality: 1,
		value: 40,
		itemKind: "armor",
		armor: {
			armorType: "helmet",
			defense: 1
		},
		base: "A protective metal or leather head covering.",
		state: "Fresh from the shop.",
		composed: "A protective metal or leather head covering."
	},
	shield: {
		name: "Shield",
		slots: 1,
		quality: 1,
		value: 40,
		itemKind: "armor",
		armor: {
			armorType: "shield",
			defense: 1
		},
		base: "A round or kite-shaped wooden shield.",
		state: "Fresh from the shop.",
		composed: "A round or kite-shaped wooden shield."
	},
	dagger: {
		name: "Dagger",
		slots: 1,
		quality: 3,
		value: 5,
		itemKind: "weapon",
		weapon: {
			damage: "1d6",
			hands: 1
		},
		base: "A short, pointed blade for stabbing.",
		state: "Fresh from the shop.",
		composed: "A short, pointed blade for stabbing."
	},
	cudgel: {
		name: "Cudgel",
		slots: 1,
		quality: 3,
		value: 5,
		itemKind: "weapon",
		weapon: {
			damage: "1d6",
			hands: 1
		},
		base: "A short, heavy club made of wood or metal.",
		state: "Fresh from the shop.",
		composed: "A short, heavy club made of wood or metal."
	},
	sickle: {
		name: "Sickle",
		slots: 1,
		quality: 3,
		value: 5,
		itemKind: "weapon",
		weapon: {
			damage: "1d6",
			hands: 1
		},
		base: "A bladed farm implement for cutting crops, repurposed as a weapon.",
		state: "Fresh from the shop.",
		composed: "A bladed farm implement for cutting crops, repurposed as a weapon."
	},
	staff: {
		name: "Staff",
		slots: 1,
		quality: 3,
		value: 5,
		itemKind: "weapon",
		weapon: {
			damage: "1d6",
			hands: 1
		},
		base: "A wooden fighting staff.",
		state: "Fresh from the shop.",
		composed: "A wooden fighting staff."
	},
	spear: {
		name: "Spear",
		slots: 2,
		quality: 3,
		value: 10,
		itemKind: "weapon",
		weapon: {
			damage: "1d8",
			hands: 1
		},
		base: "A steel-tipped pole weapon with a long wooden haft.",
		state: "Fresh from the shop.",
		composed: "A steel-tipped pole weapon with a long wooden haft."
	},
	sword: {
		name: "Sword",
		slots: 2,
		quality: 3,
		value: 10,
		itemKind: "weapon",
		weapon: {
			damage: "1d8",
			hands: 1
		},
		base: "A straight, double-edged blade with a hilt and crossguard.",
		state: "Fresh from the shop.",
		composed: "A straight, double-edged blade with a hilt and crossguard."
	},
	mace: {
		name: "Mace",
		slots: 2,
		quality: 3,
		value: 10,
		itemKind: "weapon",
		weapon: {
			damage: "1d8",
			hands: 1
		},
		base: "A flanged metal striking weapon.",
		state: "Fresh from the shop.",
		composed: "A flanged metal striking weapon."
	},
	axe: {
		name: "Axe",
		slots: 2,
		quality: 3,
		value: 10,
		itemKind: "weapon",
		weapon: {
			damage: "1d8",
			hands: 1
		},
		base: "A single-bladed chopping weapon with a wooden handle.",
		state: "Fresh from the shop.",
		composed: "A single-bladed chopping weapon with a wooden handle."
	},
	flail: {
		name: "Flail",
		slots: 2,
		quality: 3,
		value: 10,
		itemKind: "weapon",
		weapon: {
			damage: "1d8",
			hands: 1
		},
		base: "A spiked ball attached to a handle by a chain.",
		state: "Fresh from the shop.",
		composed: "A spiked ball attached to a handle by a chain."
	},
	halberd: {
		name: "Halberd",
		slots: 3,
		quality: 3,
		value: 20,
		itemKind: "weapon",
		weapon: {
			damage: "1d10",
			hands: 2
		},
		base: "A two-handed polearm weapon combining a spear and axe head.",
		state: "Fresh from the shop.",
		composed: "A two-handed polearm weapon combining a spear and axe head."
	},
	war_hammer: {
		name: "War Hammer",
		slots: 3,
		quality: 3,
		value: 20,
		itemKind: "weapon",
		weapon: {
			damage: "1d10",
			hands: 2
		},
		base: "A heavy maul with a large, blunt head and a long haft requiring both hands to wield effectively.",
		state: "Fresh from the shop.",
		composed: "A heavy maul with a large, blunt head and a long haft requiring both hands to wield effectively."
	},
	long_sword: {
		name: "Long Sword",
		slots: 3,
		quality: 3,
		value: 20,
		itemKind: "weapon",
		weapon: {
			damage: "1d10",
			hands: 2
		},
		base: "A large sword with a long, straight blade, designed for two-handed use.",
		state: "Fresh from the shop.",
		composed: "A large sword with a long, straight blade, designed for two-handed use."
	},
	battle_axe: {
		name: "Battle Axe",
		slots: 3,
		quality: 3,
		value: 20,
		itemKind: "weapon",
		weapon: {
			damage: "1d10",
			hands: 2
		},
		base: "A large, two-headed axe designed for combat, requiring two hands to wield effectively.",
		state: "Fresh from the shop.",
		composed: "A large, two-headed axe designed for combat, requiring two hands to wield effectively."
	},
	sling: {
		name: "Sling",
		slots: 1,
		quality: 3,
		value: 5,
		itemKind: "weapon",
		weapon: {
			damage: "1d4",
			hands: 1,
			ranged: true
		},
		base: "A strip of leather with a pouch that is twirled and released to hurl small stones or bullets.",
		state: "Fresh from the shop.",
		composed: "A strip of leather with a pouch that is twirled and released to hurl small stones or bullets."
	},
	bow: {
		name: "Bow",
		slots: 2,
		quality: 3,
		value: 15,
		itemKind: "weapon",
		weapon: {
			damage: "1d6",
			hands: 2,
			ranged: true
		},
		base: "A yew or ash bow used to shoot arrows.",
		state: "Fresh from the shop.",
		composed: "A yew or ash bow used to shoot arrows."
	},
	crossbow: {
		name: "Crossbow",
		slots: 3,
		quality: 3,
		value: 60,
		itemKind: "weapon",
		weapon: {
			damage: "1d8",
			hands: 2,
			ranged: true
		},
		base: "A ranged weapon that uses a bowstring, released by a trigger mechanism, to shoot bolts or quarrels.",
		state: "Fresh from the shop.",
		composed: "A ranged weapon that uses a bowstring, released by a trigger mechanism, to shoot bolts or quarrels."
	},
	air_bladder: {
		name: "Air bladder",
		value: 5,
		base: "An inflatable bag for breathing underwater or floating on water.",
		state: "Fresh from the shop.",
		composed: "An inflatable bag for breathing underwater or floating on water."
	},
	bear_trap: {
		name: "Bear trap",
		value: 20,
		base: "A heavy steel trap with spring-loaded jaws, designed to immobilize large animals or humanoids.",
		state: "Fresh from the shop.",
		composed: "A heavy steel trap with spring-loaded jaws, designed to immobilize large animals or humanoids."
	},
	bedroll: {
		name: "Bedroll",
		value: 10,
		base: "A simple bedroll for sleeping on the ground.",
		state: "Fresh from the shop.",
		composed: "A simple bedroll for sleeping on the ground."
	},
	bellows: {
		name: "Bellows",
		value: 10,
		base: "A device for blowing air into a fire to increase its intensity.",
		state: "Fresh from the shop.",
		composed: "A device for blowing air into a fire to increase its intensity."
	},
	grease: {
		name: "Black grease",
		value: 1,
		base: "Heavy black lubricant or theatrical greasepaint.",
		state: "Fresh from the shop.",
		composed: "Heavy black lubricant or theatrical greasepaint."
	},
	block_and_tackle: {
		name: "Block and tackle",
		value: 30,
		base: "A basic pulley system for lifting heavy objects.",
		state: "Fresh from the shop.",
		composed: "A basic pulley system for lifting heavy objects."
	},
	blank_book: {
		name: "Blank book",
		value: 300,
		base: "An empty book with blank pages, ready to be filled with writing or drawings.",
		state: "Fresh from the shop.",
		composed: "An empty book with blank pages, ready to be filled with writing or drawings."
	},
	reading_book: {
		name: "Book",
		value: 600,
		itemKind: "book",
		base: "An informational text.",
		state: "Fresh from the shop.",
		composed: "An informational text."
	},
	bottle: {
		name: "Bottle",
		value: 1,
		base: "A glass or clay bottle for holding liquids.",
		state: "Fresh from the shop.",
		composed: "A glass or clay bottle for holding liquids."
	},
	bucket: {
		name: "Bucket",
		value: 5,
		base: "A simple bucket for carrying water or other liquids.",
		state: "Fresh from the shop.",
		composed: "A simple bucket for carrying water or other liquids."
	},
	caltrops: {
		name: "Caltrops",
		amount: "1 bag",
		value: 10,
		base: "Iron spikes that can be scattered on the ground to impede movement.",
		state: "Fresh from the shop.",
		composed: "Iron spikes that can be scattered on the ground to impede movement."
	},
	marked_cards: {
		name: "Cards with an extra ace",
		value: 5,
		base: "A set of playing cards with an extra ace, intended for cheating at games of chance.",
		state: "Fresh from the shop.",
		composed: "A set of playing cards with an extra ace, intended for cheating at games of chance."
	},
	chain: {
		name: "Chain",
		amount: "10 feet",
		value: 10,
		base: "A length of iron chain.",
		state: "Fresh from the shop.",
		composed: "A length of iron chain."
	},
	chalk: {
		name: "Chalk",
		amount: "10 pieces",
		value: 1,
		base: "A piece of colored chalk for marking surfaces.",
		state: "Fresh from the shop.",
		composed: "A piece of colored chalk for marking surfaces."
	},
	chisel: {
		name: "Chisel",
		value: 5,
		base: "An iron chisel for carving stone or wood.",
		state: "Fresh from the shop.",
		composed: "An iron chisel for carving stone or wood."
	},
	cookpots: {
		name: "Cookpots",
		value: 10,
		base: "A set of cookware for preparing meals over a fire.",
		state: "Fresh from the shop.",
		composed: "A set of cookware for preparing meals over a fire."
	},
	crowbar: {
		name: "Crowbar",
		value: 10,
		base: "A length of iron with a flattened end for prying open doors or chests.",
		state: "Fresh from the shop.",
		composed: "A length of iron with a flattened end for prying open doors or chests."
	},
	drill: {
		name: "Drill",
		value: 10,
		base: "A hand drill capable of boring into wood or stone.",
		state: "Fresh from the shop.",
		composed: "A hand drill capable of boring into wood or stone."
	},
	face_paint: {
		name: "Face paint",
		value: 10,
		base: "Pigments and makeup for painting the face.",
		state: "Fresh from the shop.",
		composed: "Pigments and makeup for painting the face."
	},
	fake_jewels: {
		name: "Fake jewels",
		value: 50,
		base: "Imitation gemstones made from glass. Good enough to fool a casual observer, but not a jeweler.",
		state: "Fresh from the shop.",
		composed: "Imitation gemstones made from glass. Good enough to fool a casual observer, but not a jeweler."
	},
	fishing_rod: {
		name: "Fishing rod and tackle",
		value: 10,
		base: "Simple fishing equipment for angling.",
		state: "Fresh from the shop.",
		composed: "Simple fishing equipment for angling."
	},
	glass_marbles: {
		name: "Glass marbles",
		amount: "1 bag",
		value: 5,
		base: "A bag of glass marbles.",
		state: "Fresh from the shop.",
		composed: "A bag of glass marbles."
	},
	glue: {
		name: "Glue",
		amount: "1 bottle",
		value: 1,
		base: "A bottle of strong adhesive.",
		state: "Fresh from the shop.",
		composed: "A bottle of strong adhesive."
	},
	grappling_hook: {
		name: "Grappling hook",
		value: 10,
		base: "An iron hook that can be attached to a length of rope to facilitate climbing.",
		state: "Fresh from the shop.",
		composed: "An iron hook that can be attached to a length of rope to facilitate climbing."
	},
	hammer: {
		name: "Hammer",
		value: 10,
		base: "A simple iron hammer.",
		state: "Fresh from the shop.",
		composed: "A simple iron hammer."
	},
	holy_water: {
		name: "Holy water",
		value: 25,
		base: "Water blessed by a priest, repellant to some evil creatures.",
		state: "Fresh from the shop.",
		composed: "Water blessed by a priest, repellant to some evil creatures."
	},
	horn: {
		name: "Horn",
		value: 10,
		base: "A hollow horn that can be blown to make a loud sound.",
		state: "Fresh from the shop.",
		composed: "A hollow horn that can be blown to make a loud sound."
	},
	hourglass: {
		name: "Hourglass",
		value: 300,
		base: "A glass timepiece with sand that runs from one chamber to another in a fixed interval.",
		state: "Fresh from the shop.",
		composed: "A glass timepiece with sand that runs from one chamber to another in a fixed interval."
	},
	incense: {
		name: "Incense",
		amount: "1 packet",
		value: 10,
		base: "A packet of fragrant incense.",
		state: "Fresh from the shop.",
		composed: "A packet of fragrant incense."
	},
	iron_tongs: {
		name: "Iron tongs",
		value: 10,
		base: "Iron tongs for gripping hot metal.",
		state: "Fresh from the shop.",
		composed: "Iron tongs for gripping hot metal."
	},
	ladder: {
		name: "Ladder (10 feet)",
		value: 10,
		base: "A 10-foot wooden ladder.",
		state: "Fresh from the shop.",
		composed: "A 10-foot wooden ladder."
	},
	sponge: {
		name: "Large sponge",
		value: 5,
		base: "A large absorbent sponge for cleaning or bathing.",
		state: "Fresh from the shop.",
		composed: "A large absorbent sponge for cleaning or bathing."
	},
	lens: {
		name: "Lens",
		value: 100,
		base: "A glass optic lens for magnifying or focusing light.",
		state: "Fresh from the shop.",
		composed: "A glass optic lens for magnifying or focusing light."
	},
	lockpicks: {
		name: "Lockpicks",
		value: 100,
		base: "A set of lockpicks for opening locks without a key.",
		state: "Fresh from the shop.",
		composed: "A set of lockpicks for opening locks without a key."
	},
	manacles: {
		name: "Manacles",
		value: 10,
		base: "A set of iron manacles that lock over the wrists or ankles of a prisoner.",
		state: "Fresh from the shop.",
		composed: "A set of iron manacles that lock over the wrists or ankles of a prisoner."
	},
	metal_file: {
		name: "Metal file",
		value: 5,
		base: "A textured metal file for grinding down rough edges.",
		state: "Fresh from the shop.",
		composed: "A textured metal file for grinding down rough edges."
	},
	mirror: {
		name: "Small silver mirror",
		value: 200,
		base: "A luxury handmirror with a silver backing that provides a clear reflection.",
		state: "Fresh from the shop.",
		composed: "A luxury handmirror with a silver backing that provides a clear reflection."
	},
	musical_instrument: {
		name: "Musical instrument",
		value: 200,
		base: "A well-made musical instrument.",
		state: "Fresh from the shop.",
		composed: "A well-made musical instrument."
	},
	nails: {
		name: "Nails",
		amount: "12",
		value: 5,
		base: "Simple iron nails.",
		state: "Fresh from the shop.",
		composed: "Simple iron nails."
	},
	net: {
		name: "Net",
		value: 10,
		base: "A net for catching fish, animals, or people.",
		state: "Fresh from the shop.",
		composed: "A net for catching fish, animals, or people."
	},
	oilskin_bag: {
		name: "Oilskin bag",
		value: 5,
		base: "A waterproof bag made of oiled cotton.",
		state: "Fresh from the shop.",
		composed: "A waterproof bag made of oiled cotton."
	},
	oilskin_trousers: {
		name: "Oilskin trousers",
		value: 10,
		base: "Water repellant trousers made of oiled cotton.",
		state: "Fresh from the shop.",
		composed: "Water repellant trousers made of oiled cotton."
	},
	padlock: {
		name: "Padlock and key",
		value: 20,
		base: "An iron padlock and its matching key.",
		state: "Fresh from the shop.",
		composed: "An iron padlock and its matching key."
	},
	perfume: {
		name: "Perfume",
		value: 50,
		base: "A bottle of fragrant perfume.",
		state: "Fresh from the shop.",
		composed: "A bottle of fragrant perfume."
	},
	pick: {
		name: "Pick",
		value: 10,
		base: "A handheld pickaxe for breaking rock or ice.",
		state: "Fresh from the shop.",
		composed: "A handheld pickaxe for breaking rock or ice."
	},
	pole: {
		name: "Pole",
		amount: "10 feet",
		value: 5,
		base: "A long wooden pole.",
		state: "Fresh from the shop.",
		composed: "A long wooden pole."
	},
	quill_and_ink: {
		name: "Quill and ink",
		value: 1,
		base: "A feather quillpen and a pot of writing ink.",
		state: "Fresh from the shop.",
		composed: "A feather quillpen and a pot of writing ink."
	},
	rope: {
		name: "Rope",
		amount: "50 feet",
		value: 10,
		base: "A length of strong but flexible hemp rope.",
		state: "Fresh from the shop.",
		composed: "A length of strong but flexible hemp rope."
	},
	sack: {
		name: "Sack",
		value: 1,
		base: "A simple cloth or burlap bag for carrying bulk items.",
		state: "Fresh from the shop.",
		composed: "A simple cloth or burlap bag for carrying bulk items."
	},
	saw: {
		name: "Saw",
		value: 10,
		base: "A hand saw for cutting wood or other materials.",
		state: "Fresh from the shop.",
		composed: "A hand saw for cutting wood or other materials."
	},
	loaded_dice: {
		name: "Set of loaded dice",
		value: 5,
		base: "A set of knucklebones for gambling that have been illicitly weighted to favor certain rolls.",
		state: "Fresh from the shop.",
		composed: "A set of knucklebones for gambling that have been illicitly weighted to favor certain rolls."
	},
	shovel: {
		name: "Shovel",
		value: 10,
		base: "A sturdy spade for digging.",
		state: "Fresh from the shop.",
		composed: "A sturdy spade for digging."
	},
	small_bell: {
		name: "Small bell",
		value: 20,
		base: "A small bell that can be used for signaling or as part of an alarm.",
		state: "Fresh from the shop.",
		composed: "A small bell that can be used for signaling or as part of an alarm."
	},
	soap: {
		name: "Soap",
		value: 1,
		base: "Lye-based cleaning soap for washing clothing or the body.",
		state: "Fresh from the shop.",
		composed: "Lye-based cleaning soap for washing clothing or the body."
	},
	iron_spike: {
		name: "Iron spike",
		value: 5,
		base: "A sharp iron spike.",
		state: "Fresh from the shop.",
		composed: "A sharp iron spike."
	},
	wood_spike: {
		name: "Wooden spike",
		value: 1,
		base: "A sharpened wooden stake, suitable for use as a tent peg or against vampires.",
		state: "Fresh from the shop.",
		composed: "A sharpened wooden stake, suitable for use as a tent peg or against vampires."
	},
	spiked_boots: {
		name: "Spiked boots",
		value: 5,
		base: "Climbing boots outfitted with metal crampons for traction.",
		state: "Fresh from the shop.",
		composed: "Climbing boots outfitted with metal crampons for traction."
	},
	spyglass: {
		name: "Spyglass",
		value: 1000,
		base: "A small collapsible telescope.",
		state: "Fresh from the shop.",
		composed: "A small collapsible telescope."
	},
	tar: {
		name: "Tar",
		amount: "1 pot",
		value: 10,
		base: "A pot of sticky black tar, flammable and useful for waterproofing.",
		state: "Fresh from the shop.",
		composed: "A pot of sticky black tar, flammable and useful for waterproofing."
	},
	tent_3man: {
		name: "Three-man tent",
		value: 100,
		base: "A canvas tent with sufficient space for three people and their gear.",
		state: "Fresh from the shop.",
		composed: "A canvas tent with sufficient space for three people and their gear."
	},
	tent_personal: {
		name: "Personal tent",
		value: 50,
		base: "A canvas tent with sufficient space for one person and their gear.",
		state: "Fresh from the shop.",
		composed: "A canvas tent with sufficient space for one person and their gear."
	},
	twine: {
		name: "Twine",
		amount: "300 feet",
		value: 5,
		base: "A length of strong but thin braided cord.",
		state: "Fresh from the shop.",
		composed: "A length of strong but thin braided cord."
	},
	waterskin: {
		name: "Waterskin",
		value: 5,
		base: "A stoppered leather container for carrying water.",
		state: "Fresh from the shop.",
		composed: "A stoppered leather container for carrying water."
	},
	whistle: {
		name: "Whistle",
		value: 5,
		base: "A tin whistle, surprisingly loud for its size, suitable for signaling over a distance.",
		state: "Fresh from the shop.",
		composed: "A tin whistle, surprisingly loud for its size, suitable for signaling over a distance."
	},
	candle: {
		name: "Candle",
		amount: "4 hours",
		value: 1,
		base: "A wax candle, suitable for lighting a small area.",
		state: "Fresh from the shop.",
		composed: "A wax candle, suitable for lighting a small area."
	},
	lantern: {
		name: "Lantern",
		value: 30,
		base: "A portable light source with a glass enclosure and a wick, fueled by lamp oil.",
		state: "Fresh from the shop.",
		composed: "A portable light source with a glass enclosure and a wick, fueled by lamp oil."
	},
	lamp_oil: {
		name: "Lamp oil",
		amount: "4 hours",
		value: 5,
		base: "A flask of oil for a lantern or lamp.",
		state: "Fresh from the shop.",
		composed: "A flask of oil for a lantern or lamp."
	},
	tinderbox: {
		name: "Tinderbox",
		value: 10,
		base: "A small box containing flint, steel, and tinder for starting a fire.",
		state: "Fresh from the shop.",
		composed: "A small box containing flint, steel, and tinder for starting a fire."
	},
	torch: {
		name: "Torch",
		amount: "1 hour",
		value: 1,
		base: "A wooden stick with one end wrapped in flammable cloth soaked in pitch or tallow.",
		state: "Fresh from the shop.",
		composed: "A wooden stick with one end wrapped in flammable cloth soaked in pitch or tallow."
	},
	arrows: {
		name: "Arrows",
		amount: "20",
		value: 5,
		base: "Arrows for a bow or crossbow.",
		state: "Fresh from the shop.",
		composed: "Arrows for a bow or crossbow."
	},
	quiver: {
		name: "Quiver",
		amount: "20 arrows",
		value: 10,
		base: "A quiver of arrows.",
		state: "Fresh from the shop.",
		composed: "A quiver of arrows."
	},
	rations: {
		name: "Travel rations",
		amount: "1 day",
		value: 5,
		base: "Some combination of hardtack, cured meat, dried fruit and nuts, and other stable foods suitable for a long journey.",
		state: "Fresh from the shop.",
		composed: "Some combination of hardtack, cured meat, dried fruit and nuts, and other stable foods suitable for a long journey."
	},
	animal_feed: {
		name: "Animal feed",
		amount: "1 day",
		value: 2,
		base: "A sack of grain or hay for feeding livestock.",
		state: "Fresh from the shop.",
		composed: "A sack of grain or hay for feeding livestock."
	},
	salt: {
		name: "Salt",
		amount: "1 bushel",
		value: 3,
		base: "A bushel of salt, a valuable preservative, commonly used as currency where coin is of no use.",
		state: "Fresh from the shop.",
		composed: "A bushel of salt, a valuable preservative, commonly used as currency where coin is of no use."
	},
	spices: {
		name: "Spices",
		amount: "1 lb",
		value: 100,
		base: "A cask of exotic spices, a valuable commodity.",
		state: "Fresh from the shop.",
		composed: "A cask of exotic spices, a valuable commodity."
	},
	sugar: {
		name: "Sugar",
		amount: "1 lb",
		value: 12,
		base: "A cask of granulated sugar, a valuable sweetener and preservative.",
		state: "Fresh from the shop.",
		composed: "A cask of granulated sugar, a valuable sweetener and preservative."
	},
	card_deck: {
		name: "Card deck",
		value: 5,
		base: "A deck of cards suitable for a number of commonly played games, some intended for gambling.",
		state: "Fresh from the shop.",
		composed: "A deck of cards suitable for a number of commonly played games, some intended for gambling."
	},
	dice_set: {
		name: "Dice set",
		value: 5,
		base: "A set of knucklebones for gambling or games of chance.",
		state: "Fresh from the shop.",
		composed: "A set of knucklebones for gambling or games of chance."
	},
	spellbook: {
		name: "Spellbook",
		slots: 1,
		value: 500,
		itemKind: "spellbook",
		base: "A tome of arcane knowledge. Reading aloud from it casts a spell.",
		state: "Fresh from the shop.",
		composed: "A tome of arcane knowledge. Reading aloud from it casts a spell."
	},
	copper: {
		name: "Copper",
		slots: 0,
		value: 0,
		base: "Copper pennies, coin of the realm.",
		state: "Worn but spendable.",
		composed: "Copper pennies, coin of the realm."
	}
};
Object.keys(STANDARD_EQUIPMENT);
var written = (s) => {
	const t = s?.trim();
	return t === "" ? void 0 : t;
};
/**
* The part every item has, whatever kind it is.
*
* `composed` falls back to `base` and settles the description debt, which is
* the point of the whole file: a thing that arrives described is never swept up
* by a composition pass. An entry with no prose at all stays undescribed and
* `needUpdate` is left alone, so an unfilled table mints what it always did.
*/
function mintCommon(t, parentId, over) {
	const base = written(t.base);
	const state = written(t.state) ?? (base === void 0 ? void 0 : "Sound and unremarkable; nothing has happened to it yet.");
	const composed = written(t.composed) ?? base;
	const amount = over.amount ?? t.amount;
	return {
		id: makeId(),
		name: t.name,
		type: "Item",
		parentId,
		slots: t.slots ?? 1,
		value: over.value ?? t.value,
		...amount !== void 0 ? { amount } : {},
		...t.quality !== void 0 ? {
			quality: t.quality,
			currentQuality: t.quality
		} : {},
		...base !== void 0 ? { base } : {},
		...state !== void 0 ? { state } : {},
		...composed !== void 0 ? {
			composed,
			needUpdate: false
		} : {}
	};
}
/**
* Maze Rats: a book is about something.
*
* The subject is rolled here because it is what the book IS. How much is in it
* is not — `uses` starts at nothing and climbs as the book is read, and whether
* a reading was the last one is settled at the reading. See `consultRoll`.
*/
function mintBook(t, rng) {
	const uses = t.book?.uses ?? 0;
	if (t.book?.subject !== void 0) return {
		subject: t.book.subject,
		uses
	};
	if (!rng) throw new Error(`${t.name} is a book and rolls for its subject — mint it with an Rng`);
	return {
		subject: rollBookSubject(rng),
		uses
	};
}
/**
* An item from a template, which is what every mint here comes down to.
*
* Separate from `mintItem` so that a template built somewhere else — a test, or
* a thing the fiction has just invented — goes through exactly the same door as
* a table entry, rather than through a second construction that could disagree
* with it.
*
* The `Rng` is optional because most kinds roll for nothing — a purse of copper
* and a coil of rope are entirely decided by the template — and required in
* practice for the one kind that does. Which kinds those are is this file's
* business rather than the caller's, so a book minted without a stream throws
* here rather than quietly inventing what is written in it.
*/
function mintTemplate(t, parentId, rng, over = {}) {
	const item = mintCommon(t, parentId, over);
	switch (t.itemKind) {
		case "weapon": return {
			...item,
			itemKind: "weapon",
			weapon: { ...t.weapon }
		};
		case "armor": return {
			...item,
			itemKind: "armor",
			armor: { ...t.armor }
		};
		case "book": return {
			...item,
			itemKind: "book",
			book: mintBook(t, rng)
		};
		case "spellbook": throw new Error(`${t.name} is a spellbook — mint it with mintSpellbook, which knows the spell`);
		default: return item;
	}
}
/** One standard thing, ready to be carried. */
function mintItem(key, parentId, rng, over = {}) {
	return mintTemplate(STANDARD_EQUIPMENT[key], parentId, rng, over);
}
/**
* Copper for a thing that was never on a price list.
*
* Anchored to Knave's own numbers rather than invented from nothing: a starting
* purse is 3d6×20 (60–360cp), a gambeson is 60 and a spyglass 1000, so a
* mundane find is gear money, a notable one is armour money, and a significant
* one beats full plate. Each band is ten times the one under it.
*
* THE MODEL NEVER PICKS THIS. A referee that priced its own treasure would be
* generating a number; what it may do is say which of the three grades a thing
* is, which is a judgement about fiction, and the dice do the rest.
*/
var VALUE_BANDS = {
	mundane: [10, 120],
	notable: [120, 1200],
	significant: [1200, 12e3]
};
function rollItemValue(rng, grade) {
	const [lo, hi] = VALUE_BANDS[grade];
	const raw = rng.range(lo, hi);
	const step = raw >= 1e3 ? 100 : raw >= 100 ? 10 : 5;
	return Math.max(lo, Math.round(raw / step) * step);
}
//#endregion
//#region src/engine/dungeon-entities-pass.ts
/**
* Knave gives a monster's Hit Dice, and HD then fills the six ability bonuses,
* the attack bonus, and max HP. Nothing upstream produces HD, so it is derived
* here: the DUNGEON LEVEL is the base and COMPLEXITY modifies it.
*
*   major    level +1 to +2   the set piece
*   complex  level +0 to +1   a peer threat
*   simple   level -1 to  0   chaff, dangerous in numbers
*
* Complexity, NOT tier. Tier says how many creatures the entity represents --
* one thing, a band, a swarm -- which is orthogonal to how hard each of them
* hits. Keying HD to tier made a Solo's thralls as tough as the Solo, and gave
* every lone wanderer boss-tier dice just for being alone. Group members get
* their complexity from their tier (a Band IS complex); minions and
* unaffiliated creatures carry their own.
*
* A group's leader sits one die above its rank and file, which is what
* `isLeader` is for -- see the note on leaders in emitCreature().
*
* Clamped to 1..10 because Knave ability bonuses top out at +10 and a monster's
* bonuses default to its HD; past that the derived defenses stop making sense.
*/
var COMPLEXITY_HD_OFFSET = {
	major: [1, 2],
	complex: [0, 1],
	simple: [-1, 0]
};
function hitDiceFor(complexity, level, rng, isLeader = false) {
	const [lo, hi] = COMPLEXITY_HD_OFFSET[complexity];
	const hd = level + rng.range(lo, hi) + (isLeader ? 1 : 0);
	return Math.max(1, Math.min(10, hd));
}
function statsFor(complexity, level, rng, isLeader = false) {
	const hd = hitDiceFor(complexity, level, rng, isLeader);
	return {
		hitDice: hd,
		hp: hd * 4,
		modifiers: {}
	};
}
var kw = (...r) => r.filter((x) => !!x);
/**
* A parcel is a thing you carry off or a thing you learn. Loot is an item;
* knowledge, leverage, and boons are things the room holds -- an inscription, a
* bound favour, a working mechanism -- so they land as features. See OPEN #4.
*/
function parcelIsItem(p) {
	return p.type === "material" || p.type === "relic";
}
/**
* Every creature's prose identity has to resolve to a dungeon-level template.
* Three cases fall out of how stocking builds mobiles:
*
*  1. Group base / outpost -- shares the group's rolled seed, so it points
*     straight at the group id and stores nothing of its own.
*  2. Minions (young / thrall / ecology / hirelings) -- attached to an
*     inhabitant group but rolled their OWN seed, so they need their own
*     template. Affiliation is kept separately on `affiliationGroupId`.
*  3. Wanderers -- their own group, created during stocking rather than during
*     dungeon generation. Structurally identical to case 1: point at the group.
*
* NOTE ON LEADERS: nothing at this stage is marked as a leader. A people group
* is placed as a collective encounter and the writing pass decides which named
* NPCs are present, so the leader does not exist as its own mobile yet. When it
* creates one, statsFor(..., isLeader = true) is the die it should get.
*/
/**
* Create one creature from a group. This is the single path by which creatures
* come into being, used both by this pass and by the writing pass at runtime.
*
* A creature room's stocking produces ONE mobile, which stands for the whole
* encounter rather than for one body. How many creatures actually populate that
* room is a reading of the fiction -- three militia at a checkpoint, a dozen
* rats, one ogre -- so the writing pass calls this as many times as the scene
* wants, and picks a `member` for each so they resolve to different people.
*
*   member  absent   the group's base monster, or an unnamed member of a
*                    people group -- the anonymous rank and file
*           "elite"  a monster group's biggerSpecimen
*           <npc id> a specific NpcSeed from a people group
*
* `isLeader` adds a die, for the named head of a group.
* `minion` forces the simple band regardless of what the group is.
*/
function createCreatureFromGroup(group, roomId, level, rng, opts = {}) {
	const complexity = opts.minion ? "simple" : TIER_COMPLEXITY[group.tier];
	return {
		id: makeId(),
		name: opts.name ?? "",
		type: "Creature",
		roomId,
		stats: statsFor(complexity, level, rng, opts.isLeader),
		narrative: {
			blueprintId: group.id,
			...opts.member ? { member: opts.member } : {}
		}
	};
}
/**
* Create a creature that belongs to no group -- a minion with its own rolled
* seed, or anything the writing pass invents that needs its own identity. The
* seed is registered as a dungeon-level template so repeat instances stay
* consistent, per the rule that prose identity never lives on the creature.
*/
function createCreatureFromSeed(seed, roomId, level, complexity, registry, rng, opts = {}) {
	const tpl = {
		id: makeId(),
		seed
	};
	registry.creatures[tpl.id] = tpl;
	const c = {
		id: makeId(),
		name: opts.name ?? "",
		type: "Creature",
		roomId,
		stats: statsFor(complexity, level, rng, opts.isLeader),
		narrative: { blueprintId: tpl.id }
	};
	if (opts.affiliationGroupId) c.affiliationGroupId = opts.affiliationGroupId;
	return c;
}
function emitCreature(m, groups, level, registry, rng) {
	const group = m.groupId ? groups.get(m.groupId) : void 0;
	const tier = m.tier ?? group?.tier ?? "Band";
	const complexity = m.minion ? "simple" : m.monster?.complexity ?? TIER_COMPLEXITY[tier];
	if (group && m.minion === void 0) {
		const c = createCreatureFromGroup(group, m.locationRoomId, level, rng, { name: m.name });
		if (m.monster && m.monster.complexity !== TIER_COMPLEXITY[group.tier]) c.stats = statsFor(m.monster.complexity, level, rng);
		return c;
	}
	return createCreatureFromSeed(m.monster ?? m.npc, m.locationRoomId, level, complexity, registry, rng, {
		affiliationGroupId: group?.id,
		name: m.name
	});
}
function runEntitiesPass(sd, bp, rng = new Rng(sd.seed)) {
	const registry = {
		creatures: {},
		hazards: {},
		groups: {}
	};
	const rooms = [];
	const connectors = [];
	const creatures = [];
	const features = [];
	const items = [];
	const hazards = [];
	const effects = [];
	const bindings = [];
	const detailCandidates = [];
	const bind = (entityId, roomId, element, keywords) => bindings.push({
		entityId,
		roomId,
		element,
		keywords
	});
	for (const r of sd.rooms) {
		const room = {
			id: r.roomId,
			name: "",
			type: "Room"
		};
		if (r.detail) detailCandidates.push({
			roomId: r.roomId,
			text: r.detail
		});
		if (r.special) if (r.special.kind === "hazard") {
			const seed = {
				id: makeId(),
				effect: r.special.hazard ?? r.special.trapEffect,
				trigger: r.special.trapTrigger ?? ""
			};
			registry.hazards[seed.id] = seed;
			const h = {
				id: makeId(),
				name: "",
				type: "Hazard",
				blueprintId: seed.id,
				sprung: false,
				active: r.special.trapTrigger === void 0
			};
			hazards.push(h);
			room.hazardId = h.id;
			bind(h.id, r.roomId, "hazard", kw(r.special.hazard, r.special.trapTrigger, r.special.trapEffect));
		} else {
			const f = {
				id: makeId(),
				name: "",
				type: "RoomFeature",
				roomId: r.roomId
			};
			features.push(f);
			bind(f.id, r.roomId, "obstacle", kw(r.special.subject, r.special.behaviour));
		}
		if (r.clue) {
			const f = {
				id: makeId(),
				name: "",
				type: "RoomFeature",
				roomId: r.roomId
			};
			features.push(f);
			bind(f.id, r.roomId, "clue", kw(r.clue.keyword));
		}
		if (r.reward) if (parcelIsItem(r.reward)) {
			const it = {
				id: makeId(),
				name: "",
				type: "Item",
				parentId: r.roomId,
				slots: 1,
				value: rollItemValue(rng, r.reward.grade)
			};
			items.push(it);
			bind(it.id, r.roomId, "reward", kw(r.reward.content));
		} else {
			const f = {
				id: makeId(),
				name: "",
				type: "RoomFeature",
				roomId: r.roomId
			};
			features.push(f);
			bind(f.id, r.roomId, "reward", kw(r.reward.content));
		}
		rooms.push(room);
	}
	const groups = /* @__PURE__ */ new Map();
	for (const g of [...bp.inhabitants, ...sd.wandererGroups]) groups.set(g.id, g);
	for (const m of sd.mobiles) {
		const c = emitCreature(m, groups, sd.level, registry, rng);
		creatures.push(c);
		bind(c.id, m.locationRoomId, "creature", kw(m.activity));
	}
	for (const c of sd.connectors) {
		const conn = {
			id: c.id,
			name: "",
			type: "RoomConnector",
			endpointA: c.a,
			endpointB: c.b
		};
		if (c.gated) conn.conditional = c.requirement ?? "[gated -- condition not yet written]";
		if (c.hidden) conn.isHidden = true;
		connectors.push(conn);
		bind(conn.id, c.a, "connector", []);
	}
	const entranceRoom = sd.rooms.find((r) => r.roomId === sd.entranceRoomId);
	if (entranceRoom) {
		const way = {
			id: makeId(),
			name: "",
			type: "RoomConnector",
			endpointA: entranceRoom.roomId,
			endpointB: null
		};
		connectors.push(way);
		bind(way.id, entranceRoom.roomId, "connector", kw(entranceRoom.entranceFeature));
	}
	const goalRoom = sd.rooms.find((r) => r.goalDirective);
	return {
		registry,
		rooms,
		connectors,
		creatures,
		features,
		items,
		hazards,
		effects,
		bindings,
		detailCandidates,
		pendingGoal: {
			roomId: goalRoom.roomId,
			reward: goalRoom.goalDirective.reward,
			mission: goalRoom.goalDirective.mission,
			instruction: goalRoom.goalDirective.instruction
		}
	};
}
/**
* Turn a detail the writing pass judged interactive into a real entity. The
* detail stays in the room's description either way -- promoting it does not
* remove it from the prose, it gives the player something to act on.
*/
function promoteDetail(c, res) {
	const f = {
		id: makeId(),
		name: "",
		type: "RoomFeature",
		roomId: c.roomId
	};
	res.features.push(f);
	res.bindings.push({
		entityId: f.id,
		roomId: c.roomId,
		element: "detail",
		keywords: [c.text]
	});
	return f;
}
/**
* A fixture from the content pass, as a real feature of the room.
*
* The mirror of `promoteDetail`, and deliberately the same shape: a thing the
* writing pass decided to add, minted here so the entity layer stays the one
* place entities come from. The caller fills in name, base and `place`.
*
* There is no binding for it. `ElementBinding` ties an entity back to the
* STOCKED element it came from, and a fixture came from no roll — it is the
* model furnishing a room whose footprint code had already drawn. Nothing later
* looks a fixture up by element, so a binding would be a row that only ever gets
* filtered out.
*/
function addFixture(roomId, res) {
	const f = {
		id: makeId(),
		name: "",
		type: "RoomFeature",
		roomId
	};
	res.features.push(f);
	return f;
}
/** See `Outline` — measured, and re-measure before changing either. */
var FILL_RECTANGULAR = .85;
var FILL_NOTCHED = .6;
var WALLS = [
	"north",
	"south",
	"east",
	"west"
];
/** The step from a cell to the cell outside it, through the named wall. */
var STEP = {
	north: {
		x: 0,
		y: -1
	},
	south: {
		x: 0,
		y: 1
	},
	east: {
		x: 1,
		y: 0
	},
	west: {
		x: -1,
		y: 0
	}
};
/** Which two compass words name the ends of this wall, low first. */
var ENDS = {
	north: ["west", "east"],
	south: ["west", "east"],
	east: ["north", "south"],
	west: ["north", "south"]
};
var cellKey$1 = (p) => `${p.x},${p.y}`;
function boundingBox(cells) {
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (const c of cells) {
		if (c.x < minX) minX = c.x;
		if (c.y < minY) minY = c.y;
		if (c.x > maxX) maxX = c.x;
		if (c.y > maxY) maxY = c.y;
	}
	return {
		x: minX,
		y: minY,
		w: maxX - minX + 1,
		h: maxY - minY + 1
	};
}
/**
* The floor cells that back onto each side.
*
* A cell is on the north wall when the cell above it is not this room's — which
* is what "along the north wall" has to mean for a room that is not a rectangle.
* An L has north-facing floor at two different heights and both of them are
* genuinely the north wall of the part of the room they are in.
*/
function wallCells(cells) {
	const mine = new Set(cells.map(cellKey$1));
	const out = {
		north: [],
		south: [],
		east: [],
		west: []
	};
	for (const c of cells) for (const w of WALLS) {
		const s = STEP[w];
		if (!mine.has(cellKey$1({
			x: c.x + s.x,
			y: c.y + s.y
		}))) out[w].push(c);
	}
	return out;
}
/**
* The longest unbroken stretch of one wall, in cells.
*
* Not the count of wall cells: a room with four separate two-cell stretches of
* north wall has no north wall a player would describe as one thing. Runs are
* taken within a single row (or column), so the two arms of an L do not add up.
*/
function longestRun(facing, wall) {
	const horizontal = wall === "north" || wall === "south";
	const rows = /* @__PURE__ */ new Map();
	for (const c of facing) {
		const row = horizontal ? c.y : c.x;
		const along = horizontal ? c.x : c.y;
		const list = rows.get(row);
		if (list) list.push(along);
		else rows.set(row, [along]);
	}
	let best = 0;
	for (const list of rows.values()) {
		list.sort((a, b) => a - b);
		let run = 1;
		for (let i = 1; i <= list.length; i++) if (i < list.length && list[i] === list[i - 1] + 1) run++;
		else {
			if (run > best) best = run;
			run = 1;
		}
	}
	return best;
}
/**
* How far along its wall a cell sits: toward one end, or in the middle.
*
* Thirds of the bounding box, and a wall shorter than four cells has no ends
* worth naming — "toward the west end" of a three-foot stretch is a distinction
* the player cannot act on, so it comes back null.
*/
function alongWall(cell, wall, box) {
	const horizontal = wall === "north" || wall === "south";
	const span = horizontal ? box.w : box.h;
	if (span < 4) return null;
	const offset = horizontal ? cell.x - box.x : cell.y - box.y;
	const [low, high] = ENDS[wall];
	if (offset < span / 3) return low;
	if (offset >= span * 2 / 3) return high;
	return null;
}
/** Which wall of the room a door in `from` leading to `to` cuts through. */
function wallOf(from, to) {
	if (to.y < from.y) return "north";
	if (to.y > from.y) return "south";
	if (to.x > from.x) return "east";
	return "west";
}
/**
* How far each room is from the way in, in rooms.
*
* Computed here rather than read off `RoomStock.depth` so this module needs only
* the graph and the plan. That keeps it testable against a bare graph and keeps
* the drawing independent of the stocking, which is the same separation the
* block plan itself makes.
*/
function roomDepths(graph) {
	const depth = graph.rooms.map(() => Infinity);
	const adj = graph.rooms.map(() => []);
	for (const e of graph.edges) {
		adj[e.a].push(e.b);
		adj[e.b].push(e.a);
	}
	const queue = [...graph.entrances];
	for (const r of queue) depth[r] = 0;
	for (let i = 0; i < queue.length; i++) {
		const at = queue[i];
		for (const n of adj[at]) {
			if (depth[n] !== Infinity) continue;
			depth[n] = depth[at] + 1;
			queue.push(n);
		}
	}
	return depth;
}
/**
* One `RoomGeometry` per room, in graph index order.
*
* Pure, cheap, and derived — nothing here is persisted. The block plan is the
* durable thing and this is a reading of it, so a change to the vocabulary is a
* change to one function rather than a migration.
*/
function roomGeometry(plan, graph, opts = {}) {
	const corridorAt = opts.isCorridor ?? (() => false);
	const depth = roomDepths(graph);
	const exitsOf = graph.rooms.map(() => []);
	const byPair = /* @__PURE__ */ new Map();
	for (const e of graph.edges) byPair.set(`${Math.min(e.a, e.b)}-${Math.max(e.a, e.b)}`, e.entityId);
	const boxes = plan.rooms.map((cells) => boundingBox(cells));
	for (const d of plan.doors) {
		const connectorId = byPair.get(`${Math.min(d.a, d.b)}-${Math.max(d.a, d.b)}`) ?? null;
		exitsOf[d.a].push({
			connectorId,
			to: d.b,
			wall: wallOf(d.from, d.to),
			along: alongWall(d.from, wallOf(d.from, d.to), boxes[d.a])
		});
		exitsOf[d.b].push({
			connectorId,
			to: d.a,
			wall: wallOf(d.to, d.from),
			along: alongWall(d.to, wallOf(d.to, d.from), boxes[d.b])
		});
	}
	if (plan.surface) {
		const { room, from, to } = plan.surface;
		exitsOf[room].push({
			connectorId: null,
			to: null,
			wall: wallOf(from, to),
			along: alongWall(from, wallOf(from, to), boxes[room])
		});
	}
	return plan.rooms.map((cells, i) => {
		const box = boxes[i];
		const facing = wallCells(cells);
		const long = Math.max(box.w, box.h);
		const short = Math.min(box.w, box.h);
		const ratio = long / Math.max(short, 1);
		const fill = cells.length / (box.w * box.h);
		const exits = exitsOf[i];
		const arrival = exits.find((x) => x.to === null) ?? exits.filter((x) => x.to !== null).sort((a, b) => depth[a.to] - depth[b.to])[0];
		return {
			room: i,
			corridor: corridorAt(i),
			area: cells.length,
			box: {
				w: box.w,
				h: box.h
			},
			feet: {
				w: box.w * 5,
				h: box.h * 5
			},
			sizeClass: classOf(cells.length),
			proportion: ratio >= 2 ? "long" : ratio >= 1.25 ? "moderate" : "square",
			longAxis: ratio < 1.25 ? null : box.h > box.w ? "north-south" : "east-west",
			outline: fill >= FILL_RECTANGULAR ? "rectangular" : fill >= FILL_NOTCHED ? "notched" : "ragged",
			walls: {
				north: longestRun(facing.north, "north"),
				south: longestRun(facing.south, "south"),
				east: longestRun(facing.east, "east"),
				west: longestRun(facing.west, "west")
			},
			exits,
			arrival
		};
	});
}
function roomGround(plan, geoms) {
	const doorCells = plan.rooms.map(() => []);
	/** the cell of room `i` that the door to room `j` sits in */
	const cellToward = /* @__PURE__ */ new Map();
	for (const d of plan.doors) {
		doorCells[d.a].push(d.from);
		doorCells[d.b].push(d.to);
		cellToward.set(`${d.a}>${d.b}`, d.from);
		cellToward.set(`${d.b}>${d.a}`, d.to);
	}
	if (plan.surface) {
		doorCells[plan.surface.room].push(plan.surface.from);
		cellToward.set(`${plan.surface.room}>out`, plan.surface.from);
	}
	return plan.rooms.map((cells, i) => {
		const arrival = geoms[i]?.arrival;
		return {
			room: i,
			cells,
			doorCells: doorCells[i],
			arrivalCell: arrival ? cellToward.get(`${i}>${arrival.to ?? "out"}`) : void 0
		};
	});
}
function siteRooms(plan, graph, opts = {}) {
	const geometry = roomGeometry(plan, graph, opts);
	return {
		geometry,
		ground: roomGround(plan, geometry)
	};
}
/** "toward the west end" / "at the middle" — how an `Along` is said. */
function alongPhrase(along) {
	return along === null ? "at the middle" : `toward the ${along} end`;
}
/** "the north wall, toward the west end" — how an exit's position is said. */
function exitPhrase(exit) {
	return `the ${exit.wall} wall, ${alongPhrase(exit.along)}`;
}
/**
* The room's shape as one line, for a prompt.
*
* Deliberately one line and deliberately plain. It sits among twenty other
* fields in a room brief, and anything longer would start competing with the
* fiction for the model's attention — which is the opposite of the point. The
* dimensions are the load-bearing part; everything else is a qualifier on them.
*/
/**
* The proportion axis as an adjective.
*
* `moderate` is the name of a band and not a word anybody would use about a
* room — "a small moderate chamber" reads as a mistake. The bands do not change;
* only what they are called on the page does.
*/
var SHAPE_WORD = {
	square: "roughly square",
	moderate: "oblong",
	long: "long and narrow"
};
var OUTLINE_WORD = {
	rectangular: "close to a rectangle, give or take a corner",
	notched: "irregular, its walls stepping in and out",
	ragged: "ragged, nothing like a rectangle"
};
function describeGeometry(g, opts = {}) {
	const kind = g.corridor ? "a passage" : `a ${g.sizeClass} chamber`;
	const runs = g.longAxis ? `, running ${g.longAxis}` : "";
	const byWall = /* @__PURE__ */ new Map();
	for (const x of g.exits) {
		if (x.connectorId !== null && opts.omit?.has(x.connectorId)) continue;
		const list = byWall.get(x.wall);
		if (list) list.push(x);
		else byWall.set(x.wall, [x]);
	}
	const ways = WALLS.filter((w) => byWall.has(w)).map((w) => `${wordFor(byWall.get(w).length)} off the ${w} wall`).join(", ");
	return `${kind}, about ${g.feet.w} by ${g.feet.h} feet -- ${SHAPE_WORD[g.proportion]}${runs}, ${OUTLINE_WORD[g.outline]}` + (ways ? `. Ways out: ${ways}` : "");
}
/**
* Counts in words, because the payload should not read as though a number were
* being handed over to be reasoned with. Past four it stops mattering.
*/
function wordFor(n) {
	return [
		"no",
		"one",
		"two",
		"three",
		"four",
		"five",
		"six",
		"seven",
		"eight"
	][n] ?? `${n}`;
}
//#endregion
//#region src/engine/dungeon-fixtures.ts
var FIXTURE_KINDS = [
	"altar",
	"bunks",
	"cells",
	"hearth",
	"pews",
	"pillars",
	"pit",
	"pool",
	"rubble",
	"sarcophagi",
	"shelves",
	"stair",
	"stalls",
	"well"
];
var POSITION_WORDS = [
	"north wall",
	"south wall",
	"east wall",
	"west wall",
	"centre",
	"a corner",
	"near the entrance",
	"far end",
	"throughout"
];
/**
* A position word as something you could say out loud.
*
* The words are ENUM VALUES — short, unambiguous, easy for a model to pick from
* a list — and they do not survive being dropped into a sentence: "at
* throughout" and "at near the entrance" are what a naive prefix produces. So
* the wire form and the prose form are separate, and this is the only place the
* second one is decided.
*
* Falls through unchanged for anything it does not recognise, because the
* caller is rendering an entity that was stored, not validating a response.
*/
var POSITION_PHRASE = {
	"north wall": "along the north wall",
	"south wall": "along the south wall",
	"east wall": "along the east wall",
	"west wall": "along the west wall",
	centre: "in the middle of the room",
	"a corner": "in a corner",
	"near the entrance": "near the way in",
	"far end": "at the far end",
	throughout: "spread through the room"
};
function positionPhrase(word) {
	return isPositionWord(word) ? POSITION_PHRASE[word] : word;
}
/**
* The fifteen drawable things, and what each one implies about its placement.
*
* Adding to this list is a one-line change and deliberately so: the enum is the
* whole contract, and a kind that draws as a dot needs nothing but a gloss, a
* count and two flags.
*/
var FIXTURES = {
	altar: {
		gloss: "a raised block for offering, execution or display",
		count: [1, 1],
		hugsWall: false,
		corridor: false
	},
	bunks: {
		gloss: "tiers of sleeping berths",
		count: [3, 6],
		hugsWall: true,
		corridor: false
	},
	cells: {
		gloss: "barred or barricaded holding cells",
		count: [2, 5],
		hugsWall: true,
		corridor: false
	},
	hearth: {
		gloss: "a fire pit, forge or chimney breast",
		count: [1, 1],
		hugsWall: true,
		corridor: false
	},
	pews: {
		gloss: "ranked benches facing one way",
		count: [4, 8],
		hugsWall: false,
		corridor: false
	},
	pillars: {
		gloss: "columns holding the ceiling up",
		count: [2, 6],
		hugsWall: false,
		corridor: true
	},
	pit: {
		gloss: "an opening in the floor -- a shaft, a sump, a grave",
		count: [1, 1],
		hugsWall: false,
		corridor: true
	},
	pool: {
		gloss: "standing water, clean or otherwise",
		count: [1, 1],
		hugsWall: false,
		corridor: false
	},
	rubble: {
		gloss: "fallen stone and debris",
		count: [1, 3],
		hugsWall: false,
		corridor: true
	},
	sarcophagi: {
		gloss: "stone coffins, niches or shelves for the dead",
		count: [2, 5],
		hugsWall: true,
		corridor: true
	},
	shelves: {
		gloss: "racking, stacks or storage",
		count: [2, 4],
		hugsWall: true,
		corridor: true
	},
	stair: {
		gloss: "steps within the room, going nowhere else",
		count: [1, 1],
		hugsWall: true,
		corridor: true
	},
	stalls: {
		gloss: "partitioned bays for animals or work",
		count: [3, 6],
		hugsWall: true,
		corridor: false
	},
	well: {
		gloss: "a lined shaft down to water",
		count: [1, 1],
		hugsWall: false,
		corridor: false
	}
};
/**
* How many fixtures a room may hold, by how big it is.
*
* A cap rather than a quota. A tiny room with three fixtures in it is a room
* with no floor, and the model has no sense of how much space a stone coffin
* takes because it has never been shown the grid. Anything past the cap is
* dropped, quietly.
*/
var CAP = {
	tiny: 1,
	small: 2,
	medium: 3,
	large: 3
};
function fixtureCap(g) {
	return g.corridor ? 1 : CAP[g.sizeClass] ?? 2;
}
var isFixtureKind = (s) => FIXTURE_KINDS.includes(s);
var isPositionWord = (s) => POSITION_WORDS.includes(s);
/**
* The menu, rendered ONCE for a prompt.
*
* Once, and not per room: a chunk is six rooms and the list is five hundred
* characters, so repeating it costs three kilobytes a call to say the same
* fourteen things six times. The narrower passage menu is expressed as a star
* on the kinds that fit rather than as a second copy of most of the list.
*/
function fixtureMenu() {
	return FIXTURE_KINDS.map((k) => `${k}${FIXTURES[k].corridor ? "*" : ""} (${FIXTURES[k].gloss})`).join("; ");
}
var cellKey = (p) => `${p.x},${p.y}`;
var dist2 = (a, b) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
/**
* The cells a position word admits.
*
* Every word resolves to a subset of the room's floor, and every subset can come
* back empty — a room with no corner, a corridor with no middle. The caller
* falls back rather than failing.
*/
function candidates(word, ground, geom) {
	const cells = ground.cells;
	const facing = wallCells(cells);
	switch (word) {
		case "north wall":
		case "south wall":
		case "east wall":
		case "west wall": return facing[word.split(" ")[0]];
		case "a corner": {
			const mine = new Set(cells.map(cellKey));
			const out = (c, dx, dy) => !mine.has(cellKey({
				x: c.x + dx,
				y: c.y + dy
			}));
			return cells.filter((c) => (out(c, 0, -1) || out(c, 0, 1)) && (out(c, -1, 0) || out(c, 1, 0)));
		}
		case "centre": {
			const xs = cells.map((c) => c.x);
			const ys = cells.map((c) => c.y);
			const [x0, x1] = [Math.min(...xs), Math.max(...xs)];
			const [y0, y1] = [Math.min(...ys), Math.max(...ys)];
			const inThird = (v, lo, hi) => v >= lo + (hi - lo) / 3 && v <= hi - (hi - lo) / 3;
			return cells.filter((c) => inThird(c.x, x0, x1) && inThird(c.y, y0, y1));
		}
		case "near the entrance":
		case "far end": {
			const from = ground.arrivalCell;
			if (!from) return cells;
			const ranked = [...cells].sort((a, b) => dist2(a, from) - dist2(b, from));
			const third = Math.max(1, Math.ceil(ranked.length / 3));
			return word === "near the entrance" ? ranked.slice(0, third) : ranked.slice(-third);
		}
		case "throughout": {
			const mine = new Set(cells.map(cellKey));
			const surrounded = (c) => mine.has(cellKey({
				x: c.x + 1,
				y: c.y
			})) && mine.has(cellKey({
				x: c.x - 1,
				y: c.y
			})) && mine.has(cellKey({
				x: c.x,
				y: c.y + 1
			})) && mine.has(cellKey({
				x: c.x,
				y: c.y - 1
			}));
			const interior = cells.filter(surrounded);
			return interior.length ? interior : cells;
		}
		default: return cells;
	}
}
/**
* Spread the markers out.
*
* Farthest-point sampling: take one at random, then each next one as far as
* possible from everything already taken. Six pillars picked at random cluster;
* six picked this way stand in something a player would read as a colonnade,
* and it costs one pass over a few dozen cells.
*/
function spread(pool, n, rng) {
	if (pool.length <= n) return [...pool];
	const taken = [rng.pick(pool)];
	while (taken.length < n) {
		let best;
		let bestD = -Infinity;
		for (const c of pool) {
			if (taken.some((t) => t.x === c.x && t.y === c.y)) continue;
			const d = Math.min(...taken.map((t) => dist2(t, c)));
			if (d > bestD) {
				bestD = d;
				best = c;
			}
		}
		if (!best) break;
		taken.push(best);
	}
	return taken;
}
/**
* Which wall a wall-hugging fixture goes against when it was not given one.
*
* The longest wall, because that is the one a rank of bunks or a row of stalls
* would actually have been built along, and because it is the one with room.
*/
function longestWall(geom) {
	return `${[
		"north",
		"south",
		"east",
		"west"
	].reduce((a, b) => geom.walls[b] > geom.walls[a] ? b : a)} wall`;
}
/**
* Put one fixture in the room, or fail to.
*
* Fails — returns undefined — only when the room has no free floor left at all,
* which a cap of three in a room of ten cells makes rare and does not make
* impossible. A dropped fixture is a fixture the prose never mentioned, because
* apply drops the entity with it.
*/
function placeFixture(req, ground, geom, rng, opts = {}) {
	const spec = FIXTURES[req.kind];
	const taken = opts.taken ?? /* @__PURE__ */ new Set();
	const blocked = /* @__PURE__ */ new Set([...ground.doorCells.map(cellKey), ...taken]);
	const wanted = spec.hugsWall && !req.position.endsWith("wall") && req.position !== "a corner" ? longestWall(geom) : req.position;
	const free = (list) => list.filter((c) => !blocked.has(cellKey(c)));
	let position = wanted;
	let pool = free(candidates(wanted, ground, geom));
	if (!pool.length) {
		pool = free(ground.cells);
		position = "throughout";
	}
	if (!pool.length) return void 0;
	const [lo, hi] = spec.count;
	const cells = spread(pool, Math.min(rng.range(lo, hi), pool.length), rng);
	for (const c of cells) taken.add(cellKey(c));
	return {
		cells,
		position,
		fixture: req.kind
	};
}
/**
* Put a thing that is already in the room somewhere in it.
*
* The stocked chest, the clue, the hazard: they exist whatever happens, so this
* never fails to place them if there is a cell at all, and it takes ONE cell
* because a chest is a chest. Without this the map would dot the furniture and
* miss the things the player came for.
*/
function placeAt(word, ground, geom, rng, opts = {}) {
	const taken = opts.taken ?? /* @__PURE__ */ new Set();
	const blocked = /* @__PURE__ */ new Set([...ground.doorCells.map(cellKey), ...taken]);
	const free = (list) => list.filter((c) => !blocked.has(cellKey(c)));
	let position = word;
	let pool = free(candidates(word, ground, geom));
	if (!pool.length) {
		pool = free(ground.cells);
		position = "throughout";
	}
	if (!pool.length) {
		pool = ground.cells.filter((c) => !ground.doorCells.some((d) => d.x === c.x && d.y === c.y));
		position = "throughout";
	}
	if (!pool.length) return void 0;
	const cell = rng.pick(pool);
	taken.add(cellKey(cell));
	return {
		cells: [cell],
		position
	};
}
//#endregion
//#region src/engine/dungeon-content-pass.ts
/**
* CONTENT PASS  (per chunk)
* =========================
*
* The fourth pass, and the first that writes prose. ONE batch call per chunk
* (six rooms). In a single call the model names and writes the standing `base`
* for every room, entity, connector, and creature-group local to those rooms,
* and the deterministic layer settles counts and stats around it.
*
* CONSOLIDATION. A pack of one creature type is ONE entity with a `count` and a
* single stat block -- five fen-seals are "Fen-seals x5", not five identical
* bodies. Distinct specimens (an elite, a named person) split off into their own
* entity. The number appearing is rolled in code from the group's tier, never by
* the model.
*
* KEYWORDS. Everything that gets a base also carries `keywords`: a record of the
* procgen rolls behind it, keyed by the table each was rolled from. These ride
* along into the context of any later pass that revisits the entity.
*/
function monsterKeywords(m) {
	const r = {
		Complexity: m.complexity,
		Silhouette: m.silhouette
	};
	if (m.animals?.length) r["Reference animals"] = m.animals.join(" + ");
	if (m.humanoidSeed) r[m.humanoidSeed.table] = m.humanoidSeed.result;
	for (const t of m.traitsAndAbilities) r[t.table] = r[t.table] ? `${r[t.table]}; ${t.result}` : t.result;
	for (const f of m.featuresAndMutations) r[f.table] = r[f.table] ? `${r[f.table]}; ${f.result}` : f.result;
	r["Tactic"] = m.tactic;
	if (m.personality) r["Personality"] = m.personality;
	if (m.weaknesses.length) r["Weakness"] = m.weaknesses.join(", ");
	return r;
}
function npcKeywords(n) {
	const r = {
		[n.origin.kind]: n.origin.result,
		Asset: n.asset,
		Liability: n.liability,
		Method: n.method,
		Appearance: n.appearance,
		Personality: n.personality,
		Goal: n.goal
	};
	for (const f of n.flavor) r[f.table] = r[f.table] ? `${r[f.table]}; ${f.result}` : f.result;
	return r;
}
var PARCEL_TABLE = {
	material: "Valuable Material",
	knowledge: "Knowledge",
	leverage: "Leverage",
	boon: "Boon",
	relic: "Relic"
};
function itemKeywords(p) {
	return { [PARCEL_TABLE[p.type] ?? "Reward"]: p.content };
}
function hazardKeywords(s) {
	if (s.hazard) return { Hazard: s.hazard };
	const r = {};
	if (s.trapTrigger) r["Trap Trigger"] = s.trapTrigger;
	if (s.trapEffect) r["Trap Effect"] = s.trapEffect;
	return r;
}
function obstacleKeywords(s) {
	const r = {};
	if (s.subject) r["Obstacle"] = s.subject;
	if (s.behaviour) r[s.behaviourSource === "mr-trick" ? "Trick" : "Cairn Feature"] = s.behaviour;
	return r;
}
function roomKeywords(r) {
	const kw = { Room: r.identity };
	if (r.detail) kw["Room Detail"] = r.detail;
	return kw;
}
function baseMonsterOf(g) {
	return g.kind === "monsters" ? g.monster : void 0;
}
function describeMonster(m) {
	const bits = [`${m.complexity} ${m.silhouette}`];
	if (m.silhouette === "beastlike" && m.animals?.length) bits.push(`drawn from ${m.animals.join(" and ")}`);
	else if (m.humanoidSeed) bits.push(`${m.humanoidSeed.table.toLowerCase()}: ${m.humanoidSeed.result}`);
	for (const ta of m.traitsAndAbilities) bits.push(`${ta.table.toLowerCase()}: ${ta.result}`);
	for (const fm of m.featuresAndMutations) bits.push(`${fm.table.toLowerCase()}: ${fm.result}`);
	bits.push(`tactic: ${m.tactic}`);
	if (m.personality) bits.push(`personality: ${m.personality}`);
	if (m.weaknesses.length) bits.push(`weakness: ${m.weaknesses.join(", ")}`);
	return bits.join("; ");
}
function describeNpc(n) {
	const parts = [
		`${n.isLeader ? "[LEADER] " : ""}${n.name} (${n.presentingGender}) [${n.id}]`,
		`${n.origin.kind}: ${n.origin.result}`,
		`asset: ${n.asset}`,
		`liability: ${n.liability}`,
		`method: ${n.method}`,
		`appearance: ${n.appearance}`,
		`personality: ${n.personality}`,
		`goal: ${n.goal}`
	];
	if (n.flavor.length) parts.push(n.flavor.map((f) => `${f.table}: ${f.result}`).join("; "));
	return parts.join("; ");
}
function describeGroup(g) {
	if (g.kind === "monsters") {
		const L = [`MONSTER GROUP, tier ${g.tier}`, `  base: ${describeMonster(g.monster)}`];
		if (g.biggerSpecimen) L.push(`  elite specimen: ${describeMonster(g.biggerSpecimen)}`);
		return L.join("\n");
	}
	const L = [
		`PEOPLE GROUP, tier ${g.tier}`,
		`  faction: ${g.faction}`,
		`  traits: ${g.traits.join("; ")}`
	];
	if (g.undefinedUnderlings) L.push(`  plus an undefined mass of underlings`);
	for (const n of g.npcs) L.push(`  - ${describeNpc(n)}`);
	return L.join("\n");
}
function describeLooseSeed(m) {
	if (m.monster) return `LOOSE MONSTER\n  ${describeMonster(m.monster)}`;
	if (m.npc) return `LOOSE PERSON\n  ${describeNpc(m.npc)}`;
	return m.notes ?? "unspecified creature";
}
function depthBand(depth, maxDepth) {
	if (depth === 0) return "threshold";
	if (!maxDepth) return "shallow";
	const n = depth / maxDepth;
	if (n >= .99) return "furthest";
	if (n > .66) return "deep";
	if (n > .33) return "middle";
	return "shallow";
}
function tensionBand(danger) {
	if (danger >= .75) return "lethal";
	if (danger >= .5) return "dangerous";
	if (danger >= .25) return "uneasy";
	return "calm";
}
/** Number appearing, rolled in code from the group's tier. Detachments are thinner. */
function numberAppearing(tier, isBase, rng) {
	let n = tier === "Solo" ? 1 : tier === "Band" ? rng.range(2, 5) : rng.range(6, 12);
	if (!isBase && n > 2) n = Math.max(2, Math.floor(n / 2));
	return n;
}
function buildContentPassPayload(sd, bp, ep, chunk, dungeonContext, site) {
	const rng = new Rng((sd.seed ?? 0) + 131 * (chunk + 1));
	const roomById = new Map(sd.rooms.map((r) => [r.roomId, r]));
	const mobById = new Map(sd.mobiles.map((m) => [m.id, m]));
	const ref = (r) => `room_${r.index}`;
	const itemIds = new Set(ep.items.map((i) => i.id));
	const hazardIds = new Set(ep.hazards.map((h) => h.id));
	const featureById = new Map(ep.features.map((f) => [f.id, f]));
	const groupById = /* @__PURE__ */ new Map();
	for (const g of [...bp.inhabitants, ...sd.wandererGroups]) groupById.set(g.id, g);
	const inChunk = sd.rooms.filter((r) => r.chunk === chunk);
	const inChunkIds = new Set(inChunk.map((r) => r.roomId));
	const linksOf = (roomId) => sd.connectors.filter((c) => c.a === roomId || c.b === roomId).map((c) => ({
		conn: c,
		other: roomById.get(c.a === roomId ? c.b : c.a)
	}));
	/**
	* A connector is written by the pass that can see BOTH rooms it joins.
	*
	* That is this one only when both endpoints are in this chunk -- and then the
	* lower graph index owns it, so it is written once rather than by each of its
	* two rooms.
	*
	* A connector leaving the chunk is a SEAM and is not written here. Every chunk
	* payload is built before any of them is applied, so at this moment the room on
	* the far side has no name and no base: whatever this chunk wrote would be
	* written blind, and then silently overwritten by the other chunk writing it
	* equally blind from its own side. Seams go to `buildSeamsPassPayload`, which
	* runs after every chunk has landed and has both rooms in front of it.
	*/
	const ownsConnector = (c, r) => {
		if (!(c.a === r.roomId || c.b === r.roomId)) return false;
		if (!inChunkIds.has(c.a) || !inChunkIds.has(c.b)) return false;
		const owner = roomById.get(c.a).index <= roomById.get(c.b).index ? c.a : c.b;
		return r.roomId === owner;
	};
	const wallOf = (roomIndex, connectorId) => {
		const exit = (site?.geometry[roomIndex])?.exits.find((x) => x.connectorId === connectorId);
		return exit ? exitPhrase(exit) : void 0;
	};
	const rooms = inChunk.map((r) => {
		const links = linksOf(r.roomId);
		const geom = site?.geometry[r.index];
		const entities = [];
		for (const b of ep.bindings) {
			if (b.roomId !== r.roomId) continue;
			if (b.element === "creature" || b.element === "connector" || b.element === "detail") continue;
			const entity = itemIds.has(b.entityId) ? "Item" : hazardIds.has(b.entityId) ? "Hazard" : "RoomFeature";
			let keywords = {};
			let note;
			switch (b.element) {
				case "entrance":
					keywords = r.entranceFeature ? { Entrance: r.entranceFeature } : {};
					break;
				case "clue":
					if (r.clue) {
						keywords = { Clue: r.clue.keyword };
						const t = r.clue.targetRoomId ? roomById.get(r.clue.targetRoomId) : void 0;
						note = `points at ${r.clue.about}` + (t ? ` (${ref(t)})` : "");
					}
					break;
				case "obstacle":
					if (r.special) keywords = obstacleKeywords(r.special);
					break;
				case "hazard":
					if (r.special) keywords = hazardKeywords(r.special);
					break;
				case "reward": if (r.reward) keywords = itemKeywords(r.reward);
			}
			entities.push({
				ref: b.entityId,
				kind: b.element,
				entity,
				keywords,
				note,
				hidden: featureById.get(b.entityId)?.isHidden
			});
		}
		const detailCandidates = ep.detailCandidates.filter((d) => d.roomId === r.roomId).map((d) => ({
			text: d.text,
			keywords: { "Room Detail": d.text }
		}));
		const connectors = links.filter((l) => ownsConnector(l.conn, r)).slice().map((l) => ({
			ref: l.conn.id,
			toRef: ref(l.other),
			toIdentity: l.other.identity,
			gated: l.conn.gated,
			hidden: l.conn.hidden,
			wall: wallOf(r.index, l.conn.id)
		}));
		for (const l of links) {
			if (inChunkIds.has(l.other.roomId)) continue;
			connectors.push({
				ref: l.conn.id,
				toRef: ref(l.other),
				toIdentity: l.other.identity,
				gated: l.conn.gated,
				hidden: l.conn.hidden,
				seam: true,
				wall: wallOf(r.index, l.conn.id)
			});
		}
		if (r.roomId === sd.entranceRoomId) {
			const surface = ep.connectors.find((c) => c.endpointB === null && c.endpointA === r.roomId);
			if (surface) connectors.push({
				ref: surface.id,
				toRef: null,
				surface: r.entranceFeature ? { Entrance: r.entranceFeature } : {},
				gated: false,
				hidden: false,
				wall: wallOf(r.index, null)
			});
		}
		const encounters = r.occupants.map((mid) => {
			const m = mobById.get(mid);
			const group = m.groupId ? groupById.get(m.groupId) : void 0;
			const tier = m.tier ?? group?.tier ?? "Band";
			const template = group ? describeGroup(group) : describeLooseSeed(m);
			const baseSeed = group ? baseMonsterOf(group) : m.monster;
			const massKw = baseSeed ? monsterKeywords(baseSeed) : m.npc ? npcKeywords(m.npc) : {};
			const distinct = [];
			if (group && group.kind === "people") for (const n of group.npcs) distinct.push({
				kind: "named",
				member: n.id,
				isLeader: n.isLeader,
				keywords: npcKeywords(n)
			});
			if (!!group && group.kind === "monsters" && !!group.biggerSpecimen && !!m.isBase) distinct.push({
				kind: "elite",
				isLeader: true,
				keywords: monsterKeywords(group.biggerSpecimen)
			});
			let mass;
			if (!group || group.kind === "monsters" || group.kind === "people" && group.undefinedUnderlings) mass = {
				count: numberAppearing(tier, m.isBase ?? false, rng),
				keywords: massKw
			};
			return {
				ref: m.id,
				roomRef: ref(r),
				tier,
				activity: m.activity ?? "unspecified",
				disposition: m.disposition ?? "hostile",
				affiliation: m.groupIndex !== void 0 ? `${m.isBase ? "base of" : "detachment from"} group ${m.groupIndex + 1}` : "unaffiliated",
				template,
				group: mass,
				distinct
			};
		});
		return {
			ref: ref(r),
			role: r.role,
			identity: r.identity,
			depth: depthBand(r.depth, sd.maxDepth),
			tension: tensionBand(r.danger),
			isDeadEnd: r.isDeadEnd,
			headline: r.headline,
			stacked: r.stacked,
			detail: r.detail,
			keywords: roomKeywords(r),
			entities,
			detailCandidates,
			connectors,
			encounters,
			goal: r.roomId === ep.pendingGoal.roomId ? {
				reward: ep.pendingGoal.reward,
				mission: ep.pendingGoal.mission
			} : void 0,
			gatedExits: links.filter((l) => l.conn.gated).map((l) => ref(l.other)),
			openExits: links.filter((l) => !l.conn.gated).map((l) => ref(l.other)),
			geometry: geom ? describeGeometry(geom) : void 0,
			fixtures: geom ? {
				cap: fixtureCap(geom),
				corridor: geom.corridor
			} : void 0
		};
	});
	const borderIds = /* @__PURE__ */ new Set();
	for (const r of inChunk) for (const l of linksOf(r.roomId)) if (!inChunkIds.has(l.other.roomId)) borderIds.add(l.other.roomId);
	const borders = [...borderIds].map((id) => {
		const b = roomById.get(id);
		const parts = [];
		if (b.occupants.length) parts.push(`holds ${b.occupants.length} creature group(s)`);
		if (b.special) parts.push(b.special.kind === "hazard" ? "hazardous" : "has an obstacle");
		if (b.role === "goal") parts.push("the objective is here");
		if (b.role === "entrance") parts.push("the way in");
		return {
			ref: ref(b),
			identity: b.identity,
			headline: b.headline,
			summary: parts.length ? parts.join("; ") : "quiet",
			connectsTo: linksOf(b.roomId).filter((l) => inChunkIds.has(l.other.roomId)).map((l) => ref(l.other))
		};
	});
	let ground;
	if (site) {
		ground = {};
		for (const r of inChunk) ground[ref(r)] = {
			geometry: site.geometry[r.index],
			ground: site.ground[r.index]
		};
	}
	return {
		chunk,
		dungeonContext,
		rooms,
		borders,
		instructions: CONTENT_PASS_INSTRUCTIONS,
		responseSchema: CONTENT_PASS_SCHEMA,
		ground
	};
}
var kwLine = (kw) => Object.entries(kw).map(([t, v]) => `${t}=${v}`).join("  |  ") || "--";
function renderContentPassPrompt(p) {
	const L = [];
	L.push(p.instructions, "");
	L.push("=== DUNGEON FICTION (shared context) ===", p.dungeonContext, "");
	L.push(`=== ROOMS TO WRITE (${p.rooms.length}) ===`, "");
	for (const r of p.rooms) {
		L.push(`--- ${r.ref} ---`);
		L.push(`identity: ${r.identity}`);
		if (r.role !== "normal") L.push(`role: ${r.role}`);
		L.push(`depth: ${r.depth}   tension: ${r.tension}${r.isDeadEnd ? "   dead end" : ""}`);
		L.push(`headline: ${r.headline}${r.stacked ? ` + ${r.stacked}` : ""}`);
		L.push(`room keywords: ${kwLine(r.keywords)}`);
		if (r.geometry) L.push(`as drawn: ${r.geometry}`);
		for (const e of r.entities) L.push(`entity [${e.ref}] ${e.kind} (${e.entity})${e.hidden ? " HIDDEN" : ""}: ${kwLine(e.keywords)}` + (e.note ? ` -- ${e.note}` : ""));
		for (const d of r.detailCandidates) L.push(`promotable detail [${kwLine(d.keywords)}] -- make it an entity only if a player would act on it`);
		for (const c of r.connectors) {
			const where = c.wall ? ` in ${c.wall}` : "";
			if (c.surface) {
				L.push(`connector [${c.ref}] OUT OF THE DUNGEON${where} -- the way the party came in and the only way back to daylight; realise it from [${kwLine(c.surface)}] and say what it physically is. Name it as a thing, not as an exit.`);
				continue;
			}
			if (c.seam) {
				L.push(`way out [${c.ref}]${where} to ${c.toRef} (${c.toIdentity})${c.gated ? " GATED" : ""} -- WRITTEN ELSEWHERE. It leaves this region, so it is written by a later pass that can see both rooms. Count it among this room's ways out; do not name it, describe it, or return it.`);
				continue;
			}
			const flags = `${c.gated ? " GATED" : ""}${c.hidden ? " CONCEALED" : ""}`;
			const asks = [c.hidden ? "write it as the thing a person would walk past -- a seam, a draught, a panel that rings hollow -- not as a door" : "say what it physically is", c.gated ? "and what blocks it, from here" : "no barrier"].join("; ");
			L.push(`connector [${c.ref}]${where} to ${c.toRef} (${c.toIdentity})${flags} -- ${asks}`);
		}
		for (const en of r.encounters) {
			L.push(`encounter [${en.ref}] ${en.tier}, ${en.affiliation}, currently ${en.activity}, disposition ${en.disposition}`);
			if (en.group) L.push(`    mass: ${en.group.count} x rank-and-file -> ONE consolidated entity, one stat block  [${kwLine(en.group.keywords)}]`);
			for (const d of en.distinct) L.push(`    distinct ${d.kind}${d.member ? ` [${d.member}]` : ""}${d.isLeader ? " (leader)" : ""} -> its own entity  [${kwLine(d.keywords)}]`);
			for (const line of en.template.split("\n")) L.push(`      ${line}`);
		}
		if (r.goal) {
			L.push(`GOAL HERE: reward "${r.goal.reward}" + mission "${r.goal.mission}".`);
			L.push(`  ${GOAL_INSTRUCTION}`);
		}
		if (r.gatedExits.length) L.push(`gated exits: ${r.gatedExits.join(", ")}`);
		if (r.openExits.length) L.push(`open exits: ${r.openExits.join(", ")}`);
		if (r.fixtures) L.push(`fixtures: up to ${r.fixtures.cap}, or none` + (r.fixtures.corridor ? " -- A PASSAGE: starred kinds only" : ""));
		L.push("");
	}
	if (p.borders.length) {
		L.push(`=== BORDER ROOMS -- context only, do NOT write ===`, "");
		for (const b of p.borders) L.push(`${b.ref}: ${b.identity} (${b.headline}) -- ${b.summary}; connects to ${b.connectsTo.join(", ")}`);
		L.push("");
	}
	L.push("=== RESPONSE FORMAT ===", p.responseSchema);
	return L.join("\n");
}
/**
* A connector is read from both ends, and it is one entity with one name.
*
* Name it "Corridor to the Kennel" and the player standing IN the Kennel reads
* "Corridor to the Kennel" on the way out — pointing at where they already are.
* A referee asked to route "go back to the Laboratory" then has two exits both
* claiming to lead to the Kennel and picks by coin toss. So the name carries the
* nature of the crossing and nothing else, and `renderRoom` appends the room on
* the far side, correct from whichever end is being read.
*/
var CONNECTOR_NAMING = `Its NAME is what the thing physically is and
  NOTHING else -- "Iron door", "Low archway", "Spiral stair", "Flooded crawl",
  "Rope bridge". Name NEITHER room it joins: no "to the", no "from the", no room
  name, no direction. One connector is walked both ways and read from both ends,
  so a name that points is wrong from one of them. Where it leads is appended
  when it is read, and is not yours to write.`;
/**
* A stair has a top and a bottom, and one entity read from both ends has no
* "up" of its own.
*
* So the form says which ROOM is the upper one, by name. That is the one phrasing
* that survives being read from either side, and without it the same flight of
* steps is written as descending from both of its rooms -- which is what a player
* walking back the way they came finds out.
*
* Both rooms are named by whoever is writing: a chunk writes only the connectors
* whose two rooms it is naming in the same response, and the seams pass is handed
* the names the chunks settled.
*/
var CONNECTOR_HEIGHT = `Where it changes level -- a stair, a ladder, a
  shaft, a ramp, a hole in the floor, a drop -- the FORM must say which of the two
  rooms is above and which below, BY NAME: "a stair, the Counting Room at its head
  and the Sump at its foot". Not "leads down", which is true from only one end.`;
var GOAL_INSTRUCTION = "Create exactly one entity that embodies the objective. Read the fiction and decide what type it needs to be -- an Item, a RoomFeature, or a Creature -- so that a party acting on it plausibly satisfies the mission. Then name and write it.";
var CONTENT_PASS_INSTRUCTIONS = `You are writing one region of a dungeon: six rooms and everything in them.

WHAT YOU ARE GIVEN
Every room, entity, connector, and creature has already been decided by procgen.
Counts and hit dice are already rolled. Your job is to realise it in prose and
settle the few things procgen leaves to you -- not to choose what is there. Each
line lists the rolled keywords behind it as table=value; those are seeds to
realise, not text to echo.

PER ROOM
- name + base: the room's standing description. base is IMMUTABLE -- only what is
  true of the place itself, not what a party is doing in it, nothing that changes
  when its contents change.
- Each listed entity's name + base, written the same way: fixed identity, concrete
  to this fiction.
- Each connector: name + what it physically IS -- a door, a stair, a corridor, a
  crawl, a short drop, a collapsed arch, whatever separates the two rooms, even if
  mundane. ${CONNECTOR_NAMING}
  For a GATED connector also write what blocks it, seen from this room; do not
  invent the key.
  ${CONNECTOR_HEIGHT}
- Promotable details: a detail is always part of the room's description. Make it
  its own entity ONLY if a player would act on it. Most stay as description.
- Fixtures: up to the number the room gives, off the one menu. See FIXTURES.

THE ROOM AS DRAWN
Each room has already been drawn on the map. "as drawn" gives you its real size
in feet, its proportions, whether its outline is square-cornered or broken up,
and how many ways out are in each wall; each connector says which wall it is in.

WRITE TO THE DRAWING, NOT TO THE IDENTITY. The rolled identity says what the
place was built as; the drawing says what it came out as, and where the two
disagree the drawing wins. A room rolled "Banquet hall" and drawn twenty feet
square is not a long hall -- it is what became of one, or a service room off one,
or a hall the collapse took most of. Say so. A player looking at the map and
reading your prose must not be looking at two different rooms.

Two hard rules about direction:
- Compass only. North, south, east and west are on the map and are safe. "Left",
  "right", "ahead", "behind" depend on which way the party is facing and you do
  not know that; a party that walks back through will read them as lies.
- Do not invent an exit, a window, or a level change that is not listed. The ways
  out are exactly the connectors given.

And two about the ways out, both of them because base is IMMUTABLE and there is
no later pass that can correct it:
- DO NOT COUNT THEM IN THE ROOM'S BASE. "Four ways out: east, south, and two to
  the west" stops being true the first time one is opened, barred, collapsed or
  found, and the description cannot be rewritten to catch up -- so the number goes
  on being read aloud to the player long after it is wrong. The map draws the ways
  out and the game lists them fresh every turn. Describe the room; let the
  counting be done by something that is allowed to change its mind.
- A CONCEALED way is NOT part of the room's description. Write what it physically
  is on the connector itself -- that is the text the player reads on FINDING it --
  and keep it out of the room's base entirely, not even as a hint or a draught. A
  room whose standing description mentions the crack in the west wall has no
  secret door in it, because that description is read out on arrival. Where a
  concealed way is meant to be findable, procgen lists a clue as its own entity.

Feet are given so the prose can be concrete. Round them, compare them to
something, or ignore them -- but do not contradict them.

FIXTURES -- WHAT IS STANDING IN THE ROOM
The menu, once. Starred kinds also fit in a passage; the rest need a chamber.

  ${fixtureMenu()}

Each room says how many it may hold. Choose up to that many, or NONE AT ALL --
an empty room is a real room, and a dungeon of uniformly furnished ones reads as
a catalogue. Pick what the fiction has already earned: a barracks has bunks, a
shrine has an altar, a collapsed gallery has rubble.

Each fixture gets a "kind" from the menu, a "position", a name and a base, and is
written exactly like any other feature -- a thing in this dungeon, not a generic
one. Positions, and nothing else: ${POSITION_WORDS.join(", ")}.

A fixture is furniture, never a way somewhere. "stair" on the menu means steps
INSIDE the room -- up to a dais, down into water -- that arrive nowhere else. If
you want a way between two rooms, it is one of the connectors and it is already
listed. See A WAY THROUGH IS NEVER A FEATURE.

DO NOT say how many there are. "Pillars" is your decision; six pillars is not --
the count is rolled, and the map will draw whatever it rolled. Name them in a way
that survives either number, and write the base about what they ARE rather than
about how many.

Anything already listed as an entity may ALSO take a "position", from the same
words, saying where in the room it sits. That is what puts the chest, the clue
and the hazard on the map alongside the furniture.

NAMING A ROOM
The name comes from whatever DOMINATES the room, not from the identity it was
rolled from. The rolled identity says what the place was built as; the name says
what a party walking in would call it. A kennel whose stalls stand empty, with an
iron bridge over a chasm running through the middle of it, is not the Kennel --
the bridge and the chasm are what anyone would remember it by, and what they will
say when they mean "back to the room with the bridge". So read the room's
entities and its detail, work out what the biggest thing in there actually is,
and name it for that. Short, concrete, and sayable out loud.

EVERYTHING IS THERE FOR A REASON
Before you write a room or a feature, know why it is in THIS dungeon. Usually the
answer is ordinary and needs no room on the page -- a barracks in a fort, a sump
at the bottom of a mine. But anything that does NOT obviously belong is the first
thing a party will notice and ask about, and the fiction has to be able to answer.
A theatre inside a prison must have a story behind it: who built it, for whom, and
what became of it. Put that answer in the base, as a clause, not a lecture. An
incongruity with a reason behind it is the best thing in a dungeon; one without is
a mistake the player can see from the doorway.

A WAY THROUGH IS NEVER A FEATURE
If something you are about to write reads as a way to somewhere else -- a stair,
a shaft, a hole in the wall, a rent in the floor, a tunnel, a door -- it is a
CONNECTOR, not a RoomFeature and not a promoted detail. Spend the idea on one of
the connectors this room already has: each is listed with the room it leads to,
so pick the one whose far side suits it and write it as that connector's name
and form. The rooms are joined the way they are joined; you are describing those
joins, not adding to them.

A player will try to walk through anything that looks like a passage. Written as
a feature it leads nowhere, and they find that out by trying.

The ONE exception is the connector marked OUT OF THE DUNGEON, which is a real
way through to no room at all. It is already in your list. Do not invent others.

CREATURES -- CONSOLIDATE
The count is already rolled. A mass of one creature type is ONE entity with a
single stat block; do NOT split it into individuals. "5 x rank-and-file" is one
entity you name in the plural ("Fen-seals") and write once. Only a specimen
marked "distinct" -- an elite, a named person -- becomes its own entity alongside
the mass. Write the group's shared base once (the mass); write each distinct
specimen its own base. Give the mass and each distinct one a one-line current
activity fitting the encounter. Stats: you are given the hit-dice spine; return
only DEVIATIONS the keywords imply (a heavier die for claws, armour, a morale or
ability shift). Leave stats out for an average body.

BEASTS -- WHAT THE REFERENCE ANIMALS ARE FOR
A beastlike monster is listed with one reference animal or two. That was decided
by the roll, not left to you: one means one, two means both. They are the starting
point for a body, NOT the description of it. Take the general shape and bearing
from them -- how it stands, how it moves, how much of the room it takes up -- and
then write SPECIFIC borrowed parts: the shape of the snout, what it has instead of
ears, the horn or the antler, the set of the eyes, the feet, the hide.

What you must not do is name the animal and stop. "Badger-like", "part badger,
part Pteranodon", "resembles a heron" -- that is the reference showing through
where a creature should be. Name an animal only when the naming does real work
("the flat spade-shaped digging claws of a badger" both names it and tells you
something); otherwise the player should be able to picture the thing without ever
learning what it was built out of.

THE GOAL
One room is marked GOAL. ${GOAL_INSTRUCTION}

HARD RULES
1. Every listed entity, encounter, and connector must appear exactly once -- except
   a way out marked WRITTEN ELSEWHERE, which you must NOT return. That one leaves
   this region and is written by a pass that can see the room on the other side.
   Do not add a creature, hazard, or connector that was not listed.
2. Keywords are seeds, not labels. Realise them into the place; do not gloss.
3. Do not contradict the fiction. Material, history, and the state of the ruin are
   settled.
4. Depth and tension are tone, never content. A calm room holding a lethal thing
   still holds it.
5. A clue must point at what it is said to point at, written as something noticed.

MAKE THEM DISTINCT
These rooms are read in sequence. Give each one something the others lack. If two
would read the same, change one.`;
var CONTENT_PASS_SCHEMA = `Return JSON only, no prose outside it:

{
  "rooms": [
    {
      "ref": "<room ref, exactly as given>",
      "name": "<short room name>",
      "base": "<the room's standing description>",
      "entities": [ { "ref": "<entity ref>", "name": "<name>", "base": "<identity>", "position": "<one of the position words>" } ],
      "fixtures": [ { "kind": "<one from THIS room's menu>", "position": "<one of the position words>", "name": "<name>", "base": "<identity>" } ],
      "promotions": [ { "text": "<detail text as given>", "name": "<name>", "base": "<identity>", "hidden": false, "position": "<one of the position words>" } ],
      "connectors": [ { "ref": "<connector ref>", "name": "<what it is, naming neither room>", "form": "<what it physically is>", "requirement": "<gated only: what blocks it>" } ],
      "encounters": [
        {
          "ref": "<encounter ref>",
          "group": { "name": "<plural name>", "base": "<shared identity>", "activity": "<one line>", "stats": { "damage": "1d8" } },
          "distinct": [
            { "kind": "elite|named", "member": "<named: person id>", "name": "<name>", "base": "<identity>", "isLeader": false, "activity": "<one line>", "stats": { "armorDefense": 14 } }
          ]
        }
      ],
      "goal": { "entityType": "Item|RoomFeature|Creature", "name": "<name>", "base": "<identity>", "position": "<one of the position words>" }
    }
  ]
}

Include each key only when the room has it; "group" only when a mass is listed;
"distinct" only for specimens marked distinct; omit "goal" except in the GOAL
room. Leave "stats" out for an average creature.

"fixtures" and every "position" are optional and are omitted entirely for a room
with no "as drawn" line. NEVER put a count, a dimension, or a coordinate in any
of them: "kind" and "position" are words off the lists and nothing else.`;
/**
* EVERYTHING THIS CHUNK WAS ASKED ABOUT AND DID NOT WRITE.
*
* A response answering five of six connectors is valid JSON against a valid
* schema. Zod checks shape, and nothing about the shape says how many connectors
* there should be -- so the omission passes, the chunk applies, and the gap
* surfaces only when `validateWritten` sweeps at the end, by which point the pass
* is over and the one retry has gone unspent. That is how a live run finished
* with three of ~90 written things unwritten, one of them a connector between two
* rooms in the same chunk, which no seam could explain.
*
* This turns an omission into exactly the zod-shaped failure the retry already
* knows how to take. It lives here rather than in the schema because only the
* PAYLOAD knows what was asked for, and the schema never sees the payload.
*
* WHAT IS DELIBERATELY NOT CHECKED, all for one reason -- the model chose, so
* there is nothing it can have left out: fixtures, promoted details, and the
* seam connectors carried as context, which HARD RULE 1 tells it not to return.
*/
function contentPassOmissions(payload, res) {
	const out = [];
	const roomByRef = new Map((res.rooms ?? []).map((r) => [r.ref, r]));
	const absent = (want, got) => {
		const have = new Set(got);
		return want.filter((ref) => !have.has(ref));
	};
	for (const brief of payload.rooms) {
		const rr = roomByRef.get(brief.ref);
		if (!rr) {
			out.push({
				path: `rooms.${brief.ref}`,
				message: `room ${brief.ref} was listed and is missing from the response entirely`
			});
			continue;
		}
		const at = `rooms.${brief.ref}`;
		for (const ref of absent(brief.entities.map((e) => e.ref), (rr.entities ?? []).map((e) => e.ref))) out.push({
			path: `${at}.entities`,
			message: `entity ${ref} was listed and is not in the response; every listed entity must be written exactly once`
		});
		for (const ref of absent(brief.connectors.filter((c) => !c.seam).map((c) => c.ref), (rr.connectors ?? []).map((c) => c.ref))) out.push({
			path: `${at}.connectors`,
			message: `connector ${ref} was listed and is not in the response; a way out with no form is one the game cannot describe when a player walks up to it`
		});
		if (brief.goal && !rr.goal) out.push({
			path: `${at}.goal`,
			message: `this room is the GOAL room and no "goal" was written for it`
		});
		const written = new Map((rr.encounters ?? []).map((e) => [e.ref, e]));
		for (const en of brief.encounters) {
			const er = written.get(en.ref);
			if (!er) {
				out.push({
					path: `${at}.encounters`,
					message: `encounter ${en.ref} was listed and is not in the response`
				});
				continue;
			}
			if (en.group && !er.group) out.push({
				path: `${at}.encounters.${en.ref}.group`,
				message: `encounter ${en.ref} lists a group of ${en.group.count} and the response wrote no "group" for it`
			});
			for (const d of en.distinct) {
				if ((er.distinct ?? []).some((x) => x.kind === d.kind && x.member === d.member)) continue;
				out.push({
					path: `${at}.encounters.${en.ref}.distinct`,
					message: `encounter ${en.ref} lists a distinct ${d.kind}` + (d.member ? ` (member ${d.member})` : "") + ` and the response has no entry matching it`
				});
			}
		}
	}
	return out;
}
/** Every entity carries the procgen rolls behind it, keyed by source table. */
/**
* EVERY NAME IN THE RESPONSE, CAPITALISED, IN ONE PLACE.
*
* A dozen sites below lift `name` off the response and onto an entity — rooms,
* written entities, fixtures, promotions, connectors, groups, distinct
* specimens, the goal — and normalising at each of them means the thirteenth
* one, whenever it is written, ships lower-case names again. This is the
* chokepoint instead: past here, no name in `res` is unnormalised.
*
* Keyed on the field NAME, which is safe because every `name` in
* `ContentPassResponse` is a thing the player reads. What is deliberately not
* touched: `kind` and `form` and `position`, which are vocabulary the code
* matches on and would break if their case moved.
*
* On a copy. The raw response is what the journal recorded and what a replay
* reads back; rewriting it underneath them would make the record disagree with
* the call it is a record of.
*/
function withProperNames(res) {
	const copy = structuredClone(res);
	const walk = (node) => {
		if (Array.isArray(node)) {
			for (const v of node) walk(v);
			return;
		}
		if (node === null || typeof node !== "object") return;
		const rec = node;
		for (const [k, v] of Object.entries(rec)) if (k === "name" && typeof v === "string") rec[k] = properName(v);
		else walk(v);
	};
	walk(copy);
	return copy;
}
function applyContentPass(raw, payload, ep, bp, sd, rng) {
	const res = withProperNames(raw);
	const roomById = new Map(ep.rooms.map((r) => [r.id, r]));
	const roomByRef = new Map(sd.rooms.map((r) => [`room_${r.index}`, r.roomId]));
	const mobById = new Map(sd.mobiles.map((m) => [m.id, m]));
	const groupById = /* @__PURE__ */ new Map();
	for (const g of [...bp.inhabitants, ...sd.wandererGroups]) groupById.set(g.id, g);
	const featureById = new Map(ep.features.map((f) => [f.id, f]));
	const itemById = new Map(ep.items.map((i) => [i.id, i]));
	const hazardById = new Map(ep.hazards.map((h) => [h.id, h]));
	const connectorById = new Map(ep.connectors.map((c) => [c.id, c]));
	const detailByText = new Map(ep.detailCandidates.map((d) => [`${d.roomId}:${d.text}`, d]));
	const briefByRoom = new Map(payload.rooms.map((r) => [r.ref, r]));
	const entityKw = /* @__PURE__ */ new Map();
	const encounterBrief = /* @__PURE__ */ new Map();
	for (const r of payload.rooms) {
		for (const e of r.entities) entityKw.set(e.ref, e.keywords);
		for (const en of r.encounters) encounterBrief.set(en.ref, en);
	}
	const created = [];
	let goalEntity;
	for (const rr of res.rooms) {
		const roomId = roomByRef.get(rr.ref);
		if (!roomId) continue;
		const brief = briefByRoom.get(rr.ref);
		const room = roomById.get(roomId);
		if (room) {
			room.name = rr.name;
			room.base = rr.base;
			room.keywords = brief?.keywords ?? {};
		}
		const site = payload.ground?.[rr.ref];
		const taken = /* @__PURE__ */ new Set();
		const place = (word) => {
			if (!site) return void 0;
			return placeAt(word !== void 0 && isPositionWord(word) ? word : "centre", site.ground, site.geometry, rng, { taken });
		};
		for (const w of rr.entities ?? []) {
			const kw = entityKw.get(w.ref) ?? {};
			const f = featureById.get(w.ref);
			if (f) {
				f.name = w.name;
				f.base = w.base;
				f.keywords = kw;
				f.place = place(w.position);
				continue;
			}
			const it = itemById.get(w.ref);
			if (it) {
				it.name = w.name;
				it.base = w.base;
				it.keywords = kw;
				if (it.parentId === roomId) it.place = place(w.position);
				continue;
			}
			const hz = hazardById.get(w.ref);
			if (hz) {
				hz.name = w.name;
				hz.keywords = kw;
				const seed = ep.registry.hazards[hz.blueprintId];
				if (seed) seed.base = w.base;
			}
		}
		for (const fx of (rr.fixtures ?? []).slice(0, site ? fixtureCap(site.geometry) : 0)) {
			if (!isFixtureKind(fx.kind)) continue;
			const word = isPositionWord(fx.position) ? fx.position : "centre";
			const placed = placeFixture({
				kind: fx.kind,
				position: word
			}, site.ground, site.geometry, rng, { taken });
			if (!placed) continue;
			const f = addFixture(roomId, ep);
			f.name = fx.name;
			f.base = fx.base;
			f.keywords = { Fixture: fx.kind };
			f.place = placed;
		}
		for (const pr of rr.promotions ?? []) {
			const cand = detailByText.get(`${roomId}:${pr.text}`);
			if (!cand) continue;
			const f = promoteDetail(cand, ep);
			f.name = pr.name;
			f.base = pr.base;
			f.keywords = { "Room Detail": pr.text };
			if (pr.hidden) f.isHidden = true;
			f.place = place(pr.position);
		}
		for (const cr of rr.connectors ?? []) {
			const conn = connectorById.get(cr.ref);
			if (!conn) continue;
			if (brief?.connectors.find((c) => c.ref === cr.ref)?.seam) continue;
			conn.name = cr.name;
			conn.base = cr.form;
			conn.keywords = {};
			if (cr.requirement) conn.conditional = cr.requirement || "[gated -- condition not yet written]";
		}
		if (rr.goal && roomId === ep.pendingGoal.roomId) {
			goalEntity = createGoalEntity(rr.goal, roomId, sd, rng, ep);
			if (goalEntity.type === "Creature") created.push(goalEntity);
			if (goalEntity.type === "Item" || goalEntity.type === "RoomFeature") goalEntity.place = place(rr.goal.position);
		}
		for (const er of rr.encounters ?? []) {
			const m = mobById.get(er.ref);
			if (!m) continue;
			const en = encounterBrief.get(er.ref);
			const group = m.groupId ? groupById.get(m.groupId) : void 0;
			if (er.group && en?.group) {
				const c = group ? createCreatureFromGroup(group, roomId, sd.level, rng, { name: er.group.name }) : createCreatureFromSeed(m.monster ?? m.npc, roomId, sd.level, m.monster?.complexity ?? "simple", ep.registry, rng, { name: er.group.name });
				c.count = en.group.count;
				c.activity = er.group.activity;
				c.keywords = en.group.keywords;
				if (er.group.stats) mergeStats(c.stats, er.group.stats);
				if (group) {
					const tpl = ep.registry.groups[group.id] ??= { id: group.id };
					tpl.base ??= er.group.base;
					tpl.name ??= er.group.name;
				} else c.base = er.group.base;
				created.push(c);
			}
			for (const d of er.distinct ?? []) {
				const c = mintDistinct(d, m, group, roomId, sd.level, rng, ep);
				c.count = 1;
				c.activity = d.activity;
				c.keywords = en?.distinct.find((x) => x.kind === d.kind && x.member === d.member)?.keywords ?? {};
				if (d.stats) mergeStats(c.stats, d.stats);
				created.push(c);
			}
		}
	}
	const writtenRoomIds = new Set(res.rooms.map((rr) => roomByRef.get(rr.ref)).filter((x) => !!x));
	ep.creatures = ep.creatures.filter((c) => !writtenRoomIds.has(c.roomId));
	ep.creatures.push(...created);
	return {
		goalEntity,
		createdCreatures: created
	};
}
function mintDistinct(d, m, group, roomId, level, rng, ep) {
	if (d.kind === "elite" && group && group.kind === "monsters" && group.biggerSpecimen) {
		const c = createCreatureFromSeed(group.biggerSpecimen, roomId, level, group.biggerSpecimen.complexity, ep.registry, rng, {
			name: d.name,
			isLeader: d.isLeader,
			affiliationGroupId: group.id
		});
		ep.registry.creatures[c.narrative.blueprintId].base = d.base;
		return c;
	}
	if (d.kind === "named" && group && group.kind === "people") {
		const c = createCreatureFromGroup(group, roomId, level, rng, {
			member: d.member,
			isLeader: d.isLeader,
			name: d.name
		});
		c.base = d.base;
		return c;
	}
	const c = createCreatureFromSeed(m.monster ?? m.npc, roomId, level, m.monster?.complexity ?? "simple", ep.registry, rng, {
		name: d.name,
		isLeader: d.isLeader
	});
	ep.registry.creatures[c.narrative.blueprintId].base = d.base;
	return c;
}
function mergeStats(spine, dev) {
	if (dev.damage) spine.damage = dev.damage;
	if (dev.armorDefense !== void 0) spine.armorDefense = dev.armorDefense;
	if (dev.morale !== void 0) spine.morale = dev.morale;
	if (dev.modifiers) spine.modifiers = {
		...spine.modifiers,
		...dev.modifiers
	};
}
function createGoalEntity(goal, roomId, sd, rng, ep) {
	const kw = {
		Reward: ep.pendingGoal.reward,
		Mission: ep.pendingGoal.mission
	};
	if (goal.entityType === "Item") {
		const it = {
			id: makeId(),
			name: goal.name,
			type: "Item",
			base: goal.base,
			parentId: roomId,
			slots: 1,
			value: rollItemValue(rng, "significant")
		};
		it.keywords = kw;
		ep.items.push(it);
		return it;
	}
	if (goal.entityType === "Creature") {
		const c = createCreatureFromSeed({
			complexity: "major",
			silhouette: "humanoid",
			traitsAndAbilities: [],
			featuresAndMutations: [],
			tactic: "",
			weaknesses: [],
			personality: ""
		}, roomId, sd.level, "major", ep.registry, rng, { name: goal.name });
		ep.registry.creatures[c.narrative.blueprintId].base = goal.base;
		c.keywords = kw;
		return c;
	}
	const f = {
		id: makeId(),
		name: goal.name,
		type: "RoomFeature",
		base: goal.base,
		roomId
	};
	f.keywords = kw;
	ep.features.push(f);
	return f;
}
//#endregion
//#region src/engine/dungeon-pass.ts
/**
* DUNGEON PASS  (once, up front)
* ==============================
*
* The first call, and the only one that sees the whole dungeon at once. It
* turns the rolled genome -- purpose, ruination, inhabitants, goal seed -- into
* the standing fiction every later pass writes against:
*
*   theme      the sensory register: material, light, sound, smell
*   history    what it was, what happened, who is here now
*   goal       ONE objective resolved out of the reward/mission pair
*   opening    what the player reads before the first room
*   groups     the shared base for each rolled inhabitant group
*
* INHABITANT BASES ARE WRITTEN HERE. A group is a dungeon-level thing: it can
* be placed in several rooms across several chunks, and every instance shares
* one identity. Writing it once, here, is what keeps chunks from each inventing
* their own version of the same population -- and who lives here belongs in the
* dungeon's fiction anyway, not in whichever room happens to hold them.
*
* Wanderer groups are NOT written here. They do not exist yet (stocking rolls
* them), they are filler drawn when the rolled inhabitants are already placed,
* and they are explicitly not part of the resident population. The content pass
* writes theirs, in the one chunk each appears in.
*/
function buildDungeonPassPayload(bp) {
	return {
		rollSheet: rollSheet(bp),
		groupIds: bp.inhabitants.map((g) => g.id),
		size: bp.size,
		level: bp.level ?? 1,
		instructions: DUNGEON_PASS_INSTRUCTIONS,
		responseSchema: DUNGEON_PASS_SCHEMA
	};
}
function renderDungeonPassPrompt(p) {
	const L = [];
	L.push(p.instructions, "");
	L.push(p.rollSheet, "");
	L.push(`=== GROUPS YOU MUST WRITE (${p.groupIds.length}) ===`);
	L.push("One name + base for each id below, exactly these ids and no others. They are", "the groups printed above; the id is in brackets on each group's header line.");
	for (const id of p.groupIds) L.push(`  ${id}`);
	L.push("");
	L.push("=== RESPONSE FORMAT ===", p.responseSchema);
	return L.join("\n");
}
var DUNGEON_PASS_INSTRUCTIONS = `You are establishing a dungeon's standing fiction, before any of its rooms are
written. Everything below has already been rolled. Your job is to make one
coherent place out of it -- not to choose what is there, and not to describe any
individual room.

Whatever you write here is read by every later pass and cannot be contradicted
afterwards. Commit to it.

WHAT TO WRITE

name        What this place is called. Short. It may be what its builders called
            it, or what people call it now -- pick whichever the fiction earns.

theme       The sensory register, in a few sentences: what it is built from,
            what the light is like, what it sounds like, what it smells of, what
            the air does. Concrete nouns. This is the palette every room draws
            from, so make it specific enough to constrain and broad enough to
            furnish twenty rooms.

history     What the place was for, what happened to it, and how it came to hold
            what it holds now. Tie the ruination cause to the inhabitants: the
            best dungeons are one story, not a building plus some monsters that
            wandered in. A few short paragraphs.

goal        You are given a Dungeon Reward and a Mission. Resolve them into ONE
            objective -- take one, discard the other, or fuse them, whichever
            reads best. Then write it twice:
              summary: one line the player is told before they go in.
              spec:    what actually counts as achieving it, for the referee.
                       Concrete enough to adjudicate: what must be found, done,
                       taken, or ended. This decides when the run is won, so do
                       not leave it to taste.

opening     Everything the player knows walking in. Second person, present
            tense, three or four short paragraphs, and the ONLY briefing they
            get -- they cannot see the theme, the history, or the goal spec, and
            nothing later in the run will stop to explain what they are doing
            here. Write it as prose, not as a briefing document with headings.

            It must carry four things:

              WHAT THIS PLACE IS, and roughly where. A ruined abbey under a
              tidal flat; a mine the road still goes past. Enough for the
              player to picture it from outside before they are inside it.

              WHAT IS SAID TO HAVE HAPPENED HERE. A version of the history --
              the version that reached the surface. It may be thin, wrong in
              places, or half legend. What it must NOT be is complete: leave
              the player something to find out. If the truth is that the
              abbot's own order did this, the rumour can be that something came
              up out of the sea.

              WHAT THEY ARE GOING TO MEET. The shape of the danger, not its
              statistics. Say the thing lives here and hunts; do not say its
              hit dice, its weakness, or how many there are. A player should be
              able to decide what to bring and still be surprised.

              WHY THEY CAME, and WHAT THEY ARE HERE TO DO. The why is brief and
              may stay vague for now -- hired, paid in advance, owed a favour,
              sent. One clause is enough. The WHAT is not vague: it is the goal
              you wrote above, said plainly, in its own sentence, near the end
              where it lands last. The player should be able to close the
              opening and say what they are here for in one line. If they
              cannot, rewrite it.

            End at the threshold: the way in, and the first thing the place does
            to them. The next thing they read is the first room, so hand off
            into it rather than describing it.

groups      For each listed group id, a plural name and a standing base.
            The base is what these things ARE, permanently and everywhere in
            this dungeon: their form, their nature, how they behave, what they
            want. Realise the rolled keywords into a creature or a faction; do
            not list the keywords back.
            Write nothing that a single encounter could change. No "currently",
            no "at the moment", no room, no posture, no wound. Twelve instances
            of this group in eight rooms all share this one description, so
            anything true of only one of them does not belong in it.
            A group's LEADER and any named people get their own descriptions
            later -- write the group here, not its individuals.

HARD RULES
1. Do not contradict the rolls. Form, ruination, inhabitants and goal seed are
   settled; you are realising them, not revising them.
2. Do not write rooms. No room names, no floor plan, no "in the eastern wing".
   Rooms are written later, by a pass that has the layout in front of it. This
   binds the opening too: it ends AT the way in, and the room beyond it is the
   next thing the player reads, written by somebody who can see it.
3. Return a base for every listed group id and for no other id.
4. Keywords are seeds, not vocabulary. "Fungal" means work out what the fungus
   has done to them; it does not mean using the word "fungal".
5. Write prose, not notes. This is read as fiction by everything downstream.
6. The opening and the goal summary must say the same thing. The summary is the
   objective as a line; the opening is that same objective as something a person
   was asked to go and do. They are read minutes apart, and disagreeing is worse
   than either of them being weak.
7. The opening tells the player what they were TOLD, not what is true. Theme and
   history are the facts, and they are for the referee. What reached the player
   is allowed to be partial, and should be.`;
var DUNGEON_PASS_SCHEMA = `Return JSON only, no prose outside it:

{
  "name": "<the dungeon's name>",
  "theme": "<sensory register: material, light, sound, smell, air>",
  "history": "<what it was, what happened, who is here now>",
  "goal": {
    "summary": "<one line, told to the player>",
    "spec": "<what counts as achieving it, for the referee>"
  },
  "openingProse": "<second person: what the place is, what is said to have happened, what lives there, why they came, and — plainly, in its own sentence — what they are here to do>",
  "groups": [
    { "id": "<exactly as listed>", "name": "<plural name>", "base": "<standing identity>" }
  ]
}`;
var DungeonPassError = class extends Error {
	constructor(message) {
		super(message);
		this.name = "DungeonPassError";
	}
};
function applyDungeonPass(res, payload) {
	const expected = new Set(payload.groupIds);
	const got = new Set(res.groups.map((g) => g.id));
	const missing = [...expected].filter((id) => !got.has(id));
	const unknown = [...got].filter((id) => !expected.has(id));
	if (missing.length || unknown.length) throw new DungeonPassError([missing.length ? `no base returned for group(s): ${missing.join(", ")}` : "", unknown.length ? `base returned for unknown group(s): ${unknown.join(", ")}` : ""].filter(Boolean).join("; "));
	const blank = res.groups.filter((g) => !g.base?.trim() || !g.name?.trim());
	if (blank.length) throw new DungeonPassError(`empty name or base for group(s): ${blank.map((g) => g.id).join(", ")}`);
	const groups = {};
	for (const g of res.groups) groups[g.id] = {
		id: g.id,
		name: properName(g.name),
		base: g.base
	};
	return {
		dungeonContext: renderDungeonContext(res),
		groups,
		pass: res
	};
}
/** The standing fiction, as the later passes read it. */
function renderDungeonContext(res) {
	const L = [];
	L.push(`THE DUNGEON: ${res.name}`, "");
	L.push("THEME", res.theme, "");
	L.push("HISTORY", res.history, "");
	L.push("WHO LIVES HERE");
	for (const g of res.groups) L.push(`  ${g.name} -- ${g.base}`);
	L.push("");
	L.push("THE PLAYER'S GOAL", `  ${res.goal.summary}`, `  Satisfied by: ${res.goal.spec}`);
	return L.join("\n");
}
//#endregion
//#region src/engine/dungeon-seams-pass.ts
/**
* SEAMS PASS  (once, after every chunk has landed)
* ================================================
*
* The ways between regions. One call, and usually a short one -- two connectors
* per chunk boundary, six or eight in a large dungeon.
*
* WHY IT IS NOT PART OF THE CONTENT PASS. A connector is one entity joining two
* rooms, and it cannot be written honestly by somebody who has only seen one of
* them: what it physically is depends on both ends, and which end of a stair is
* the top is a fact about the pair. Within a chunk that is free -- six rooms are
* named in a single response, so the writer has both. Across a chunk boundary it
* is not: every chunk payload is built before any of them is applied, which is
* what lets the chunks run in parallel, so at the moment a chunk is written the
* room on the other side of its border has no name and no base.
*
* Before this pass existed, both chunks wrote those connectors -- each blind to
* the other's room -- and the later apply silently overwrote the earlier one. The
* name the player read was whichever chunk happened to have the higher number.
*
* So the chunks skip them (see `ownsConnector`) and they arrive here instead,
* after the serial applies, with both rooms written and in front of the model.
*/
/**
* Every way through that crosses a chunk boundary.
*
* The surface exit is not one: it joins a room to daylight, so there is no
* second room to wait for and the entrance room's own chunk writes it.
*/
function buildSeamsPassPayload(sd, ep, dungeonContext) {
	const chunkOf = new Map(sd.rooms.map((r) => [r.roomId, r.chunk]));
	const roomById = new Map(ep.rooms.map((r) => [r.id, r]));
	const brief = (id) => {
		const room = roomById.get(id);
		return {
			id,
			name: room?.name ?? "",
			base: room?.base ?? ""
		};
	};
	const seams = [];
	for (const c of ep.connectors) {
		if (isSurfaceExit(c) || c.endpointB === null) continue;
		if (chunkOf.get(c.endpointA) === chunkOf.get(c.endpointB)) continue;
		seams.push({
			ref: c.id,
			a: brief(c.endpointA),
			b: brief(c.endpointB),
			gated: c.conditional !== void 0,
			hidden: c.isHidden === true
		});
	}
	return {
		dungeonContext,
		seams,
		instructions: SEAMS_PASS_INSTRUCTIONS,
		responseSchema: SEAMS_PASS_SCHEMA
	};
}
function renderSeamsPassPrompt(p) {
	const L = [];
	L.push(p.instructions, "");
	L.push("=== DUNGEON FICTION (shared context) ===", p.dungeonContext, "");
	L.push(`=== WAYS TO WRITE (${p.seams.length}) ===`, "");
	const oneLine = (s) => s.replace(/\s*\n\s*/g, " ");
	for (const s of p.seams) {
		L.push(`--- ${s.ref} ---`);
		L.push(`joins "${s.a.name}" -- ${oneLine(s.a.base)}`);
		L.push(`  to   "${s.b.name}" -- ${oneLine(s.b.base)}`);
		if (s.gated) L.push(`GATED -- also write what blocks it, true from both sides.`);
		if (s.hidden) L.push("CONCEALED -- write it as the thing a person would walk past: a seam, a draught, a panel that rings hollow. Not as a door.");
		L.push("");
	}
	L.push("=== RESPONSE FORMAT ===", p.responseSchema);
	return L.join("\n");
}
var SEAMS_PASS_INSTRUCTIONS = `You are writing the ways through between regions of a dungeon whose rooms are
already written. Each one below is a single way through joining two rooms, and
both of those rooms are quoted with the description that has already been
committed to. Nothing else about the dungeon is yours to change.

FOR EACH WAY THROUGH
- name: what the thing physically is. ${CONNECTOR_NAMING}
- form: what it IS, in a sentence or two -- a door, a stair, a crawl, a flooded
  culvert, a rent in the floor. Make it suit BOTH rooms it joins: you can see
  both, which is the whole reason these were held back until now. A vault wants a
  door; a kennel wants a gate; two rooms at different depths in the water want
  something that explains the difference.
  ${CONNECTOR_HEIGHT}
- requirement: GATED ways only -- what stands in the way. Phrase it so it reads
  correctly from either side, since a player can meet it from either. Do not
  invent the key.

HARD RULES
1. Return exactly the ways listed, each once, with its ref exactly as given. Do
   not add one, and do not leave one out: a way with no form is a way the game
   cannot describe when a player walks up to it.
2. Do not contradict either room's description. They are written and committed.
3. Do not describe the rooms. You are writing what is BETWEEN them.
4. Write prose, not notes.`;
var SEAMS_PASS_SCHEMA = `Return JSON only, no prose outside it:

{
  "connectors": [
    {
      "ref": "<exactly as given>",
      "name": "<what it is, naming neither room>",
      "form": "<what it physically is; which room is above, where it changes level>",
      "requirement": "<gated only: what blocks it>"
    }
  ]
}`;
/**
* Every way through that was listed and did not come back.
*
* The same hole `contentPassOmissions` closes, in the pass that has always been
* able to see it: `applySeamsPass` already reports `missing`, but it reports it
* AFTER applying, when the call is spent and there is no retry left to take.
* Asked before the response is accepted, the same question buys the retry.
*
* A seam that never comes back is the worst-placed gap in the dungeon: it is by
* definition a way between two regions, so a player meets it while crossing from
* one to the other, and it has no form for the referee to describe.
*/
function seamsPassOmissions(payload, res) {
	const written = new Set((res.connectors ?? []).map((c) => c.ref));
	return payload.seams.filter((s) => !written.has(s.ref)).map((s) => ({
		path: `connectors.${s.ref}`,
		message: `way through ${s.ref} (${s.a.name} to ${s.b.name}) was listed and is not in the response`
	}));
}
/**
* Write the name and form onto the connector entities.
*
* Anything not listed in the payload is ignored rather than applied: a chunk's
* connectors were written by whoever could see both their rooms, and this pass
* has no business overwriting them.
*/
function applySeamsPass(res, payload, ep) {
	const listed = new Set(payload.seams.map((s) => s.ref));
	const connectorById = new Map(ep.connectors.map((c) => [c.id, c]));
	const written = [];
	for (const cr of res.connectors ?? []) {
		if (!listed.has(cr.ref)) continue;
		const conn = connectorById.get(cr.ref);
		if (!conn) continue;
		conn.name = properName(cr.name);
		conn.base = cr.form;
		conn.keywords = {};
		if (cr.requirement) conn.conditional = cr.requirement;
		written.push(cr.ref);
	}
	return {
		written,
		missing: [...listed].filter((ref) => !written.includes(ref))
	};
}
/**
* A defense used as a roll target. Knave contests must EXCEED the defense, so
* meeting `defense + 1` is the same bar. The only `+1` in the codebase.
*/
function dcFromDefense(defense) {
	return defense + 1;
}
function die(rng, sides) {
	return Math.floor(rng.next() * sides) + 1;
}
/**
* Advantage and disadvantage are roll-two-keep-best / keep-worst, on the d20
* only — never on damage. A natural 20 or 1 is read off the die that counts,
* not off whichever die happened to show it.
*/
function d20(rng, edge = "none") {
	const rolled = edge === "none" ? [die(rng, 20)] : [die(rng, 20), die(rng, 20)];
	const kept = edge === "advantage" ? Math.max(...rolled) : edge === "disadvantage" ? Math.min(...rolled) : rolled[0];
	return {
		rolled,
		kept,
		nat20: kept === 20,
		nat1: kept === 1
	};
}
var DAMAGE_RE = /^\s*(\d*)\s*d\s*(\d+)\s*(?:([+-])\s*(\d+))?\s*$/i;
/** "1d6", "2d8+1", "d10", "1d6-1". Throws on anything else. */
function parseDamage(expr) {
	const m = DAMAGE_RE.exec(expr);
	if (!m) throw new Error(`unparseable damage expression: ${JSON.stringify(expr)}`);
	const count = m[1] === "" ? 1 : Number(m[1]);
	const sides = Number(m[2]);
	const flat = m[3] === void 0 ? 0 : (m[3] === "-" ? -1 : 1) * Number(m[4]);
	if (count < 1 || sides < 1) throw new Error(`nonsensical damage expression: ${JSON.stringify(expr)}`);
	return {
		count,
		sides,
		flat
	};
}
/**
* `extraDice` adds dice of the weapon's own type — a natural 20, or the right
* weapon against the right enemy. Damage never takes advantage.
*/
function rollDamage(rng, expr, extraDice = 0) {
	const { count, sides, flat } = parseDamage(expr);
	const rolls = [];
	for (let i = 0; i < count + extraDice; i++) rolls.push(die(rng, sides));
	return {
		expr,
		rolls,
		flat,
		total: Math.max(0, rolls.reduce((a, b) => a + b, 0) + flat)
	};
}
/**
* The contest underneath all three: d20 + bonus against a number to meet.
*
* Exported because the turn machine resolves a `RollSpec` whose `dc` has
* already been converted from a defense by whoever offered the roll — so it
* needs the bare contest, and taking it from here keeps `dcFromDefense` the
* only place a defense turns into a target.
*/
function checkRoll(rng, bonus, dc, edge = "none") {
	const roll = d20(rng, edge);
	const total = roll.kept + bonus;
	return {
		...roll,
		bonus,
		total,
		dc,
		success: total >= dc
	};
}
/**
* A save. `dc` defaults to the ordinary 16; when a creature is the source of
* the risk, pass `dcFromDefense(creatureDefense)` instead — that is also how an
* opposed save is expressed, since a defense is always bonus + 10.
*/
function saveRoll(rng, bonus, dc = 16, edge = "none") {
	return checkRoll(rng, bonus, dc, edge);
}
function critEffects(o, wellSuited = false) {
	return {
		defenderArmor: o.nat20,
		attackerWeapon: o.nat1,
		extraDamageDice: (o.nat20 ? 1 : 0) + (wellSuited ? 1 : 0)
	};
}
/**
* An attack. Takes the target's DEFENSE, not a DC — that is the vocabulary the
* playbook uses. Rolls its own damage on a hit, including the extra die for a
* natural 20 and for a well-suited weapon.
*/
function attackRoll(rng, opts) {
	const outcome = checkRoll(rng, opts.bonus, dcFromDefense(opts.targetDefense), opts.edge ?? "none");
	const crit = critEffects(outcome, opts.wellSuited);
	const result = {
		...outcome,
		crit
	};
	if (outcome.success && opts.damage) result.damage = rollDamage(rng, opts.damage, crit.extraDamageDice);
	return result;
}
/**
* A stunt — stunning, shoving, disarming, tripping, sundering. Resolved as a
* contest against the target's defense and dealing no damage of its own.
*
* A player with advantage may instead spend it to stunt AND deal damage on the
* same hit; the playbook passes `edge: "none"` in that case, because the
* advantage bought the combination rather than a reroll.
*/
function stuntRoll(rng, bonus, targetDefense, edge = "none") {
	return checkRoll(rng, bonus, dcFromDefense(targetDefense), edge);
}
/**
* 2d6 against the group's morale rating. They break when the roll comes up
* HIGHER than the rating, so equalling it still holds.
*
* Triggered by half the group falling, the leader going down, or a lone
* creature dropping to half its hit points.
*/
function moraleRoll(rng, rating = 7) {
	const rolled = [die(rng, 6), die(rng, 6)];
	const total = rolled[0] + rolled[1];
	return {
		rolled,
		total,
		holds: total <= rating
	};
}
/**
* A book gives up what it has, and then it has no more.
*
* Add one to the count of readings, roll a d6, and the book is spent when the
* die comes up at or under that count. Nothing decides in advance how much is
* in a book: the first reading is safe five times in six, the third is even
* money, the sixth is certain, and the expected book answers between two and
* three questions.
*
* The roll happens at the READING, not at the writing — which is the difference
* between a book whose depth is a fact about the world and one whose depth is
* found out by using it. Only the second can surprise the person holding it.
*/
function consultRoll(rng, priorUses = 0) {
	const uses = Math.max(0, priorUses) + 1;
	const rolled = die(rng, 6);
	return {
		uses,
		rolled,
		exhausted: rolled <= uses
	};
}
//#endregion
//#region src/engine/dungeon-character.ts
/**
* dungeon-character.ts
* ====================
*
* The player character. Made during character creation, before play; the
* runtime reads it into the context of every generation so the model always
* knows who is standing in the room, what they can perceive, and what they can
* reach or carry. Mutation in play (damage, inventory changes, quality loss,
* conditions) happens through the helpers here.
*
* Knave-native: six abilities stored as BONUSES (a defense is always bonus + 10),
* HP, level (which caps ability bonuses), the eleven Knave background traits, an
* inventory of real Item entities, and a free-text condition list.
*
* CARRYING CAPACITY is Knave's: slots = CON defense = CON bonus + 10. Each item
* costs its own `slots` (default 1); the total may not exceed capacity. See the
* slot helpers below.
*/
/** Total slots this character can carry: CON defense (CON bonus + 10). */
function slotCapacity(pc) {
	return pc.abilities.con + 10;
}
/** Slots currently taken up, summing each item's cost (default 1). */
function slotsUsed(pc) {
	return pc.inventory.reduce((n, it) => n + (it.slots ?? 1), 0);
}
function slotsFree(pc) {
	return slotCapacity(pc) - slotsUsed(pc);
}
function isOverburdened(pc) {
	return slotsUsed(pc) > slotCapacity(pc);
}
/** Whether an item would fit in the remaining free slots. */
function canCarry(pc, item) {
	return (item.slots ?? 1) <= slotsFree(pc);
}
/** Capacity / used / free / overburdened in one call, for display or checks. */
function inventoryStatus(pc) {
	const capacity = slotCapacity(pc);
	const used = slotsUsed(pc);
	return {
		capacity,
		used,
		free: capacity - used,
		overburdened: used > capacity
	};
}
/**
* Add an item to the character's inventory, binding its parentId to the
* character. Refuses (returns false) if it would exceed capacity, unless
* `force` is set -- forcing leaves the character overburdened, which callers can
* detect via isOverburdened().
*/
function addItem(pc, item, opts = {}) {
	if (!opts.force && !canCarry(pc, item)) return false;
	item.parentId = pc.id;
	pc.inventory.push(item);
	return true;
}
/** Remove an item by id; returns the removed item, or undefined if not held.
*  Also clears any equipment slot that pointed at it. */
function removeItem(pc, itemId) {
	const i = pc.inventory.findIndex((x) => x.id === itemId);
	if (i === -1) return void 0;
	for (const slot of EQUIP_SLOTS) if (pc.equipped[slot] === itemId) delete pc.equipped[slot];
	return pc.inventory.splice(i, 1)[0];
}
var EQUIP_SLOTS = [
	"weapon",
	"armor",
	"helmet",
	"shield"
];
/** The inventory item with this id, if the character is carrying it. */
function heldItem(pc, itemId) {
	return itemId ? pc.inventory.find((i) => i.id === itemId) : void 0;
}
function isTwoHanded(item) {
	return item !== void 0 && isWeapon(item) && item.weapon.hands === 2;
}
/** Whether an item is the right kind of thing for a slot (ignores conflicts). */
function slotAcceptsItem(slot, item) {
	const armorType = isArmor(item) ? item.armor.armorType : void 0;
	switch (slot) {
		case "weapon": return isWeapon(item);
		case "armor": return armorType === "body";
		case "helmet": return armorType === "helmet";
		case "shield": return armorType === "shield";
	}
}
/** Whether `itemId` may be equipped to `slot`, and why not if it can't. */
function canEquip(pc, slot, itemId) {
	const item = heldItem(pc, itemId);
	if (!item) return {
		ok: false,
		reason: "that item isn't in the character's inventory"
	};
	if (!slotAcceptsItem(slot, item)) return {
		ok: false,
		reason: `the ${slot} slot needs ${slot === "weapon" ? "a weapon" : slot === "armor" ? "body armor" : slot === "helmet" ? "a helmet" : "a shield"}`
	};
	if (slot === "shield" && isTwoHanded(heldItem(pc, pc.equipped.weapon))) return {
		ok: false,
		reason: "a shield can't be used alongside a two-handed weapon"
	};
	if (slot === "weapon" && isTwoHanded(item) && pc.equipped.shield) return {
		ok: false,
		reason: "a two-handed weapon can't be used while a shield is equipped"
	};
	return { ok: true };
}
/**
* Which filled slots CANNOT stay filled if `itemId` goes into `slot`.
*
* Only one rule in Knave: a shield and a two-handed weapon need three hands
* between them. It is symmetric — taking up the halberd puts the shield away,
* and taking up the shield puts the halberd away — because both are the same
* physical fact stated from opposite ends.
*/
function conflictingSlots(pc, slot, itemId) {
	const item = heldItem(pc, itemId);
	if (!item) return [];
	if (slot === "weapon" && isTwoHanded(item) && pc.equipped.shield) return ["shield"];
	if (slot === "shield" && isTwoHanded(heldItem(pc, pc.equipped.weapon))) return ["weapon"];
	return [];
}
/**
* Equip, clearing whatever the new arrangement contradicts.
*
* This is what the diff applier calls. A diff states the destination — "the
* halberd is now in their hands" — and it is this function's job to work out
* everything that has to be true for that, rather than the referee's job to
* remember to put the shield away first and lose a round trip when it forgets.
*
* `canEquip` stays strict and is still the right question for a UI asking
* "is this legal right now"; the failures it reports that this cannot resolve
* — an item not carried, the wrong kind of thing for the slot — remain
* failures here.
*/
function equipResolving(pc, slot, itemId) {
	const displaced = conflictingSlots(pc, slot, itemId);
	const before = displaced.map((s) => [s, pc.equipped[s]]);
	for (const s of displaced) unequip(pc, s);
	const check = canEquip(pc, slot, itemId);
	if (!check.ok) {
		for (const [s, id] of before) if (id !== void 0) pc.equipped[s] = id;
		return {
			...check,
			displaced: []
		};
	}
	pc.equipped[slot] = itemId;
	return {
		ok: true,
		displaced
	};
}
/** Clear an equipment slot. */
function unequip(pc, slot) {
	delete pc.equipped[slot];
}
/** Re-check every filled slot; returns a list of problems (empty = all valid). */
function validateEquipment(pc) {
	const issues = [];
	for (const slot of EQUIP_SLOTS) {
		const id = pc.equipped[slot];
		if (id === void 0) continue;
		const check = canEquip(pc, slot, id);
		if (!check.ok) issues.push(`${slot}: ${check.reason}`);
	}
	return issues;
}
/** The bonus applied to a melee attack roll. */
function meleeAttackBonus(pc) {
	return pc.abilities.str;
}
/** The bonus applied to a ranged attack roll. */
function rangedAttackBonus(pc) {
	return pc.abilities.wis;
}
/**
* The character's armor defense — the number a foe must meet to hit them.
* Starts from the item in the **armor** slot (its `armor.defense`), or 11 when
* the slot is empty, then +1 for an equipped helmet and +1 for an equipped
* shield. Parallels the creature-side `armorDefense(stats)` in dungeon-entities.
*/
function armorDefense(pc) {
	const worn = heldItem(pc, pc.equipped.armor);
	const base = worn && isArmor(worn) ? worn.armor.defense : 11;
	const helmet = heldItem(pc, pc.equipped.helmet) ? 1 : 0;
	const shield = heldItem(pc, pc.equipped.shield) ? 1 : 0;
	return base + helmet + shield;
}
/** A one-line label for an item, terse enough for the PC block in a prompt. */
function itemSummary(it) {
	const bits = [it.name || "unnamed item"];
	if (it.amount) bits.push(`(${it.amount})`);
	if (isWeapon(it)) {
		const w = it.weapon;
		bits.push(`[${w.ranged ? "ranged " : ""}${w.damage}${w.hands === 2 ? ", 2h" : ""}]`);
	}
	if (isArmor(it)) bits.push(`[armor def ${it.armor.defense}]`);
	if (isBook(it)) {
		const subject = it.book.subject || "no stated subject";
		bits.push(it.book.exhausted ? `[${subject}, read out]` : `[${subject}]`);
	}
	const q = it.currentQuality ?? it.quality;
	if (q !== void 0) bits.push(`q${q}`);
	const s = it.slots ?? 1;
	if (s !== 1) bits.push(`${s} slots`);
	return bits.join(" ");
}
//#endregion
//#region src/engine/knave-tables.ts
var t = (s) => s.split("|");
t("Athletic|Brawny|Corpulent|Delicate|Gaunt|Hulking|Lanky|Ripped|Rugged|Scrawny|Short|Sinewy|Slender|Flabby|Statuesque|Stout|Tiny|Towering|Willowy|Wiry");
t("Bloated|Blunt|Bony|Chiseled|Delicate|Elongated|Patrician|Pinched|Hawkish|Broken|Impish|Narrow|Ratlike|Round|Sunken|Sharp|Soft|Square|Wide|Wolfish");
t("Battle scar|Birthmark|Burn scar|Dark|Makeup|Oily|Pale|Perfect|Pierced|Pockmarked|Reeking|Tattooed|Rosy|Rough|Sallow|Sunburned|Tanned|War paint|Weathered|Whip scar");
t("Bald|Braided|Bristly|Cropped|Curly|Disheveled|Dreadlocks|Filthy|Frizzy|Greased|Limp|Long|Luxurious|Mohawk|Oily|Ponytail|Silky|Topknot|Wavy|Wispy");
t("Antique|Bloody|Ceremonial|Decorated|Eccentric|Elegant|Fashionable|Filthy|Flamboyant|Stained|Foreign|Frayed|Frumpy|Livery|Oversized|Patched|Perfumed|Rancid|Torn|Undersized");
t("Ambitious|Cautious|Courageous|Courteous|Curious|Disciplined|Focused|Generous|Gregarious|Honest|Honorable|Humble|Idealistic|Just|Loyal|Merciful|Righteous|Serene|Stoic|Tolerant");
t("Aggressive|Arrogant|Bitter|Cowardly|Cruel|Deceitful|Flippant|Gluttonous|Greedy|Irascible|Lazy|Nervous|Prejudiced|Reckless|Rude|Suspicious|Vain|Vengeful|Wasteful|Whiny");
t("Blunt|Booming|Breathy|Cryptic|Drawling|Droning|Flowery|Formal|Gravelly|Hoarse|Mumbling|Precise|Quaint|Rambling|Rapid-fire|Dialect|Slow|Squeaky|Stuttering|Whispery");
t("Alchemist|Beggar|Butcher|Burglar|Charlatan|Cleric|Cook|Cultist|Gambler|Herbalist|Magician|Mariner|Mercenary|Merchant|Outlaw|Performer|Pickpocket|Smuggler|Student|Tracker");
t("Abandoned|Addicted|Blackmailed|Condemned|Cursed|Defrauded|Demoted|Discredited|Disowned|Exiled|Framed|Haunted|Kidnapped|Mutilated|Poor|Pursued|Rejected|Replaced|Robbed|Suspected");
[
	...Array(5).fill("Law"),
	...Array(10).fill("Neutrality"),
	...Array(5).fill("Chaos")
];
/** The armor rows, worst to best — which is also cheapest to dearest. */
var ARMOR_KEYS = [
	"gambeson",
	"brigandine",
	"chain_armor",
	"half_plate",
	"full_plate",
	"helmet",
	"shield"
];
var WEAPON_CLASSES = [
	{
		key: "light",
		label: "Light",
		members: [
			"dagger",
			"cudgel",
			"sickle",
			"staff"
		]
	},
	{
		key: "medium",
		label: "Medium",
		members: [
			"spear",
			"sword",
			"mace",
			"axe",
			"flail"
		]
	},
	{
		key: "heavy",
		label: "Heavy",
		members: [
			"halberd",
			"war_hammer",
			"long_sword",
			"battle_axe"
		]
	},
	{
		key: "sling",
		label: "Sling",
		members: ["sling"]
	},
	{
		key: "bow",
		label: "Bow",
		members: ["bow"]
	},
	{
		key: "crossbow",
		label: "Crossbow",
		members: ["crossbow"]
	}
];
WEAPON_CLASSES.flatMap((c) => c.members);
var SHOP_SECTIONS = [
	{
		key: "tools",
		label: "Tools & gear",
		entries: [
			"air_bladder",
			"bear_trap",
			"bedroll",
			"bellows",
			"grease",
			"block_and_tackle",
			"blank_book",
			"reading_book",
			"bottle",
			"bucket",
			"caltrops",
			"marked_cards",
			"chain",
			"chalk",
			"chisel",
			"cookpots",
			"crowbar",
			"drill",
			"face_paint",
			"fake_jewels",
			"fishing_rod",
			"glass_marbles",
			"glue",
			"grappling_hook",
			"hammer",
			"holy_water",
			"horn",
			"hourglass",
			"incense",
			"iron_tongs",
			"ladder",
			"sponge",
			"lens",
			"lockpicks",
			"manacles",
			"metal_file",
			"mirror",
			"musical_instrument",
			"nails",
			"net",
			"oilskin_bag",
			"oilskin_trousers",
			"padlock",
			"perfume",
			"pick",
			"pole",
			"quill_and_ink",
			"rope",
			"sack",
			"saw",
			"loaded_dice",
			"shovel",
			"small_bell",
			"soap",
			"iron_spike",
			"wood_spike",
			"spiked_boots",
			"spyglass",
			"tar",
			"tent_3man",
			"tent_personal",
			"twine",
			"waterskin",
			"whistle"
		]
	},
	{
		key: "light",
		label: "Light",
		note: "Burn times are the book's.",
		entries: [
			"candle",
			"lantern",
			"lamp_oil",
			"tinderbox",
			"torch"
		]
	},
	{
		key: "ammunition",
		label: "Ammunition",
		entries: ["arrows", "quiver"]
	},
	{
		key: "clothing",
		label: "Clothing",
		entries: [
			"poor_clothing",
			"standard_clothing",
			"winter_clothing",
			"noble_clothing",
			"furs"
		]
	},
	{
		key: "food",
		label: "Food & drink",
		entries: [
			"rations",
			"animal_feed",
			"bacon",
			"bread",
			"cheese",
			"cider",
			"cod",
			"eggs",
			"flour",
			"fruit",
			"garlic",
			"grain",
			"herbs",
			"lard",
			"onions",
			"salt",
			"spices",
			"sugar",
			"wine"
		]
	}
];
var spell = (s) => {
	const i = s.indexOf(": ");
	return {
		name: s.slice(0, i),
		effect: s.slice(i + 2)
	};
};
[
	"Adhere: Object is covered in extremely sticky slime.",
	"Animate Object: Object obeys your commands as best it can. It can walk 15ft per round.",
	"Anthropomorphize: A touched animal either gains human intelligence or human appearance for L days.",
	"Arcane Eye: You can see through a magical floating eyeball that flies around at your command.",
	"Astral Prison: An object is frozen in time and space within an invulnerable crystal shell.",
	"Attract: L+1 objects are strongly magnetically attracted to each other if they come within 10 feet.",
	"Auditory Illusion: You create illusory sounds that seem to come from a direction of your choice.",
	"Babble: A creature must loudly and clearly repeat everything you think. It is otherwise mute.",
	"Beast Form: You and your possessions transform into a mundane animal.",
	"Befuddle: L creatures of your choice are unable to form new short-term memories for the duration of the spell.",
	"Bend Fate: Roll L+1 d20s. Whenever you must roll a d20 after casting the spell, you must choose and then discard one of the rolled results until they are all gone.",
	"Bird Person: Your arms turn into huge bird wings.",
	"Body Swap: You switch bodies with a creature you touch. If one body dies, the other dies as well.",
	"Catherine: A woman wearing a blue dress appears until end of spell. She will obey polite, safe requests.",
	"Charm: L creatures treat you like a friend.",
	"Command: A creature obeys a single, three-word command that does not harm it.",
	"Comprehend: You become fluent in all languages.",
	"Control Plants: Nearby plants and trees obey you and gain the ability to move at 5 feet per round.",
	"Control Weather: You may alter the type of weather at will, but you do not otherwise control it.",
	"Counterspell: Make an opposed Intelligence save against the Intelligence of the caster of a nearby spell. You may do this out of turn as a reaction, or against an ongoing magical effect. On a success, you may cancel the spell.",
	"Deafen: All nearby creatures are deafened.",
	"Detect Magic: You hear nearby magical auras singing.",
	"Disassemble: Any of your body parts may be detached and reattached at will, without causing pain or damage. You can still control them.",
	"Disguise: You may alter the appearance of L characters at will as long as they remain humanoid. Attempts to duplicate other characters will seem uncanny.",
	"Displace: An object appears to be up to L×10ft from its actual position.",
	"Earthquake: The ground begins shaking violently. Structures may be damaged or collapse.",
	"Elasticity: Your body can stretch up to L×10ft.",
	"Elemental Wall: A straight wall of ice or fire L×40ft long and 10ft high rises from the ground.",
	"Filch: L visible items teleport to your hands.",
	"Fog Cloud: Dense fog spreads out from you.",
	"Frenzy: L creatures erupt in a frenzy of violence.",
	"Gate: A portal to a random plane opens.",
	"Gravity Shift: You can change the direction of gravity (for yourself only) up to once per round.",
	"Greed: L creatures develop an overwhelming urge to possess a visible item of your choice.",
	"Haste: Your movement speed is tripled.",
	"Hatred: L creatures develop a deep hatred of another creature or group of creatures and wish to destroy it.",
	"Hear Whispers: You can hear faint sounds clearly.",
	"Hover: An object hovers, frictionless, 2ft above the ground. It can hold up to L humanoids.",
	"Hypnotize: A creature enters a trance and will truthfully answer L yes or no questions you ask it.",
	"Icy Touch: A thick ice layer spreads across a touched surface, up to L×10ft in radius.",
	"Illuminate: A floating light moves as you command.",
	"Increase Gravity: The gravity in an area triples.",
	"Invisible Tether: Two objects within 10ft of each other cannot be moved more than 10ft apart.",
	"Knock: L nearby mundane or magical locks unlock.",
	"Leap: You can jump up to L×10ft in the air.",
	"Liquid Air: The air around you becomes swimmable.",
	"Magic Dampener: All nearby magical effects have their effectiveness halved.",
	"Manse: A sturdy, furnished cottage appears for L×12 hours. You can permit and forbid entry to it at will.",
	"Marble Madness: Your pockets are full of marbles, and will refill every round.",
	"Masquerade: Appearances and voices become identical to a touched character.",
	"Miniaturize: You and L other touched creatures are reduced to the size of a mouse.",
	"Mirror Image: L illusory duplicates of yourself appear under your control.",
	"Mirrorwalk: A mirror becomes a gateway to another mirror that you looked into today.",
	"Multiarm: You gain L extra arms.",
	"Night Sphere: An L×40ft wide sphere of darkness displaying the night sky appears.",
	"Objectify: You become any inanimate object between the size of a grand piano and an apple.",
	"Ooze Form: You become a living jelly.",
	"Pacify: L creatures have an aversion to violence.",
	"Phantom Coach: A ghostly coach appears until end of spell. It moves unnaturally fast over any terrain, including water.",
	"Phobia: L creatures become terrified of an object of your choice.",
	"Pit: A pit 10ft wide and L×5ft deep opens in the ground.",
	"Primeval Surge: An object grows to the size of an elephant. If it is an animal, it is enraged.",
	"Psychometry: The referee answers L yes or no questions about a touched object.",
	"Pull: An object of any size is pulled directly towards you with the strength of L men for one round.",
	"Push: An object of any size is pushed directly away from you with the strength of L men for one round.",
	"Raise Dead: L skeletons rise from the ground to serve you. They are incredibly stupid and can only obey simple orders.",
	"Raise Spirit: The spirit of a dead body manifests and will answer L questions.",
	"Read Mind: You can hear the surface thoughts of nearby creatures.",
	"Repel: L+1 objects are strongly magnetically repelled from each other if they come within 10 feet.",
	"Scry: You can see through the eyes of a creature you touched earlier today.",
	"Sculpt Elements: All inanimate material behaves like clay in your hands.",
	"Shroud: L creatures are invisible until they move.",
	"Shuffle: L creatures instantly switch places. Determine where they end up randomly.",
	"Sleep: L creatures fall into a light sleep.",
	"Smoke Form: Your body becomes living smoke.",
	"Snail Knight: 10 minutes after casting, a knight sitting astride a giant snail rides into view. He is able to answer most questions related to quests and chivalry, and may aid you if he finds you worthy.",
	"Sniff: You can smell even the faintest traces of scents.",
	"Sort: Inanimate items sort themselves according to categories you set. The categories must be visually verifiable.",
	"Spectacle: A clearly unreal but impressive illusion of your choice appears, under your control. It may be up to the size of a palace and has full motion and sound.",
	"Spellseize: Cast this as a reaction to another spell going off to make a temporary copy of it that you can cast at any time before this spell ends.",
	"Spider Climb: You can climb surfaces like a spider.",
	"Summon Cube: Once per second, (6 times per round) you may summon or banish a 3-foot-wide cube of earth. New cubes must be affixed to the earth or to other cubes.",
	"Swarm: You become a swarm of crows, rats, or piranhas. You only take damage from area effects.",
	"Telekinesis: You may mentally move L items.",
	"Telepathy: L+1 creatures can hear each other's thoughts, no matter how far apart they move.",
	"Teleport: An object disappears and reappears on the ground in a visible, clear area up to L×40ft away.",
	"Thaumaturgic Anchor: Object becomes the target of every spell cast near it.",
	"Thicket: A thicket of trees and dense brush up to L×40ft wide suddenly sprouts up.",
	"Time Jump: An object disappears as it jumps L×10 minutes into the future. When it returns, it appears in the unoccupied area nearest to where it left.",
	"Summon Idol: A carved stone statue the size of a four poster bed rises from the ground.",
	"Time Rush: Time in a 40ft bubble starts moving 10 times faster.",
	"Time Slow: Time in a 40ft bubble slows to 10%.",
	"True Sight: You see through all nearby illusions.",
	"Upwell: A spring of seawater appears.",
	"Vision: You completely control what a creature sees.",
	"Visual Illusion: A silent, immobile, illusion of your choice appears, up to the size of a bedroom.",
	"Ward: A silver circle 40ft across appears on the ground. Choose one thing that cannot cross it: living creatures, dead creatures, projectiles or metal.",
	"Web: Your wrists can shoot thick webbing.",
	"Wizard Mark: Your finger can shoot a stream of ulfire-colored paint. This paint is only visible to you, and can be seen at any distance, even through solid objects.",
	"X-Ray Vision: You gain X-Ray vision."
].map(spell);
"Alma|Balthazar|Barsaba|Bertram|Bianca|Clovis|Constance|Damaris|Esme|Faustus|Fern|Hester|Jasper|Jessamine|Merrick|Mortimer|Nerissa|Odette|Oswald|Peregrine|Piety|Quentin|Silas|Sybil|Tuesday|Ursula|Waverly|Wendy".split("|");
"Barrow|Beetleman|Berrycloth|Coffin|Culpepper|Dankworth|Digworthy|Dreggs|Gimble|Graveworm|Hardwick|Hovel|Knibbs|Midnighter|Nethercoat|Ottick|Relish|Rumbold|Rummage|Sallow|Saltmarsh|Silverless|Skitter|Slee|Stoker|Tarwater|Tumbler|Villin".split("|");
//#endregion
//#region src/engine/shop.ts
function good(key, kind, section) {
	const t = STANDARD_EQUIPMENT[key];
	return {
		key,
		name: t.name,
		...t.amount ? { amount: t.amount } : {},
		cost: t.value,
		slots: t.slots ?? 1,
		kind,
		section,
		template: t,
		toItem: (rng) => mintItem(key, "", rng)
	};
}
/** The armor rows, worst to best — which is also cheapest to dearest. */
var ARMOR_GOODS = ARMOR_KEYS.map((k) => good(k, "armor", "armor"));
/** Every named weapon, in class order. The screen groups them by class again. */
var WEAPON_GOODS = WEAPON_CLASSES.flatMap((c) => c.members.map((k) => good(k, "weapon", "weapons")));
var GEAR_GOODS = SHOP_SECTIONS.flatMap((s) => s.entries.map((k) => good(k, "gear", s.key)));
var ALL_GOODS = [
	...ARMOR_GOODS,
	...WEAPON_GOODS,
	...GEAR_GOODS
];
new Map(ALL_GOODS.map((g) => [g.key, g]));
[...SHOP_SECTIONS.map((s) => ({
	key: s.key,
	label: s.label,
	...s.note ? { note: s.note } : {},
	goods: GEAR_GOODS.filter((g) => g.section === s.key)
}))];
Math.PI / 2, -Math.PI / 2;
//#endregion
//#region src/engine/dungeon-blockplan.ts
/**
* BLOCK PLAN — the dungeon as a partition of the grid, before any room has a shape.
*
* The packer in `dungeon-floorplan.ts` searches: it picks a rectangle for a room,
* tries it against its placed neighbours, and backtracks when the rest of the
* dungeon will not fit around it. Measured, that search runs out of its position
* budget rather than out of options — it thrashes — and at thirty rooms it draws
* about one time in a hundred, because every room has to succeed and the odds
* multiply.
*
* This builds instead of searching. One cell per room, a line between every pair
* that connects, then the rooms grow outward until they have divided the space
* between them. Nothing backtracks and nothing compounds, so a thirty-room
* dungeon is not meaningfully harder than a six-room one.
*
* This file covers the first two steps only:
*
*   1. CENTRES — one cell per room, from Phase A's relaxed positions, spaced so
*      that connected rooms sit 4 to 8 cells apart measured round a corner.
*   2. PATHS   — a line from each room's centre to each of its neighbours',
*      turning at most once, no two lines sharing a cell.
*
* Step 2 is the only one that can fail, and it is why this returns null. Phase A
* guarantees the graph *can* be drawn without crossings; it does not guarantee
* that its force-relaxed positions are such a drawing, and a one-turn line has
* only two routes to choose between. When it fails the caller advances the seed,
* exactly as everything else here does.
*/
/** How far apart connected rooms should sit, measured round one corner. */
var SPAN_MIN = 5;
var SPAN_MAX = 9;
/** Rooms in different chunks sit at the far end of that: a chunk boundary is a journey. */
var TARGET_SAME = 6;
var TARGET_ACROSS = 9;
/** No two centres closer than this, connected or not. */
var CLEAR = 3;
/** How many times a failing connection may move a room before the seed is given up on. */
var REPAIRS = 250;
var manhattan = (p, q) => Math.abs(p.x - q.x) + Math.abs(p.y - q.y);
/**
* Space the rooms out.
*
* Phase A already relaxed them — connected rooms pulling together, all rooms
* pushing apart — so the shape is right and only the scale is wrong. This takes
* that shape, sizes it so a typical connection comes out in range, and then runs
* a short relaxation of its own against the actual targets, because scaling
* alone leaves the short edges too short and the long ones too long.
*/
function spaceOut(graph, chunkOf, rng) {
	const n = graph.rooms.length;
	const edges = graph.edges.map((e) => ({
		a: e.a,
		b: e.b,
		target: chunkOf.get(e.a) === chunkOf.get(e.b) ? TARGET_SAME : TARGET_ACROSS
	}));
	const raw = graph.edges.map((e) => Math.hypot(graph.rooms[e.a].pos.x - graph.rooms[e.b].pos.x, graph.rooms[e.a].pos.y - graph.rooms[e.b].pos.y)).sort((p, q) => p - q);
	const scale = 15 / 2 / 1.27 / (raw[Math.floor(raw.length / 2)] || 1);
	const pos = graph.rooms.map((r) => ({
		x: r.pos.x * scale + rng.range(-2e3, 2e3) / 1e3,
		y: r.pos.y * scale + rng.range(-2e3, 2e3) / 1e3
	}));
	const springs = (passes) => {
		for (let pass = 0; pass < passes; pass++) {
			const fx = new Array(n).fill(0);
			const fy = new Array(n).fill(0);
			for (const e of edges) {
				const dx = pos[e.b].x - pos[e.a].x;
				const dy = pos[e.b].y - pos[e.a].y;
				const d = Math.abs(dx) + Math.abs(dy) || .001;
				const pull = (d - e.target) / d * .12;
				fx[e.a] += dx * pull;
				fy[e.a] += dy * pull;
				fx[e.b] -= dx * pull;
				fy[e.b] -= dy * pull;
			}
			for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
				const dx = pos[j].x - pos[i].x;
				const dy = pos[j].y - pos[i].y;
				const d = Math.abs(dx) + Math.abs(dy) || .001;
				if (d >= 4) continue;
				const push = (4 - d) / d * .25;
				fx[i] -= dx * push;
				fy[i] -= dy * push;
				fx[j] += dx * push;
				fy[j] += dy * push;
			}
			for (let i = 0; i < n; i++) {
				pos[i].x += fx[i];
				pos[i].y += fy[i];
			}
		}
	};
	springs(240);
	const eList = edges.map((e) => ({
		a: e.a,
		b: e.b
	}));
	for (let round = 0; round < 6; round++) {
		untangle(pos, eList, rng, 1200);
		springs(50);
	}
	untangle(pos, eList, rng, 1200);
	const cells = pos.map((p) => ({
		x: Math.round(p.x),
		y: Math.round(p.y)
	}));
	const taken = /* @__PURE__ */ new Set();
	const key = (p) => `${p.x},${p.y}`;
	for (let i = 0; i < n; i++) {
		let guard = 0;
		while (guard++ < 400) {
			if (!(taken.has(key(cells[i])) || cells.some((c, j) => j !== i && taken.has(key(c)) && manhattan(c, cells[i]) < CLEAR))) break;
			cells[i].x += rng.pick([
				-1,
				0,
				1
			]);
			cells[i].y += rng.pick([
				-1,
				0,
				1
			]);
		}
		taken.add(key(cells[i]));
	}
	return cells;
}
/** Do the open segments p1p2 and p3p4 properly cross? */
function segsCross(p1, p2, p3, p4) {
	const side = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
	const d1 = side(p3, p4, p1);
	const d2 = side(p3, p4, p2);
	const d3 = side(p1, p2, p3);
	const d4 = side(p1, p2, p4);
	return (d1 > 0 && d2 < 0 || d1 < 0 && d2 > 0) && (d3 > 0 && d4 < 0 || d3 < 0 && d4 > 0);
}
/** How many pairs of connections cross. Pairs sharing a room are skipped. */
function countCrossings(pos, edges) {
	let n = 0;
	for (let i = 0; i < edges.length; i++) for (let j = i + 1; j < edges.length; j++) {
		const e = edges[i];
		const f = edges[j];
		if (e.a === f.a || e.a === f.b || e.b === f.a || e.b === f.b) continue;
		if (segsCross(pos[e.a], pos[e.b], pos[f.a], pos[f.b])) n++;
	}
	return n;
}
/**
* Pull the crossings out of the layout.
*
* THIS IS THE ONE THAT MATTERS. Phase A's `relax()` is a plain spring simulation
* with no notion of a crossing, and measured over 25 dungeons a size-4 layout has
* 3.4 crossing pairs and a size-5 has 6.0 — every single size-4 dungeon has at
* least one. Phase A validates that the *graph* is planar, which says a
* crossing-free drawing exists; it does not say the positions it hands out are
* one. Those are different claims and the difference is most of why nothing here
* would draw.
*
* A crossing cannot be nudged away — undoing one means moving a room to the far
* side of something, which is why retrying and repairing both failed on exactly
* the dungeons that had them. Swapping the two rooms is that move.
*/
function untangle(pos, edges, rng, budget) {
	let best = countCrossings(pos, edges);
	const swap = (u, v) => {
		const t = pos[u];
		pos[u] = pos[v];
		pos[v] = t;
	};
	for (let step = 0; step < budget && best > 0; step++) {
		let e = -1;
		let f = -1;
		outer: for (let i = 0; i < edges.length; i++) for (let j = i + 1; j < edges.length; j++) {
			const p = edges[i];
			const q = edges[j];
			if (p.a === q.a || p.a === q.b || p.b === q.a || p.b === q.b) continue;
			if (segsCross(pos[p.a], pos[p.b], pos[q.a], pos[q.b])) {
				e = i;
				f = j;
				break outer;
			}
		}
		if (e < 0) break;
		const four = [
			edges[e].a,
			edges[e].b,
			edges[f].a,
			edges[f].b
		];
		const pairs = [
			[four[0], four[2]],
			[four[0], four[3]],
			[four[1], four[2]],
			[four[1], four[3]]
		];
		let improved = false;
		for (const [u, v] of rng.pickN(pairs, pairs.length)) {
			swap(u, v);
			const now = countCrossings(pos, edges);
			if (now < best) {
				best = now;
				improved = true;
				break;
			}
			swap(u, v);
		}
		if (improved) continue;
		const who = rng.pick(four);
		const saved = { ...pos[who] };
		pos[who] = {
			x: pos[who].x + rng.range(-4, 4),
			y: pos[who].y + rng.range(-4, 4)
		};
		const now = countCrossings(pos, edges);
		if (now <= best) best = now;
		else pos[who] = saved;
	}
	return best;
}
/** Every cell from `from` to `to` along one axis, excluding `from`, including `to`. */
function leg(from, to) {
	const dx = Math.sign(to.x - from.x);
	const dy = Math.sign(to.y - from.y);
	const cells = [];
	let { x, y } = from;
	while (x !== to.x || y !== to.y) {
		x += dx;
		y += dy;
		cells.push({
			x,
			y
		});
	}
	return cells;
}
/** The two ways to get from a to b turning once: along x first, or along y first. */
function lRoutes(a, b) {
	const via = (corner) => [...leg(a, corner), ...leg(corner, b)];
	if (a.x === b.x || a.y === b.y) return [leg(a, b)];
	return [via({
		x: b.x,
		y: a.y
	}), via({
		x: a.x,
		y: b.y
	})];
}
var key = (p) => `${p.x},${p.y}`;
/** The four 2x2 blocks that have the anchor cell as one of their corners. */
var CORNERS = [
	[0, 0],
	[-1, 0],
	[0, -1],
	[-1, -1]
];
var blockAt = (p, [ox, oy]) => [
	{
		x: p.x + ox,
		y: p.y + oy
	},
	{
		x: p.x + ox + 1,
		y: p.y + oy
	},
	{
		x: p.x + ox,
		y: p.y + oy + 1
	},
	{
		x: p.x + ox + 1,
		y: p.y + oy + 1
	}
];
/**
* Grow each anchor into a 2x2, with the anchor at a randomly chosen corner.
*
* A single cell has four ways out, and a one-turn line can only leave toward its
* target — so a room with three or four connections has to find distinct exits
* among neighbours that each offer only two, and often cannot. Measured, that
* alone took size 2 to zero. A 2x2 has eight cells around it, which doubles the
* exits and lets two connections heading the same way leave side by side.
*
* The corner is free variety, but it is also the slack that keeps two blocks
* whose anchors are close from landing on top of each other, so it is chosen
* against what is already down rather than blindly.
*/
function makeBlocks(centres, rng) {
	const taken = /* @__PURE__ */ new Set();
	const blocks = [];
	for (const p of centres) {
		let placed = null;
		for (const corner of rng.pickN(CORNERS, CORNERS.length)) {
			const cells = blockAt(p, corner);
			if (cells.some((c) => taken.has(key(c)))) continue;
			placed = cells;
			break;
		}
		if (!placed) return null;
		for (const c of placed) taken.add(key(c));
		blocks.push(placed);
	}
	return blocks;
}
/** Cells orthogonally touching the block but not in it. */
function rimOf(block) {
	const inside = new Set(block.map(key));
	const out = /* @__PURE__ */ new Map();
	for (const c of block) for (const [dx, dy] of [
		[1, 0],
		[-1, 0],
		[0, 1],
		[0, -1]
	]) {
		const n = {
			x: c.x + dx,
			y: c.y + dy
		};
		if (!inside.has(key(n))) out.set(key(n), n);
	}
	return [...out.values()];
}
/** How many exit pairs a single connection will try before giving up on it. */
var ROUTE_TRIES = 96;
function route(blocks, graph, rng) {
	const solid = /* @__PURE__ */ new Set();
	for (const b of blocks) for (const c of b) solid.add(key(c));
	const used = new Set(solid);
	const centreOf = (b) => ({
		x: b[0].x + .5,
		y: b[0].y + .5
	});
	const order = graph.edges.map((e, i) => ({
		e,
		i,
		d: manhattan(centreOf(blocks[e.a]), centreOf(blocks[e.b]))
	})).sort((p, q) => p.d - q.d || p.i - q.i);
	const paths = [];
	for (const { e } of order) {
		const A = new Set(blocks[e.a].map(key));
		const B = new Set(blocks[e.b].map(key));
		if (rimOf(blocks[e.a]).some((c) => B.has(key(c)))) {
			paths.push({
				a: e.a,
				b: e.b,
				cells: []
			});
			continue;
		}
		const exits = rimOf(blocks[e.a]).filter((c) => !used.has(key(c)));
		const entries = rimOf(blocks[e.b]).filter((c) => !used.has(key(c)));
		const pairs = [];
		for (const from of exits) for (const to of entries) pairs.push({
			from,
			to,
			d: manhattan(from, to)
		});
		pairs.sort((p, q) => p.d - q.d);
		let laid = null;
		for (const { from, to } of pairs.slice(0, ROUTE_TRIES)) {
			const routes = lRoutes(from, to);
			if (rng.coin()) routes.reverse();
			for (const rest of routes) {
				const cells = [from, ...rest];
				if (cells.some((c) => used.has(key(c)) || A.has(key(c)) || B.has(key(c)))) continue;
				laid = cells;
				break;
			}
			if (laid) break;
		}
		if (!laid) return {
			ok: false,
			a: e.a,
			b: e.b
		};
		for (const c of laid) used.add(key(c));
		paths.push({
			a: e.a,
			b: e.b,
			cells: laid
		});
	}
	return {
		ok: true,
		paths
	};
}
/**
* Shove one room a couple of cells and see if that unjams things.
*
* Restarting from a fresh seed does not work here: the spacing pass is a
* convergent relaxation, so a new seed lands in much the same layout and a
* dungeon that will not route keeps not routing however many times it is asked.
* Measured, half the graphs at size 3 failed every one of a hundred attempts.
* Moving the room that actually failed is the difference between rerolling the
* problem and addressing it.
*/
function shift(blocks, i, graph, rng) {
	const others = /* @__PURE__ */ new Set();
	blocks.forEach((b, j) => {
		if (j !== i) for (const c of b) others.add(key(c));
	});
	const linked = graph.edges.filter((e) => e.a === i || e.b === i).map((e) => e.a === i ? e.b : e.a);
	const clear = [];
	const ideal = [];
	for (let dx = -2; dx <= 2; dx++) for (let dy = -2; dy <= 2; dy++) {
		if (dx === 0 && dy === 0) continue;
		const moved = blocks[i].map((c) => ({
			x: c.x + dx,
			y: c.y + dy
		}));
		if (moved.some((c) => others.has(key(c)))) continue;
		clear.push(moved);
		if (linked.every((j) => {
			const d = manhattan(moved[0], blocks[j][0]);
			return d >= SPAN_MIN && d <= SPAN_MAX;
		})) ideal.push(moved);
	}
	const pool = ideal.length ? ideal : clear;
	if (!pool.length) return false;
	blocks[i] = rng.pick(pool);
	return true;
}
/**
* One attempt at centres and connections. Null when a connection had nowhere to
* go; the caller advances the seed.
*/
function seedBlockPlan(graph, seed) {
	const rng = new Rng(seed);
	const centres = spaceOut(graph, new Map(graph.rooms.map((r, i) => [i, r.chunk])), rng);
	const blocks = makeBlocks(centres, rng);
	if (!blocks) return null;
	for (let repair = 0; repair <= REPAIRS; repair++) {
		const got = route(blocks, graph, rng);
		if (got.ok) return {
			seed,
			centres,
			blocks,
			paths: got.paths,
			attempts: 1
		};
		if (repair === REPAIRS) break;
		const who = rng.coin() ? got.a : got.b;
		if (!shift(blocks, who, graph, rng) && !shift(blocks, who === got.a ? got.b : got.a, graph, rng)) break;
	}
	return null;
}
var NEIGHBOURS = [
	[1, 0],
	[-1, 0],
	[0, 1],
	[0, -1]
];
/**
* Rooms take turns claiming ground until the connections between them are gone.
*
* A room may take empty rock, or a stretch of a corridor it is an end of — never
* another room's ground, and never a corridor it has no part in. So the two ends
* of a connection eat toward each other and meet somewhere along it, which is
* what makes the two zones touch. That is the whole trick: adjacency stops being
* something to search for and becomes a consequence of how the ground was
* divided.
*
* It stops when every corridor cell has an owner. Rock beyond that is left as
* rock, which is what keeps this from turning into a honeycomb.
*/
/**
* How boxed in a room is: how many of the eight compass directions have another
* room somewhere along them.
*
* A room in the middle of the dungeon has neighbours on all sides and only the
* ground between them to claim; one on the rim has open rock behind it and can
* expand into that forever. So the interior rooms are served first — they are
* competing for the contested ground, and the outer ones lose nothing by
* waiting, because what they are growing into is not contested at all.
*/
function surroundedness(blocks) {
	return blocks.map((mine, i) => {
		const sectors = /* @__PURE__ */ new Set();
		blocks.forEach((other, j) => {
			if (i === j) return;
			const dx = other[0].x - mine[0].x;
			const dy = other[0].y - mine[0].y;
			sectors.add(Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) & 7);
		});
		return sectors.size;
	});
}
function growZones(seed, graph, isCorridor) {
	const owner = /* @__PURE__ */ new Map();
	const pathEnds = /* @__PURE__ */ new Map();
	seed.blocks.forEach((cells, i) => {
		for (const c of cells) owner.set(key(c), i);
	});
	for (const p of seed.paths) for (const c of p.cells) pathEnds.set(key(c), [p.a, p.b]);
	const boxed = surroundedness(seed.blocks);
	const turnOrder = seed.blocks.map((_c, i) => i).sort((a, b) => {
		const ca = isCorridor?.(a) ? 1 : 0;
		const cb = isCorridor?.(b) ? 1 : 0;
		if (ca !== cb) return ca - cb;
		return boxed[b] - boxed[a];
	});
	const zones = seed.blocks.map((cells) => [...cells]);
	let frontier = seed.blocks.map((cells) => [...cells]);
	let unclaimed = pathEnds.size;
	const mayTake = (room, k) => {
		if (owner.has(k)) return false;
		const ends = pathEnds.get(k);
		return !ends || ends[0] === room || ends[1] === room;
	};
	for (let turn = 0; turn < 400 && unclaimed > 0; turn++) {
		const next = seed.blocks.map(() => []);
		let moved = false;
		for (const i of turnOrder) for (const c of frontier[i]) for (const [dx, dy] of NEIGHBOURS) {
			const n = {
				x: c.x + dx,
				y: c.y + dy
			};
			const k = key(n);
			if (!mayTake(i, k)) continue;
			owner.set(k, i);
			if (pathEnds.has(k)) unclaimed--;
			zones[i].push(n);
			next[i].push(n);
			moved = true;
		}
		if (!moved) break;
		frontier = next;
	}
	return zones;
}
/** Where two zones touch: a cell of each, side by side. */
function contacts(zones, graph) {
	const own = /* @__PURE__ */ new Map();
	zones.forEach((cells, i) => {
		for (const c of cells) own.set(key(c), i);
	});
	const out = /* @__PURE__ */ new Map();
	const push = (i, v) => {
		const list = out.get(i) ?? [];
		list.push(v);
		out.set(i, list);
	};
	for (const e of graph.edges) {
		let found = null;
		for (const c of zones[e.a]) {
			for (const [dx, dy] of NEIGHBOURS) {
				const n = {
					x: c.x + dx,
					y: c.y + dy
				};
				if (own.get(key(n)) === e.b) {
					found = {
						mine: c,
						theirs: n
					};
					break;
				}
			}
			if (found) break;
		}
		if (!found) continue;
		push(e.a, {
			mine: found.mine,
			theirs: found.theirs,
			with: e.b
		});
		push(e.b, {
			mine: found.theirs,
			theirs: found.mine,
			with: e.a
		});
	}
	return out;
}
/** Shortest run of cells inside `zone` from any of `from` to `to`. */
function walkInZone(zone, from, to) {
	const prev = /* @__PURE__ */ new Map();
	const queue = [];
	for (const k of from) {
		const [x, y] = k.split(",").map(Number);
		prev.set(k, null);
		queue.push({
			x,
			y
		});
	}
	for (let h = 0; h < queue.length; h++) {
		const cur = queue[h];
		if (cur.x === to.x && cur.y === to.y) {
			const path = [];
			let at = cur;
			while (at) {
				path.push(at);
				at = prev.get(key(at)) ?? void 0;
			}
			return path;
		}
		for (const [dx, dy] of NEIGHBOURS) {
			const n = {
				x: cur.x + dx,
				y: cur.y + dy
			};
			const k = key(n);
			if (!zone.has(k) || prev.has(k)) continue;
			prev.set(k, cur);
			queue.push(n);
		}
	}
	return null;
}
/**
* Build each room inside the ground it was given.
*
* The zones touching is not the same as the ROOMS touching — a room drawn in the
* middle of its zone can sit nowhere near the boundary it shares with its
* neighbour. So the contact cells are agreed between each pair first and both
* rooms are required to contain their side of it. Contact then holds by
* construction rather than by being checked afterwards, which is the mistake the
* old packer made and spent all its time backtracking over.
*
* After that it is just growth: the room fills outward inside its own zone until
* it has the floor it wants, and stops. What it does not take stays rock, which
* is the gap between rooms.
*/
/**
* Short side over long side, as a band the room is grown to sit inside.
* `long` is a passage one or two cells wide; `square` is a chamber.
*/
var ASPECT_BAND = {
	square: [.75, 1],
	moderate: [.3, .6],
	long: [.08, .3]
};
var unkey = (k) => {
	const [x, y] = k.split(",").map(Number);
	return {
		x,
		y
	};
};
/** Short side over long side of the bounding box. 1 is square. */
function boxRatio(cells) {
	let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
	for (const k of cells) {
		const p = unkey(k);
		if (p.x < minX) minX = p.x;
		if (p.y < minY) minY = p.y;
		if (p.x > maxX) maxX = p.x;
		if (p.y > maxY) maxY = p.y;
	}
	const w = maxX - minX + 1;
	const h = maxY - minY + 1;
	return Math.min(w, h) / Math.max(w, h);
}
function buildRooms(seed, zones, graph, proportionOf, targetArea, rng) {
	const touch = contacts(zones, graph);
	const out = [];
	for (let i = 0; i < zones.length; i++) {
		const zone = new Set(zones[i].map(key));
		const taken = new Set(seed.blocks[i].map(key));
		for (const c of touch.get(i) ?? []) {
			if (taken.has(key(c.mine))) continue;
			const run = walkInZone(zone, taken, c.mine);
			if (!run) return null;
			for (const p of run) taken.add(key(p));
		}
		const band = ASPECT_BAND[proportionOf(i)];
		const stray = (r) => r < band[0] ? band[0] - r : r > band[1] ? r - band[1] : 0;
		const want = Math.min(targetArea(i), Math.floor(zones[i].length * .9));
		let guard = 0;
		while (taken.size < want && guard++ < 400) {
			const ring = /* @__PURE__ */ new Set();
			for (const k of taken) {
				const p = unkey(k);
				for (const [dx, dy] of NEIGHBOURS) {
					const n = key({
						x: p.x + dx,
						y: p.y + dy
					});
					if (zone.has(n) && !taken.has(n)) ring.add(n);
				}
			}
			if (!ring.size) break;
			const here = stray(boxRatio(taken));
			let best = null;
			let bestCost = Infinity;
			for (const k of ring) {
				taken.add(k);
				const cost = stray(boxRatio(taken));
				taken.delete(k);
				if (cost < bestCost) {
					bestCost = cost;
					best = k;
				}
			}
			if (best === null || bestCost > here + 1e-9) break;
			taken.add(best);
		}
		out.push([...taken].map(unkey));
	}
	return out;
}
/**
* Put one door on each connector, anywhere along the wall its two rooms share.
*
* Runs after the rooms are built, on the wall they actually ended up sharing —
* which exists by construction, because both rooms were required to contain
* their side of a contact before either was drawn.
*/
function chooseDoors(rooms, graph, rng) {
	const doors = [];
	for (const e of graph.edges) {
		const other = new Set(rooms[e.b].map(key));
		const along = [];
		for (const c of rooms[e.a]) for (const [dx, dy] of NEIGHBOURS) {
			const n = {
				x: c.x + dx,
				y: c.y + dy
			};
			if (other.has(key(n))) along.push({
				a: e.a,
				b: e.b,
				from: c,
				to: n
			});
		}
		if (along.length) doors.push(rng.pick(along));
	}
	return doors;
}
/**
* Put the way out on any wall of the entrance room that faces open rock.
*
* Uniformly at random among those, which is the whole rule. An earlier draft
* pushed it toward the rim of the drawing by preferring the cell furthest from
* the dungeon's centroid; the entrance room is already an outlying room — Phase
* A picks entrances by distance from the centre — so that was work to buy
* something the room's position had mostly bought already.
*
* "Facing open rock" is the one real condition: a cell nobody owns. A way out
* that opens into another room's floor is not a way out.
*/
function surfaceDoor(rooms, entrance, rng) {
	const mine = rooms[entrance];
	if (!mine?.length) return null;
	const owned = /* @__PURE__ */ new Set();
	for (const cells of rooms) for (const c of cells) owned.add(key(c));
	const options = [];
	for (const c of mine) for (const [dx, dy] of NEIGHBOURS) {
		const out = {
			x: c.x + dx,
			y: c.y + dy
		};
		if (!owned.has(key(out))) options.push({
			room: entrance,
			from: c,
			to: out
		});
	}
	return options.length ? rng.pick(options) : null;
}
/**
* The whole plan, from the graph and nothing else but which rooms are passages.
*
* That is the entire dependency, and it is what lets the layout run before any
* of the fiction: identity, headlines, danger and rewards all come after, and
* the identity roll can then be conditioned on the size each room turned out to
* be. Chunk membership rides on the graph rooms already.
*/
function blockPlan(graph, isCorridor, seed, proportionOf) {
	const base = seedBlockPlan(graph, seed);
	if (!base) return null;
	const zones = growZones(base, graph, isCorridor);
	const rng = new Rng(seed + 1);
	const rolled = zones.map((_z, i) => isCorridor(i) ? "long" : rng.pick([
		"square",
		"square",
		"moderate",
		"moderate",
		"moderate",
		"long"
	]));
	const wanted = zones.map(() => rng.pick([
		6,
		9,
		14,
		20,
		28,
		40,
		56
	]));
	const rooms = buildRooms(base, zones, graph, proportionOf ?? ((i) => rolled[i]), (i) => wanted[i], rng);
	if (!rooms) return null;
	const entrance = graph.entrances.length ? graph.entrances[0] : 0;
	return {
		...base,
		zones,
		rooms,
		doors: chooseDoors(rooms, graph, rng),
		surface: surfaceDoor(rooms, entrance, rng)
	};
}
/** Try layout seeds until one draws. */
function blockPlanValid(graph, isCorridor, seed, attempts = 100) {
	for (let i = 0; i < attempts; i++) {
		const got = blockPlan(graph, isCorridor, seed + i * 7919);
		if (got) return {
			...got,
			attempts: i + 1
		};
	}
	return null;
}
/**
* What each room turned out to be, once it was built.
*
* The size class is READ OFF the finished room rather than asked for in advance.
* That is the whole inversion: the ground a room could get is decided by where
* its neighbours are and how much space they left it, which no roll can know, so
* the roll is better spent on what the room *is* — and it can only sensibly be
* spent once the size is a fact. See `sizeAllows`, which turns the archetype
* pins from an instruction the packer could not honour into a condition on the
* identity roll, which it always can.
*/
function roomSizes(rooms) {
	return rooms.map((cells) => classOf(cells.length));
}
//#endregion
//#region src/runtime/llm/models.ts
/**
* Everything is on Haiku 4.5 while the pipeline is being built: it is the
* cheapest current model ($1 / $5 per million tokens in / out, against Sonnet
* 5's $3 / $15), and prompt iteration means running the same seed many times.
*
* Two limits it carries that the larger models do not — neither binds today,
* but both would if this stayed past the prototype:
*   - 200K context, not 1M. A chunk prompt is a few thousand tokens, so there
*     is a lot of headroom, but a very large dungeon would eventually crowd it.
*   - 64K max output, not 128K. Above MAX_TOKENS below, so it does not bind.
*
* Haiku 4.5 also predates adaptive thinking and the effort parameter — it takes
* the older `budget_tokens` form and errors on `effort`. Nothing here uses
* either, but that is the thing to check before turning them on.
*
* Expect this to stop being one model. The obvious first split is the Dungeon
* Pass: it runs once, sets the fiction every other call is written against, and
* costs a rounding error next to N content-pass calls — so it is the cheapest
* place to buy quality. That is what this registry being task-keyed is for.
*/
var MODELS = {
	"dungeon-pass": "claude-haiku-4-5",
	"content-pass": "claude-haiku-4-5",
	"seams-pass": "claude-haiku-4-5",
	"room-entry": "claude-haiku-4-5",
	"turn-loop": "claude-haiku-4-5"
};
/**
* Per-task output ceiling. Generation passes write a lot; turns write a little.
* The content pass writes six rooms and everything in them in one response,
* which is why it gets four times the others.
*/
var MAX_TOKENS = {
	"dungeon-pass": 4096,
	"content-pass": 16384,
	"seams-pass": 4096,
	"room-entry": 4096,
	"turn-loop": 4096
};
function modelFor(task) {
	return MODELS[task];
}
//#endregion
//#region src/runtime/llm/schemas.ts
/**
* Zod for every model response. Nothing reaches the engine unvalidated.
*
* These mirror the response interfaces the engine declares — the engine owns
* the shape, this file owns the checking. `satisfies` on each export keeps the
* two from drifting apart silently: change the interface without changing the
* schema and this file stops compiling.
*/
var nonEmpty = z.string().trim().min(1);
var dungeonPassSchema = z.object({
	name: nonEmpty,
	theme: nonEmpty,
	history: nonEmpty,
	goal: z.object({
		summary: nonEmpty,
		spec: nonEmpty
	}),
	openingProse: nonEmpty,
	groups: z.array(z.object({
		id: nonEmpty,
		name: nonEmpty,
		base: nonEmpty
	})).min(1)
});
var modifiers = z.object({
	str: z.number().int().optional(),
	dex: z.number().int().optional(),
	con: z.number().int().optional(),
	int: z.number().int().optional(),
	wis: z.number().int().optional(),
	cha: z.number().int().optional(),
	attack: z.number().int().optional()
});
var statDeviations = z.object({
	damage: z.string().optional(),
	armorDefense: z.number().int().optional(),
	morale: z.number().int().optional(),
	modifiers: modifiers.optional()
});
/**
* Where in the room something stands.
*
* A LOOSE STRING, not an enum, and deliberately: a position that does not parse
* is a fixture in the middle of the room instead of at the far end, where a
* rejected batch is six unwritten rooms and a retry. `applyContentPass` does the
* narrowing (`isPositionWord`) and falls back to the centre. Same reasoning for
* `kind` below — the difference is that an unrecognised kind cannot be drawn at
* all, so apply drops the fixture rather than guessing at one.
*/
var position = z.string().optional();
var writtenEntity = z.object({
	ref: nonEmpty,
	name: nonEmpty,
	base: nonEmpty,
	position
});
var fixtureResponse = z.object({
	kind: nonEmpty,
	position: nonEmpty,
	name: nonEmpty,
	base: nonEmpty
});
var promotedDetail = z.object({
	text: nonEmpty,
	name: nonEmpty,
	base: nonEmpty,
	hidden: z.boolean().optional(),
	position
});
var connectorResponse = z.object({
	ref: nonEmpty,
	name: nonEmpty,
	form: nonEmpty,
	requirement: z.string().optional()
});
var groupResponse = z.object({
	name: nonEmpty,
	base: nonEmpty,
	activity: nonEmpty,
	stats: statDeviations.optional()
});
var distinctResponse = z.object({
	kind: z.enum(["elite", "named"]),
	member: z.string().optional(),
	name: nonEmpty,
	base: nonEmpty,
	isLeader: z.boolean().optional(),
	activity: nonEmpty,
	stats: statDeviations.optional()
});
var encounterResponse = z.object({
	ref: nonEmpty,
	group: groupResponse.optional(),
	distinct: z.array(distinctResponse).optional()
});
var roomResponse = z.object({
	ref: nonEmpty,
	name: nonEmpty,
	base: nonEmpty,
	entities: z.array(writtenEntity).optional(),
	fixtures: z.array(fixtureResponse).optional(),
	promotions: z.array(promotedDetail).optional(),
	connectors: z.array(connectorResponse).optional(),
	encounters: z.array(encounterResponse).optional(),
	goal: z.object({
		entityType: z.enum([
			"Item",
			"RoomFeature",
			"Creature"
		]),
		name: nonEmpty,
		base: nonEmpty,
		position
	}).optional()
});
var contentPassSchema = z.object({ rooms: z.array(roomResponse).min(1) });
var seamsPassSchema = z.object({ connectors: z.array(connectorResponse).min(1) });
var ability = z.enum([
	"str",
	"dex",
	"con",
	"int",
	"wis",
	"cha"
]);
var edge = z.enum([
	"none",
	"advantage",
	"disadvantage"
]);
/**
* The stages a REFEREE may name — a strict subset of `Stage`.
*
* `thinking`, `rolling`, `room_entry` and `error` are the software talking, and
* `resolving` is the machine's own marker for the call it is making right now.
* A commit that named one of them would leave the player looking at a closed
* input area with nothing running. Narrowing the enum makes that unsayable
* rather than merely discouraged.
*/
var refereeStage = z.enum([
	"awaiting_action",
	"clarifying",
	"rejected",
	"roll_offered",
	"dead",
	"departed"
]);
/**
* The steps a turn can RESUME at. The rest are mid-cascade — a single call runs
* step 1 through step 3 without stopping — so they are not resume points and
* naming one would only cost a retry.
*/
var refereeStep = z.enum([
	"1-target",
	"4-confirm-roll",
	"5-resolution"
]);
/**
* What goes on the table. The player-facing terms sit alongside the two
* referee-side numbers, and the interface renders only the former — see
* RollSpec, and `InputArea` which never reads `dc`.
*
* A save carries `dc`; an attack or a stunt carries `targetDefense`, which the
* referee converts through `dcFromDefense`. That keeps the vocabulary the
* playbook uses on the wire and the one `+1` in the codebase in one function.
*/
var rollRequest = z.object({
	kind: z.enum([
		"save",
		"attack",
		"stunt"
	]),
	ability,
	bonus: z.number().int(),
	edge,
	description: nonEmpty,
	weapon: z.string().optional(),
	mode: z.enum(["damage", "stunt"]).optional(),
	advantageUse: z.enum(["normal", "stunt-and-damage"]).optional(),
	/** saves: the number to meet. Defaults to the ordinary 16. Never rendered. */
	dc: z.number().int().optional(),
	/** attacks and stunts: the target's defense, converted here. Never rendered. */
	targetDefense: z.number().int().optional(),
	damage: z.string().optional(),
	targetId: z.string().optional()
});
/** A thing being brought into existence, appended to a holder's `children[]`. */
var entitySpec = z.object({
	type: z.enum(["Item", "RoomFeature"]),
	name: nonEmpty,
	base: nonEmpty,
	state: z.string().optional(),
	slots: z.number().int().optional(),
	amount: z.string().optional(),
	hidden: z.boolean().optional(),
	/** address it from a later diff in this same commit */
	ref: z.string().optional()
});
/**
* Spelled out rather than left as `unknown`.
*
* `unknown` compiles to `{}` in JSON Schema, which tells the model nothing —
* and the one value shape it cannot guess is the entity spec behind
* `children[]`. An `anyOf` costs a few lines and puts that shape on the wire.
*/
var diffValue = z.union([
	z.string(),
	z.number(),
	z.boolean(),
	z.null(),
	z.array(z.string()),
	entitySpec
]);
var diff = z.object({
	entityId: nonEmpty,
	path: nonEmpty,
	value: diffValue
});
var commitSchema = z.object({
	/**
	* WHAT THE PLAYER READS. The only place a post can come from.
	*
	* It was loose assistant text until Phase 12 (CODING-PLAN 8a A9): narration
	* was the concatenation of every text block in the response, and nothing
	* distinguished a draft from the post. A referee that thought better of a
	* paragraph mid-response — *"Wait, I should not write that post yet… Let me
	* rewrite"* — had BOTH drafts printed, one after the other, the second in a
	* different tense and ending in a roll offer. No streaming rule catches that;
	* the buffer is complete and valid, it is just two answers stapled together.
	*
	* A field cannot be written twice. The last `commit_state` call is the only
	* one that counts, so a draft is not narration BY CONSTRUCTION rather than by
	* the loop guessing which block the referee meant — and the rule that a player
	* reads nothing until the commit has validated gets its second guarantee,
	* because the prose now travels inside the thing being validated.
	*
	* Optional for the two turns that legitimately write none: a room entry, where
	* the room's own `composed` IS the paragraph, and a commit that moves the
	* player, whose prose is discarded unread because the arrival pass is about to
	* describe the real room. Anything else with no post is refused — see
	* `missingPost` in referee.ts.
	*/
	post: z.string().trim().min(1).optional(),
	nextStage: refereeStage,
	nextStep: refereeStep,
	rollRequest: rollRequest.optional(),
	diffs: z.array(diff),
	/**
	* The dungeon's objective is accomplished. It does NOT end the run — the
	* player still has to carry it out — so it is a flag rather than a stage, and
	* it latches: saying it once is enough, forever.
	*/
	goalMet: z.boolean().optional(),
	/**
	* One fact this turn established about the DUNGEON — its history, its makers,
	* what a place was really for. Appended to the run's fiction and shown back on
	* every later call, so the story of the place only ever grows.
	*
	* Capped, and deliberately short of a paragraph: this is a line for the record,
	* not a second draft of the narration. Anything true of a single entity belongs
	* in that entity's `state` instead, which is why the length is the check.
	*/
	fictionNote: z.string().trim().min(1).max(300).optional()
});
/**
* One request in the batch. Flat rather than a discriminated union: JSON Schema
* can express the union but the model reads a flat object with a `kind` more
* reliably, and zod checks the per-kind requirements on the way back in.
*/
var rollSpecRequest = z.object({
	/** the caller's own label, so the results can be told apart */
	id: nonEmpty,
	kind: z.enum([
		"save",
		"attack",
		"stunt",
		"morale",
		"damage",
		"consult"
	]),
	/**
	* Whose roll this is — and `"player"` is deliberately unsayable, because the
	* player's own roll is offered rather than thrown (see `playersOwnDice`).
	* Optional, and read only when a roll made at one of the player's bonuses
	* would otherwise be refused: saying it is the ghoul's is how a referee gets
	* a genuine coincidence past the guard.
	*/
	actor: z.enum(["creature", "world"]).optional(),
	edge: edge.optional(),
	/** save, attack, stunt */
	bonus: z.number().int().optional(),
	/** save: the number to meet. Defaults to 16. */
	dc: z.number().int().optional(),
	/** save: a creature is the source of the risk — pass its defense instead */
	defenseAsDc: z.number().int().optional(),
	/** attack, stunt */
	targetDefense: z.number().int().optional(),
	/** attack: the weapon's die. damage: the expression to roll. */
	damage: z.string().optional(),
	expr: z.string().optional(),
	extraDice: z.number().int().optional(),
	/** attack: the right weapon against the right enemy, for the extra die */
	wellSuited: z.boolean().optional(),
	/** morale: the group's rating. Defaults to 7. */
	rating: z.number().int().optional(),
	/**
	* consult: how many times that book has been read ALREADY — its current
	* `book.uses`, and 0 for one nobody has opened. This reading is added by the
	* tool, which then says what to write back.
	*/
	uses: z.number().int().optional()
});
var rollBatchSchema = z.object({ rolls: z.array(rollSpecRequest).min(1) });
function issuesOf(error) {
	return error.issues.map((i) => ({
		path: i.path.join(".") || "(root)",
		message: i.message
	}));
}
/** Validation errors, formatted for feeding back to the model on retry. */
function formatIssues(issues) {
	return issues.map((i) => `  - ${i.path}: ${i.message}`).join("\n");
}
//#endregion
//#region src/runtime/llm/json.ts
var ResponseFormatError = class extends Error {
	issues;
	raw;
	constructor(message, issues = [], raw) {
		super(message);
		this.name = "ResponseFormatError";
		this.issues = issues;
		this.raw = raw;
	}
	/** The part worth appending to a retry prompt. */
	get feedback() {
		return this.issues.length ? `Your previous response failed validation:\n${formatIssues(this.issues)}\n\nReturn the corrected JSON.` : `Your previous response could not be parsed as JSON. Return JSON only, with no prose around it.`;
	}
};
/** Validate an already-parsed value, raising something a retry can use. */
function validate(schema, value) {
	const result = schema.safeParse(value);
	if (result.success) return result.data;
	throw new ResponseFormatError("response did not match the expected shape", issuesOf(result.error), JSON.stringify(value).slice(0, 2e3));
}
//#endregion
//#region src/runtime/llm/tool-schema.ts
/**
* ZOD -> TOOL INPUT SCHEMA
*
* The tool's `input_schema` is what actually shapes a forced tool call. Handing
* the API a permissive `{ type: "object", additionalProperties: true }` and
* relying on the prompt to describe the shape does not work: the model has to
* guess the parameter names, and it guesses differently each time. Observed on
* one seed, same prompt, two attempts — `{ region_data: … }` once, `{ rooms: … }`
* the next, and `{}` in the failure that started this. The prompt describes the
* *content*; the schema declares the *shape*, and only one of them is machine
* enforced.
*
* So the schema goes on the wire, generated from the zod schema that validates
* the response, which also means the two cannot drift apart.
*
* Structured outputs rejects a few JSON Schema keywords that zod emits happily.
* They are stripped here and still enforced by zod on the way back in — the
* same split the official SDKs make.
*/
/** Keywords structured outputs does not accept. Zod still checks them locally. */
var UNSUPPORTED = /* @__PURE__ */ new Set([
	"minLength",
	"maxLength",
	"pattern",
	"minimum",
	"maximum",
	"exclusiveMinimum",
	"exclusiveMaximum",
	"multipleOf",
	"minItems",
	"maxItems",
	"uniqueItems",
	"minProperties",
	"maxProperties",
	"$schema"
]);
function strip(node) {
	if (Array.isArray(node)) return node.map(strip);
	if (node === null || typeof node !== "object") return node;
	const out = {};
	for (const [k, v] of Object.entries(node)) {
		if (UNSUPPORTED.has(k)) continue;
		if (k === "additionalProperties" && v !== false) throw new Error("a response schema cannot contain an open-ended record: structured outputs requires additionalProperties: false. Name the keys explicitly instead.");
		out[k] = strip(v);
	}
	if (out.type === "object") out.additionalProperties = false;
	return out;
}
/**
* Strict mode compiles the schema into a grammar, and refuses to do so past 24
* optional parameters — the content pass has 35, because most of what a room
* can hold is optional (not every room has a hazard, a goal, an elite).
*
* Which is a limit on the guarantee, not on the schema: an accurate
* `input_schema` is what stops the model guessing at parameter names, and that
* works with or without strict. Where the schema is small enough, strict adds
* a hard guarantee on top; where it is not, zod is still validating every
* response and a bad one still costs only a retry.
*
* THE BUDGET IS PER REQUEST, NOT PER TOOL. The grammar is compiled for the call,
* so every strict schema on the table spends from the same 24 — `commit_state`
* (15) and `roll` (11) each fit alone and 400 the moment they are offered
* together. `fitStrict` is where that is settled; `canBeStrict` answers only for
* a tool that goes out on its own.
*/
var STRICT_OPTIONAL_LIMIT = 24;
function countOptional(node) {
	if (Array.isArray(node)) return node.reduce((n, x) => n + countOptional(x), 0);
	if (node === null || typeof node !== "object") return 0;
	const o = node;
	let n = 0;
	if (o.type === "object" && o.properties && typeof o.properties === "object") {
		const required = new Set(Array.isArray(o.required) ? o.required : []);
		n += Object.keys(o.properties).filter((k) => !required.has(k)).length;
	}
	for (const v of Object.values(o)) n += countOptional(v);
	return n;
}
/** Whether this schema is simple enough for the API to guarantee it, alone. */
function canBeStrict(schema) {
	return countOptional(schema) <= STRICT_OPTIONAL_LIMIT;
}
/**
* Spend the request's strict budget across the tools going out together.
*
* Only compiled schemas count against it — the content pass has been sending an
* unguaranteed 35-optional tool since Phase 1 — so this drops `strict` rather
* than touching any schema. The tool keeps its real shape either way, and zod
* still checks whatever comes back.
*
* Biggest first, so the guarantee lands where the model has the most to get
* wrong. On the runtime's pair that is `commit_state`, which writes state; a
* malformed `roll` costs one more exchange and nothing else.
*/
function fitStrict(tools) {
	const guaranteed = /* @__PURE__ */ new Set();
	let spent = 0;
	const byCost = tools.map((t, i) => ({
		i,
		cost: countOptional(t.input_schema)
	})).sort((a, b) => b.cost - a.cost || a.i - b.i);
	for (const { i, cost } of byCost) {
		if (spent + cost > STRICT_OPTIONAL_LIMIT) continue;
		spent += cost;
		guaranteed.add(i);
	}
	return tools.map((tool, i) => {
		if (guaranteed.has(i)) return tool.strict === true ? tool : {
			...tool,
			strict: true
		};
		if (tool.strict === void 0) return tool;
		const { strict: _dropped, ...rest } = tool;
		return rest;
	});
}
/**
* A tool `input_schema` for a zod object schema.
*
* Emits `required` and `additionalProperties: false` throughout, which is what
* `strict: true` demands — with it the API guarantees the tool input validates
* against this shape, so zod's job narrows to catching what the JSON Schema
* subset cannot express.
*/
function toolSchema(schema) {
	const json = strip(z.toJSONSchema(schema, { target: "draft-2020-12" }));
	if (json.type !== "object" || typeof json.properties !== "object") throw new Error("a tool input schema must be an object schema");
	return {
		...json,
		type: "object",
		additionalProperties: false
	};
}
//#endregion
//#region src/runtime/llm/client.ts
var PATH = "/v1/messages";
/**
* Where requests go, and what rides along.
*
* In the browser this stays empty, so the URL is relative — `/api/anthropic/...`
* — and the Vite dev proxy attaches the key. The bundle never holds it.
*
* `dev/cli-generate.ts` is the one caller that overrides this. It runs in Node,
* outside the browser and outside the dev server, so there is no proxy to go
* through and it reads the key from .env.local itself. That is not a loophole in
* the rule: the rule is that the key never reaches the *browser*, and a Node
* script is exactly where a key is supposed to live.
*/
var baseUrl = "/api/anthropic";
var extraHeaders = {};
function configureTransport(opts) {
	if (opts.baseUrl !== void 0) baseUrl = opts.baseUrl.replace(/\/$/, "");
	if (opts.headers) extraHeaders = {
		...extraHeaders,
		...opts.headers
	};
}
var LlmError = class extends Error {
	status;
	/** 429 and 5xx are worth another go; 4xx generally is not. */
	retryable;
	constructor(message, status, retryable) {
		super(message);
		this.name = "LlmError";
		this.status = status;
		this.retryable = retryable;
	}
};
var RETRIES = 3;
var BASE_DELAY_MS = 1e3;
var sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function post(body, signal) {
	let lastError;
	for (let attempt = 0; attempt <= RETRIES; attempt++) {
		if (attempt > 0) await sleep(BASE_DELAY_MS * 2 ** (attempt - 1));
		let res;
		try {
			res = await fetch(`${baseUrl}${PATH}`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					...extraHeaders
				},
				body: JSON.stringify(body),
				signal
			});
		} catch (e) {
			if (signal?.aborted) throw e;
			lastError = e;
			continue;
		}
		if (res.ok) return await res.json();
		const detail = await res.text().catch(() => "");
		const err = new LlmError(`${res.status} ${res.statusText}${detail ? ` — ${detail.slice(0, 500)}` : ""}`, res.status, res.status === 429 || res.status >= 500);
		if (!err.retryable) throw err;
		lastError = err;
	}
	throw lastError instanceof Error ? lastError : new LlmError(String(lastError), 0, false);
}
/**
* `strict` here is provisional: it says this tool could be guaranteed on its
* own. Whether it actually is depends on what else is on the table, and only
* the request knows that — `callWithTools` settles it with `fitStrict`.
*/
function toolFor(name, description, schema) {
	const input_schema = toolSchema(schema);
	return {
		name,
		description,
		input_schema,
		...canBeStrict(input_schema) ? { strict: true } : {}
	};
}
/**
* One exchange with tools on the table. Does NOT loop — the caller decides
* whether what came back finishes the turn, and only the caller knows that.
*/
async function callWithTools(opts) {
	const json = await post({
		model: modelFor(opts.task),
		max_tokens: opts.maxTokens ?? MAX_TOKENS[opts.task],
		...opts.system ? { system: opts.system } : {},
		messages: opts.messages,
		tools: fitStrict(opts.tools),
		tool_choice: opts.toolChoice ?? { type: "auto" }
	}, opts.signal);
	return {
		text: json.content.filter((b) => b.type === "text").map((b) => b.text ?? "").join(""),
		toolUses: json.content.filter((b) => b.type === "tool_use").map((b) => ({
			id: b.id ?? "",
			name: b.name ?? "",
			input: b.input
		})),
		content: json.content,
		stopReason: json.stop_reason,
		usage: {
			inputTokens: json.usage.input_tokens,
			outputTokens: json.usage.output_tokens
		}
	};
}
/**
* The answers to a batch of tool calls, as one user turn.
*
* One turn, however many calls: splitting results across messages teaches the
* model to stop asking for them together, and asking for them together is the
* whole point of the dice tool taking a list.
*/
function toolResults(results) {
	return {
		role: "user",
		content: results.map((r) => ({
			type: "tool_result",
			tool_use_id: r.id,
			content: r.content,
			...r.isError ? { is_error: true } : {}
		}))
	};
}
async function callForJson(opts) {
	const retry = opts.retryOnInvalid ?? true;
	const messages = [...opts.messages];
	const schema = toolSchema(opts.schema);
	const strict = canBeStrict(schema);
	let usage = {
		inputTokens: 0,
		outputTokens: 0
	};
	for (let attempt = 1;; attempt++) {
		const json = await post({
			model: modelFor(opts.task),
			max_tokens: opts.maxTokens ?? MAX_TOKENS[opts.task],
			...opts.system ? { system: opts.system } : {},
			messages,
			tools: [{
				name: opts.toolName,
				description: opts.toolDescription,
				input_schema: schema,
				...strict ? { strict: true } : {}
			}],
			tool_choice: {
				type: "tool",
				name: opts.toolName
			}
		}, opts.signal);
		usage = {
			inputTokens: usage.inputTokens + json.usage.input_tokens,
			outputTokens: usage.outputTokens + json.usage.output_tokens
		};
		const call = json.content.find((b) => b.type === "tool_use" && b.name === opts.toolName);
		try {
			if (!call) throw new ResponseFormatError(`the model did not call ${opts.toolName} (stop_reason: ${json.stop_reason})`);
			if (json.stop_reason === "max_tokens") throw new ResponseFormatError("the response was cut off at max_tokens; the object is incomplete");
			const value = validate(opts.schema, call.input);
			const missing = opts.check?.(value) ?? [];
			if (missing.length > 0) throw new ResponseFormatError("the response is well-formed but does not answer everything it was asked", missing, JSON.stringify(call.input).slice(0, 2e3));
			return {
				value,
				usage,
				attempts: attempt
			};
		} catch (e) {
			const isFormat = e instanceof ResponseFormatError;
			const willRetry = isFormat && retry && attempt <= 1;
			if (isFormat && opts.onAttemptFailed) try {
				opts.onAttemptFailed({
					attempt,
					willRetry,
					message: e.message,
					issues: e.issues,
					raw: e.raw ?? (call ? JSON.stringify(call.input).slice(0, 2e3) : void 0)
				});
			} catch (reporting) {
				console.warn("[llm] onAttemptFailed threw; ignoring it:", reporting);
			}
			if (!willRetry) throw e;
			messages.push({
				role: "assistant",
				content: JSON.stringify(call?.input ?? {}).slice(0, 4e3)
			}, {
				role: "user",
				content: e.feedback
			});
		}
	}
}
//#endregion
//#region src/runtime/seeds.ts
function deriveSeeds(dungeonSeed, runSeed) {
	return {
		dungeonSeed,
		graphSeed: String(dungeonSeed),
		blueprintSeed: dungeonSeed,
		stockSeed: dungeonSeed + 7919,
		layoutSeed: dungeonSeed + 104729,
		runSeed: runSeed ?? dungeonSeed ^ 1597463007
	};
}
/**
* A size-n dungeon is n chunks of six rooms: size 1 is 6 rooms, size 5 is 30.
* Identity, so there is no table -- but the two types are declared
* independently, so assert rather than assume.
*/
function chunksFor(size) {
	return size;
}
//#endregion
//#region src/runtime/journal.ts
/**
* A journal for one run.
*
* With no sink it is the no-op every test gets: `log` returns on the first
* line, nothing is allocated, nothing is stamped.
*
* `startSeq` IS WHAT MAKES A RUN SURVIVE BEING PUT DOWN. In a browser one
* journal sees a whole run and counting from zero is right. On a server there
* is no continuous anything: a session is built per request, plays one turn,
* and dies — so a journal that always started at zero would number the second
* turn's events 1, 2, 3 again, on top of the first turn's. Against a table keyed
* `(run_id, seq)` that is a collision, and the failure would be the quiet kind:
* every write here is wrapped, per IT MUST NEVER BREAK A TURN, so the turn would
* succeed and the journalling would simply stop. Whoever builds the session
* passes the last sequence already stored.
*/
function createJournal(sink, startSeq = 0) {
	let seq = startSeq;
	let broken = false;
	/**
	* Steps whose playbook has already been written. Tracked on the journal
	* rather than at the call site because "have I already written this" is a
	* property of the journal, not of the referee — and it is per run, because
	* two runs each want their own copy of the instructions they were played
	* under.
	*/
	const written = /* @__PURE__ */ new Set();
	function log(event) {
		if (!sink || broken) return;
		try {
			sink.write({
				...event,
				seq: ++seq,
				at: (/* @__PURE__ */ new Date()).toISOString()
			});
		} catch (e) {
			broken = true;
			console.warn("[journal] writing failed; journalling is off for this run:", e);
		}
	}
	return {
		log,
		logSystem(step, blocks) {
			if (!sink || written.has(step)) return;
			written.add(step);
			log({
				kind: "system",
				step,
				blocks
			});
		}
	};
}
/**
* The journal for a run that is not being journalled — shared, so the default
* costs one reference rather than an object per turn machine.
*/
var NO_JOURNAL = createJournal();
/** A name for this run's directory: sortable, and says which seed it was. */
function runId(seed) {
	return `${(/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-").slice(0, 19)}-seed${seed}`;
}
/**
* The diffs a commit proposed, in one line each, as `entity path = value`.
* Shared by the transcript and by anything else that has to show a change
* without printing a wall of JSON.
*/
function describeDiff(d) {
	const value = typeof d.value === "string" ? d.value.length > 120 ? `${d.value.slice(0, 117).replace(/\s*\n\s*/g, " ")}…` : d.value.replace(/\s*\n\s*/g, " ") : JSON.stringify(d.value);
	return `${d.entityId} · ${d.path} = ${value}`;
}
//#endregion
//#region src/runtime/generate.ts
/**
* THE GENERATION PIPELINE
* =======================
*
* Runs once, up front. Produces a dungeon that is completely written before the
* player takes a single turn.
*
*   A: generateBlueprintSeed                                    [pure]
*      -> Dungeon Pass                                          [1 call]   ─┐
*   B: generateBlueprint -> stockDungeon -> runEntitiesPass     [pure]     ─┘ concurrent
*   join
*   per chunk: buildContentPassPayload -> LLM                   [N calls, parallel]
*              applyContentPass                                 [SERIAL, ascending chunk]
*
* The Dungeon Pass needs only the rolled genome, so it overlaps the pure
* stocking branch. Chunk generations all fire at once; their APPLIES are
* serialised in ascending chunk order, which is a CLAUDE.md rule and also
* plainly necessary — apply mutates shared state throughout (ep.items,
* ep.features, ep.bindings, ep.registry, and it rebuilds ep.creatures).
*
* `state` and `composed` are NOT written here. Every entity stays unencountered
* until the player walks in on it; room entry is a runtime pass.
*/
/**
* How many graphs to try before giving up on a seed.
*
* Size 5 fails about one graph in eight, so eight tries leaves a failure rate
* around one seed in ten million. Cheap enough to be generous with: the whole
* branch is pure and takes milliseconds.
*/
var GRAPH_ATTEMPTS = 8;
/**
* What a failed generation call writes down.
*
* Curried on the pass — and, for the content pass, the chunk — because that is
* exactly what `callForJson` does not know and what a reader of the journal
* most needs. The chunks run in parallel, so "a content-pass call failed" is
* not an answer.
*/
function reportFailure(journal, pass, chunk) {
	return (r) => {
		journal.log({
			kind: "generation-error",
			pass,
			...chunk !== void 0 ? { chunk } : {},
			attempt: r.attempt,
			willRetry: r.willRetry,
			message: r.message,
			issues: r.issues,
			...r.raw !== void 0 ? { raw: r.raw } : {}
		});
		console.warn(`[generate] ${pass}${chunk === void 0 ? "" : ` chunk ${chunk}`} attempt ${r.attempt} failed: ${r.message}` + (r.willRetry ? " — retrying" : " — giving up"), {
			issues: r.issues,
			raw: r.raw
		});
	};
}
/** The regions of a dungeon, ascending. One content-pass call each. */
function chunksOf(partial) {
	return [...new Set(partial.stocked.rooms.map((r) => r.chunk))].sort((a, b) => a - b);
}
/**
* The drawing, read back as words.
*
* Derived rather than persisted — the plan is the durable thing and this is one
* function over it, so the vocabulary can change without a migration. Which
* also means a partial that has been round-tripped through a database recovers
* it without having had to store it.
*/
function siteOf(partial) {
	if (!partial.blockplan) return void 0;
	const corridors = new Set(partial.stocked.rooms.filter((r) => r.isCorridor).map((r) => r.index));
	return siteRooms(partial.blockplan, partial.graph, { isCorridor: (i) => corridors.has(i) });
}
/**
* A region's payload, built from the partial.
*
* Rebuilt rather than persisted, and it must be built from UNAPPLIED entities:
* a payload says what a region needs written, and entities that have been
* written no longer need writing. So `finishGeneration` builds every payload
* before it applies anything — which is what the single-process pipeline always
* did, it just kept them in a local instead.
*/
function contentPayload(partial, chunk) {
	return buildContentPassPayload(partial.stocked, partial.blueprint, partial.entities, chunk, partial.dungeonContext, siteOf(partial));
}
/**
* Everything knowable before a room is written: the graph, the drawing, the
* stocking, the entities, and the standing fiction.
*
* Comes back as a `GeneratedDungeon` whose entities are UNWRITTEN — no names,
* no prose. That is a real state now rather than a moment inside a function,
* because the steps below happen in separate HTTP requests and this is what is
* persisted between them.
*/
async function generateStructure(opts) {
	const { size, signal } = opts;
	const level = opts.level ?? 1;
	const seeds = deriveSeeds(opts.seed);
	const report = opts.onProgress ?? (() => {});
	const journal = opts.journal ?? NO_JOURNAL;
	const blueprint = generateBlueprintSeed(size, seeds.blueprintSeed, level);
	const fiction = (async () => {
		report({ stage: "inhabitants" });
		const payload = buildDungeonPassPayload(blueprint);
		report({ stage: "history" });
		const prompt = renderDungeonPassPrompt(payload);
		const { value, usage } = await callForJson({
			task: "dungeon-pass",
			schema: dungeonPassSchema,
			toolName: "establish_dungeon",
			toolDescription: "Record the dungeon's name, theme, history, goal, opening prose, and the standing identity of each inhabitant group.",
			messages: [{
				role: "user",
				content: prompt
			}],
			signal,
			onAttemptFailed: reportFailure(journal, "dungeon-pass")
		});
		journal.log({
			kind: "generation",
			pass: "dungeon-pass",
			prompt,
			response: value,
			usage
		});
		return {
			result: applyDungeonPass(value, payload),
			usage
		};
	})();
	const structure = (async () => {
		report({ stage: "layout" });
		for (let attempt = 0;; attempt++) {
			const { dungeon } = generateBlueprint(attempt === 0 ? seeds.graphSeed : `${seeds.graphSeed}~${attempt}`, { chunks: chunksFor(size) }, true);
			report({ stage: "stocking" });
			let blockplan = null;
			const stocked = stockDungeon(dungeon, blueprint, {
				level,
				seed: seeds.stockSeed,
				layout: (rooms) => {
					const corridor = new Set(rooms.filter((r) => r.isCorridor).map((r) => r.index));
					blockplan = blockPlanValid(dungeon, (i) => corridor.has(i), seeds.layoutSeed);
					return blockplan ? roomSizes(blockplan.rooms) : rooms.map(() => void 0);
				}
			});
			const plan = blockplan;
			if (plan === null && attempt < 7) continue;
			if (plan === null) throw new Error(`no drawable layout for seed ${opts.seed} at size ${size} after ${GRAPH_ATTEMPTS} graphs`);
			return {
				dungeon,
				stocked,
				entities: runEntitiesPass(stocked, blueprint, new Rng(stocked.seed)),
				plan
			};
		}
	})();
	const [{ result: fictionResult, usage }, { dungeon, stocked, entities, plan }] = await Promise.all([fiction, structure]);
	Object.assign(entities.registry.groups, fictionResult.groups);
	return {
		id: blueprint.id,
		seeds,
		size,
		level,
		dungeonContext: fictionResult.dungeonContext,
		pass: fictionResult.pass,
		blueprint,
		graph: dungeon,
		stocked,
		entities,
		blockplan: plan,
		usage
	};
}
/**
* Write one region of the dungeon.
*
* PURE WITH RESPECT TO THE PARTIAL. It reads it to build the payload and hands
* back what came in; it applies nothing. That is what lets the regions be
* called in parallel — from separate requests, on separate machines — and
* applied serially afterwards, which is the rule in CLAUDE.md.
*/
async function generateChunk(partial, chunk, opts = {}) {
	const journal = opts.journal ?? NO_JOURNAL;
	const payload = contentPayload(partial, chunk);
	const prompt = renderContentPassPrompt(payload);
	const { value, usage } = await callForJson({
		task: "content-pass",
		schema: contentPassSchema,
		toolName: "write_region",
		toolDescription: "Name and write every room, entity, connector, and creature group in this region.",
		messages: [{
			role: "user",
			content: prompt
		}],
		...opts.signal ? { signal: opts.signal } : {},
		check: (v) => contentPassOmissions(payload, v),
		onAttemptFailed: reportFailure(journal, "content-pass", chunk)
	});
	journal.log({
		kind: "generation",
		pass: "content-pass",
		chunk,
		prompt,
		response: value,
		usage
	});
	return {
		chunk,
		value,
		usage
	};
}
/**
* Apply what the regions wrote, then write the ways between them.
*
* The applies are SERIAL and ASCENDING — see CLAUDE.md. Apply is pure and
* cheap, so ordering it costs nothing and is what keeps concurrent mutation of
* `entities` out of the picture.
*
* `entities` is mutated in place, which is why the result spreads `partial`:
* the object handed in IS the object written to, and a caller that reloaded the
* partial from a row a moment ago owns it outright.
*/
async function finishGeneration(partial, results, opts = {}) {
	const report = opts.onProgress ?? (() => {});
	const journal = opts.journal ?? NO_JOURNAL;
	const { blueprint, stocked, entities } = partial;
	const missing = chunksOf(partial).filter((c) => !results.some((r) => r.chunk === c));
	if (missing.length > 0) throw new Error(`cannot finish generation: region ${missing.join(", ")} was never written`);
	const withPayloads = [...results].sort((a, b) => a.chunk - b.chunk).map((r) => ({
		...r,
		payload: contentPayload(partial, r.chunk)
	}));
	let usage = partial.usage;
	for (const g of withPayloads) {
		applyContentPass(g.value, g.payload, entities, blueprint, stocked, new Rng(stocked.seed + g.chunk));
		usage = {
			inputTokens: usage.inputTokens + g.usage.inputTokens,
			outputTokens: usage.outputTokens + g.usage.outputTokens
		};
	}
	const seamsPayload = buildSeamsPassPayload(stocked, entities, partial.dungeonContext);
	if (seamsPayload.seams.length > 0) {
		report({ stage: "joining" });
		const prompt = renderSeamsPassPrompt(seamsPayload);
		const { value, usage: seamsUsage } = await callForJson({
			task: "seams-pass",
			schema: seamsPassSchema,
			toolName: "write_ways_through",
			toolDescription: "Name and write every way through between the regions of the dungeon.",
			messages: [{
				role: "user",
				content: prompt
			}],
			...opts.signal ? { signal: opts.signal } : {},
			check: (v) => seamsPassOmissions(seamsPayload, v),
			onAttemptFailed: reportFailure(journal, "seams-pass")
		});
		journal.log({
			kind: "generation",
			pass: "seams-pass",
			prompt,
			response: value,
			usage: seamsUsage
		});
		applySeamsPass(value, seamsPayload, entities);
		usage = {
			inputTokens: usage.inputTokens + seamsUsage.inputTokens,
			outputTokens: usage.outputTokens + seamsUsage.outputTokens
		};
	}
	return {
		...partial,
		entities,
		usage
	};
}
/**
* The three steps above, composed.
*
* This is what the browser and the CLI call and what every generation test
* exercises. The server calls the three separately, because no one Vercel
* invocation may hold more than one model call — but it is the same pipeline,
* and this composition is what keeps that true rather than aspirational.
*/
async function generateDungeon(opts) {
	const report = opts.onProgress ?? (() => {});
	const pass = {
		...opts.signal ? { signal: opts.signal } : {},
		...opts.journal ? { journal: opts.journal } : {},
		...opts.onProgress ? { onProgress: opts.onProgress } : {}
	};
	const partial = await generateStructure(opts);
	const chunks = chunksOf(partial);
	let done = 0;
	report({
		stage: "writing",
		chunksDone: 0,
		chunksTotal: chunks.length
	});
	return finishGeneration(partial, await Promise.all(chunks.map(async (chunk) => {
		const result = await generateChunk(partial, chunk, pass);
		report({
			stage: "writing",
			chunksDone: ++done,
			chunksTotal: chunks.length
		});
		return result;
	})), pass);
}
//#endregion
//#region src/runtime/types.ts
/**
* Stages that end the run.
*
* `departed` is here because a referee that writes it has ended the run whatever
* the store resolves it to, and anything asking `isTerminal` of a commit rather
* than of stored state must get the same answer.
*/
var TERMINAL_STAGES = [
	"dead",
	"departed",
	"escaped",
	"goal_met",
	"abandoned"
];
/**
* Stages in which the world must not change. Enforced by the applier, not by
* trusting the referee to have read the rule.
*/
var NO_CHANGE_STAGES = ["clarifying", "rejected"];
function isTerminal(stage) {
	return TERMINAL_STAGES.includes(stage);
}
/** Stages where the game is working and the input area is closed. */
var BUSY_STAGES = [
	"room_entry",
	"thinking",
	"rolling",
	"resolving"
];
/** Whether the player can type right now. */
function acceptsInput(stage) {
	return !BUSY_STAGES.includes(stage) && !isTerminal(stage);
}
//#endregion
//#region src/runtime/occupancy.ts
/** Everything whose own link field points straight at `holderId`. */
function directContents(holderId, e) {
	const out = [];
	for (const c of e.creatures) if (c.roomId === holderId) out.push(c);
	for (const f of e.features) if (f.roomId === holderId) out.push(f);
	for (const i of e.items) if (i.parentId === holderId) out.push(i);
	for (const x of e.effects) if (x.roomIds.includes(holderId)) out.push(x);
	return out;
}
/** Items held by `holderId`, one level deep. */
function heldItems(holderId, e) {
	return e.items.filter((i) => i.parentId === holderId);
}
//#endregion
//#region src/runtime/travel.ts
/**
* WALKING ACROSS THE DUNGEON
* =========================
*
* "Go back to the Laboratory" is one thing the player says and three rooms of
* walking. This works out which rooms those are, and — more usefully — where
* the walk actually ends, which is often not where they meant.
*
* WHY THIS IS NOT THE REFEREE'S JOB. It is a graph question with one right
* answer, and the referee is handed only the room it is standing in: it can see
* one step, has to infer the rest from turn records, and was observed inferring
* it wrong three times in a row. Nothing about routing needs judgement, so
* nothing about it should be guessed.
*
* WHAT STOPS A WALK. Crossing a room is not free. A creature standing in it, a
* fire spreading through it, a trap in it — sprung or waiting — a way that is
* barred: any of these ends the journey there, and the player is left facing the
* thing that stopped them rather than teleported past it. That is the whole
* point of letting them name a far room: it is a convenience for empty
* corridors, not a way to skip what is standing in them.
*
* The DESTINATION is never checked. Arriving is what they asked for, and
* whatever is waiting there is the arrival pass's business.
*
* WHERE THEY MAY GO. Through rooms they have been in — a route is retracing
* steps, and you cannot retrace a step you never took. The far end may be
* somewhere new, because walking into the next room is the ordinary case and
* that room is new by definition.
*/
/**
* A way through that can be part of a route.
*
* Undiscovered ways are not routes. Neither is the way OUT of the dungeon: it
* joins one room to nothing, so it is a terminus rather than an edge, and a walk
* that took it would be leaving rather than travelling. Departure is its own
* thing — see `Stage` / `departed` — and it never happens by accident on the way
* to somewhere else.
*/
var walkable = (c) => c.isHidden !== true && !isSurfaceExit(c);
/**
* Fewest rooms crossed, refusing anything `clear` turns down.
*
* Run twice by `routeTo`: once demanding a route with nothing in the way at all,
* and once taking whatever exists. The obstacle checks are the same ones the
* walk itself applies, so the two passes cannot disagree about what counts.
*
* Only rooms the player has stood in are expanded THROUGH; the goal itself may
* be new, and is never tested — arriving is what they asked for. Deterministic:
* connectors are visited in world order.
*/
function shortestPath(world, from, to, clear) {
	if (from === to) return [];
	const passable = (roomId) => {
		if (world.entities.rooms.find((r) => r.id === roomId)?.composed === void 0) return false;
		return !clear || obstacleIn(world, roomId) === void 0;
	};
	const cameBy = /* @__PURE__ */ new Map();
	const seen = /* @__PURE__ */ new Set([from]);
	let frontier = [from];
	while (frontier.length > 0) {
		const next = [];
		for (const here of frontier) for (const c of world.entities.connectors) {
			if (!touches(c, here) || !walkable(c)) continue;
			if (clear && obstacleOn(world, c) !== void 0) continue;
			const there = farSide(c, here);
			if (seen.has(there)) continue;
			seen.add(there);
			cameBy.set(there, {
				connectorId: c.id,
				roomId: there
			});
			if (there === to) {
				const legs = [];
				for (let at = to; at !== from; at = stepBefore(world, cameBy, at, from)) legs.unshift(cameBy.get(at));
				return legs;
			}
			if (passable(there)) next.push(there);
		}
		frontier = next;
	}
}
/** Walk the parent chain back one link. */
function stepBefore(world, cameBy, at, from) {
	const leg = cameBy.get(at);
	if (!leg) return from;
	return farSide(world.entities.connectors.find((x) => x.id === leg.connectorId), at);
}
/**
* A hazard that a walk cannot simply pass through, and how to say so.
*
* TWO STATES STOP THEM, for opposite reasons. One going off is a wall — fire in
* the room, the floor coming down. One that has NOT gone off is worse: walking
* through is exactly what sets it off, so a route that carried the player over
* it would spring it in silence, three rooms from where they were looking. The
* walk ends in front of it instead and the turn resolves it properly.
*
* What does NOT stop them is a hazard already spent — sprung, and no longer
* doing anything. That is scenery, and a collapsed pit is a hole you step round.
*
* The player does not read this. It goes to the referee, and only about a room
* they are now standing in, which is a room the arrival pass is about to show
* them anyway.
*/
function hazardStop(h) {
	if (!h) return void 0;
	const name = h.name || "a hazard";
	if (h.active === true) return `${name} is going off`;
	if (h.sprung !== true) return `${name} lies between them and the far side, unsprung`;
}
var hazardOf = (world, id) => id ? world.entities.hazards.find((h) => h.id === id) : void 0;
/**
* What is in this room that a person could not simply walk past.
*
* A creature is anything still standing there — the applier removes the slain,
* so presence is the whole test and the referee decides what it does about it.
* Effects are fires and gas, which are exactly walls.
*/
function obstacleIn(world, roomId) {
	const e = world.entities;
	const creature = e.creatures.find((c) => c.roomId === roomId);
	if (creature) return `${creature.name || "a creature"} is in the way`;
	const hazard = hazardStop(hazardOf(world, e.rooms.find((r) => r.id === roomId)?.hazardId));
	if (hazard) return hazard;
	const effect = e.effects.find((x) => x.roomIds.includes(roomId));
	if (effect) return `${effect.name || "something"} fills it`;
}
/** The same question, asked of a way through rather than a room. */
function obstacleOn(world, c) {
	if (c.conditional !== void 0) return `${c.name || "the way"} is blocked: ${c.conditional}`;
	const hazard = hazardStop(hazardOf(world, c.hazardId));
	return hazard ? `${hazard}, in ${c.name || "the way through"}` : void 0;
}
/**
* Where the player gets to, trying to reach `to` from where they stand.
*
* Prefers a route that is open the whole way. Only when there is none does it
* consider blocked ways — and then only to walk them up to the barrier, so the
* player ends the turn looking at the thing that stopped them rather than being
* told the room does not exist.
*/
function routeTo(world, to) {
	const from = world.currentRoomId;
	if (from === to) return {
		legs: [],
		endsAt: from
	};
	const path = shortestPath(world, from, to, true) ?? shortestPath(world, from, to, false);
	if (!path) return {
		legs: [],
		endsAt: from,
		unreachable: `no way leads from the room the player is standing in to ${JSON.stringify(to)} through rooms they have been in. They can only walk where they have already been, plus one step into somewhere new.`
	};
	const legs = [];
	let at = from;
	for (const leg of path) {
		const shut = obstacleOn(world, world.entities.connectors.find((x) => x.id === leg.connectorId));
		if (shut) return {
			legs,
			endsAt: at,
			stoppedBy: shut
		};
		legs.push(leg);
		at = leg.roomId;
		if (at === to) break;
		const held = obstacleIn(world, at);
		if (held) return {
			legs,
			endsAt: at,
			stoppedBy: `they got as far as ${roomName$1(world, at)}, where ${held}`
		};
	}
	return {
		legs,
		endsAt: at
	};
}
function roomName$1(world, id) {
	return world.entities.rooms.find((r) => r.id === id)?.name || id;
}
//#endregion
//#region src/runtime/diffs/paths.ts
/**
* Array indices are collapsed to `[#]` so one entry covers every index, while
* `[]` (append) stays a distinct path with distinct meaning.
*/
function normalizePath(path) {
	return path.replace(/\[\s*\d+\s*\]/g, "[#]").trim();
}
/**
* True of every entity: the prose pair, and whether the player is aware of it.
*
* `isHidden` sits here rather than on features alone because anything can be
* concealed — a creature waiting in the dark, a door behind a tapestry, a coin
* under a flagstone. A Room is the one exception: the map reads
* `composed !== undefined` as "the player has been here", which only holds if a
* room can never be hidden.
*/
var COMMON = [
	"state",
	"composed",
	"isHidden"
];
var WRITABLE = {
	Room: ["state", "composed"],
	RoomConnector: [...COMMON, "conditional"],
	Creature: [
		...COMMON,
		"activity",
		"count",
		"stats.hp",
		"roomId"
	],
	RoomFeature: [...COMMON, "roomId"],
	Item: [
		...COMMON,
		"currentQuality",
		"amount",
		"parentId",
		"book.uses",
		"book.exhausted"
	],
	MobileEffect: [...COMMON, "roomIds"],
	Hazard: [
		...COMMON,
		"sprung",
		"active"
	],
	PlayerCharacter: [
		"hp.current",
		"conditions[]",
		"conditions[#]",
		"inventory[]",
		"inventory[#]",
		"equipped.weapon",
		"equipped.armor",
		"equipped.helmet",
		"equipped.shield",
		"roomId"
	]
};
/** Creating a new entity under a holder. Legal on anything that can hold one. */
var CREATE_PATH = "children[]";
var CREATE_HOLDERS = [
	"Room",
	"Creature",
	"RoomFeature",
	"Item",
	"PlayerCharacter"
];
function canHoldNewEntities(kind) {
	return CREATE_HOLDERS.includes(kind);
}
function isWritable(kind, path) {
	const p = normalizePath(path);
	if (p === CREATE_PATH) return canHoldNewEntities(kind);
	return WRITABLE[kind].includes(p);
}
/** For error messages: what this kind of thing does accept. */
function writablePaths(kind) {
	return canHoldNewEntities(kind) ? [...WRITABLE[kind], CREATE_PATH] : WRITABLE[kind];
}
//#endregion
//#region src/runtime/diffs/types.ts
/** The id the referee uses for the player character. */
var PLAYER_ID = "player";
//#endregion
//#region src/runtime/diffs/apply.ts
/**
* THE APPLIER
* ===========
*
* The single chokepoint between what the referee says happened and what the
* save file contains.
*
* ATOMIC BY CONSTRUCTION. The batch is applied to a deep clone; the clone is
* adopted only if every diff succeeded. That is stronger than validating first
* and applying second, and it is the only approach that copes with a batch
* whose later diffs depend on its earlier ones — unequip the shield, then take
* up the two-handed sword. Validating both against the starting state would
* refuse the second for a conflict that the first had already resolved.
*
* The invariants are not re-implemented here. `equip`, `addItem`, `removeItem`
* and `validateEquipment` already own them, so the handlers call those. A
* well-formed write straight to `equipped.shield` would pass any path check and
* still produce a shield worn alongside a two-hander; routing through `equip`
* cannot.
*/
function indexWorld(w) {
	const m = /* @__PURE__ */ new Map();
	m.set(PLAYER_ID, {
		kind: "PlayerCharacter",
		entity: null
	});
	m.set(w.pc.id, {
		kind: "PlayerCharacter",
		entity: null
	});
	for (const r of w.entities.rooms) m.set(r.id, {
		kind: "Room",
		entity: r
	});
	for (const c of w.entities.connectors) m.set(c.id, {
		kind: "RoomConnector",
		entity: c
	});
	for (const c of w.entities.creatures) m.set(c.id, {
		kind: "Creature",
		entity: c
	});
	for (const f of w.entities.features) m.set(f.id, {
		kind: "RoomFeature",
		entity: f
	});
	for (const h of w.entities.hazards) m.set(h.id, {
		kind: "Hazard",
		entity: h
	});
	for (const e of w.entities.effects) m.set(e.id, {
		kind: "MobileEffect",
		entity: e
	});
	for (const i of w.entities.items) m.set(i.id, {
		kind: "Item",
		entity: i
	});
	for (const i of w.pc.inventory) m.set(i.id, {
		kind: "Item",
		entity: i
	});
	return m;
}
var Failure = class extends Error {};
var fail = (reason) => {
	throw new Failure(reason);
};
var asNumber = (v, what) => typeof v === "number" && Number.isFinite(v) ? v : fail(`${what} must be a number`);
var asString = (v, what) => typeof v === "string" && v.trim() !== "" ? v : fail(`${what} must be a non-empty string`);
var asBoolean = (v, what) => typeof v === "boolean" ? v : fail(`${what} must be true or false`);
function resolveId(ctx, id) {
	return ctx.refs.get(id) ?? id;
}
function requireEntity(ctx, id) {
	return ctx.index.get(resolveId(ctx, id)) ?? fail(`no entity with id ${JSON.stringify(id)}`);
}
function removeFromWorld(ctx, entity) {
	const e = ctx.world.entities;
	const drop = (list) => {
		const i = list.findIndex((x) => x.id === entity.id);
		if (i !== -1) list.splice(i, 1);
	};
	drop(e.rooms);
	drop(e.connectors);
	drop(e.creatures);
	drop(e.features);
	drop(e.items);
	drop(e.hazards);
	drop(e.effects);
	removeItem(ctx.world.pc, entity.id);
	ctx.index.delete(entity.id);
}
/** Destroy an item, wherever it is, clearing any slot that pointed at it. */
function destroyItem(ctx, item, why) {
	const wasEquipped = EQUIP_SLOTS.some((s) => ctx.world.pc.equipped[s] === item.id);
	removeFromWorld(ctx, item);
	ctx.events.push({
		kind: "item-destroyed",
		entityId: item.id,
		detail: `${item.name || "an item"} ${why}`
	});
	if (wasEquipped) ctx.events.push({
		kind: "unequipped",
		entityId: item.id,
		detail: `${item.name || "an item"} left its slot`
	});
}
/** Kill a creature; what it carried falls where it stood. */
function slayCreature(ctx, creature) {
	for (const item of heldItems(creature.id, ctx.world.entities)) item.parentId = creature.roomId;
	removeFromWorld(ctx, creature);
	ctx.events.push({
		kind: "creature-slain",
		entityId: creature.id,
		detail: `${creature.name || "a creature"} is dead`
	});
}
/**
* THE PLAYER WALKS. They do not appear.
*
* The referee names where the player is going and the world works out how far
* they get, which is the same bargain as everywhere else in this file: state the
* destination, not the procedure. `routeTo` owns the graph — see travel.ts for
* what stops a walk and why the destination itself is never checked.
*
* Two things are settled here rather than there. A route that does not exist is
* a REJECTION, so the reasons reach the referee and it gets the one retry §5
* allows; a route that ends short is APPLIED, because getting as far as the
* Torture Room and finding something in it is a real outcome and not an error.
* The event says so, and the arrival pass describes wherever they actually are.
*
* Read AFTER any earlier diff in the same batch, deliberately: unbar the door
* and walk through it is one commit, and the unbarring is already applied by the
* time the route is drawn.
*/
function walkTo(ctx, to) {
	const route = routeTo(ctx.world, to);
	if (route.unreachable) fail(route.unreachable);
	ctx.world.currentRoomId = route.endsAt;
	const last = route.legs[route.legs.length - 1];
	if (last) ctx.world.arrivedVia = last.connectorId;
	if (route.stoppedBy) ctx.events.push({
		kind: "movement-stopped",
		entityId: ctx.world.pc.id,
		detail: route.stoppedBy
	});
}
function applyProse(ctx, entity, path, value) {
	if (path === "state") {
		setState(entity, asString(value, "state"));
		return true;
	}
	if (path === "composed") {
		setComposed(entity, asString(value, "composed"));
		return true;
	}
	if (path === "isHidden") {
		if (ctx.carriedAtStart.has(entity.id)) fail(`${entity.name} was already in the player's inventory when this turn began, so it cannot be hidden or revealed — they walked in holding it. Something the player has just found is a DIFFERENT thing, even when they already own one like it: create it with children[] on whatever holds it and leave this one alone. (Picking up something concealed IS allowed: set parentId to the player and isHidden to false in the same commit.)`);
		setIsHidden(entity, asBoolean(value, "isHidden"));
		return true;
	}
	return false;
}
function applyToItem(ctx, item, path, value) {
	switch (path) {
		case "amount":
			item.amount = asString(value, "amount");
			return;
		case "book.uses": {
			if (!isBook(item)) return fail(`${item.name} is not a book, so it has no consultations`);
			const uses = asNumber(value, "book.uses");
			item.book.uses = Math.min(Math.max(uses, item.book.uses), item.book.uses + 1);
			return;
		}
		case "book.exhausted":
			if (!isBook(item)) return fail(`${item.name} is not a book, so it cannot be read out`);
			if (asBoolean(value, "book.exhausted")) {
				item.book.exhausted = true;
				ctx.events.push({
					kind: "book-exhausted",
					entityId: item.id,
					detail: `${item.name || "the book"} has nothing further to tell anyone`
				});
			}
			return;
		case "currentQuality": {
			const q = asNumber(value, "currentQuality");
			const ceiling = item.quality ?? q;
			item.currentQuality = Math.max(0, Math.min(ceiling, q));
			if (item.currentQuality === 0) destroyItem(ctx, item, "is destroyed");
			return;
		}
		case "parentId": {
			if (value === null) {
				destroyItem(ctx, item, "is gone");
				return;
			}
			const target = asString(value, "parentId");
			const heldByPlayer = ctx.world.pc.inventory.some((i) => i.id === item.id);
			if (target === "player" || target === ctx.world.pc.id) {
				takeIntoInventory(ctx, item);
				return;
			}
			requireEntity(ctx, target);
			if (heldByPlayer) {
				const removed = removeItem(ctx.world.pc, item.id);
				if (removed) ctx.world.entities.items.push(removed);
			}
			item.parentId = resolveId(ctx, target);
			return;
		}
	}
	fail(`unhandled Item path ${JSON.stringify(path)}`);
}
function applyToCreature(ctx, creature, path, value) {
	switch (path) {
		case "activity":
			creature.activity = asString(value, "activity");
			return;
		case "roomId":
			if (requireEntity(ctx, asString(value, "roomId")).kind !== "Room") fail("roomId must name a room");
			creature.roomId = resolveId(ctx, value);
			return;
		case "count": {
			const n = asNumber(value, "count");
			if (n < 0) fail("count cannot be negative");
			creature.count = n;
			if (n === 0) slayCreature(ctx, creature);
			return;
		}
		case "stats.hp": {
			const hp = asNumber(value, "stats.hp");
			creature.stats.hp = Math.min(maxHp(creature.stats), hp);
			if (creature.stats.hp <= 0) slayCreature(ctx, creature);
			return;
		}
	}
	fail(`unhandled Creature path ${JSON.stringify(path)}`);
}
function applyToPlayer(ctx, path, raw, value) {
	const pc = ctx.world.pc;
	if (path === "hp.current") {
		const hp = asNumber(value, "hp.current");
		pc.hp.current = Math.min(pc.hp.max, Math.max(-pc.hp.max, hp));
		if (pc.hp.current <= 0) ctx.events.push({
			kind: "player-died",
			entityId: pc.id,
			detail: "the player character is slain"
		});
		return;
	}
	if (path === "roomId") {
		if (requireEntity(ctx, asString(value, "roomId")).kind !== "Room") fail("roomId must name a room");
		walkTo(ctx, resolveId(ctx, value));
		return;
	}
	if (path === "conditions[]") {
		pc.conditions.push(asString(value, "a condition"));
		return;
	}
	if (path === "conditions[#]") {
		const i = indexOf(raw);
		if (i >= pc.conditions.length) fail(`no condition at index ${i}`);
		if (value !== null) fail("write null to clear a condition, or conditions[] to add one");
		pc.conditions.splice(i, 1);
		return;
	}
	if (path === "inventory[#]" || path === "inventory[]") {
		if (value === null) {
			if (path === "inventory[]") fail("inventory[] appends; write inventory[i] with null to drop");
			const i = indexOf(raw);
			const removed = removeItem(pc, (pc.inventory[i] ?? fail(`nothing carried at index ${i} to drop — to put something INTO the player's hands, write that item to inventory[] (an id to move one that exists, an entity to make one), or set the item's own parentId to "player"`)).id);
			if (removed) {
				removed.parentId = ctx.world.currentRoomId;
				ctx.world.entities.items.push(removed);
			}
			return;
		}
		if (typeof value === "string") {
			const entry = requireEntity(ctx, value);
			if (entry.kind !== "Item" || !entry.entity) fail(`only an item can be carried; ${JSON.stringify(value)} is a ${entry.kind} — to make something new, write the entity itself rather than an id`);
			takeIntoInventory(ctx, entry.entity);
			return;
		}
		createEntity(ctx, PLAYER_ID, value);
		return;
	}
	if (path.startsWith("equipped.")) {
		const slot = path.slice(9);
		if (value === null) {
			unequip(pc, slot);
			return;
		}
		const outcome = equipResolving(pc, slot, resolveId(ctx, asString(value, "an item id")));
		if (!outcome.ok) fail(outcome.reason ?? "that cannot be equipped there");
		for (const displaced of outcome.displaced) ctx.events.push({
			kind: "unequipped",
			entityId: displaced,
			detail: `the ${displaced} slot was emptied to make room`
		});
		return;
	}
	fail(`unhandled player path ${JSON.stringify(path)}`);
}
/**
* Into the player's hands, from wherever it was.
*
* Shared by `item.parentId = <player>` and by `inventory[…] = <id>`, which are
* two ways of saying the same thing and were once two different code paths —
* one of which worked. Whichever the referee reaches for, the item leaves the
* world's list, the equip slots stay coherent, and the slot budget is reported
* rather than enforced.
*
* FORCED, deliberately: the fiction has already committed to the pickup by the
* time this runs, so being overburdened is a condition to narrate, not grounds
* to refuse a commit and unsay a paragraph.
*/
function takeIntoInventory(ctx, item) {
	if (ctx.world.pc.inventory.some((i) => i.id === item.id)) return;
	const i = ctx.world.entities.items.findIndex((x) => x.id === item.id);
	if (i !== -1) ctx.world.entities.items.splice(i, 1);
	addItem(ctx.world.pc, item, { force: true });
	if (isOverburdened(ctx.world.pc)) ctx.events.push({
		kind: "overburdened",
		entityId: ctx.world.pc.id,
		detail: "carrying more than their slots allow"
	});
}
function indexOf(raw) {
	const m = /\[\s*(\d+)\s*\]/.exec(raw);
	return m ? Number(m[1]) : fail(`expected an index in ${JSON.stringify(raw)}`);
}
function createEntity(ctx, holderId, value) {
	const spec = value;
	if (!spec || typeof spec !== "object") fail("children[] takes an entity to create");
	if (spec.type !== "Item" && spec.type !== "RoomFeature") fail(`cannot create a ${String(spec.type)}; only Item and RoomFeature`);
	const name = properName(asString(spec.name, "the new entity's name"));
	const base = asString(spec.base, "the new entity's base");
	const holder = requireEntity(ctx, holderId);
	const resolvedHolder = resolveId(ctx, holderId);
	const id = makeId();
	if (spec.type === "Item") {
		const item = {
			id,
			name,
			type: "Item",
			base,
			parentId: holder.kind === "PlayerCharacter" ? ctx.world.pc.id : resolvedHolder,
			slots: spec.slots ?? 1,
			...spec.amount ? { amount: spec.amount } : {},
			value: 0
		};
		if (spec.state) setState(item, spec.state);
		if (holder.kind === "PlayerCharacter") takeIntoInventory(ctx, item);
		else ctx.world.entities.items.push(item);
		ctx.index.set(id, {
			kind: "Item",
			entity: item
		});
	} else {
		const feature = {
			id,
			name,
			type: "RoomFeature",
			base,
			roomId: roomContaining(ctx, resolvedHolder) ?? ctx.world.currentRoomId
		};
		if (spec.state) setState(feature, spec.state);
		if (spec.hidden) feature.isHidden = true;
		ctx.world.entities.features.push(feature);
		ctx.index.set(id, {
			kind: "RoomFeature",
			entity: feature
		});
	}
	if (spec.ref) ctx.refs.set(spec.ref, id);
	ctx.events.push({
		kind: "entity-created",
		entityId: id,
		detail: `${name} now exists`
	});
}
function roomContaining(ctx, id) {
	const e = ctx.world.entities;
	if (e.rooms.some((r) => r.id === id)) return id;
	const creature = e.creatures.find((c) => c.id === id);
	if (creature) return creature.roomId;
	const feature = e.features.find((f) => f.id === id);
	if (feature) return feature.roomId;
	const item = [...e.items, ...ctx.world.pc.inventory].find((i) => i.id === id);
	return item ? roomContaining(ctx, item.parentId) : void 0;
}
function applyOne(ctx, diff) {
	const raw = diff.path;
	const path = normalizePath(raw);
	const entry = requireEntity(ctx, diff.entityId);
	if (!isWritable(entry.kind, path)) fail(`${entry.kind} has no writable path ${JSON.stringify(path)}; it accepts ${writablePaths(entry.kind).join(", ")}`);
	if (path === "children[]") {
		createEntity(ctx, diff.entityId, diff.value);
		return;
	}
	if (entry.kind === "PlayerCharacter") {
		applyToPlayer(ctx, path, raw, diff.value);
		return;
	}
	const entity = entry.entity;
	if (applyProse(ctx, entity, path, diff.value)) return;
	switch (entry.kind) {
		case "Item":
			applyToItem(ctx, entity, path, diff.value);
			return;
		case "Creature":
			applyToCreature(ctx, entity, path, diff.value);
			return;
		case "RoomConnector": {
			const conn = entity;
			if (diff.value === null) delete conn.conditional;
			else conn.conditional = asString(diff.value, "conditional");
			return;
		}
		case "RoomFeature": {
			const f = entity;
			if (path === "roomId") {
				if (requireEntity(ctx, asString(diff.value, "roomId")).kind !== "Room") fail("roomId must name a room");
				f.roomId = resolveId(ctx, diff.value);
				return;
			}
			break;
		}
		case "Hazard": {
			const h = entity;
			if (path === "sprung") {
				h.sprung = asBoolean(diff.value, "sprung");
				return;
			}
			if (path === "active") {
				h.active = asBoolean(diff.value, "active");
				return;
			}
			break;
		}
		case "MobileEffect": {
			const fx = entity;
			if (path === "roomIds") {
				if (!Array.isArray(diff.value)) fail("roomIds must be an array of room ids");
				const ids = diff.value.map((v) => asString(v, "a room id"));
				for (const id of ids) if (requireEntity(ctx, id).kind !== "Room") fail(`${id} is not a room`);
				fx.roomIds = ids.map((id) => resolveId(ctx, id));
				return;
			}
			break;
		}
	}
	fail(`unhandled ${entry.kind} path ${JSON.stringify(path)}`);
}
/**
* Apply a commit. On success the caller adopts `world`; on failure the original
* is untouched and `rejected` explains why, in terms the referee can act on.
*/
function applyCommit(world, commit) {
	const rejected = [];
	if (NO_CHANGE_STAGES.includes(commit.nextStage) && (commit.diffs.length > 0 || commit.fictionNote)) {
		const reason = `a "${commit.nextStage}" turn must not change the world`;
		const refusals = commit.diffs.map((diff) => ({
			diff,
			reason
		}));
		if (commit.fictionNote !== void 0) refusals.push({
			diff: {
				entityId: "(the dungeon)",
				path: "fictionNote",
				value: commit.fictionNote
			},
			reason: `${reason}, and that includes adding to its fiction`
		});
		return {
			ok: false,
			applied: [],
			events: [],
			rejected: refusals
		};
	}
	const draft = structuredClone(world);
	const ctx = {
		world: draft,
		index: indexWorld(draft),
		events: [],
		refs: /* @__PURE__ */ new Map(),
		carriedAtStart: new Set(world.pc.inventory.map((i) => i.id))
	};
	const applied = [];
	if (commit.goalMet === true && !draft.goalMet) {
		draft.goalMet = true;
		ctx.events.push({
			kind: "goal-met",
			entityId: draft.pc.id,
			detail: "the dungeon's objective is accomplished"
		});
	}
	if (commit.fictionNote !== void 0) {
		const note = commit.fictionNote.trim();
		if (note !== "" && !draft.fiction.includes(note)) draft.fiction.push(note);
	}
	for (const diff of commit.diffs) try {
		applyOne(ctx, diff);
		applied.push(diff);
	} catch (e) {
		if (!(e instanceof Failure)) throw e;
		rejected.push({
			diff,
			reason: e.message
		});
	}
	if (rejected.length > 0) return {
		ok: false,
		applied: [],
		rejected,
		events: []
	};
	if (commit.nextStage === "departed") {
		const out = draft.entities.connectors.filter((c) => isSurfaceExit(c) && c.endpointA === draft.currentRoomId && c.isHidden !== true);
		const reason = out.length === 0 ? "the player cannot leave the dungeon from here: this room has no way to the surface. Walk them to one first — the way out is on the \"Ways out\" list of the room that has it." : out.every((c) => c.conditional !== void 0) ? `the player cannot leave: the way to the surface is blocked — ${out.map((c) => c.conditional).join("; ")}.` : void 0;
		if (reason !== void 0) return {
			ok: false,
			applied: [],
			events: [],
			rejected: [{
				diff: {
					entityId: PLAYER_ID,
					path: "nextStage",
					value: "departed"
				},
				reason
			}]
		};
	}
	for (const issue of validateEquipment(draft.pc)) {
		const slot = issue.split(":")[0];
		const id = draft.pc.equipped[slot];
		unequip(draft.pc, slot);
		ctx.events.push({
			kind: "unequipped",
			entityId: id ?? slot,
			detail: issue
		});
	}
	return {
		ok: true,
		world: draft,
		applied,
		rejected: [],
		events: ctx.events
	};
}
//#endregion
//#region src/runtime/rng.ts
/**
* THE RUN RNG
*
* Play-time randomness draws from a stream separate from generation, so
* re-rolling a character cannot shift the dungeon and replaying a run cannot
* reshape it.
*
* `Rng` keeps its state in a private field and exposes no way to read or
* restore it, so a save can't snapshot mid-stream. What a save *can* record is
* the seed and how many numbers have been drawn — replaying those draws lands
* on exactly the same point. Draws are cheap (a few multiplies each), so
* fast-forwarding thousands of them on load costs nothing measurable.
*
* A wrapper rather than a subclass: `Rng`'s own methods reach for its private
* generator directly, so overriding `next()` would not catch them. Everything
* that needs seeded randomness at runtime takes the `RollRng` interface —
* `{ next(): number }` — which both satisfy.
*/
var CountingRng = class CountingRng {
	seed;
	inner;
	count = 0;
	constructor(seed, draws = 0) {
		this.seed = seed;
		this.inner = new Rng(seed);
		this.fastForward(draws);
	}
	/** How many numbers have been drawn. Persist this alongside the seed. */
	get draws() {
		return this.count;
	}
	next() {
		this.count++;
		return this.inner.next();
	}
	/** Replay `n` draws to reach a saved position. */
	fastForward(n) {
		for (let i = 0; i < n; i++) this.next();
	}
	/** Restore from a persisted `{ seed, draws }` pair. */
	static resume(seed, draws) {
		return new CountingRng(seed, draws);
	}
};
//#endregion
//#region src/store/game.ts
/**
* GAME STATE
* ==========
*
* The serialisable root, split in two by write frequency.
*
*   GeneratedDungeon  large, written once at generation      -> dungeon:<id>
*   RunState          small, written on every commit         -> run:<id>
*
* Keeping them apart means a turn does not re-serialise thirty rooms and
* everything in them just to record that the player lost two hit points.
*
* The store owns no React. Everything below is plain state plus functions, so
* the turn machine and its tests never need a renderer. That is why the import
* below is `zustand/vanilla` and not `zustand`: the package's own entry point
* re-exports `zustand/react`, so importing it pulled React into the import
* graph of every module that touches game state — the turn machine and the
* referee included. `src/store/react.ts` holds the one binding that does.
*
* ONE STORE PER RUN. There was a module-level `useGame` here until Phase 9, and
* a singleton is the right shape for exactly one situation: a browser tab, with
* one run in it. A process serving several runs at once would have them
* overwrite each other's entities, stage, and — worst, because it is silent —
* each other's `rngDraws`. So the store is made by a factory now, and whoever
* owns a run holds its store.
*/
function newRun(dungeon, pc) {
	const entrance = dungeon.stocked.entranceRoomId;
	return {
		dungeonId: dungeon.id,
		pc,
		currentRoomId: entrance,
		arrivedVia: dungeon.entities.connectors.find((c) => c.endpointB === null && c.endpointA === entrance)?.id,
		stage: "room_entry",
		step: "room-entry",
		turnCount: 0,
		goalMet: false,
		fiction: [],
		runSeed: dungeon.seeds.runSeed,
		rngDraws: 0,
		entities: structuredClone(dungeon.entities),
		transcript: [],
		log: [{
			kind: "opening",
			text: dungeon.pass.openingProse,
			turn: 0
		}],
		turnRecords: [],
		callLog: []
	};
}
function worldOf(run) {
	return {
		entities: run.entities,
		pc: run.pc,
		currentRoomId: run.currentRoomId,
		...run.arrivedVia !== void 0 ? { arrivedVia: run.arrivedVia } : {},
		goalMet: run.goalMet,
		fiction: run.fiction ?? []
	};
}
/**
* WHICH ENDING THIS IS.
*
* Two things outrank whatever the referee thought came next, and both for the
* same reason: they are derived from state the referee does not hold and cannot
* be talked out of.
*
* Death is hit points at zero.
*
* A departure is a stage the referee ASKS for — it knows the player walked out,
* and nothing else — and the store settles what that was worth. Out with the
* objective done is `goal_met`; out without it is `escaped`. Leaving that to the
* referee would mean the ending depended on whether it still remembered a thing
* that might have happened twenty turns ago.
*/
function endingOf(commit, world, died) {
	if (died) return "dead";
	if (commit.nextStage === "departed") return world.goalMet ? "goal_met" : "escaped";
	return commit.nextStage;
}
function createGameStore() {
	return createStore(init);
}
var init = (set, get) => ({
	dungeon: void 0,
	run: void 0,
	lastEvents: [],
	start(dungeon, pc) {
		set({
			dungeon,
			run: newRun(dungeon, pc),
			lastEvents: []
		});
	},
	commit(commit) {
		const run = get().run;
		if (!run) return {
			ok: false,
			reasons: ["no run in progress"]
		};
		const result = applyCommit(worldOf(run), commit);
		if (!result.ok || !result.world) return {
			ok: false,
			reasons: result.rejected.map((r) => `${r.diff.path}: ${r.reason}`)
		};
		const died = result.events.some((e) => e.kind === "player-died");
		set({
			lastEvents: result.events,
			run: {
				...run,
				entities: result.world.entities,
				pc: result.world.pc,
				currentRoomId: result.world.currentRoomId,
				arrivedVia: result.world.arrivedVia,
				goalMet: result.world.goalMet,
				fiction: result.world.fiction,
				stage: endingOf(commit, result.world, died),
				step: commit.nextStep,
				pendingRoll: commit.nextStage === "roll_offered" ? commit.rollRequest : void 0
			}
		});
		return {
			ok: true,
			reasons: []
		};
	},
	rng() {
		const run = get().run;
		if (!run) throw new Error("no run in progress");
		return CountingRng.resume(run.runSeed, run.rngDraws);
	},
	syncRng(rng) {
		const run = get().run;
		if (run) set({ run: {
			...run,
			rngDraws: rng.draws
		} });
	},
	setStage(stage, step) {
		const run = get().run;
		if (run) set({ run: {
			...run,
			stage,
			step
		} });
	},
	setPending(pending) {
		const run = get().run;
		if (!run) return;
		if (pending) {
			set({ run: {
				...run,
				pending
			} });
			return;
		}
		const next = { ...run };
		delete next.pending;
		set({ run: next });
	},
	pushTranscript(entry) {
		const run = get().run;
		if (run) set({ run: {
			...run,
			transcript: [...run.transcript, entry]
		} });
	},
	pushLog(entry) {
		const run = get().run;
		if (run) set({ run: {
			...run,
			log: [...run.log, {
				...entry,
				turn: run.turnCount + 1
			}]
		} });
	},
	showRoom(roomId) {
		const run = get().run;
		if (run) set({ run: {
			...run,
			shownRoomId: roomId
		} });
	},
	recordTurn(record) {
		const run = get().run;
		if (!run) return;
		const turn = run.turnCount + 1;
		set({ run: {
			...run,
			turnCount: turn,
			turnRecords: [...run.turnRecords, {
				...record,
				turn
			}],
			transcript: []
		} });
	},
	logCall(entry) {
		const run = get().run;
		if (run) set({ run: {
			...run,
			callLog: [...run.callLog, entry]
		} });
	},
	reset() {
		set({
			dungeon: void 0,
			run: void 0,
			lastEvents: []
		});
	}
});
//#endregion
//#region src/runtime/dice.ts
/**
* THE DICE TOOL
* =============
*
* The referee's half of the split described in BUILD-PLAN §4.2. The player's
* roll is thrown by the interface and arrives with their next message; every
* other roll in the game — the creature that strikes back, the nerve that
* breaks, the ceiling that comes down — is asked for here.
*
* IT TAKES A LIST, AND THAT IS THE WHOLE DESIGN. A resolution with three
* creatures in it costs ONE extra exchange rather than three, so the playbook
* can tell the referee to roll wide and discard rather than go back for more.
* A morale check it did not end up needing is a rounding error; a second round
* trip is not.
*
* Every kind maps onto `engine/dungeon-rolls`, which means advantage keep-best,
* the natural 20's extra die, the well-suited bonus, the d6 that empties a book
* and damage summation stay in tested code rather than moving into the prompt. Nothing here decides a
* rule; it translates a request and reports what the dice said.
*
* The RNG is the run's, positioned where the run left off — the same stream the
* player's own rolls draw from, advanced in list order. Two runs on one seed
* roll the same dice.
*/
var sign$1 = (n) => n >= 0 ? `+${n}` : `${n}`;
/** The d20 and its bonus, spelled out so a total can never be a bare claim. */
function d20Line(o) {
	return `d20 ${o.rolled.length > 1 ? `[${o.rolled.join(", ")}] keep ${o.kept}` : `${o.kept}`} ${sign$1(o.bonus)} = ${o.total} vs ${o.dc}`;
}
/** Crits report themselves; spending the quality point is the referee's diff. */
function critNote(o) {
	if (o.nat20) return " · NATURAL 20 — the defender's armour loses 1 currentQuality";
	if (o.nat1) return " · NATURAL 1 — the attacker's weapon loses 1 currentQuality";
	return "";
}
/**
* Roll one request. Draws from `rng` in call order, so the batch is
* deterministic in the order the referee listed it.
*/
function one(rng, r) {
	const edge = r.edge ?? "none";
	const bonus = r.bonus ?? 0;
	const failed = (why) => ({
		id: r.id,
		kind: r.kind,
		line: `CANNOT ROLL — ${why}`,
		failed: true
	});
	switch (r.kind) {
		case "save": {
			const o = saveRoll(rng, bonus, r.defenseAsDc !== void 0 ? dcFromDefense(r.defenseAsDc) : r.dc ?? 16, edge);
			return {
				id: r.id,
				kind: r.kind,
				line: `save — ${d20Line(o)} — ${o.success ? "SUCCESS" : "FAILURE"}${critNote(o)}`,
				failed: false
			};
		}
		case "attack": {
			if (r.targetDefense === void 0) return failed("an attack needs targetDefense");
			const o = attackRoll(rng, {
				bonus,
				targetDefense: r.targetDefense,
				edge,
				damage: r.damage,
				wellSuited: r.wellSuited
			});
			const damage = o.damage ? ` · damage ${o.damage.expr} → [${o.damage.rolls.join(", ")}] = ${o.damage.total}` : o.success && r.damage === void 0 ? ` · no damage die was given, so none was rolled` : "";
			return {
				id: r.id,
				kind: r.kind,
				line: `attack — ${d20Line(o)} — ${o.success ? "HIT" : "MISS"}${critNote(o)}${damage}`,
				failed: false
			};
		}
		case "stunt": {
			if (r.targetDefense === void 0) return failed("a stunt needs targetDefense");
			const o = stuntRoll(rng, bonus, r.targetDefense, edge);
			return {
				id: r.id,
				kind: r.kind,
				line: `stunt — ${d20Line(o)} — ${o.success ? "SUCCESS, and it deals no damage" : "FAILURE"}${critNote(o)}`,
				failed: false
			};
		}
		case "morale": {
			const rating = r.rating ?? 7;
			const o = moraleRoll(rng, rating);
			return {
				id: r.id,
				kind: r.kind,
				line: `morale — 2d6 [${o.rolled.join(", ")}] = ${o.total} vs ${rating} — ${o.holds ? "THEY HOLD" : "THEY BREAK"}`,
				failed: false
			};
		}
		case "consult": {
			const o = consultRoll(rng, r.uses ?? 0);
			const verdict = o.exhausted ? `THE LAST OF IT · write book.uses ${o.uses} and book.exhausted true` : `THERE IS MORE IN IT · write book.uses ${o.uses}`;
			return {
				id: r.id,
				kind: r.kind,
				line: `consult — reading ${o.uses}, d6 [${o.rolled}] vs ${o.uses} — ${verdict}`,
				failed: false
			};
		}
		case "damage": {
			const expr = r.expr ?? r.damage;
			if (expr === void 0) return failed("damage needs an expression, e.g. 2d6");
			try {
				const o = rollDamage(rng, expr, r.extraDice ?? 0);
				return {
					id: r.id,
					kind: r.kind,
					line: `damage — ${o.expr} → [${o.rolls.join(", ")}] = ${o.total}`,
					failed: false
				};
			} catch (e) {
				return failed(e instanceof Error ? e.message : String(e));
			}
		}
	}
}
function rollBatch(rng, rolls) {
	return rolls.map((r) => one(rng, r));
}
/** The batch's results, keyed by the referee's own ids. */
function renderOutcomes(outcomes) {
	return outcomes.map((o) => `${o.id}: ${o.line}`).join("\n");
}
//#endregion
//#region src/store/selectors.ts
/**
* VIEW MODELS
* ===========
*
* Everything the interface renders, derived here rather than in JSX. Components
* that compute their own view state put logic somewhere it cannot be tested and
* duplicate it the moment a second component needs the same answer.
*
* Framework-free on purpose: these are plain functions over state, so the turn
* machine can use the same room view for prompt assembly that the screen uses
* for display. One place where "what is in this room" is decided means the
* player and the referee cannot end up looking at different rooms.
*/
function toView(entity, entities, registry, stats = false) {
	const view = {
		id: entity.id,
		name: entity.name,
		kind: entity.type,
		composed: entity.composed,
		state: entity.state,
		base: resolveBase(entity, registry),
		needUpdate: entity.needUpdate === true,
		isHidden: entity.isHidden === true,
		position: entity.place?.position,
		contains: heldItems(entity.id, entities).map((i) => toView(i, entities, registry, stats))
	};
	if (entity.type === "Creature") {
		const c = entity;
		view.activity = c.activity;
		view.count = c.count;
		view.hp = {
			current: c.stats.hp,
			max: maxHp(c.stats)
		};
		if (stats) view.combat = {
			armorDefense: armorDefense$1(c.stats),
			defenses: Object.fromEntries(ABILITIES.map((a) => [a, abilityDefense(c.stats, a)])),
			attackBonus: attackBonus(c.stats),
			damage: damageDie(c.stats),
			morale: c.stats.morale ?? 7
		};
	}
	if (entity.type === "Item") {
		const i = entity;
		view.slots = i.slots;
		if (i.quality !== void 0) view.quality = {
			current: i.currentQuality ?? i.quality,
			original: i.quality
		};
		if (itemValue(i) > 0) view.value = itemValue(i);
		if (isBook(i)) view.book = {
			...i.book,
			exhausted: i.book.exhausted === true
		};
	}
	return view;
}
function roomView(run, dungeon, roomId = run.currentRoomId, opts = {}) {
	const e = run.entities;
	const room = e.rooms.find((r) => r.id === roomId);
	if (!room) return void 0;
	const registry = e.registry;
	const showAll = opts.includeHidden === true;
	const stats = opts.includeStats === true;
	const visible = (x) => showAll || x.isHidden !== true;
	const contents = directContents(roomId, e).filter(visible).map((x) => toView(x, e, registry, stats)).map((v) => showAll ? v : {
		...v,
		contains: v.contains.filter((c) => !c.isHidden)
	});
	const drawn = geometryOf(dungeon, roomId);
	const concealed = new Set(e.connectors.filter((c) => touches(c, roomId) && c.isHidden === true).map((c) => c.id));
	const exits = e.connectors.filter((c) => touches(c, roomId)).filter(visible).map((c) => {
		const toRoomId = farSide(c, roomId);
		const to = toRoomId === null ? void 0 : e.rooms.find((r) => r.id === toRoomId);
		return {
			connectorId: c.id,
			toRoomId,
			surface: isSurfaceExit(c),
			toRoomName: to?.name ?? "",
			name: c.name,
			form: resolveBase(c, registry),
			blocked: c.conditional !== void 0,
			requirement: c.conditional,
			toKnown: isSurfaceExit(c) || to?.composed !== void 0,
			cameFrom: roomId === run.currentRoomId && c.id === run.arrivedVia,
			isHidden: c.isHidden === true,
			wall: drawn?.walls.get(isSurfaceExit(c) ? null : c.id)
		};
	}).sort(byUsefulness);
	return {
		id: room.id,
		name: room.name,
		composed: room.composed,
		state: room.state,
		base: resolveBase(room, registry),
		needUpdate: room.needUpdate === true,
		contents,
		exits,
		fiction: dungeon.dungeonContext,
		geometry: drawn && describeGeometry(drawn.geometry, { omit: concealed })
	};
}
/**
* One room's drawing, as the sentence and the per-connector walls.
*
* MEMOISED ON THE DUNGEON, because `roomView` runs on every render and on every
* prompt assembly while `siteRooms` covers all thirty rooms. It is pure and the
* inputs are write-once — `blockplan` and `graph` are set at generation and
* never written again — so a WeakMap keyed on the dungeon is a cache that
* cannot go stale and cannot leak.
*/
/**
* The GEOMETRY is memoised, not the sentence it renders to.
*
* The drawing is write-once and the walls with it, but which ways out are
* concealed is run state — a secret door found on turn nine has to start being
* counted — so the sentence is rendered per call against the concealed set of
* the moment. `describeGeometry` is a map over four or five exits; the siting
* pass it is memoising is the expensive half.
*/
var SITED = /* @__PURE__ */ new WeakMap();
function geometryOf(dungeon, roomId) {
	if (!dungeon.blockplan) return void 0;
	let byRoom = SITED.get(dungeon);
	if (!byRoom) {
		byRoom = /* @__PURE__ */ new Map();
		const corridors = new Set(dungeon.stocked.rooms.filter((r) => r.isCorridor).map((r) => r.index));
		const site = siteRooms(dungeon.blockplan, dungeon.graph, { isCorridor: (i) => corridors.has(i) });
		for (const [i, g] of site.geometry.entries()) byRoom.set(dungeon.graph.rooms[i].entityId, {
			geometry: g,
			walls: new Map(g.exits.map((x) => [x.connectorId, exitPhrase(x)]))
		});
		SITED.set(dungeon, byRoom);
	}
	return byRoom.get(roomId);
}
/**
* THE ORDER THE WAYS OUT ARE READ IN.
*
* Three bands, and the reasoning is the same in each: put what the player is
* most likely to be looking for where they will find it without reading.
*
*   1. the way they came in     — where they are, and the way back
*   2. ways to rooms they know  — the ones they can plan a route through
*   3. everything unexplored    — the decisions, at the bottom
*
* Stable within a band: `sort` on an array built in world order leaves ties in
* world order, so a room's exits do not shuffle between turns. Used by the panel
* AND by `renderRoom`, because the referee offering a way out in a different
* order than the player is reading them is how "the second door" stops meaning
* anything.
*/
function byUsefulness(a, b) {
	const band = (e) => e.cameFrom ? 0 : e.toKnown ? 1 : 2;
	return band(a) - band(b);
}
/**
* A way out, as it should be read from the side you are standing on.
*
* Connectors are named for what they are and never for where they go — one
* entity, two ends, and a name that points is wrong from one of them. The
* destination is joined on here instead, correct by construction whichever end
* is being read.
*
* Withheld until the player has been through, because a room's name is a thing
* they learn by arriving. That withholding is why this is the one place the
* label is built: the panel and the referee's prompt must agree about what the
* player is able to name, or the referee will offer them a room they cannot
* ask for.
*/
function exitLabel(e) {
	if (e.surface) return `${e.name} — out of the dungeon`;
	if (!e.toKnown || e.toRoomName === "") return e.name;
	return `${e.name} to ${theRoom(e.toRoomName)}`;
}
/**
* A room name with an article in front, unless it brought its own.
*
* Names are written by the content pass and arrive both ways — "Kennel" and
* "The Long Gallery" out of the same run. Anything building a sentence around
* one goes through here rather than gambling on "the The Long Gallery".
*/
function theRoom(name) {
	return /^(the|a|an)\s/i.test(name) ? name : `the ${name}`;
}
/**
* Everything in the room that owes the player fresh prose. Empty means the room
* can be re-shown exactly as they last read it, with no call at all.
*
* Concealed things fall out of this on their own — hiding something settles its
* description debt, because `composed` is prose for the player and a concealed
* thing owes them none. Revealing it opens the debt again, which is exactly
* when there is somebody to read it.
*/
function needsComposition(run, roomId = run.currentRoomId) {
	const e = run.entities;
	const room = e.rooms.find((r) => r.id === roomId);
	if (!room) return [];
	return [...needsComposition$1(room) ? [room] : [], ...directContents(roomId, e).filter(needsComposition$1)];
}
var ABILITIES = [
	"str",
	"dex",
	"con",
	"int",
	"wis",
	"cha"
];
function characterView(run) {
	const pc = run.pc;
	const registry = run.entities.registry;
	return {
		name: pc.name,
		level: pc.level,
		hp: { ...pc.hp },
		abilities: ABILITIES.map((key) => ({
			key,
			bonus: pc.abilities[key],
			defense: pc.abilities[key] + 10
		})),
		armorDefense: armorDefense(pc),
		meleeBonus: meleeAttackBonus(pc),
		rangedBonus: rangedAttackBonus(pc),
		slots: inventoryStatus(pc),
		inventory: pc.inventory.map((i) => toView(i, run.entities, registry)),
		equipped: EQUIP_SLOTS.map((slot) => {
			const item = heldItem(pc, pc.equipped[slot]);
			return {
				slot,
				item: item ? toView(item, run.entities, registry) : void 0,
				summary: item ? itemSummary(item) : void 0
			};
		}),
		conditions: [...pc.conditions],
		traits: pc.traits
	};
}
armorDefense$1({
	hitDice: 0,
	hp: 0,
	modifiers: {}
});
//#endregion
//#region src/runtime/prompts/dungeon-loop/SKILL.md?raw
var SKILL_default = "---\nname: dungeon-loop\ndescription: Referee one turn of the dungeon crawl at runtime. Use this whenever the player has typed an action in the chat and you need to resolve it against the current room, the player character, and the dungeon. It carries the action-resolution heuristic — the ordered steps for turning \"I search the desk\" or \"I steal the guard's keys\" into a legitimate, consistent outcome — beginning with determining the target of the action. Consult this on every player action, not just complex ones; the heuristic is what keeps player suggestions inside the established fiction.\n---\n\n# Dungeon Loop\n\nThis is the runtime referee for the dungeon crawl. The dungeon was built before play, and the current room has already been composed and read to the player. Your job now is the interactive loop: take what the player types and resolve it, honestly and consistently, against the world as it stands.\n\n## The turn cycle\n\n1. **Present the current room** — already done by room entry; the room's composed prose is what the player just read.\n2. **Await the player's action** — free text in the chat: what they want to do.\n3. **Resolve the action** through the heuristic pipeline below, one step at a time.\n4. **Resolution applies results, takes other creatures' turns, recomposes what changed, narrates the outcome, and checks for death or victory** (the tail of the pipeline).\n5. Return to 2.\n\n## Standing context (always in front of you)\n\nEvery turn, hold these three things in mind. They are ground truth, and they are the yardstick for judging whether anything a player proposes \"reasonably exists.\"\n\n- **The player character** — the full sheet: the six abilities as bonuses (a defense is bonus + 10), HP, level, the eleven traits, current conditions, and inventory as Item entities with slot usage. This tells you what the character can perceive, reach, and carry.\n- **The full current room** — the room entity and everything composed within it: its features, occupants (creatures), items, exits (connectors), effects, and hazards, each with its current state.\n- **The top-level dungeon** — theme, history, and the party's goal.\n\nEstablished fiction means anything written into these: an entity's base or state, the room's composed description, the dungeon's fiction. When you weigh a player's suggestion, you weigh it against this — not against what would be convenient or dramatic.\n\n## The player moves quietly unless they say otherwise\n\nAssume the character is going carefully and quietly — keeping to the wall, easing\ndoors rather than swinging them, keeping their voice down. That is what anyone\ndoes in a place like this, and the player should not have to type it every turn\nto get it.\n\nThey spend the quiet when their words spend it: \"I run down the hall\", \"I kick\nthe door in\", \"I shout to the prisoner\", \"I charge them\". Take those at their\nword — the noise is the point of them — and let the place hear it.\n\nWhat this settles is whether the creatures in a room know the player is there.\nRoom entry decides that on arrival; step 3 decides what it costs to act while\nthey still do not.\n\n## The action-resolution heuristic\n\nAn action is resolved step by step. Each step either **advances** to the next or **bounces back to \"await input.\"** Do not skip ahead, and do not resolve consequences before the earlier steps have cleared the action.\n\n- **Step 1 — Determine the target.** What is the action focused on, and is the player allowed to target it? → `steps/1-determine-target.md`\n- **Step 2 — Determine validity and action type.** Is the action a legitimate attempt, and if so, is it an information or standard action? → `steps/2-validate-and-classify.md`\n- **Step 3 — Handle the action by type.** Resolve the action according to its type. → `steps/3-handle-by-type.md`\n- **Step 4 — Roll confirmation.** For a standard action that needs a roll: confirm, clarify, or renegotiate its terms while it sits on the table waiting to be taken. → `steps/4-confirm-and-roll.md`\n- **Step 5 — Action resolution.** Decide what happened, take other creatures' turns, update state and stats, narrate the outcome, and check for death or the dungeon goal. → `steps/5-resolution.md`\n\nRolls are made two ways, and the difference matters. **The player's roll is made by the interface** — you offer it, they take it, and the result arrives with their next message. **Every other roll is yours**, made through the `roll` tool described at the end of this file. Either way the numbers come from seeded code and never from you.\n\n**You never throw the player's own roll — not by hand, and not through the `roll` tool.** An action of theirs that needs dice *ends your turn*: commit `nextStage: \"roll_offered\"` with the terms as the `rollRequest`, and stop there. They take it when they are ready and you pick the action up again at step 5 with the result in front of you. Resolving it yourself takes the roll out of their hands and tells them the outcome of an attempt they were never asked to commit to — the one move this game cannot make. A roll asked for at one of the player's own bonuses is refused and costs you the round.\n\n## Conventions that hold across every step\n\n- **Rejections never change the world.** If a step turns the action away, do not update any entity state, do not recompose anything. Say what needs saying to the player and return to \"await input.\"\n- **Carry a target record forward.** When a step approves, it hands the next step a compact record of what was approved — the existing entities involved, a part of an entity, or a newly established element. Each step's file defines the record it produces.\n- **Speak to the player only when a step tells you to.** Most of the heuristic is internal reasoning. The player hears from you when a step rejects something, asks them to justify something, or (later) narrates an outcome — not a play-by-play of your deliberation.\n- **Describe only what you were handed.** Atmosphere is yours to invent freely — the cold, the smell, the light, the sound of water somewhere below. Anything a player could *act on* is not: a ledge, a rope, a gap, a body, a door. If it is not in a `base`, a `state`, or a description they have already read, then either you create it properly in the commit or it does not exist. **Ways out are the strictest case of this** — the exits you are given are all the exits there are, and a passage you mention in passing is a passage the player will walk into and find missing.\n- **Describe only where they are.** You are handed the room the player is standing in and nothing else. Rooms they can see the door to, rooms they are about to enter, rooms beyond a grate — you have not been told what is in any of them, and inventing it is how a place gets described twice, differently.\n\n## Ending a turn: the commit\n\n### What the player reads, and what they do not\n\n**The words meant for the player are the `post` field of `commit_state`. Nothing you write outside the tool call is ever shown.**\n\n```\nStep 1: the target is the desk — an existing entity, approved.\nStep 2: valid, and an information action.\nStep 3: a careful look; nothing concealed here rewards it.\n\ncommit_state({\n  post: \"The desk is oak and much older than the room around it. Someone has\n         gone through the drawers already — they hang open, and the papers in\n         them are ruined.\",\n  nextStage: \"awaiting_action\",\n  nextStep:  \"1-target\",\n  diffs: [ ... ]\n})\n```\n\nThis is what lets you work through the heuristic in the open. Reason as loosely as you need to: name the steps, weigh the target, write the records the step files describe. None of it reaches the player, and none of it needs to be tidy. Only `post` is printed, and it is printed exactly as written — so nothing in it should be a heading, a record, or a note about your own process.\n\n**You may change your mind as often as you like.** Draft a paragraph in the open, read it back, decide it is wrong and write another — none of that reaches anyone, because only the field counts. What you must not do is leave the post outside the call: a commit with no `post` is refused and handed back to you, and the turn does not end until one arrives.\n\nWrite the post once, at the end, when you know what happened.\n\n**Its length follows the turn, not a house style.** A room they have just walked\ninto, something genuinely found, a fight turning — those earn paragraphs. An\nunlocked drawer opened, rubble stepped over, a glance at something unremarkable —\na sentence or two, and no apology for it. Padding out the small turns is how the\nbig ones stop reading as big.\n\n### The commit\n\nThe post AND everything that *changes* go out in a single structured call at the very end of your turn: **`commit_state`**. One commit per turn, always — even a turn that changes nothing still commits, to say where the game goes next.\n\n```\ncommit_state({\n  post: \"<the words the player reads>\",\n  nextStage: <what the player's input area should say>,\n  nextStep:  <where the heuristic resumes>,\n  rollRequest: { ... },   // only when nextStage is \"roll_offered\"\n  fictionNote: \"...\",     // only when the turn added to the story of the place\n  diffs: [ ... ]          // the changes, applied in the order you list them\n})\n```\n\n**`post` is required except on two turns**, and both are turns where the prose would be thrown away rather than missing:\n\n- **A room entry.** The room's `composed` is the paragraph the player reads on arrival, so writing it again would be writing it twice.\n- **A commit that moves the player.** The arrival pass runs the moment your commit lands and it is the one that has the new room in front of it. See step 5.\n\n**Write your prose after the dice.** If the turn needs the `roll` tool, call it first — an outcome written before the dice came back is a guess. Roll, read, then write the post into the commit.\n\n### nextStage and nextStep\n\n`nextStage` tells the interface what the game is waiting on. `nextStep` tells it where in the heuristic to pick up when the player answers.\n\n| nextStage | Means | Typical nextStep |\n|---|---|---|\n| `awaiting_action` | open floor, \"What do you do?\" | `1-target` |\n| `clarifying` | you asked them something and need an answer | `1-target` or `4-confirm-roll` |\n| `rejected` | the action won't work; nothing changed | `1-target` |\n| `roll_offered` | a roll is on the table | `4-confirm-roll` |\n| `dead` | the player character is slain | `5-resolution` |\n| `departed` | they walked out of the dungeon | `5-resolution` |\n\nThose six are the whole list. The stages you are not offered — `thinking`, `rolling`, `room_entry`, `resolving`, `error` — are the interface talking about itself while it works, and naming one would leave the player watching a closed input area with nothing running.\n\nTwo rules the interface enforces, so getting them wrong costs you a retry:\n\n- `rollRequest` is present **only** when `nextStage` is `roll_offered`, and is **required** when it is.\n- **`diffs` must be empty when `nextStage` is `clarifying` or `rejected`.** This is the \"rejections never change the world\" rule above, in machine-readable form. A rejected action, an unpersuasive justification, a question back to the player — none of them touch the world.\n\n### The goal, and getting out with it\n\n**Accomplishing the goal does not end the run.** It sets a flag and the player keeps playing, because a treasure in a dead man's hands at the bottom of a hole is not a win. Set `goalMet: true` on the commit for the turn it is achieved. It **latches** — once true it stays true, so you say it once and never have to remember it again. Say it the turn it happens and then stop thinking about it.\n\n**Walking out is what ends the run.** Every dungeon has at least one way to the surface, marked **OUT OF THE DUNGEON** on the \"Ways out\" list of the room that has it. It is a way through like any other: the player has to be in that room and it has to be unblocked. When they step through it, commit `nextStage: \"departed\"`.\n\nYou do not say whether that was a win. Out with the objective done and out without it are different endings, and which one this was is settled from the flag rather than from your recollection of a turn that may have been twenty turns ago. Write the leaving; the interface names the ending.\n\nA departure from a room with no way to the surface, or through one that is blocked, is refused and costs you a retry — walk them to it first.\n\n### When the turn adds to the story of the place\n\nPlay writes fiction. The player asks what the carvings are, and your answer settles\nwho the miners prayed to. A room's description says what the cells were really dug\nfor. That is this dungeon's history now — and in two turns those words are gone.\nThe exchange is cleared when the action closes, the records carry two turns, and an\nentity's `state` holds only what is true of that entity. A fact about the **place**\nhas nowhere to live, so you invent it again later, differently, and the player is\nthe one who notices.\n\n`fictionNote` is where it lives. One line, on the commits that earn it:\n\n```\nfictionNote: \"The cells were cut by the mining company, not the prison — the\ngaol took the workings over after the collapse.\"\n```\n\nIt comes back to you, in order, in front of every later call. From then on it is\nas binding as anything written before the run: build on it, never contradict it.\n\nWhat does **not** go here:\n\n- anything true of one thing in the room — that is its `state`, and `state` is\n  where you and everyone else will look for it;\n- what the player did or what happened this turn — the turn record carries that;\n- a second draft of the narration. One line. If it needs a paragraph it is a\n  description, not a fact about the place.\n\n**Most turns add nothing, and leave it out.** A note every turn is a list of\nnothing, and this only stays useful while everything on it earned its place. A\nturn that changed nothing — `clarifying`, `rejected` — cannot carry one at all:\nthe action was turned away, so nothing was established, and a commit that tries is\nrefused like any other change.\n\n### rollRequest\n\nWhat the player is being offered, and what the interface throws when they take it.\n\n```\n{ kind: \"save\" | \"attack\" | \"stunt\",\n  ability: \"str\" | \"dex\" | \"con\" | \"int\" | \"wis\" | \"cha\",   // saves; melee=str, ranged=wis for attacks\n  bonus: <the player's bonus>,\n  edge: \"none\" | \"advantage\" | \"disadvantage\",\n  description: \"<what they're attempting, in plain words>\",\n  weapon: \"<item id, described object, or 'unarmed'>\",       // attacks\n  mode: \"damage\" | \"stunt\" | null,                           // attacks\n  advantageUse: \"normal\" | \"stunt-and-damage\" | null,        // attacks with advantage\n\n  // --- the difficulty. NEVER RENDERED. ---\n  dc: <the number to meet>,                                  // saves; defaults to 16\n  targetDefense: <the target's defense>,                     // attacks and stunts\n  damage: \"<the weapon's die>\",                              // attacks that deal damage\n  targetId: \"<the entity being acted on>\" }\n```\n\nThe split matters. Everything above the line is **shown to the player**: what they are attempting, what they roll, whether they have an edge. Everything below it is **yours** — the interface holds it, rolls against it, and never puts it on the screen. That is what lets you set an honest difficulty without telling them what it is.\n\nSo a save carries its `dc` and an attack carries the target's `targetDefense` — the conversion between a defense and a number to meet is done for you. What you must never do is *say* either of them, in prose, to the player.\n\n### diffs — how the world changes\n\nEvery change is one diff, and every diff has the same three parts:\n\n```\n{ entityId: \"<whose>\", path: \"<what>\", value: <the new value> }\n```\n\nYou are describing **what is now true**, not the procedure for making it true. Write the destination value and the game works out what that means and does it properly. `{ entityId: \"<player>\", path: \"inventory[1]\", value: null }` says the second thing they were carrying is no longer in their hands — the game clears the slot, closes the gap, and puts the item on the floor of the room they are standing in, reparented and findable. You do not do those three things; you say the one thing.\n\nThe same holds throughout. Put an item's `parentId` to the player and they have picked it up, slots permitting — or write it to `inventory[]`, which says the same thing from the other end and also takes a whole new entity for something they have just found. Put a creature's `roomId` to the room next door and it has fled there. Put a connector's `conditional` to null and the way is open. Put an item's `currentQuality` to zero and it is destroyed and falls out of whatever slot it filled.\n\nFour rules govern every diff:\n\n1. **All or nothing.** The commit is checked as a whole and applied as a whole. One bad diff rejects every diff beside it and you are handed the reasons and asked again. Nothing is ever half-applied.\n2. **Order is preserved.** Diffs run top to bottom. Pick up the key before you unlock the door.\n3. **Ids are quoted, never invented — and an id names one exact object.** Every id must appear verbatim in the room, on the character sheet, or on something you created earlier in this same commit. It refers to *that* thing and nothing else: something the player has just found is a **new entity**, created with `children[]` on whatever holds it, even when something of the same kind already exists somewhere else. The lantern in their pack is not the lantern in the straw. Reaching for a plausible id rather than making one is how a player's own belongings end up described as scenery across the dungeon.\n4. **You never author a number.** Every hit point lost, every point of damage, every die result either came back from the `roll` tool or arrived with the player's own roll. Read it and use it. Do not decide that the ghoul hits for four.\n\nIf a diff is impossible — a shield onto a hand already holding a two-handed weapon, an id that does not exist, a field that cannot be written — you get back a message saying why, and you fix it and commit again.\n\n### What you may and may not change\n\nSome things were settled when the dungeon was written and are fixed forever:\n\n> **Never writable:** an entity's `base`, `name`, `id`, `type`, or `keywords`; a creature's `hitDice`, ability modifiers, or blueprint; an item's `slots` or original `quality`; a connector's endpoints; the player's abilities, traits, level, or maximum hit points.\n\n`base` is a thing's identity — what it *is*, as opposed to how it currently stands. If something has changed so much that its `base` would need rewriting, that is not an edit. That is a new entity: end the old one and create its replacement.\n\nEverything else is yours to move: current hit points, conditions, what is equipped, what is carried, where creatures stand, how many of them are left, what a room and its contents currently look like, whether a hazard has sprung, whether a way through is still blocked.\n\n### state and composed\n\nTwo fields carry the prose of a thing that has changed, and they are written at different moments.\n\n- **`state`** — what is true of it *right now*. The desk is overturned; the ghoul is bleeding from the shoulder; the door hangs off one hinge. No `state` at all means the player has never encountered it.\n- **`composed`** — the player-facing description, rendered from `base` + `state`. It is what the player has actually been told.\n\n**When `composed` and `state` disagree, `composed` wins.** It is the only one of the two the player has read, and going back on what they were told is the worst thing this game can do to them — worse than an inconsistency you quietly absorb. A player who is told there are ledges and then told there are no ledges has stopped being able to trust anything you say, and there is no recovering from that inside a run.\n\nSo: **if a player acts on something that is in `composed` but not in `base` or `state`, it is real.** Do not reject it. Approve it, and in the same commit write it into the `state` of whatever holds it — or create it as an entity, if it is a thing they can pick up or break. It was true the moment you told them; you are only catching the record up.\n\nThat direction is one-way. Something in `base` or `state` that never made it into `composed` has *not* been promised to anyone — the player has not read it, so they cannot act on it until they discover it.\n\n**Write `state` whenever a thing changes. Write `composed` only for what the player can see right now.** Setting `state` automatically marks the thing as needing a fresh description; the description itself is written the next time the player lays eyes on it. A creature that flees two rooms away and bleeds out there gets its `state` written now and its `composed` written whenever the player next walks in on it — there is no point describing a room nobody is standing in.\n\nSo: in a room the player is in, `state` and `composed` travel together, and anything containing the changed thing may need its `composed` rewritten too — overturn the desk and the room may no longer read correctly. Elsewhere, `state` alone.\n\n### Making something new\n\nThe heuristic lets a player act on things that were never written down — the keyring on a guard's belt, a cask in a storeroom you described but never listed. When step 1 approves one of those, it becomes real, and real means an entity.\n\nCreate it by adding it to whatever holds it:\n\n```\n{ entityId: \"<the guard>\", path: \"children[]\", value: {\n    type: \"Item\", name: \"Iron keyring\",\n    base: \"<what it is — fixed identity, nothing that will stop being true>\",\n    state: \"<what is true of it right now>\" } }\n```\n\n**A `name` is a label and starts with a capital.** \"Iron keyring\", \"Unmarked ledger\", \"Wendy Wilberforce\" — not \"iron keyring\". It is set beside the other things in the room card and on the character sheet, where a lower-case entry reads as a mistake. Only the first letter: \"Iron keyring\", never \"Iron Keyring\". The `base` beneath it is a sentence and stays one.\n\nFrom that moment it is an ordinary part of the world: it can be taken, broken, dropped, described. Do not leave a newly established element living only in prose — if the player can act on it, it needs to exist.\n\n**This is the route for anything found by searching**, and the temptation to skip it is strongest exactly when the player already owns something similar. A search of the stables turns up a lantern: that lantern is new, and it is `children[]` on the stall or on the room. It is not the lantern already hanging off the character's pack, no matter how well the id fits.\n\n### The writable paths\n\n| Path | On | Writing it means |\n|---|---|---|\n| `state` | anything | what is true of it now; marks it for a fresh description |\n| `composed` | anything | its description, as the player would read it |\n| `hp.current` | the player | damage or healing; at 0 or below they are dead |\n| `conditions[]` / `conditions[i]` | the player | append a condition, or set one to null to clear it |\n| `equipped.weapon` `.armor` `.helmet` `.shield` | the player | an item id to wear or wield it; null to put it away |\n| `inventory[i]` | the player | null to drop that item where they stand |\n| `inventory[]` | the player | into their hands: an item id to take one that already exists, or a whole new entity to make one on the spot |\n| `parentId` | an item | who holds it now — the player, a room, a creature, a chest; null means it is gone |\n| `currentQuality` | an item | wear and damage; at 0 it is destroyed |\n| `amount` | an item | how much is left — \"4 doses\", \"20 feet\" |\n| `book.uses` | a book | readings it has had, counting up; write what the `consult` roll gives you |\n| `book.exhausted` | a book | true once a `consult` roll says that reading was the last in it |\n| `stats.hp` | a creature | damage or healing; at 0 or below it dies |\n| `count` | a creature | how many of them remain; at 0 the group is wiped out |\n| `activity` | a creature | one line on what it is doing now |\n| `roomId` | a creature or feature | where it is |\n| `roomId` | the player | where they are standing — see below |\n| `roomIds` | a spreading effect | every room it now reaches |\n| `conditional` | a connector | what blocks the way; null means it is open |\n| `isHidden` | anything but a room | whether the player is aware of it; set when you first describe it, false once found |\n| `sprung` / `active` | a hazard | whether it has gone off, and whether it is still going |\n| `children[]` | anything | a new entity belonging to it |\n\n**Moving the player is the one write the world answers back on.** Write the room they are going to and the walk is worked out: the route takes the clearest way through rooms they have already been in, and they end up as far along it as they actually get. A creature in a room on the way, a fire or gas in one, a trap — whether it has gone off or is still waiting — a barred way: each ends the walk there, and the player is standing in front of it. You are told where they stopped. **You are not told they arrived, because they did not.**\n\nThey can only *enter* somewhere new one room at a time, from a way out of the room they are standing in — a route is retracing steps, and there are none to retrace through unfamiliar ground. Name a room with no route to it and the whole commit is refused, because the alternative is the player standing somewhere no corridor reaches, told they walked there.\n\nThe \"Ways out\" list names the far side of every way through they have used. **Take the id from that list**, or from the turn records, which name the rooms they have moved between. Do not work it out from a connector's name — connectors are named for what they are, never for where they lead.\n\n### The dice: `roll`\n\nOne tool, and it takes a **batch**. Everything a turn needs is asked for in a single call, and the results come back together — so a resolution with three creatures in it costs one exchange, not three.\n\n**Never ask this tool for the player's own roll.** Theirs was made by the interface the moment they took it, and arrives already in front of you as the roll result for this turn; one they have *not* been offered yet is not yours to throw either — put it on the table with `roll_offered` and end the turn. What you roll for is everything else: the creatures, the traps, the falling masonry.\n\nThat rule is enforced, not merely asked for. A `save`, `attack` or `stunt` at one of the player character's own bonuses comes back refused with nothing rolled. Two things are never mistaken for theirs: `morale` and `damage`, whatever the number, and an attack aimed at the player's own armour, which is plainly something striking *them*. For anything else that genuinely shares a bonus with them by coincidence — a ghoul with the same +2 saving against a shove — add `actor: \"creature\"` or `actor: \"world\"` and it is taken at your word.\n\nAsk for what you need, giving each one an `id` of your choosing so you can tell the answers apart:\n\n```\nroll({ rolls: [\n  { id: \"ghoul-swings\",  kind: \"attack\", bonus: 2, targetDefense: 12, damage: \"1d6\" },\n  { id: \"second-ghoul\",  kind: \"attack\", bonus: 2, targetDefense: 12, damage: \"1d6\" },\n  { id: \"do-they-hold\",  kind: \"morale\", rating: 7 },\n  { id: \"the-ceiling\",   kind: \"damage\", expr: \"2d6\" }\n] })\n```\n\nThe kinds, and what each returns:\n\n- `{ kind: \"save\", bonus, dc, edge }` — ordinary DC is 16. When a creature is the source of the risk, pass its relevant defense as `defenseAsDc` instead and the conversion is handled. Returns success or failure. Note that `defenseAsDc` wins over `dc` when both are given, so send one or the other.\n- `{ kind: \"attack\", bonus, targetDefense, edge, damage, wellSuited }` — hit or miss, and the damage on a hit, including the extra die on a natural 20 and the extra die for the right weapon against the right enemy.\n- `{ kind: \"stunt\", bonus, targetDefense, edge }` — success or failure. Stunts deal no damage of their own.\n- `{ kind: \"morale\", rating }` — 2d6 against a group's morale, default 7. Whether they hold or break.\n- `{ kind: \"damage\", expr, extraDice }` — damage from something that is not an attack: a fall, a trap, a ceiling coming down.\n- `{ kind: \"consult\", uses }` — the player reads a book. Pass its **current** `book.uses`, which is 0 for one nobody has opened; the reading is added for you. Comes back saying whether there is more in it, and giving you the two numbers to write. **The reading always happens** — this decides whether the book has anything left afterwards, never whether the player learns something now.\n\n`edge` is `\"none\"` unless you have a reason. All seeded and deterministic; you never supply a result, and you never state a number that did not come back from this tool.\n\n**Ask for everything at once, then decide.** It costs nothing to roll for a creature and then not use it — a morale check you did not end up needing is a rounding error, and going back for a second batch is a whole extra exchange. Roll wide, then narrate.\n\nA natural 20 on an attack costs the defender's armour a point of quality; a natural 1 costs the attacker's weapon a point. The roll tells you it happened — you write it as a `currentQuality` diff.\n";
//#endregion
//#region src/runtime/prompts/dungeon-loop/steps/1-determine-target.md?raw
var _1_determine_target_default = "# Step 1 — Determine the target of the action\n\n## Purpose\n\nBefore anything can be resolved, find the **target**: the thing the player is asking about or attempting to act upon. Then decide whether the player is allowed to target it. This step *only* identifies and validates the target — it does not resolve what happens to it. That comes later.\n\nGauge the general focus of the action. If the player says \"I search the writing desk,\" the target is the desk. If they say \"I throw a torch at the gathered rats,\" the target is the swarm of rats. Strip the action down to what it is aimed at.\n\n## What can be a target\n\n- **An existing entity** — a room feature they want to inspect, a creature they attack, an item they pick up.\n- **A constituent part of an entity** — something named in an entity's description or state but not modeled as its own entity: the keyring noted on a guard's belt, a single rat within a Horde, a carving on a wall that never became its own entity.\n- **Multiple entities as a whole** — a knot of creatures caught in one spell, three torches doused at once.\n- **Something that plausibly exists but has no entity yet** — a cask of wine the player takes from a storeroom you described but never enumerated.\n\n## Decide by where the target comes from\n\nWork through these in order. The first that fits decides the outcome.\n\n### A. It is already there → approve automatically\n\nApprove with no questions, and advance, when the target is:\n\n- **An existing entity the player is aware of.** \"Aware of\" means they have perceived it. A concealed thing they have not yet discovered is *not* a valid named target — but note that an action like \"I search the shelves\" validly targets the shelves (an existing entity); whether that turns up the hidden thing is resolved in a later step, not here.\n- **A part of an entity's description or state**, even without its own entity: the individual rat in the Horde, the keyring the guard's state says hangs at his belt, the loose flagstone mentioned in the room.\n- **Anything the player has been told about**, whether or not you can find it in a `base` or a `state`. If it is in a `composed` description they have read, it is established and it is theirs to act on — see \"state and composed\" in the skill. Approve it, and record that its `state` needs catching up.\n\nThese are free to target. Record the target and move on.\n\n> **You may never reject something on the grounds that a thing you already described is not there.** The room's description is your own words, and the player believing them is not a mistake they made. If your description mentioned ledges and the current state does not, the ledges are real and the state is behind — fix the state. This is the single most damaging thing you can get wrong: it makes the world unreliable, and a player who cannot trust the description cannot play.\n\n### B. It is not there yet → judge whether it reasonably could be\n\nThe player may propose a target that is neither an entity nor part of any entity's description. Allow it **only if it is something that could reasonably be expected to exist given the current state of the fiction.**\n\n**Approve and incorporate** when it follows naturally from what is established:\n\n> The guard's state never mentioned keys, but a guard standing watch over cells could reasonably carry them. → Reasonable. Treat the keys as true from now on, record them as a newly established element on the guard, approve, advance.\n\n**Reject** when it does not fit — because the thing wouldn't have it, because it is unfounded, or because it contradicts established fiction:\n\n> The figure is another prisoner, not a guard. A fellow prisoner would not be holding your cell keys. → Reject.\n\n> The player wants to lift a magical artifact off the guard. Nothing establishes one, and it is a large unearned gain. → Reject.\n\n> The fiction already states a *different* guard, down the hall, carries the keys. → Direct contradiction. → Reject.\n\n**To reject:** tell the player plainly that the element doesn't exist, say *why* it was rejected, and ask them for a different course of action. Do not update any state. Return to await input.\n\n### C. On the fence → ask them to justify\n\nIf you are genuinely unsure whether the proposed element fits, **or** it is plausible but would hand the player a significant advantage or benefit, don't simply wave it through. Ask the player to justify why that element would be present. Phrase it as a request for *their* reasoning, not a yes/no:\n\n- \"Why do you think this guard would have the keys to your cell specifically?\"\n- \"How do you know there's poison in the pantry?\"\n- \"What makes you think that this wall is weak enough to be broken?\"\n\nThen wait for their answer, and judge it against the established fiction:\n\n- **Sound reasoning that connects one or more existing details of the fiction to their claim → approve, incorporate, advance.** The connection to established detail is the bar. \"The room description said the guard was drunk and slumped over — he'd never notice me lifting his keys\" leans on something real. A confident assertion that hangs on nothing already in the fiction does not clear it.\n- **Otherwise → gently tell them you are not persuaded**, and ask for a different action. Return to await input; change nothing.\n- **If they say they don't know, or want to take the suggestion back → tell them to propose a different action instead.** Return to await input.\n\n## Movement: the target is a way out, and it must be the right one\n\nWhen the player is going somewhere, the target is **the connector they leave by** — not the room they name. Take it from the \"Ways out\" list, which gives you, for each one: what it is called, what it physically is, and the room on the far side, named whenever they have been there.\n\nMatch their words to that list, and be strict about what counts as a match:\n\n- They name a way out, or describe it unmistakably (\"the iron door\", \"the stair down\") → that connector. Approve.\n- They name a room, and **exactly one** way out leads there → that connector. Approve.\n- They say \"back\", \"back the way I came\", \"out\" → work it out from the previous turns' records, which name the rooms they moved between. If those settle it beyond doubt, approve. If they do not, ask.\n\n**If you cannot settle it, ask — every time.** Two ways out could serve, the room they named is not on the list, \"back\" is ambiguous, they named somewhere they have not been and you are guessing which direction it lies in: all of these are questions, not judgement calls. Put the options to them in the words the list uses:\n\n> \"Two ways lead out of here — the ascending passage to the Torture Room, and the mirrored corridor to the Laboratory. Which do you take?\"\n\n> \"There's no way out of this chamber that leads to the Well directly. The corridor to the Laboratory goes back toward it — do you want to head that way?\"\n\nThis is cheap and being wrong is not. A move you guessed at puts the player in a room they did not choose and had no way to refuse, and by the time they find out, they are standing in it. **Never infer a destination from a connector's name** — connectors are named for what they are, never for where they go, and the far side is only what the \"Ways out\" line says it is.\n\n### Going somewhere further off\n\nA room they have already been in can be named directly, however far away it is — \"I head back to the Well\" is one action, not four. Write its id and the walk is worked out for you: the route is drawn through rooms they have been in, and they end up as far along it as they actually get.\n\n**They may not get all the way, and that is not a failure to correct.** A creature standing in a room on the route, a fire or gas filling one, a trap in one — whether it has gone off or is still waiting — a way that is barred: any of these ends the walk there, and the player is left in front of it. You will be told where they actually stopped, and a trap they stopped in front of has **not** sprung. Do not narrate the journey as though it completed, and do not go looking for a way round: the route already took the clearest one there was.\n\nSomewhere they have **never** been is different — they can only step into it, one room at a time, from a way out of the room they are standing in. There is no route through unfamiliar ground, because retracing steps is what a route is.\n\n## Incorporating a newly established element\n\n**Know why it is there.** Anything you make real belongs to this dungeon, not just to the sentence that asked for it. Ordinary things need no explaining — a gaoler has keys, a storeroom has casks, a barracks has bedding. Something stranger does: if you are approving a thing that would make a player standing in front of it ask *what is that doing here*, the answer is part of what you write into it. Being unable to supply one is a sign the thing should have been rejected in B.\n\nWhen you approve something from **B** or **C** that wasn't already in the fiction, treat it as true from here on so the world stays consistent. **Do not rewrite entity state in this step** — creating the entity and updating its holder belong to later steps. Just record the new element on the target: what it is, and which entity (or the room, if it belongs to nothing) it hangs off, so the steps that follow can realize it.\n\n## Output of this step\n\n**On approval**, hand the next step a target record. Shape is illustrative — keep these facts:\n\n```json\n{\n  \"outcome\": \"approved\",\n  \"summary\": \"the keyring on the guard's belt\",\n  \"scope\": \"part\",\n  \"entities\": [\"<guard-entity-id>\"],\n  \"part\": \"iron keyring at his belt\",\n  \"newElement\": {\n    \"description\": \"a ring of iron keys\",\n    \"attachTo\": \"<guard-entity-id>\",\n    \"needsEntity\": true\n  }\n}\n```\n\n- `scope` is one of `\"entity\"` (an existing entity), `\"part\"` (a part of one), `\"multiple\"` (several entities as a whole — list them all in `entities`), or `\"new\"` (a newly established element that belongs to no existing entity — `attachTo` is then the room id).\n- `entities` holds the ids of every existing entity the target maps to.\n- `newElement` is present only when something was newly established in B or C; omit it otherwise.\n\n**On rejection, or a justification you were not persuaded by, or a retraction**, produce **no advancing record.** Deliver the player-facing message the branch called for (why it was rejected / that you are not persuaded / a request to propose a different action) and return to await input. No state changes.\n\n## Worked examples\n\n**Existing entity.**\nInput: \"I open the iron chest in the corner.\" (an Item/feature entity in the room)\n→ Existing entity the player perceives. Approve. `scope: \"entity\"`, `entities: [chest-id]`. Advance.\n\n**Part of a description.**\nInput: \"I grab the keyring off the guard's belt.\" (guard's state mentions the keyring; it has no entity of its own)\n→ Part of an entity's description. Approve. `scope: \"part\"`, `entities: [guard-id]`, `part: \"keyring at his belt\"`. Advance.\n\n**Multiple entities as one.**\nInput: \"I sweep my flaming brand across all three ghouls.\" (three creature entities present)\n→ Multiple entities as a whole. Approve. `scope: \"multiple\"`, `entities: [ghoul1, ghoul2, ghoul3]`. Advance.\n\n**Reasonable new element — approve and incorporate.**\nInput: \"I take the guard's keys.\" (guard on cell duty; keys never mentioned)\n→ Not established, but reasonable for a cell guard. Approve, record the keys as a new element on the guard. `scope: \"new\"` / `newElement.attachTo: guard-id, needsEntity: true`. Advance.\n\n**Unreasonable — reject.**\nInput: \"I take the guard's magic sword of flame.\" (no magic sword established anywhere)\n→ Unfounded and a large unearned gain. Reject. Tell the player there is no such sword and ask for a different action. No state change.\n\n**Contradiction — reject.**\nInput: \"I take the keys off this guard.\" (fiction already says the keys are held by a different guard down the hall)\n→ Contradicts established fiction. Reject, explaining the keys aren't on this guard. No state change.\n\n**On the fence — justified, approve.**\nInput: \"I quietly slip the keys off his belt while he's not looking.\"\n→ Plausible but a big advantage. Ask: \"What makes you think you can lift them unnoticed?\" Player: \"The room said he's slumped and snoring drunk.\" → Connects to established detail. Approve, incorporate. Advance.\n\n**On the fence — unpersuasive, bounce.**\nInput: \"There's a secret lever behind the throne, I pull it.\"\n→ Ask: \"Why do you think there's a lever there?\" Player: \"Throne rooms always have them.\" → Hangs on nothing in this fiction. Gently decline, ask for a different action. No state change.\n\n**Retraction.**\nPlayer, after being asked to justify: \"Eh, never mind, I don't actually know.\"\n→ Tell them to propose a different action instead. Return to await input.\n";
//#endregion
//#region src/runtime/prompts/dungeon-loop/steps/2-validate-and-classify.md?raw
var _2_validate_and_classify_default = "# Step 2 — Determine validity and action type\n\nStep 1 settled *what* the action is aimed at and approved the target. Now judge whether the action itself is legitimate, and if so, what kind of action it is. This step consumes the approved target record from step 1.\n\n## Determine whether the action is valid\n\nThe action is valid if it is something the player could reasonably do — or attempt to do — to the target, with **at least some plausible chance of success.** The bar is a *plausible attempt*, not a likely one: long odds are fine, zero odds are not.\n\nJudge plausibility from the player's vantage. **Factors the player could not know do not lower the plausible chance of success.** A lock that is secretly rusted shut, a guard who secretly cannot be bribed, a floor that is secretly rigged — none of these make the attempt invalid. They get resolved when the action plays out, and the attempt may simply fail then. What the player *does* know — everything in the established fiction — does constrain them.\n\n### An action is invalid when any of these is true\n\n- **It isn't the player's own action.** The player controls their character and nothing else. Narrating what another creature does, or what the world does on its own, is not an action they can take. \"The guard wanders off,\" \"it starts to rain,\" \"my torchbearer charges in\" (when no such ally is established) — invalid. **One exception:** a chat input that reads as an open question — no action by anyone, just asking for information the character might know or perceive about their surroundings — is accepted, and classified as an **information action** (below).\n- **It relies on another creature doing something they wouldn't reasonably do.** The player may *attempt* to influence a creature — persuade, threaten, deceive, distract — and that attempt is valid; the creature's response is judged later. But an action that *presumes* the response, or only works if the creature acts against its own nature, is invalid. \"I hold out my hand and the guard gives me the keys\" presumes a hostile guard's cooperation → invalid. \"I try to convince the guard I'm his relief so he'll hand over the keys\" is a valid attempt.\n- **It contradicts the established fiction.** An action with no plausible chance *because of what the player already knows.* \"I lift the one-ton portcullis the room described, bare-handed,\" or \"I fly across the chasm\" with no established means of flight → invalid.\n\nWhen the action is invalid, tell the player it isn't valid, briefly say why, and ask them to choose a different action. Change no state. Return to await input.\n\n## If valid, determine the action type\n\nThere are two types. Classify by the action's **primary purpose**:\n\n1. **Information** — a no-risk, no-stakes action whose primary aim is to get information about something in the fiction. Two forms: cursory inspection of a target (\"look at\", \"examine\", \"watch\"), and open questions about the world (\"What do I know about the Worm cult?\", \"What can I hear beyond the door?\"). Check this first: \"I look at the guard\" is an information action, and \"I peer through the doorway into the next room\" is information, not movement — the player is gathering information, not acting on the world. An inspection that would need a risky method, trip a hazard, or provoke a creature is *not* this type — that carries stakes, so it is a standard action.\n2. **Standard** — everything else the player actually *does* to the world: picking a lock, drinking a potion, shoving a statue, swinging a sword at a ghoul, stepping through a doorway into the next room, persuading a guard. Attacks and moving between rooms are ordinary standard actions; they are not special-cased.\n\nWhen it is unclear, decide by what the player is *chiefly* trying to do: to learn (information) or to act on the world (standard).\n\n## Output of this step\n\nOn success, extend the target record from step 1:\n\n```json\n{\n  ...target record...,\n  \"valid\": true,\n  \"actionType\": \"information\" | \"standard\"\n}\n```\n\nOn an invalid action, produce no advancing record: deliver the \"not valid, here's why, choose another action\" message and return to await input. No state changes.\n\n## Worked examples\n\n- \"I examine the runes above the arch.\" → valid; **information**.\n- \"I peer through the barred window into the next cell.\" → valid; **information** (gathering information, not acting).\n- \"I swing my mace at the skeleton.\" → valid; **standard** (an attack is a standard action).\n- \"I step through the western doorway.\" → valid; **standard** (moving between rooms is a standard action).\n- \"I try to pry the gem from the idol's eye with my dagger.\" → valid (a plausible attempt, long odds are fine); **standard**.\n- \"I pick the lock on the chest.\" — unknown to the player, the lock is rusted solid. → still **valid**; the hidden factor doesn't remove the plausible attempt (it may fail later); **standard**.\n- \"I command the ogre to kneel and it obeys.\" → **invalid**: relies on a creature doing something unreasonable / presumes the response. Ask for a different action.\n- \"The portcullis rises and I stroll under it.\" → **invalid**: not the player's own action / presumes a world event. Ask for a different action.\n- \"I leap the twenty-foot chasm the room described in a single bound.\" → **invalid**: contradicts what the player already knows; no plausible chance. Ask for a different action.\n";
//#endregion
//#region src/runtime/prompts/dungeon-loop/steps/3-handle-by-type.md?raw
var _3_handle_by_type_default = "# Step 3 — Handle the action by type\n\nA valid action arrives here carrying its `actionType` from step 2. Dispatch to the matching handler. Each handler resolves the action on its own terms — updating state, recomposing what changed, presenting the result to the player, and returning to await input when the action completes (or bouncing back to await input if it turns the player away).\n\n- **information** → `steps/3-information.md`\n- **standard** → `steps/3-standard.md`\n";
//#endregion
//#region src/runtime/prompts/dungeon-loop/steps/3-information.md?raw
var _3_information_default = "# Step 3 · information action\n\nAn information action has no risk or stakes; the player is only trying to learn something. Two forms arrive here — an open question about the world, or an inspection of something present. Resolve whichever fits.\n\n## A. An open question about a general fact of the world\n\nThe player asks about the world at large rather than a thing in front of them — lore, history, a name, a rumor, whether something is a known danger. (\"What do I know about the Worm cult?\", \"Is red moss like this poisonous?\")\n\nDecide whether the player's character, from their own fiction — their traits, their background, and anything they have lived through in this dungeon — would reasonably know anything about it.\n\n- **If they would:** tell them what their character knows. Then update the state of anything the new knowledge bears on — often nothing, but sometimes it recontextualizes an entity the party has already seen. *(This part of the system may change later.)*\n- **If they wouldn't:** tell them their character doesn't know anything about it, and ask them for a different course of action. Change no state. Return to await input.\n\n## B. Examining or asking about something present\n\nThe player inspects, or asks about, something they can see or have already encountered. Work out what the character perceives, at one of two depths:\n\n- **Cursory inspection** — what is immediately apparent, plus anything that could reasonably be gleaned by simple, low-effort means **that wouldn't trigger a hazard or provoke a serious reaction from any creature present.** Cursory covers reasonable minor moves: stepping closer, picking the thing up, rapping on it, trying a doorknob, skimming part of a book.\n- **Directed inspection** — if the player names a particular *method*, a specific *element* they are studying closely, or something specific they are *looking for*, you may reveal things a cursory glance would miss — including details that were held back as mere clues — **as long as their method and focus are reasonably on track.** An apt, specific approach is rewarded; a scattershot or wrong-headed one turns up only what cursory inspection would.\n\nThis is the found side of the hidden-as-clue rule from room entry: a directed look along the right track turns a clue into the thing itself. A hidden thing surfaced this way is now discovered — set its `isHidden` to false, update its state to say what the player has just uncovered, and write its `composed` for the first time. Room entry deliberately left that blank, because until now there was nobody who could see it.\n\n## C. Consulting a book\n\nA book they are carrying can be opened at any time, as an action, and asked about anything in their situation. It is not a search of the room and not a check against their character's own learning — it is a written authority on one subject, and the whole of what makes it worth carrying is that it knows things the character does not.\n\n**Judge relevance generously.** The subject is a heading, not a boundary. A book on *Monsters* can say what a thing in the next room probably is, what it eats, and what has historically been used to kill it; one on *Lost places* can speak to who dug these halls and what they were digging for; one on *Theology* can read an altar, name a god by its symbols, and say what that god was owed. If a reasonable scholar of that subject would have written a sentence bearing on what the player asked, the book has it. **Then stop short of the absurd** — a cookbook does not know the password, and a book of love poems has nothing to say about the trap mechanism. When the connection will not hold, say what the book *does* cover and let them choose again; that costs them nothing and no reading is spent.\n\n**Make the answer worth the action.** Give them something they can act on — a name, a weakness, a practice, a reason — not a paragraph confirming what they already know. This is one of the few places the dungeon will tell the player something true without making them bleed for it, and a book that answers in generalities is a book nobody opens twice.\n\nThen find out whether the book had anything more in it, by rolling:\n\n```\nroll({ rolls: [{ id: \"the-herbal\", kind: \"consult\", uses: 2 }] })\n```\n\n`uses` is that book's **current** `book.uses` — 0 for one nobody has opened. The roll comes back with the two numbers to write: `book.uses` always, and `book.exhausted` when that reading was the last of it. **The answer you just gave stands either way.** The die decides only whether the book can be opened again, so roll it after you know what the book says, and never treat a spent book as a failed reading.\n\nA book already carrying `exhausted: true` has been read to the end. Say so plainly — they have had everything it holds — and turn the action away without a roll and without a diff.\n\n## In every case where information is delivered\n\nUpdate the state of every entity the new information affects — a revealed detail, a false bottom found, a hidden feature now discovered — and generate new composed prose for each (the same base + state → composed rendering used on room entry), so the world stays consistent from here on. Changing an entity's state flags it and its containers for recompose, so a detail found on a desk can also update the room's description.\n\nThis step is where the dungeon's own story most often grows: an answer about the lore, the carvings, the faction, what a place was built for, is an answer that becomes true the moment you give it. When what you have just told the player is a fact about the **dungeon** rather than about a thing in the room, carry it on the commit as a `fictionNote` — one line, see the skill — so the next twenty turns are told the same thing you just were.\n\nThen present the information to the player in a post.\n\n**And if a book they are carrying bears on what they just asked, say so.** Not as a correction and not instead of answering — answer first, out of whatever the character themselves knows, and then add the line: they are carrying a book on this, and it may have more. The player cannot be expected to hold their own inventory in their head against every question they think to ask, and a book that goes unopened for a whole run because nobody remembered it was there is a book that may as well not have been written. Same generous reading of relevance as above, and the same limit: if the connection is a stretch, leave it unsaid.\n\nThat completes the action. Wait for the player's next chat input.\n";
//#endregion
//#region src/runtime/prompts/dungeon-loop/steps/3-standard.md?raw
var _3_standard_default = "# Step 3 · standard action\n\nA standard action is anything the player actually *does* to the world — including attacks and moving between rooms. Resolve it in two parts: decide whether it carries risk and stakes, then either let it simply happen or set up the roll it needs.\n\n## The player's intent shapes the *how*, not the result\n\nThe player may say what they are trying to accomplish, or what they would like to happen. Take that into account for **how** the character goes about the action — their approach, their aim, what they concentrate on. They do **not** get to dictate the result. The outcome is always a clean determination of what the player character is actually capable of doing. A stated wish never becomes a guaranteed effect.\n\n## Determine risk and stakes\n\nAsk two things, and require **both**:\n\n- Is there a **significant chance the action could fail?**\n- Would failure carry an **appreciable consequence?**\n\nIf both are true, the action has stakes. A negligible chance of failure, or a failure that costs nothing worth noting, means no stakes.\n\n- **No risk or stakes → let it happen.** The action simply succeeds, as the character's capability dictates. Carry it forward to resolution with no roll. *(Resolution — applying the outcome and narrating it — is the next step.)*\n- **Risk and stakes → the action requires a roll.** Set it up as below, present the confirmation post, and put the roll on the table. **The roll is theirs to take; your turn ends when it is offered.**\n\n### Judge the risk from the page, never from what might be there\n\n**Both questions are asked of what you were handed** — the room, its contents, their `state`, what the player has already been told. A risk you have to invent in order to find is not a risk; it is you writing the danger and then charging for it.\n\nIf you catch yourself reaching for a difficulty and thinking *I have not decided what is in there yet, but there could be something* — stop. There is nothing there. **You cannot set a number against a threat you have not been given.** A creature you have not been handed sets no defense, and \"the room is unexplored\" is not a hazard; it is the ordinary condition of a dungeon. What is waiting beyond a door is the arrival pass's business, not yours, and it will handle it.\n\nThe same holds for what the player is worried about. A player who says \"I sneak in\" is telling you *how* they go — carefully, quietly — not asking you to find something for them to fail against. Their caution shapes the description. It does not manufacture stakes.\n\nSo: **moving between rooms is auto-success**, unless something you can point to on the page makes it otherwise — a creature that has noticed them and would move to stop them, a way out you were told is blocked or unstable, a hazard already sprung, a condition the player is carrying. Point at it, or let them walk. A creature that has *not* noticed them is the next section's business, not this one's.\n\n## Acting in a room that has not noticed you\n\nRoom entry settled whether the creatures here know the player is there, and the\nanswer is written in their `activity`. While they are unaware, the player is\nholding something real, and this step is where it gets kept or spent.\n\n**Going back the way they came is auto-success.** Withdrawing through the way they\nentered by, from creatures who have not noticed them, is the one thing an\nunnoticed person can reliably do. Let them go. Where you can point at something on\nthe page that genuinely complicates the withdrawal — one of them standing between\nthe player and it, a floor of broken glass the description already mentions, a way\nout you were told is stuck — it becomes a Dex save **with advantage**. Not a flat\none. The default is still that they get out.\n\n**Anything else is a Dex save to stay unnoticed.** Crossing the room, lifting\nsomething off a table, working a lock, leaving by a different way, getting a close\nlook at the thing they came for: while the room is unaware, the question is not\nwhether the act works. It is whether it is seen. So the action's roll is a Dex\nsave, and it is the *only* roll — one action, one roll, and this is it.\n\nIf the act would carry stakes even in an empty room — a lock genuinely beyond\nthem, a jump that could turn an ankle — it is still one roll, not two. Pick the\nability the harder half turns on, and let a failure carry both halves: they\nfumbled it *and* the room heard.\n\nFailure here means something particular, and step 5 knows it: not that the lock\nbeat them, but that something looked up. Frame the roll in those terms when you\npresent it.\n\nNone of this applies to creatures that already know they are there. The quiet is\nspent; judge the action for stakes like any other.\n\n## Set up the roll\n\nDetermine which roll the action calls for.\n\n### Attacking an enemy in open combat → an attack roll\n\n- **Bonus** — melee attacks use the character's **Strength** bonus; ranged attacks use their **Wisdom** bonus.\n- **Weapon** — work out what they strike with: an item in their inventory, something in the environment close enough to snatch mid-fight, or their bare hands. If the input makes it clear, settle it now, since it decides melee vs ranged and therefore which bonus applies. If it is ambiguous, leave it to be clarified.\n- **Target number** — the enemy's defense. Never revealed to the player.\n- Two more things must be settled before the attack can be rolled. They don't change the setup, but flag them for the player: whether they strike to **deal damage** or to attempt a **stunt** (per the Knave rules), and — if they have advantage — whether they will spend it the normal way (roll 2d20, drop the lowest) or instead to **both perform a stunt and deal damage** on a hit.\n\n### Anything else with stakes → a save\n\n- Choose the ability the save is rolled with according to the Knave rules — the ability whose domain matches the threat:\n  - **Strength** — resisting force, breaking free, holding ground, heaving something heavy.\n  - **Dexterity** — dodging, leaping, balancing, anything about speed and precision of the body.\n  - **Constitution** — enduring poison, disease, cold, exhaustion, or other bodily strain.\n  - **Intelligence** — seeing through illusion or trickery, recalling or reasoning under pressure.\n  - **Wisdom** — resisting fear, noticing danger in time, holding one's nerve or focus.\n  - **Charisma** — resisting charm or domination, holding sway in a clash of wills.\n- **Target number (DC)** — if the primary source of the risk is a creature, use that creature's **defense for whichever ability best matches how it threatens the player.** Otherwise the DC is **16.** Never revealed to the player.\n\nThen gauge **advantage or disadvantage** per the game rules: advantage when the character's approach, position, or a fictional edge clearly favors them; disadvantage when the environment, circumstances, or a fictional handicap work against them; neither when it is an even attempt.\n\n### Pay for what they set up\n\nAdvantage is how this game pays for thinking, and it should be paid readily. A\nplayer who did something earlier and is now *using* it has earned it: they put the\nlamps out two turns ago and are crossing the room now, they wedged the door before\nstarting the fight, they read that the thing feeds on carrion and brought some. So\nhas a player whose approach is simply better than the obvious one — going at it\nsideways, turning a feature of the room into a tool, using a creature's own habit\nagainst it.\n\nPay it at the level that fits what they actually did:\n\n- a good idea, or a small piece of preparation → **advantage**;\n- preparation that genuinely takes the risk out of it → **no stakes at all**; let\n  it happen, per the top of this step;\n- where what ought to be bigger is the *outcome* rather than the odds — more\n  carried off, a creature out of the fight rather than merely hurt — that is step\n  5's to give. Note it in the record and let resolution spend it.\n\nThe bar is that it leans on something real: an earlier action of theirs, a detail\nof the room, something established about the target. Confidence on its own is not\nsetup and buys nothing.\n\n## Present the confirmation post\n\n**This post is the terms of the bet, stated before it is taken.** It stops at the moment of attempt — the instant *before* the hand closes on the thing, the blade starts to move, the foot leaves the ledge. Nothing in it has happened yet. So do not write the attempt, do not write what it disturbs, and do not write how it comes out: the dice have not been thrown, and prose the player has read is prose the game is committed to. Narrating the attempt is step 5's, once there is a result to narrate.\n\nTell the player, in a post:\n\n- **what they are about to attempt** — the action confirmed in the fiction, and what makes it uncertain;\n- **where an edge came from, whenever there is one.** The screen prints `ADVANTAGE` or `DISADVANTAGE` as a bare word; only you know what bought it. Name the thing in the fiction it came from — the lamps they put out two turns ago, the door they wedged, the wet stone underfoot, the arm they are favouring. A player who cannot see that their preparation paid stops preparing, and one who cannot see where a disadvantage came from cannot argue it away or do something about it. This is the other half of the rule below: a factor worth naming is worth advantage, and an advantage worth giving is worth naming.\n- **why this ability, unless it is obvious** — and it usually is. A leap is Dexterity and a heaved portcullis is Strength; saying so is noise. But where the fit is a judgement, a clause settles it: Wisdom to hold their nerve rather than Dexterity to move faster, Intelligence rather than Charisma against a thing that is arguing in bad faith, Constitution because what threatens them is the cold and not the climb. It tells the player what kind of attempt you have understood this to be, which is what lets them say \"no, I meant —\" before the dice rather than after.\n- **for an attack, whatever is still open**: the weapon, whether they strike to deal damage or to attempt a stunt, and — if they have advantage — how they mean to spend it.\n\n**The values are the screen's; the reasons are yours.** The interface prints the offer directly beneath your post, built from the `rollRequest` you commit — `DEX SAVE · +3 · ADVANTAGE`, and `description` as the line above the Roll button. So the numbers and the labels want no restating: \"Make a Dexterity save — DC 16. Roll 1d20+3\" is a sentence the screen has already written, without the leak and without the chance of disagreeing with itself. What the screen cannot say is **why** — what bought the edge, why this ability and not another, what makes the attempt uncertain at all — and that is what the post is for. If the offer is missing something the player needs in order to decide, it belongs in the `rollRequest`, never in a second copy of it.\n\n**Never show the difficulty of the roll** — not the DC, not the target's defense. You may say in plain terms that something looks like a long shot, and you may name what is working against them; never the number.\n\n**Do not name anything working *for* them unless you are giving them advantage.** \"The hasp is half eaten with rust\", \"you have the higher ground\", \"it is favouring the leg you opened\" — a player reads any of those as the roll being softened, and if the roll was not softened you have quietly told them the difficulty is lower than it is. So the rule is: if a factor is worth mentioning, it is worth advantage. If it is not worth advantage, leave it out and let the odds speak for themselves. **And it binds in both directions** — the factor you did pay advantage for is the one you must name, per the post's second bullet. Naming without paying misleads them; paying without naming hides the fact that thinking works.\n\n## Then end the turn on it\n\n**You do not roll this. Not now, and not with the `roll` tool — not ever.** The dice for the player's own attempt are thrown by the interface when *they* take it. Your job was to settle the terms; having settled them, get out of the way.\n\nSo the turn ends here. Commit `nextStage: \"roll_offered\"` and `nextStep: \"4-confirm-roll\"`, carrying the roll as the `rollRequest`, and change no state — nothing has happened yet. The player takes it, or argues with it, and either way the action reaches you again with the result already made.\n\nRolling it yourself would hand them the outcome of something they never agreed to attempt. The `roll` tool refuses a save or an attack made at one of their own bonuses for exactly this reason, so reaching for it here costs you the round as well as the point.\n\n## Output of this step\n\n**No stakes:**\n\n```json\n{ ...action record..., \"stakes\": false, \"resolution\": \"auto-success\" }\n```\n\nHand this to resolution (next step); no confirmation post.\n\n**Stakes — save:**\n\n```json\n{\n  ...action record...,\n  \"stakes\": true,\n  \"roll\": {\n    \"kind\": \"save\",\n    \"ability\": \"str\" | \"dex\" | \"con\" | \"int\" | \"wis\" | \"cha\",\n    \"bonus\": 0,\n    \"edge\": \"advantage\" | \"disadvantage\" | \"none\",\n    \"dc\": 16\n  }\n}\n```\n\n**Stakes — attack:**\n\n```json\n{\n  ...action record...,\n  \"stakes\": true,\n  \"roll\": {\n    \"kind\": \"attack\",\n    \"bonus\": 0,\n    \"edge\": \"advantage\" | \"disadvantage\" | \"none\",\n    \"targetDefense\": 0,\n    \"weapon\": \"<inventory item id | described environment object | unarmed> | null\",\n    \"mode\": \"damage\" | \"stunt\" | null,\n    \"advantageUse\": \"normal\" | \"stunt-and-damage\" | null\n  }\n}\n```\n\n`bonus` on an attack is the STR bonus (melee) or WIS bonus (ranged). `weapon`, `mode`, and `advantageUse` may be `null` when still to clarify — the next step settles them before the attack is rolled (`advantageUse` applies only when `edge` is `advantage`). `dc` and `targetDefense` are internal; never shown.\n\nThat record goes out verbatim as the commit's `rollRequest`. Present the confirmation post, commit it with `nextStage: \"roll_offered\"`, and stop.\n";
//#endregion
//#region src/runtime/prompts/dungeon-loop/steps/4-confirm-and-roll.md?raw
var _4_confirm_and_roll_default = "# Step 4 — Roll confirmation\n\nThe player has been shown what the roll will be (the standard-action confirmation post). Now handle their response. Loop here until they either **cancel** or **take the roll** — nothing is rolled and nothing changes until then.\n\n**You do not roll this one.** The dice for the player's own roll are thrown by the interface, not by you: you settle the terms and put them on the table as a `rollRequest`, the player takes it when they are ready, and the result comes back to you at step 5 already made. Your job in this step is to get the terms right and then get out of the way.\n\n## Read the player's response\n\nThe player's message will be one of:\n\n- **taking the roll** — but note that this usually reaches you as the *result*, not as a message: if they simply pressed the button, the next thing you see is step 5 with the dice already thrown;\n- a **cancellation** / abandoning the action,\n- for an attack, a **clarification** of an outstanding detail,\n- an **adjustment or negotiation** for a better roll or a changed action.\n\nSo what you handle here is the *talking*. If the message is ambiguous, ask them to adjust or cancel — the roll is already on the table and stays there.\n\n## Settling the terms\n\nThe roll goes on the table as a `rollRequest`. Everything in it must be settled before it does.\n\n**Save.** The player's **bonus**, whether they have **advantage or disadvantage**, and the **DC** (defaults to 16; a creature's defense converts to one).\n\n**Attack.** All three attack details must be settled first:\n\n- the **weapon** — an item in their inventory, or an environment object close enough to grab mid-fight, or bare hands;\n- whether they strike to **deal damage** or to attempt a **stunt**;\n- if they have advantage, whether they spend it **normally** (roll 2d20, drop the lowest) or to **perform a stunt and deal damage** on a hit.\n\nIf any of these is still open, ask for it and leave the roll off the table. Once all are settled, the request carries the character's attack bonus (STR for melee, WIS for ranged), the edge, the weapon's damage die, the target's defense and whether the weapon is well suited to it. If the player spent advantage on stunt-and-damage, set the edge to none — the advantage bought the combination, not a reroll — and apply the stunt in resolution.\n\n## Cancel → restart the loop\n\nIf the player abandons the attack or the action, change no state. Ask them for a different course of action and return to await input — the start of the loop.\n\n## Adjust or negotiate → update the roll, then re-confirm\n\nThe player may argue for a better roll or change their action. If they can articulate a **good reason — especially one that leans on other established entities** — allow it. Reasonable changes include:\n\n- gaining **advantage** on the roll,\n- **cancelling out a disadvantage,**\n- **changing the equipment** they use,\n- or otherwise changing the nature of the action — including **which stat** the roll uses or **which target** they roll against.\n\nApply the change (recompute bonus, edge, DC or target, or weapon as needed), then put the amended `rollRequest` back on the table and ask them to confirm it. The interface re-renders the terms from it, so your post says **what changed and why** — not the numbers over again. A weak or unfounded reason earns no change — say so plainly and leave the roll as it stood.\n\nArgument is the late half of the same ledger step 3 keeps under \"pay for what they set up\", and it pays at the same rates: a good reason that leans on something real buys advantage, and a reason good enough that the risk is simply gone takes the roll off the table and lets the action happen. What it never buys is a lower number you keep to yourself — either the edge changes or nothing does.\n\nKeep the difficulty hidden throughout: never the DC, never the target's defense. A qualitative \"this still looks like a long shot\" is fine; a number is not. The bonus and the edge need no restating either — the offer beneath your post carries them, amended, the moment you commit it. **What does need saying is why they moved**: an edge the player has just argued into existence is one they earned, and naming what bought it is how they find out the argument worked. As in step 3, the values are the screen's and the reasons are yours. And also as in step 3: **do not name a factor working in their favour unless it is buying them advantage** — mentioning one while the terms stand unchanged tells them the roll got easier when it did not.\n\n## The loop\n\nPut the roll on the table → read whatever they say back → cancel / clarify / adjust, and put it back on the table amended. It continues until the player **cancels** (return to the start of the loop, no state change) or **takes it** — at which point the dice are thrown for you and the next thing you see is step 5, holding the result.\n";
//#endregion
//#region src/runtime/prompts/dungeon-loop/steps/5-resolution.md?raw
var _5_resolution_default = "# Step 5 — Action resolution\n\nEverything the action needs has been decided: a no-stakes action carries an auto-success; a stakes action carries the result of the player's save or attack, **already rolled by the interface and sitting in front of you.** Now resolve it fully — decide what happened, let the world react, write the changes into the world, and narrate it. This is also where other creatures take their turns.\n\n**Roll everything you need in one call, and roll it first.** The dice you need are the creatures' — their attacks, their nerve — plus anything the world throws. Work out the whole list before you call `roll`, ask for all of it at once, and then write the turn. A second batch is a second exchange, and rolling for something you end up not using costs nothing. See the `roll` tool at the end of SKILL.md.\n\n## 1. Decide what happened\n\nWork out, in general terms, the outcome from the player's input and the roll result (if any):\n\n- **Auto-success (no stakes)** — the player does what they set out to do, but keep the effects **fairly minor.** A no-stakes action should not produce large swings.\n- **Roll succeeded** — they accomplish what they set out to do, within reason, **without suffering harm.**\n- **Roll failed** — they **do not** accomplish their goal, and they suffer some consequence of the attempt.\n\nFor an **attack**, the roll's success is a **hit**:\n\n- **Hit, dealing damage** → apply the rolled damage to the target.\n- **Hit, performing a stunt** → the stunt happens (per the Knave rules); no damage — *unless* the player spent advantage on **stunt-and-damage**, in which case both the stunt and the damage land.\n- **Miss** → the blow does not connect; the goal is not met, and the opening may cost the player (often through the creatures' turns below).\n\n**A save to stay unnoticed fails differently.** Where the roll on the table was \"do it without being seen\" (step 3), failing it does not mean the act failed. It means something looked up. The lock may well have opened; what has changed is that the room knows. Narrate it that way, and write the creatures' new `activity` — what they noticed, and what they are doing about it — so the next turn begins in a room that is awake to them.\n\nWorth saying in the other direction too: on a success they are *still* unnoticed. Leave the `activity` lines saying so. A creature does not drift into awareness between turns without something making it happen.\n\nLet the player's stated intent shape *what* success looks like, but keep the result inside what the character could actually achieve — never a wish granted wholesale.\n\n**Let cleverness show up in the size of it.** Where the player reached this outcome by setting something up earlier, or by an approach plainly better than the obvious one, spend that here rather than absorbing it: more of what they were after comes away, it costs them less, the creature ends up out of the fight instead of merely hurt, the thing they wanted survives being taken. Step 3 pays for thinking in the odds; this is where it pays in what actually happened — and it is also the one thing that lifts a no-stakes action above \"fairly minor\". What it never does is overrule the dice: a failed roll is a failure, however well it was planned.\n\n## 2. Take other creatures' turns\n\nResolution also simulates the rest of the scene. For any creature involved in the action, or acting at the same time, decide two things: how the result of the action affects it, and what it does on its own turn.\n\n**Creature attacks.** A creature in combat with the player (or with another creature) may attack. Ask for it as a `kind: \"attack\"` in the batch:\n\n- **bonus** — the creature's **Strength** bonus for a melee attack, **Wisdom** bonus for a ranged one (a creature's ability bonus is its Hit Dice plus any modifier),\n- against the **player's armor defense** — the defense of the armor they wear, or **11** unarmored,\n- dealing the creature's **damage die** on a hit.\n- On a **natural 20**, the creature deals **+1d** damage *and* the player's **armor loses 1 `currentQuality`.** (The +1d is automatic in the roll; apply the armor-quality loss here.)\n\n**Morale.** An action can break a group's nerve. Roll morale for the opposing creatures when any of these happens — or anything you judge comparable:\n\n- half of their group is eliminated,\n- their leader (or largest specimen) is defeated,\n- a single creature is dropped to half its health or less.\n\nAsk for it as a `kind: \"morale\"` in the batch, passing their rating (default 7). It comes back as **holds** or **breaks** — the 2d6 against the rating is done for you. A group that breaks attempts to flee, retreat, or parley; fold that into what they do on their turn.\n\nSince a morale check often depends on damage you have not applied yet, include it in the batch anyway. Roll it, and then decide whether the trigger was met.\n\n**Noise does not stop at the door — but you hold only this room.** The rooms next to this one are not in front of you, and their creatures are not yours to write or to wake. What you can do is leave the fact where the next pass will find it: when the action was loud — a fight, a scream, a door forced, masonry down — say so plainly in the outcome you record for the turn. Room entry reads those records, and that is how the room they walk into next knows what it heard.\n\n## 3. Update state and stats\n\nWith the action, its consequences, and the creatures' reactions decided, write it all into the world:\n\n- **catch up anything the player acted on that was only ever in a description.** If step 1 approved a target that lives in a `composed` paragraph but in no `base` or `state` — the ledge you described on arrival, the crate you mentioned in passing — write it into the `state` of whatever holds it now, or create it as an entity if it can be taken or broken. It has been true since you said it; this is the turn the record catches up.\n- update the **state** of every affected entity (which flags it, and its containers, for recompose),\n- **and if the turn settled something about the dungeon itself** — who built this, what the place was for, what happened here — put that one line on the commit as a `fictionNote` (see the skill). Only what is true of the *place*; anything true of a thing in the room is that thing's `state`, and most turns carry no note at all.\n- apply changes to **game stats**: hit points from damage dealt or taken, items **consumed or damaged** (spend `currentQuality`), a **creature slain**, the **player or an entity moved** to another room, and so on.\n\n## 4. Narrate and recompose\n\nDraft a post that narrates how the action plays out and lays out its effects — the outcome, any damage, what the creatures did, what changed. At the same time, generate fresh **composed** prose for every entity you updated (the same base + state → composed rendering used on room entry), so the world stays consistent from here on.\n\n**If the player moved to a new room, write no post at all.** Set their `roomId`, commit, and stop. Arriving somewhere is its own pass, it runs the moment your commit lands, and it is the one that has the new room's contents in front of it — you do not. **A commit that moves the player has its post discarded unread**; anything you write there reaches nobody, so spend nothing on it.\n\nThis is not a style note. If you describe the room beyond, you are describing a place you have not been handed: you will furnish it out of nothing, and a moment later the player will be told what is actually there. Two descriptions of one room, disagreeing, one turn apart. An empty forge hall, and then the three figures standing in it. The arrival is the moment worth writing, and it is not yours.\n\nThe exception is a move that **costs** something — a fall, a wound taken squeezing through, a torch dropped. Apply that as state in the same commit. The arrival pass reads state and will account for it.\n\n## 5. End-of-turn checks\n\nThe action is complete. Before looping, check three things:\n\n- **Is the player still alive?** If their hit points are **0 or below**, they have been slain and the run is over — `nextStage: \"dead\"`.\n- **Did this turn accomplish the dungeon's goal?** Then set **`goalMet: true`** on the commit. The run does **not** end: they are holding it, not home with it, and the walk back out is the rest of the game. It latches, so you never have to say it twice.\n- **Did they just walk out through the way marked OUT OF THE DUNGEON?** Then the run is over — `nextStage: \"departed\"`. Do not say whether it was a win; that is settled from the flag, not from you.\n\nIf none, the turn ends. Return to the start of the loop and await the player's next chat input.\n";
//#endregion
//#region src/runtime/prompts/dungeon-loop/steps/room-entry.md?raw
var room_entry_default = "# Room entry — describing where the player now stands\n\nThe player has moved into a room. Your job is to make them feel like they have arrived\nsomewhere, and to write down what they now know.\n\nYou are handed the room and **only the things in it that need describing** — anything\nnever encountered, and anything whose state has changed since they last looked. Things\nalready described and unchanged are not your concern; the player will see their\nexisting descriptions unaltered. If you were called at all, something here needs\nwriting.\n\n## Compose from the inside out\n\nWrite the contents first, then the room. A room's description speaks about what is in\nit, so it cannot be written until the things it contains have been settled. Work\noutward: the individual features, items, and creatures; then anything containing them;\nthen the room itself.\n\nEach thing gets:\n\n- **`state`** — what is true of it right now, as distinct from what it permanently is.\n  Its `base` already says what it is; do not restate that. `state` is the ash in the\n  grate, the splintered lid, the wound you gave it two rooms ago that it is still\n  favouring.\n- **`composed`** — how the player perceives it. Rendered from `base` plus `state`,\n  written for someone standing in front of it.\n\nFor anything the player has never encountered, both are new. For something they have\nseen before whose state has since changed, the state may already be written and only\nthe description needs catching up — read what is there before you overwrite it.\n\n## Describe what is there. Do not invent what is not.\n\nThis is the rule that matters most, because **what you write here becomes a promise.** The player reads this paragraph and acts on it, and everything in it has to still be true next turn.\n\n**Atmosphere is free. Affordances are not.**\n\n- *Atmosphere* — the cold, the smell, the quality of the light, the sound of water somewhere below, how old the stonework looks. Write as much as you like. Nobody can act on it and nothing depends on it later.\n- *An affordance* is anything a player could reach for: a ledge they could climb, a gap they could squeeze through, a beam they could pull down, a rope, a shelf, a body, a door. **Every affordance in your description must already exist in a `base` or a `state` you were handed, or be something you create in this same commit.**\n\nIf you want the ledge, you may have it — but then it is a fact, and facts live where facts live. Put it in the room's `state`, or create it as a `RoomFeature` in `children[]`. What you may not do is put it *only* in the paragraph, because the paragraph is not something you are allowed to reason from next turn, and the player will act on it and be told it was never there.\n\n**Never describe a way out that is not a connector.** You are handed every exit this room has. A \"passage continuing north\", a \"stair down to the lower workings\", a \"crack you might squeeze through\" that is not in that list does not exist — it is not on the map, it leads nowhere, and it cannot be walked through. If a room feels like it should have another way out, that is the layout's business and not yours. Describe the ways out you were given, and no others.\n\n## What the room's description has to carry\n\nThe room's `composed` is the paragraph the player actually reads on arrival. It has to\ndo four jobs at once, and it should do them as prose rather than as a list.\n\n**The place itself.** What it was built for, what has become of it, what it is like to\nstand in. This comes from the room's `base` and the dungeon's fiction, which have\nalready committed to material, age, and the state of the ruin — do not contradict\nthem.\n\n**What is in it.** Every feature, item and creature present, worked into the\ndescription. A thing the player is not told about cannot be acted on, and everything\nyou were handed is there to be found.\n\n**Who is in it.** Each creature's `activity` says what it is doing at the moment of\narrival — feeding, arguing, asleep, already watching the door. That is the hook. A\ncreature discovered mid-something is a situation; a creature standing in a room is\nfurniture. Give the player the situation.\n\n**The ways out.** Every connector, described as what it physically is — an arch, a\nstair, a crawl, a rotted door. Where one is blocked, say what blocks it as it appears\nfrom this side. Exits are the player's only means of planning, and a way out they were\nnever told about does not exist to them.\n\nEach is listed with the room on the far side. **Name that room only where the line says\nthey have been there** — say \"the stair back down to the Laboratory\", because they know\nit and they will want to ask for it by name. For a way out they have not been through,\ndescribe the opening and nothing beyond it. You are given the name so you can keep the\nmap straight; the player earns it by walking through.\n\nOne way out may be marked **OUT OF THE DUNGEON**. That is the way they came in and the\nonly way home, and it is worth a sentence of its own — daylight at the top of it, the\nair moving the wrong way, whatever it is. Never let it read as one more door. A player\nwho cannot find the way out is a player who cannot decide to leave, and deciding when\nto leave is most of the game.\n\n## The map is open beside them\n\nThe room block carries an **As drawn on the map** line: the room's real size in feet,\nits proportions, its outline, and which wall each way out is in. Things standing in the\nroom say where they stand — along the north wall, at the far end, in a corner.\n\n**The player is looking at that drawing while they read you.** So the description has to\nfit it. A room given as twenty by thirty feet is not a great hall; a door given as being\nin the east wall is not behind them. Where the room's `base` and the drawing seem to\ndisagree, the drawing is the fact and the base is the fiction written around it — take\nthe base's material, history and mood, and the drawing's shape.\n\nTwo hard rules, both about the same mistake:\n\n**Compass only.** North is north on the map wherever the party happens to be facing, and\nyou are not told which way that is. \"The north wall\" is always true. \"On your left\" is a\nguess, and a player who walks back in through another door finds out it was wrong.\n\n**Invent no openings.** The ways out are exactly the connectors you were given. A window,\na side passage, a hole in the ceiling, a second stair — if it is not in the list it is\nnot in the room, and a player will try to walk through anything you describe.\n\nDo not read the dimensions out. They are there so the prose can be concrete about scale\nand direction, not so the player gets a floor plan in words.\n\n## What the player is not aware of\n\n**You decide this, and here is where it is decided.** Every entity carries\n`isHidden`. It starts false, and the first time you compose something — the first\ntime it has a description at all — you settle whether someone standing in this room\nwould actually notice it. Nothing before you has made that judgement, because nothing\nbefore you knew what the room reads like.\n\nSet `isHidden` to true when the fiction has just made the thing unnoticeable:\n\n- it is inside something closed, buried, or behind something else\n- the room's own description accounts for why it goes unseen — the dark, the depth of\n  the water, the heap of fallen masonry\n- it is a thing whose whole point is being missed: a false back, a seam in the\n  masonry, a loose flagstone, a creature that has not moved yet\n\nLeave it false for everything a person in the room would simply see. Most things are\nnot hidden. A room where nothing is visible is not mysterious, it is empty.\n\n**A hidden thing gets a `state` and NO `composed`.** Write what is true of it —\nyou are the one who knows, and nobody will ask you again — but do not write its\ndescription. `composed` is what the player reads, and the player cannot read this\nyet. It gets described when it is found, by whoever narrates the finding.\n\n**Never let the room's description name it.** If it is worth finding, the room may\ncarry a *clue* — something slightly wrong that a careful player might pull at. A\ndraught from a wall with nothing behind it. A flagstone worn smoother than its\nneighbours. Shelving that stands a hand's width off the wall. Never name the thing\nitself, never say that something is concealed, and never write a sentence whose only\nfunction is to announce that there is a secret here.\n\nThe clue is the front half of a rule whose back half lives in the information step: a\nplayer who looks in the right place, in the right way, turns the clue into the thing.\nGive it away here and searching this dungeon stops meaning anything.\n\n**Two things you do not decide.**\n\n*Ways out.* Whether a passage is concealed was settled when the dungeon was laid out,\nbecause the map and the reachable shape of the place hang off it. A connector already\nmarked hidden stays hidden and stays out of your description; one that is not, is\nnot. Do not set `isHidden` on a connector.\n\n*Rooms.* Never hidden, ever. The map reads a room's description as \"the player has\nbeen here\", so leave rooms alone.\n\nFinding is the other half: when the player does discover something, set `isHidden`\nback to false and rewrite its `state` — that is the resolution step's business, not\nyours.\n\n## What the creatures have not noticed\n\nThe other half of the same judgement. `isHidden` is what the player has not seen;\nthis is what the room has not seen of *them*.\n\n**Assume the creatures in here have not noticed the player.** They were living\ntheir own afternoon until a moment ago, and someone careful in a doorway is easy\nto miss. Three things break that, and only these three:\n\n- **They came in loudly.** The action that brought them here spent the quiet —\n  they ran, they charged, they kicked it open, they were shouting. See the\n  standing assumption in the skill.\n- **Something carried from next door.** The turn records say what they just did\n  and how it went. A fight, a scream, a portcullis dropped, a door forced — one\n  room away and a turn or two ago, the things in here heard it and are already\n  watching the way in.\n- **They were waiting for someone.** The creature's `activity` says so: set for an\n  ambush, posted on the entrance, hiding from whatever comes through. That was\n  decided before you got here. Do not overrule it.\n\nOtherwise they are unaware, and you say so in each creature's `activity`, in plain\nwords — \"gnawing at the joint with its back to the arch\", \"asleep in the straw\",\n\"arguing over the dice and not watching the door\". **`activity` is the one field\nentry may write besides the prose pair**, because whether the room knows they are\nthere is what the whole next turn hangs on, and it has to still be readable a turn\nlater.\n\nThen describe them doing it. **A creature that has not noticed the player is never\ndescribed as noticing them** — no head coming up, no eyes finding them in the\ndoorway, no sense that it knows. That moment is the thing the player gets to spend,\nand narrating it away spends it for them.\n\nUnaware is not harmless. Say what it is and what it could clearly do; leave it not\nknowing.\n\n## What entry never does\n\nEntry is not an action. The player has not done anything yet, and nothing may happen\nto them for having walked in.\n\n- **Roll nothing.** No saves, no attacks, no morale.\n- **Start no combat.** A hostile creature is described as a present threat and left\n  standing. It acts on its turn, once the player has acted on theirs.\n- **Spring nothing.** A hazard the player has walked into the room with is described\n  if it is apparent, and left unsprung. It goes off when something sets it off.\n- **Change nothing but prose and awareness.** No hit points, no inventory, no\n  conditions, no movement. `state`, `composed`, and the `activity` lines that say\n  what the creatures are doing and whether they have noticed anything. Nothing\n  else.\n\nThe room can be frightening. It cannot be expensive.\n\n## Tone\n\nThis is the moment the game is for. The player has committed to a door and it has\nopened. Write it as arrival — the shift in air, the light going wrong, the sound that\nstops when they step in — and not as an inventory of contents with an atmosphere\nsentence stapled to the front.\n\nLong enough to furnish the place, short enough to read in one breath before deciding\nwhat to do. If a detail is not something the player could see, hear, or smell from\nwhere they are standing, it belongs in `state`, not in the description.\n\n## Ending\n\n**The room's `composed` is what the player reads on arrival. You do not have to write it twice.** It goes into the commit as a diff, and the interface shows that paragraph to the player as the arrival itself — so write it as prose meant to be read aloud, not as a note about the room. If you have something to say beyond it, write that as your message and it will be shown instead.\n\nIf writing this room settled something about the **dungeon** — what the place was\nbuilt for, who cut it, what happened here — put that one line on the commit as a\n`fictionNote` (see the skill). Arrival prose is where a dungeon's history most\noften gets written, and the note is what stops it being written a second time,\ndifferently, four rooms from now.\n\nCommit the `state` and `composed` diffs, then hand the turn back:\n\n```\nnextStage: \"awaiting_action\"\nnextStep:  \"1-target\"\n```\n\nThe player is standing in the room. Ask them what they do.\n";
//#endregion
//#region src/runtime/prompts/loader.ts
/** The standing instructions: the conventions, the commit, and the dice tool. */
var SKILL = SKILL_default;
var CHAIN = {
	"1-target": [
		_1_determine_target_default,
		_2_validate_and_classify_default,
		_3_handle_by_type_default,
		_3_information_default,
		_3_standard_default
	],
	"2-classify": [
		_2_validate_and_classify_default,
		_3_handle_by_type_default,
		_3_information_default,
		_3_standard_default
	],
	"3-information": [_3_information_default],
	"3-standard": [_3_standard_default],
	"4-confirm-roll": [_4_confirm_and_roll_default],
	"5-resolution": [_5_resolution_default],
	"room-entry": [room_entry_default]
};
/** The step files for an entry point, in the order the heuristic runs them. */
function stepPrompt(step) {
	return CHAIN[step].join("\n\n---\n\n");
}
//#endregion
//#region src/runtime/prompts/render.ts
/**
* GROUND TRUTH, AS TEXT
* =====================
*
* The character sheet and the current room, rendered fresh for every call. This
* is the "re-rendered each turn" half of BUILD-PLAN §4.4, and it is the half
* that matters: the entity `state` fields are the game's long-term memory, and
* this is how they reach the referee. The transcript only carries the thread of
* a conversation.
*
* TWO RULES SHAPE EVERY LINE HERE.
*
* **Ids are quoted, never invented.** Every entity is rendered with its id in
* brackets, because the applier resolves what the referee writes and a diff
* naming something that does not exist costs a retry. If it can be addressed,
* its id is on the page.
*
* **The referee sees more than the player.** Concealed things are listed and
* marked, because the referee has to know what is there to be found; creature
* defenses are listed, because somebody has to set a difficulty. Neither ever
* reaches `ui/` — see `RoomViewOptions`, which gates both.
*
* Built on the same `roomView` / `characterView` the screen uses, so the player
* and the referee cannot end up looking at different rooms.
*/
var ABILITY_ORDER = [
	"str",
	"dex",
	"con",
	"int",
	"wis",
	"cha"
];
var sign = (n) => n >= 0 ? `+${n}` : `${n}`;
/** Drop empty lines a conditional field left behind. */
var lines = (xs) => xs.filter((x) => x !== void 0).join("\n");
function renderCharacter(pc) {
	const abilities = ABILITY_ORDER.map((k) => {
		const a = pc.abilities.find((x) => x.key === k);
		return `${k.toUpperCase()} ${sign(a.bonus)} (defense ${a.defense})`;
	}).join(" · ");
	const carried = pc.inventory.length ? pc.inventory.map((i) => `- ${renderItemLine(i)}`).join("\n") : "- (nothing)";
	const equipped = pc.equipped.map((e) => `${e.slot}: ${e.item ? `[${e.item.id}] ${e.item.name}` : "—"}`).join(" · ");
	return lines([
		`## The player character`,
		``,
		`**${pc.name}** — level ${pc.level}, referred to in diffs as \`player\`.`,
		`Hit points **${pc.hp.current}/${pc.hp.max}**.`,
		abilities,
		`Armour defense ${pc.armorDefense} · melee attack ${sign(pc.meleeBonus)} · ranged attack ${sign(pc.rangedBonus)}`,
		`Inventory slots ${pc.slots.used}/${pc.slots.capacity}${pc.slots.overburdened ? " — OVERBURDENED" : ""}`,
		pc.conditions.length ? `Conditions: ${pc.conditions.join(", ")}` : `Conditions: none`,
		``,
		`Carrying:`,
		carried,
		``,
		`Equipped — ${equipped}`,
		``,
		`Traits: ${Object.entries(pc.traits).map(([k, v]) => `${k} ${v}`).join(", ")}`
	]);
}
/** An item's own numbers: what it costs to carry, how worn it is, what it is worth. */
function itemDetail(i) {
	const bits = [
		i.slots !== void 0 ? `${i.slots} slot${i.slots === 1 ? "" : "s"}` : void 0,
		i.quality ? `quality ${i.quality.current}/${i.quality.original}` : void 0,
		i.value ? `worth ${i.value} cp` : void 0,
		i.book ? i.book.exhausted ? `a book on ${i.book.subject || "no stated subject"} — READ OUT, nothing left in it` : `a book on ${i.book.subject || "no stated subject"} — book.uses ${i.book.uses}` : void 0
	].filter((x) => x !== void 0);
	return bits.length ? bits.join(", ") : void 0;
}
function renderItemLine(i) {
	const detail = itemDetail(i);
	return `[${i.id}] ${i.name}${detail ? ` — ${detail}` : ""}`;
}
/**
* How a thing stands with the player, in three words.
*
* The distinction the room-entry step turns on: never encountered means both
* fields are yours to write; stale means the state moved while they were
* elsewhere and only the description is owed.
*/
function standing(e) {
	if (e.composed === void 0 && e.state === void 0) return "NEVER ENCOUNTERED";
	if (e.needUpdate || e.composed === void 0) return "DESCRIPTION STALE";
	return "described, unchanged";
}
function renderEntity(e, indent = "") {
	const head = [`[${e.id}] ${e.name} — ${e.kind}`];
	if (e.count !== void 0 && e.count > 1) head.push(`×${e.count}`);
	if (e.hp) head.push(`hp ${e.hp.current}/${e.hp.max}`);
	if (e.isHidden) head.push("NOT YET FOUND BY THE PLAYER");
	if (e.position) head.push(positionPhrase(e.position));
	const out = [`${indent}- ${head.join(" · ")} (${standing(e)})`];
	const field = (label, value) => value === void 0 || value.trim() === "" ? void 0 : `${indent}    ${label}: ${value.replace(/\s*\n\s*/g, " ")}`;
	out.push(...[
		field("base", e.base),
		field("state", e.state),
		field("composed", e.composed),
		e.activity ? `${indent}    doing: ${e.activity}` : void 0,
		e.combat ? `${indent}    defenses ${ABILITY_ORDER.map((a) => `${a} ${e.combat.defenses[a]}`).join(" ")} · armour defense ${e.combat.armorDefense} · attack ${sign(e.combat.attackBonus)} · damage ${e.combat.damage} · morale ${e.combat.morale}` : void 0,
		itemDetail(e) ? `${indent}    ${itemDetail(e)}` : void 0
	].filter((x) => x !== void 0 && x.trim() !== ""));
	for (const child of e.contains) out.push(renderEntity(child, `${indent}  `));
	return out.join("\n");
}
function renderRoom(room) {
	const contents = room.contents.length ? room.contents.map((c) => renderEntity(c)).join("\n") : "- (nothing in it)";
	const exits = room.exits.length ? room.exits.map((x) => {
		const bits = [
			x.form ? x.form.replace(/\s*\n\s*/g, " ") : void 0,
			x.wall ? `in ${x.wall}` : void 0,
			x.cameFrom && !x.surface ? `THE WAY THEY CAME IN` : void 0,
			x.isHidden ? "NOT YET FOUND BY THE PLAYER — do not describe it, do not count it among the ways out, and do not hint at it except through a clue they find" : void 0,
			x.blocked ? `BLOCKED: ${x.requirement ?? "something is in the way"}` : void 0,
			x.surface ? "LEADS OUT OF THE DUNGEON — the way they came in, and the way home. Walking through it ENDS THE RUN: commit nextStage \"departed\"" : x.toKnown ? `leads to [${x.toRoomId}] ${x.toRoomName}, which they have been to` : `leads to [${x.toRoomId}], somewhere they have not been`
		].filter(Boolean);
		return `- [${x.connectorId}] "${exitLabel(x)}" — ${bits.join(" · ")}`;
	}).join("\n") : "- (no way out of this room)";
	return lines([
		`## The room the player is standing in`,
		``,
		`[${room.id}] **${room.name}** (${standing(room)})`,
		room.base ? `base: ${room.base.replace(/\s*\n\s*/g, " ")}` : void 0,
		room.state ? `state: ${room.state.replace(/\s*\n\s*/g, " ")}` : void 0,
		room.composed ? `composed — THE PLAYER HAS READ THIS; it binds you: ${room.composed.replace(/\s*\n\s*/g, " ")}` : void 0,
		room.geometry ? lines([
			``,
			`### As drawn on the map`,
			room.geometry,
			"The compass here is the MAP's, not the party's: north is north wherever they are facing. Say \"the north wall\"; never \"on your left\", which you have no way to know."
		]) : void 0,
		``,
		`### In it`,
		contents,
		``,
		`### Ways out`,
		exits
	]);
}
/**
* The player's own roll, as the step-5 input.
*
* The DC is on the page. The referee set it and is the one deciding what the
* result means; withholding it here would only invite it to guess whether the
* roll cleared.
*/
function renderRoll(o) {
	const dice = o.rolled.length > 1 ? `[${o.rolled.join(", ")}] keeping ${o.kept}` : `${o.kept}`;
	return lines([
		`## The roll the player just took`,
		``,
		`They attempted: ${o.spec.description}`,
		`${o.spec.kind} on ${o.spec.ability.toUpperCase()}, edge ${o.spec.edge}` + (o.spec.targetId ? `, against [${o.spec.targetId}]` : ""),
		`d20 ${dice} ${sign(o.spec.bonus)} = **${o.total}** against ${o.spec.dc} — **${o.success ? "SUCCESS" : "FAILURE"}**`,
		o.nat20 ? `Natural 20: the defender's armour loses a point of currentQuality.` : void 0,
		o.nat1 ? `Natural 1: the attacker's weapon loses a point of currentQuality.` : void 0,
		o.damage ? `Damage rolled: ${o.damage.expr} → [${o.damage.rolls.join(", ")}] = **${o.damage.total}**` : void 0,
		``,
		`These are the only numbers you have for this action. Use them; do not restate them differently.`
	]);
}
/**
* Completed turns, as structure rather than prose — §4.4. The paragraphs are
* gone; what a finished turn owes the next one is a few facts.
*/
function renderRecords(records) {
	if (records.length === 0) return "";
	return lines([
		`## Turns already finished`,
		``,
		...records.map((r) => {
			return `- ${[
				`turn ${r.turn}`,
				`action: ${r.action}`,
				r.target ? `target: [${r.target}]` : void 0,
				r.roll ? `${r.roll.kind} roll ${r.roll.total} — ${r.roll.success ? "success" : "failure"}` : void 0,
				`${r.diffsApplied} change${r.diffsApplied === 1 ? "" : "s"} applied`
			].filter(Boolean).join(" · ")}\n  outcome: ${r.outcome.replace(/\s*\n\s*/g, " ")}`;
		})
	]);
}
//#endregion
//#region src/runtime/prompts/assemble.ts
function assemble(req) {
	const { dungeon, run } = req;
	return {
		system: [
			{
				type: "text",
				text: SKILL
			},
			{
				type: "text",
				text: `# This dungeon\n\n${dungeon.dungeonContext}`,
				cache_control: { type: "ephemeral" }
			},
			...fiction(run),
			{
				type: "text",
				text: stepPrompt(req.step)
			}
		],
		messages: [
			brief(req),
			...exchange(run),
			instruction(req)
		]
	};
}
/**
* What the run itself has established about the dungeon.
*
* Empty until a turn writes a `fictionNote`, and no block at all until then —
* an empty heading would read as "nothing has been learned here", which is a
* claim, and on turn one it is not one worth making.
*/
function fiction(run) {
	const notes = run.fiction ?? [];
	if (notes.length === 0) return [];
	return [{
		type: "text",
		text: [
			`# What play has since established about this place\n`,
			`Written during the run, in the order it came out, and as binding as`,
			`anything above — most of it has already reached the player. Do not`,
			`contradict it. Build on it.\n`,
			...notes.map((n) => `- ${n}`)
		].join("\n")
	}];
}
function brief(req) {
	const { run, dungeon } = req;
	const room = roomView(run, dungeon, run.currentRoomId, {
		includeHidden: true,
		includeStats: true
	});
	const records = run.turnRecords.slice(-2);
	return {
		role: "user",
		content: [
			`# The world as it stands`,
			``,
			`This is regenerated every turn and is always current. Turn ${run.turnCount + 1}.`,
			``,
			renderCharacter(characterView(run)),
			``,
			room ? renderRoom(room) : `## The room the player is standing in\n\n(missing — this is a bug)`,
			records.length ? `\n${renderRecords(records)}` : ``
		].join("\n")
	};
}
/**
* The conversation for the action currently being resolved — a clarification
* asked and answered, a roll argued over. Cleared the moment a turn closes,
* which is what keeps it short without anything having to trim it.
*
* A roll is the player's, so it goes on their side of the exchange — but they
* did not *say* it, and a die result introduced as speech is a die result the
* referee may argue with. See `turn.ts`: the transcript entry is defence in
* depth behind `renderRoll`, not the authoritative copy.
*/
function exchange(run) {
	return run.transcript.slice(-12).map((e) => ({
		role: e.role === "referee" ? "assistant" : "user",
		content: spoken(e)
	}));
}
function spoken(e) {
	switch (e.role) {
		case "player": return `The player says: ${e.text}`;
		case "roll": return `The player rolled: ${e.text}`;
		case "referee": return e.text;
	}
}
var CLOSE = [
	`Work through the heuristic in the open — none of it is shown to the player.`,
	`Put the words they read inside \`<post>\` tags, once, at the end.`,
	`Then end your turn with a single \`commit_state\` call.`,
	`Every number you use must have come from the \`roll\` tool or from the player's own roll above.`
].join(" ");
function instruction(req) {
	return {
		role: "user",
		content: [
			task(req),
			``,
			CLOSE
		].join("\n")
	};
}
/**
* A RETRY IS THE SAME TURN, ASKED AGAIN.
*
* So the reasons are a PREAMBLE and everything the first ask carried follows
* them, unchanged. They are never a substitute for it.
*
* This was an if/else chain whose rejection branch returned early, and the
* cost was not obvious: the roll reaches the referee through exactly one line
* — `renderRoll`, in the body below — so a retry after a roll was a prompt
* with the roll missing from it. A referee at step 5 with a rejection notice,
* no number, and an action it has not resolved does the only coherent thing
* left and restarts the heuristic, which means offering the same roll a second
* time. In the 2026-08-10 playtest the player won a DEX save at 20, had the
* commit refused for an unrelated reason, was asked to roll again, got a 9,
* and lost what they had already taken.
*
* That one defect also produced the duplicated establishing paragraph — a
* restarted heuristic re-narrates — and the report that the referee "got
* completely messed up". It was not confused. It was told nothing.
*/
function task(req) {
	return (req.rejections?.length ? [refused(req.rejections), body(req)] : [body(req)]).join("\n\n");
}
function refused(reasons) {
	return [
		`# Your last commit was REFUSED`,
		``,
		`**Nothing was applied.** The world is exactly as the section above describes it. The reasons:`,
		``,
		...reasons.map((r) => `- ${r}`),
		``,
		`Ids must appear verbatim in the sheet or the room above, or have been created earlier in the same commit; \`base\`, \`name\`, \`id\` and \`type\` are never writable; a \`clarifying\` or \`rejected\` commit must carry no diffs at all.`,
		``,
		`**This is the same turn, not a new one.** What you were asked for follows, unchanged — the same step, the same action, the same roll if there was one. Write it again with the reasons above fixed. The player has not seen any of your last attempt: the narration was held back with the commit, so write the whole turn, not a correction to it.`
	].join("\n");
}
function body(req) {
	if (req.step === "room-entry") {
		const owed = needsComposition(req.run);
		return [
			`# The player has just walked in here`,
			``,
			owed.length ? `These need writing — nothing else does:\n\n${owed.map((e) => `- [${e.id}] ${e.name} (${e.type})`).join("\n")}` : `Nothing here needs new prose. Commit no diffs and hand the turn straight back.`,
			``,
			`Describe the arrival. Change nothing but \`state\` and \`composed\`.`
		].join("\n");
	}
	if (req.roll) return `${renderRoll(req.roll)}\n\nResolve the action at step 5.`;
	return [
		`# The player has acted`,
		``,
		`Their words are the last message above. Resume the heuristic at the step you were given and carry it as far as it goes.`
	].join("\n");
}
//#endregion
//#region src/runtime/referee.ts
/**
* THE REFEREE, WITH A MODEL BEHIND IT
* ===================================
*
* The other implementation of `Referee`. The stub answers from a keyword table;
* this one asks the model. Nothing in `turn.ts` changes between them, which was
* the point of the seam.
*
* A TURN IS A CONVERSATION, NOT A QUESTION. The generation passes ask once and
* validate once. A turn goes: the referee reads the room, asks the dice for
* everything it needs in one batch, reads what came back, writes the outcome,
* and commits. So this file owns a loop, and the loop's stopping rules are the
* interesting part:
*
*   - `tool_choice: auto`, and NOT `any`. Forcing a tool call is the obvious
*     way to guarantee the turn commits, and it was the first thing tried. It
*     costs the narration: a forced call suppresses the prose that would have
*     come before it, and on the first live run an information action came back
*     as a bare commit — 81 output tokens, nothing for the player to read. The
*     prose is the product. So the model is left free to write, and a turn that
*     ends without committing is asked again rather than prevented.
*   - A commit that fails validation is handed back as a tool ERROR, in the
*     same conversation, with the reasons. That is a correction, not a retry:
*     the model still has everything it just wrote.
*   - On the last permitted round the dice are taken off the table and
*     `commit_state` is forced, so a referee that keeps rolling gets closed out
*     rather than looping until the budget is gone.
*
* WHAT IT DOES NOT DO. It does not apply anything, does not decide what a turn
* means, and does not know what stage the game is in beyond what it is told.
* The commit goes back to the machine, the machine hands it to the applier, and
* the applier is the thing that says no.
*
* The one number this file produces that did not come from the model is every
* number: the dice are rolled here, from the run's seeded RNG. The model reads
* results it did not choose.
*/
var COMMIT_TOOL = toolFor("commit_state", "End your turn. Carries the words the player reads (`post`), where the game goes next, and what changed. Exactly one call per turn, always — even a turn that changes nothing commits, to say what the player's input area should be waiting on. Call this LAST. Anything you write outside this call is your own working-out and is never shown to anyone.", commitSchema);
var ROLL_TOOL = toolFor("roll", "Roll dice. Takes a LIST and answers all of it at once, so ask for everything the turn might need in one call — creature attacks, morale, a trap going off — and discard what you end up not using. Going back for a second batch costs a whole extra exchange. The player's own roll never comes through here; it was already made for you.", rollBatchSchema);
/**
* The referee's roll request becomes the machine's `RollSpec`.
*
* The one thing that actually changes shape: the playbook speaks of a target's
* DEFENSE and the machine wants the number to MEET, so the conversion happens
* here, once, through the one function in the codebase that owns the `+1`.
*/
function toRollSpec(r) {
	const dc = r.kind === "save" ? r.dc ?? 16 : r.targetDefense !== void 0 ? dcFromDefense(r.targetDefense) : r.dc;
	return {
		kind: r.kind,
		ability: r.ability,
		bonus: r.bonus,
		edge: r.edge,
		description: r.description,
		dc,
		...r.weapon !== void 0 ? { weapon: r.weapon } : {},
		...r.mode !== void 0 ? { mode: r.mode } : {},
		...r.advantageUse !== void 0 ? { advantageUse: r.advantageUse } : {},
		...r.damage !== void 0 ? { damage: r.damage } : {},
		...r.targetId !== void 0 ? { targetId: r.targetId } : {}
	};
}
/**
* DAMAGE THAT NO DICE PRODUCED.
*
* The load-bearing rule of the whole system is that the model never generates a
* number, and this is where a violation of it actually shows up. Observed on
* the first live run: the player was offered no roll for climbing down a wet
* rock face, and the referee simply narrated the fall — the slip, the water,
* "you are hurt but breathing" — and wrote hit points off the sheet. Every word
* of it was good. None of it was earned.
*
* A turn that takes hit points off ANYTHING must have dice behind it: the
* player's own roll, which arrives with the request, or a `roll` call made
* during this turn. Neither means the number was invented, and an invented
* number is refused before the applier ever sees it — the applier's whitelist
* cannot catch this, because `hp.current` is perfectly writable and only the
* provenance is wrong.
*
* HEALING IS LEFT ALONE. A written salve that restores what it says it restores
* is reading a number off the fiction, not inventing one. Damage is the
* direction that costs the player something they did not agree to risk.
*/
function unearnedDamage(req, commit) {
	const before = /* @__PURE__ */ new Map([[PLAYER_ID, req.run.pc.hp.current]]);
	for (const c of req.run.entities.creatures) before.set(c.id, c.stats.hp);
	const out = [];
	for (const d of commit.diffs) {
		if (d.path !== "hp.current" && d.path !== "stats.hp") continue;
		if (typeof d.value !== "number") continue;
		const was = before.get(d.entityId);
		if (was === void 0 || d.value >= was) continue;
		out.push(`[${d.entityId}] loses ${was - d.value} hit points, but no dice were rolled this turn. Damage comes off the \`roll\` tool or off the player's own roll — never off your judgement.`);
	}
	if (out.length > 0) out.push("If this action had stakes, that is what the roll is FOR: put it on the table with nextStage \"roll_offered\" and stop there. The player takes it, and you resolve what it said. If the harm belongs to something other than the player's own attempt — a creature striking back, a fall, a trap — call `roll` for it and use what comes back.");
	return out;
}
/**
* THE ROLL THAT WAS NEVER OFFERED.
*
* A sibling of `unearnedDamage`, and the same shape of failure: the numbers had
* a provenance, and the player still did not get what they were owed. Observed
* on a live run — asked whether they could hide inside a forge-stone, the
* referee worked out a DEX save, wrote "Step 4 — Confirm and roll," and then
* called `roll` for it. The dice were honest. The player never saw the roll
* offered, never took it, and read the outcome of an attempt they were not
* asked to commit to. Two turns in a row.
*
* THE PLAYER'S ROLL IS THE ONE PLACE THE GAME HANDS THEM THE DICE. It goes on
* the table as `roll_offered` with a `rollRequest`, the turn ENDS there, and
* the interface throws it when they take it. The `roll` tool is for everything
* else — the creatures, the traps, the falling masonry.
*
* HOW ONE IS RECOGNISED. Only the bonus tells them apart: a roll made at one of
* the player character's own six modifiers, on a turn where no roll of theirs
* has arrived, is theirs. Two exceptions keep it honest — `morale` and `damage`
* are never a player's roll whatever the number, and an `attack` aimed at the
* player's own armour is a creature striking them, not them striking out.
*
* A bonus can collide by coincidence: a 2HD creature saving against a shove
* shares +2 with a player who has it. So the refusal names `actor` as the way
* out — a roll marked as a creature's or the world's is taken at its word, and
* a referee that meant it costs itself one round rather than the turn.
*/
function playersOwnDice(req, batch) {
	if (req.roll) return [];
	const pc = req.run.pc;
	const theirs = new Set(Object.values(pc.abilities));
	const armor = armorDefense(pc);
	const out = [];
	for (const r of batch.rolls) {
		if (r.kind === "morale" || r.kind === "damage" || r.kind === "consult") continue;
		if (r.actor !== void 0) continue;
		if (r.bonus === void 0 || !theirs.has(r.bonus)) continue;
		if (r.kind === "attack" && r.targetDefense === armor) continue;
		out.push(`[${r.id}] is a ${r.kind} at ${r.bonus >= 0 ? "+" : ""}${r.bonus}, which is one of the player character's own bonuses — so this is their roll, and you do not throw it.`);
	}
	if (out.length > 0) out.push("Their roll goes on the table and the turn ends there: commit nextStage \"roll_offered\" and nextStep \"4-confirm-roll\" with the terms as the `rollRequest`. They take it, and it comes back to you at step 5 already made. If one of these is a creature's roll or the world's and only happens to share a bonus with them, mark it `actor` and ask again.");
	return out;
}
/**
* A TURN THAT WOULD REACH THE PLAYER AS A BLANK SCREEN.
*
* The other half of moving the post onto the commit (§8a A9). Once loose text
* is no longer narration, a referee that writes its paragraph outside the tool
* call has written it to nobody — so the absence has to be caught here, where it
* can be handed back as a correction inside the same conversation, rather than
* discovered by the player.
*
* TWO TURNS LEGITIMATELY WRITE NO POST, and both are cases where prose would be
* wasted rather than missing:
*
*   - A ROOM ENTRY. The room's own `composed` is the paragraph the player reads
*     on arrival — `room-entry.md` says so — and asking for it twice would cost
*     double the output tokens for one paragraph and invite the two copies to
*     drift. `arrival()` reads it out of the diffs.
*   - A COMMIT THAT MOVES THE PLAYER. `5-resolution.md` says to write none: the
*     arrival pass runs the moment this commit lands and it is the one with the
*     new room in front of it. The machine discards the prose either way, so
*     requiring it here would be requiring something to throw away.
*/
function missingPost(req, c) {
	if (c.post !== void 0) return [];
	if (req.step === "room-entry") return [];
	if (c.diffs.some((d) => d.entityId === "player" && d.path === "roomId")) return [];
	return ["this commit has no `post`, so the turn reaches the player as a blank screen. The post is a field of `commit_state` — anything you write outside the tool call is working-out and is never shown. Put the words meant for the player in `post` and commit again."];
}
/**
* The cross-field rules a JSON Schema cannot state.
*
* BUILD-PLAN §4.1 wants these caught as schema violations rather than left to
* confuse the interface — a `roll_offered` with nothing to roll is a game
* sitting on a Roll button that does nothing. Returned as text because that is
* what goes back to the model.
*
* The "rejections change nothing" rule is NOT here: the applier enforces it,
* and enforcing it in two places would mean two places to get it wrong.
*/
function problemsWith(c) {
	const out = [];
	if (c.nextStage === "roll_offered" && c.rollRequest === void 0) out.push(`nextStage is "roll_offered" but there is no rollRequest — the player would have nothing to roll.`);
	if (c.nextStage !== "roll_offered" && c.rollRequest !== void 0) out.push(`a rollRequest is only legal when nextStage is "roll_offered"; this one says "${c.nextStage}".`);
	if (c.rollRequest && c.rollRequest.kind !== "save") {
		const r = c.rollRequest;
		if (r.targetDefense === void 0 && r.dc === void 0) out.push(`a ${r.kind} rollRequest needs targetDefense — the defense of what is being struck.`);
	}
	return out;
}
function createModelReferee(opts) {
	const { store, journal = NO_JOURNAL } = opts;
	const maxRounds = opts.maxRounds ?? 4;
	return async function referee(req) {
		const task = req.step === "room-entry" ? "room-entry" : "turn-loop";
		const prompt = assemble(req);
		journal.logSystem(req.step, prompt.system);
		const messages = [...prompt.messages];
		/** whether any dice have been thrown for this turn — see unearnedDamage */
		let rolled = false;
		for (let round = 1; round <= maxRounds; round++) {
			const last = round === maxRounds;
			const turn = await call({
				task,
				round,
				system: prompt.system,
				messages,
				tools: last ? [COMMIT_TOOL] : [ROLL_TOOL, COMMIT_TOOL],
				toolChoice: last ? {
					type: "tool",
					name: "commit_state"
				} : { type: "auto" },
				signal: opts.signal,
				step: req.step,
				store,
				journal
			});
			const rolls = turn.toolUses.filter((t) => t.name === "roll");
			const commit = turn.toolUses.find((t) => t.name === "commit_state");
			if (commit) {
				const read = readCommit(commit, (parsed, c) => [...missingPost(req, parsed), ...rolled || req.roll ? [] : unearnedDamage(req, c)]);
				if (typeof read === "string") {
					messages.push({
						role: "assistant",
						content: turn.content
					}, toolResults([{
						id: commit.id,
						content: read,
						isError: true
					}]));
					continue;
				}
				return {
					narration: read.post ?? arrival(req, read.commit),
					commit: read.commit
				};
			}
			if (rolls.length > 0) {
				const answers = rolls.map((r) => answerRoll(store, journal, r, (batch) => playersOwnDice(req, batch)));
				if (answers.some((a) => a.threw)) rolled = true;
				messages.push({
					role: "assistant",
					content: turn.content
				}, toolResults(answers.map((a) => a.result)));
				continue;
			}
			messages.push({
				role: "assistant",
				content: turn.content
			}, {
				role: "user",
				content: `You ended your turn without calling \`commit_state\`. The game is now waiting on a stage nobody set. Call \`commit_state\` and say where the turn leaves the player.`
			});
		}
		throw new Error(`the referee did not commit within ${maxRounds} calls (step ${req.step})`);
	};
}
/**
* WHAT THE PLAYER READS WHEN THEY WALK IN.
*
* A room entry that wrote no prose is not a referee that forgot to speak. The
* room's `composed` IS the paragraph the player reads on arrival — room-entry.md
* says so in as many words — so a model that writes it into the diff and stops
* has done the work and simply not repeated itself. Observed on the first live
* run: a full, good description of the chasm written onto the room, and an
* empty screen.
*
* Asking it to write the same paragraph twice would cost double the output
* tokens for one paragraph and invite the two copies to drift. So the commit is
* read for it instead, and the playbook says that is the arrangement.
*
* Only on entry, and only when there is nothing else: prose the referee wrote
* for the player always wins.
*/
function arrival(req, commit) {
	if (req.step !== "room-entry") return "";
	const here = req.run.currentRoomId;
	return commit.diffs.findLast((d) => d.entityId === here && d.path === "composed" && typeof d.value === "string")?.value ?? "";
}
/**
* Validate a commit, or say what is wrong with it in the model's own terms.
*
* `also` is the pair of checks that need the turn's own history — whether any
* dice were thrown, and which step this is — which this function does not have
* and should not grow parameters for. It is handed both shapes: the parsed
* commit, which still carries the `post`, and the normalised one, which is what
* the applier would see.
*
* THE POST COMES BACK BESIDE THE COMMIT rather than on it. `Commit` is what the
* applier and the store consume, and neither has any business with prose — the
* post is the referee's answer to the player, and it travels in `RefereeReply`
* where the machine already expects it.
*/
function readCommit(call, also) {
	let parsed;
	try {
		parsed = validate(commitSchema, call.input);
	} catch (e) {
		if (e instanceof ResponseFormatError) return e.feedback;
		throw e;
	}
	const commit = {
		nextStage: parsed.nextStage,
		nextStep: parsed.nextStep,
		diffs: parsed.diffs,
		...parsed.rollRequest ? { rollRequest: toRollSpec(parsed.rollRequest) } : {},
		...parsed.goalMet ? { goalMet: true } : {},
		...parsed.fictionNote ? { fictionNote: parsed.fictionNote } : {}
	};
	const problems = [...problemsWith(parsed), ...also(parsed, commit)];
	if (problems.length > 0) return `That commit was refused and nothing was applied:\n${problems.map((p) => `  - ${p}`).join("\n")}\nCall commit_state again with those fixed.`;
	return {
		commit,
		...parsed.post !== void 0 ? { post: parsed.post } : {}
	};
}
/**
* Roll what was asked for, from the run's own stream.
*
* `syncRng` immediately after: the draw count is what makes a reload resume
* mid-stream, and dice that were rolled but not recorded would be rolled again.
*
* `threw` is what the caller cannot see from the result alone: a batch that was
* malformed or refused comes back as an error having touched neither the stream
* nor the turn, and a turn that has not thrown any dice is still a turn that
* cannot write damage off its own judgement.
*/
function answerRoll(store, journal, call, guard) {
	let batch;
	try {
		batch = validate(rollBatchSchema, call.input);
	} catch (e) {
		if (e instanceof ResponseFormatError) return {
			result: {
				id: call.id,
				content: e.feedback,
				isError: true
			},
			threw: false
		};
		throw e;
	}
	const refused = guard(batch);
	if (refused.length > 0) return {
		result: {
			id: call.id,
			content: `Nothing was rolled:\n${refused.map((p) => `  - ${p}`).join("\n")}`,
			isError: true
		},
		threw: false
	};
	const rng = store.getState().rng();
	const outcomes = rollBatch(rng, batch.rolls);
	store.getState().syncRng(rng);
	journal.log({
		kind: "roll",
		source: "referee",
		requested: batch.rolls,
		outcomes,
		draws: rng.draws
	});
	return {
		result: {
			id: call.id,
			content: renderOutcomes(outcomes),
			...outcomes.some((o) => o.failed) ? { isError: true } : {}
		},
		threw: true
	};
}
/**
* One call, timed and logged.
*
* `turn.ts` deliberately does not write to `callLog` — it cannot know what
* model answered or what it cost. This is where that is known, so this is where
* it is written, on the way out and on the way down.
*/
async function call(args) {
	const { step, store, journal, round, ...rest } = args;
	const started = Date.now();
	journal.log({
		kind: "prompt",
		step,
		messages: rest.messages
	});
	const logCall = (usage, error) => store.getState().logCall({
		at: started,
		step,
		model: modelFor(rest.task),
		inputTokens: usage.inputTokens,
		outputTokens: usage.outputTokens,
		ms: Date.now() - started,
		...error ? { error } : {}
	});
	try {
		const turn = await callWithTools(rest);
		logCall(turn.usage);
		journal.log({
			kind: "response",
			step,
			round,
			text: turn.text,
			toolUses: turn.toolUses,
			usage: turn.usage,
			ms: Date.now() - started
		});
		return turn;
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		logCall({
			inputTokens: 0,
			outputTokens: 0
		}, message);
		journal.log({
			kind: "error",
			where: `referee:${step}`,
			message
		});
		throw e;
	}
}
//#endregion
//#region src/runtime/turn.ts
/**
* THE TURN MACHINE
* ================
*
* What happens between the player pressing return and the screen changing.
*
* The machine owns none of the rules and none of the prose. It asks a
* `Referee` what should happen, hands the answer to the applier, and decides
* where the game goes next. That division is the whole point: in Phase 3 the
* referee is a fixture returning canned envelopes, in Phase 4 it is the model,
* and nothing in this file changes when they swap.
*
* Two axes move together here and are easy to confuse. `stage` is what the
* PLAYER is being told — it opens and closes the input area. `step` is where
* the REFEREE is in the heuristic — it selects the step file loaded into the
* next call. See runtime/types.ts.
*
* WHAT THIS FILE DECIDES, as against what the referee decides:
*
*   - that a refused commit is worth exactly one more ask (§5: no partial
*     fallback, and a second failure surfaces)
*   - when a turn has CLOSED, and so when the clock ticks and the exchange is
*     thrown away
*   - that the player moving rooms means a room entry, whatever the referee
*     thought `nextStage` should be
*
* Everything else — what happened, what changed, what it reads like — is the
* referee's, and arrives as prose plus a commit.
*
* No React. No llm/client. Runs under vitest against the real store and the
* real applier.
*/
/**
* Resolve a spec with the run's RNG.
*
* `spec.dc` is already the number to meet for all three kinds — see the note on
* RollSpec — so every roll is the one contest, and only an attack that means to
* hurt goes on to roll damage.
*/
function resolveSpec(rng, spec) {
	const outcome = checkRoll(rng, spec.bonus, spec.dc, spec.edge);
	const crit = critEffects(outcome);
	const rolled = {
		spec,
		rolled: outcome.rolled,
		kept: outcome.kept,
		total: outcome.total,
		success: outcome.success,
		nat20: outcome.nat20,
		nat1: outcome.nat1,
		crit: {
			defenderArmor: crit.defenderArmor,
			attackerWeapon: crit.attackerWeapon
		}
	};
	if (outcome.success && spec.kind === "attack" && spec.mode !== "stunt" && spec.damage) rolled.damage = rollDamage(rng, spec.damage, crit.extraDamageDice);
	return rolled;
}
/** The dice, as a line in the scrollback. Terms of the bet, never the DC. */
function describeRoll(o) {
	const sign = o.spec.bonus >= 0 ? "+" : "";
	const dice = o.rolled.length > 1 ? `[${o.rolled.join(", ")}] keep ${o.kept}` : `${o.kept}`;
	const edge = o.spec.edge === "none" ? "" : ` (${o.spec.edge})`;
	const damage = o.damage ? ` · ${o.damage.expr} → ${o.damage.total}` : "";
	const crit = o.nat20 ? " · CRITICAL" : o.nat1 ? " · FUMBLE" : "";
	return `${o.spec.ability.toUpperCase()} ${o.spec.kind}${edge}: ${dice} ${sign}${o.spec.bonus} = ${o.total} — ${o.success ? "success" : "failure"}${crit}${damage}`;
}
/** Stages a turn ends on. Reaching one closes the exchange. */
var CLOSING_STAGES = [
	"awaiting_action",
	"dead",
	"goal_met"
];
/**
* The commit, and what the applier made of it.
*
* Both halves in one record, because reading them apart is useless: a diff that
* was proposed and a diff that was applied look identical, and the whole
* question when a turn goes wrong is which of the two happened. `lastEvents`
* carries the consequences the applier performed that nobody asked for — an
* item destroyed at zero quality, armour that fell off because it became
* illegal — and those belong with it.
*/
function logCommit(journal, commit, result, retry, events) {
	journal.log({
		kind: "commit",
		commit,
		ok: result.ok,
		...result.ok ? {} : { reasons: result.reasons },
		...result.ok && events.length > 0 ? { events } : {},
		...retry ? { retry } : {}
	});
}
/** For the move record. Falls back to the id so a record is never blank. */
var roomName = (r, id) => theRoom(r.entities.rooms.find((x) => x.id === id)?.name || id);
function createTurnMachine(referee, deps) {
	const { store, journal = NO_JOURNAL } = deps;
	const state = () => store.getState();
	const run = () => state().run;
	/**
	* Every stage the MACHINE sets goes through here, so the journal sees them
	* all without five scattered log calls. The ones the referee sets arrive via
	* `commit` and are logged there.
	*/
	const setStage = (stage, step) => {
		const from = run()?.stage;
		state().setStage(stage, step);
		journal.log({
			kind: "stage",
			...from ? { from } : {},
			to: stage,
			step
		});
	};
	/**
	* Ask, apply, and work out what that means.
	*
	* `entering` marks the room-entry pass, which must not chain another one: a
	* room-entry commit that somehow moved the player again would otherwise
	* describe rooms forever.
	*/
	async function ask(req, entering = false) {
		const before = req.run;
		let reply;
		try {
			reply = await referee(req);
		} catch (e) {
			fail(before.step, e);
			return;
		}
		let result = state().commit(reply.commit);
		logCommit(journal, reply.commit, result, false, state().lastEvents);
		if (!result.ok) {
			try {
				reply = await referee({
					...req,
					rejections: result.reasons
				});
			} catch (e) {
				fail(before.step, e);
				return;
			}
			result = state().commit(reply.commit);
			logCommit(journal, reply.commit, result, true, state().lastEvents);
			if (!result.ok) {
				fail(before.step, new Error(result.reasons.join("; ")));
				return;
			}
		}
		const after = run();
		if (!after) return;
		state().setPending(void 0);
		const moved = !entering && after.currentRoomId !== before.currentRoomId;
		if (!moved && reply.narration.trim() !== "") {
			journal.log({
				kind: "narration",
				text: reply.narration,
				arrival: entering,
				...entering ? { roomId: before.currentRoomId } : {}
			});
			state().pushLog({
				kind: entering ? "arrival" : "referee",
				text: reply.narration,
				...entering ? { roomId: before.currentRoomId } : {}
			});
			state().pushTranscript({
				role: "referee",
				text: reply.narration
			});
		}
		if (entering) state().showRoom(after.currentRoomId);
		const stopped = state().lastEvents.find((e) => e.kind === "movement-stopped");
		const outcome = moved ? `They left ${roomName(before, before.currentRoomId)} and are now in ${roomName(after, after.currentRoomId)}.` + (stopped ? ` They meant to go further — ${stopped.detail}.` : "") : reply.narration;
		if (!entering && CLOSING_STAGES.includes(after.stage) && (reply.commit.diffs.length > 0 || isTerminal(after.stage))) {
			journal.log({
				kind: "turn",
				turn: after.turnCount + 1,
				action: req.input ?? "(continued)",
				outcome,
				diffs: reply.commit.diffs.length
			});
			state().recordTurn({
				action: req.input ?? "(continued)",
				...req.roll ? { roll: {
					kind: req.roll.spec.kind,
					total: req.roll.total,
					success: req.roll.success
				} } : {},
				...req.roll?.spec.targetId ? { target: req.roll.spec.targetId } : {},
				outcome,
				diffsApplied: reply.commit.diffs.length
			});
		}
		if (moved && !isTerminal(after.stage)) await enterRoom();
	}
	/**
	* The turn cannot be finished. Keep the world exactly as it was, put the game
	* into the one stage where the software rather than the referee is talking,
	* and leave the player's draft alone so a retry costs them nothing.
	*
	* Nothing is written to `callLog` here: the machine does not know what model
	* answered or what it cost. Whoever implements the `Referee` does, and logs.
	*/
	function fail(step, e) {
		const message = e instanceof Error ? e.message : String(e);
		console.warn("[turn] the referee could not finish:", e);
		journal.log({
			kind: "error",
			where: `turn:${step}`,
			message
		});
		const from = run()?.stage;
		state().setStage("error", step);
		journal.log({
			kind: "stage",
			...from ? { from } : {},
			to: "error",
			step
		});
	}
	/**
	* The last thing asked, so `retry` can ask it again after an error.
	*
	* IN THE RUN STATE, not in this closure. A machine is built per request on the
	* server and thrown away with the response, so a closure variable was empty
	* every time it mattered — see `PendingRequest`. Written immediately before
	* each ask and cleared by the one that lands.
	*/
	const remember = (pending) => state().setPending(pending);
	/**
	* Describe where the player is standing — but only if anything here has
	* changed since they last read it.
	*
	* THE SWEEP DECIDES, AND IT DECIDES BEFORE THE CALL. Nothing owing fresh
	* prose means the room can be re-shown exactly as they last read it: free,
	* instant, and consistent by construction, because a room the player has not
	* affected cannot drift in its retelling.
	*
	* The sweep already existed — inside `assemble`, where it ran after the
	* prompt was built and the call was going out, and the instruction it wrote
	* on an empty result was "nothing here needs new prose, hand the turn
	* straight back". A full-price round trip to be told nothing happened, and
	* in the 2026-08-10 playtest that was 5 of 11 arrivals. (8a A4.)
	*/
	async function enterRoom() {
		const r = run();
		const dungeon = state().dungeon;
		if (!r || !dungeon) return;
		const shown = r.entities.rooms.find((x) => x.id === r.currentRoomId)?.composed;
		if (shown !== void 0 && needsComposition(r).length === 0) {
			journal.log({
				kind: "narration",
				text: shown,
				arrival: true,
				roomId: r.currentRoomId
			});
			state().pushLog({
				kind: "arrival",
				text: shown,
				roomId: r.currentRoomId
			});
			state().pushTranscript({
				role: "referee",
				text: shown
			});
			state().showRoom(r.currentRoomId);
			setStage("awaiting_action", "1-target");
			return;
		}
		setStage("room_entry", "room-entry");
		remember({
			step: "room-entry",
			entering: true
		});
		await ask({
			step: "room-entry",
			dungeon,
			run: run()
		}, true);
	}
	async function submit(text) {
		const r = run();
		const dungeon = state().dungeon;
		if (!r || !dungeon || !acceptsInput(r.stage) || text.trim() === "") return;
		journal.log({
			kind: "player",
			text
		});
		state().pushLog({
			kind: "player",
			text
		});
		state().pushTranscript({
			role: "player",
			text
		});
		const step = r.step;
		setStage("thinking", step);
		remember({
			input: text,
			step,
			entering: false
		});
		await ask({
			step,
			dungeon,
			run: run(),
			input: text
		});
	}
	async function roll() {
		const r = run();
		const dungeon = state().dungeon;
		if (!r || !dungeon || r.stage !== "roll_offered" || !r.pendingRoll) return;
		setStage("rolling", "4-confirm-roll");
		const rng = state().rng();
		const outcome = resolveSpec(rng, r.pendingRoll);
		state().syncRng(rng);
		journal.log({
			kind: "roll",
			source: "player",
			outcome,
			draws: rng.draws
		});
		state().pushLog({
			kind: "roll",
			text: describeRoll(outcome)
		});
		state().pushTranscript({
			role: "roll",
			text: describeRoll(outcome)
		});
		setStage("resolving", "5-resolution");
		remember({
			roll: outcome,
			step: "5-resolution",
			entering: false
		});
		await ask({
			step: "5-resolution",
			dungeon,
			run: run(),
			roll: outcome
		});
	}
	async function retry() {
		const r = run();
		const dungeon = state().dungeon;
		if (!r || !dungeon || r.stage !== "error" || !r.pending) return;
		const { input, roll: rolled, step, entering } = r.pending;
		setStage(entering ? "room_entry" : rolled ? "resolving" : "thinking", step);
		await ask({
			step,
			dungeon,
			run: run(),
			input,
			roll: rolled
		}, entering);
	}
	return {
		enterRoom,
		submit,
		roll,
		retry
	};
}
//#endregion
//#region src/runtime/session.ts
/**
* A RUN, AS ONE OBJECT
* ====================
*
* Everything a single run needs to exist: its store, its journal, its referee,
* its turn machine, and the sequence that gets it from a seed to a player
* standing in the first room.
*
* That sequence used to live inside `App.tsx`, in a function called `begin`,
* interleaved with `setScreen` and `setProgress` and a ref guarding React's
* development double-mount. None of it was React's business — attach a journal,
* write the first line, generate, start the store, describe the room — and all
* of it is exactly what a server handler has to do when a player asks for a new
* run. Leaving it in a component meant the only way to play a run was to render
* one.
*
* So it is here, and the component above it does what a component should: shows
* what the store says and calls these four methods.
*
* NOTHING IS SHARED BETWEEN SESSIONS. The store and the journal are made per
* session, not imported, which is the whole point of the exercise — two
* sessions in one process are two runs and cannot see each other. See the notes
* atop `store/game.ts` and `runtime/journal.ts` for what that replaced.
*
* No React. Runs under vitest and under `node` — see `dev/cli-play.ts`, which
* plays a whole run through this with no browser anywhere.
*/
/**
* An error, said usefully.
*
* "response did not match the expected shape" is what a `ResponseFormatError`
* says on its own, and on a screen it is worth nothing: it names no pass, no
* chunk, and no field. The issues are right there on the error, so the first
* few of them go into the message — enough to tell a prompt problem from a bad
* roll of the dice without opening anything.
*/
function describeFailure(e) {
	const message = e instanceof Error ? e.message : String(e);
	if (!(e instanceof ResponseFormatError) || e.issues.length === 0) return message;
	const shown = e.issues.slice(0, 3).map((i) => `${i.path}: ${i.message}`);
	const rest = e.issues.length - shown.length;
	return `${message} — ${shown.join("; ")}${rest > 0 ? `, and ${rest} more` : ""}`;
}
function createGameSession(opts = {}) {
	const store = createGameStore();
	const generate = opts.generate ?? generateDungeon;
	let id;
	let journal;
	let machine;
	let begun = false;
	/**
	* The journal, the referee, and the machine, in that order — each needs the
	* one before it. Called by both entry points, because a resumed run is as
	* entitled to a journal as a new one.
	*/
	function wire(runId) {
		id = runId;
		journal = createJournal(opts.sink?.(runId), opts.startSeq ?? 0);
		machine = createTurnMachine(opts.referee?.({
			store,
			journal
		}) ?? createModelReferee({
			store,
			journal,
			...opts.maxRounds !== void 0 ? { maxRounds: opts.maxRounds } : {},
			...opts.signal ? { signal: opts.signal } : {}
		}), {
			store,
			journal
		});
	}
	/**
	* The machine, or nothing. Every method below is reachable from an interface
	* that could call it before the run exists — a stray keystroke during
	* generation, a resumed page — and doing nothing is the honest answer.
	*/
	const turn = () => machine;
	return {
		store,
		get runId() {
			return id;
		},
		async begin({ seed, size, level, character }) {
			if (begun) return;
			begun = true;
			wire(runId(seed));
			journal.log({
				kind: "run",
				runId: id,
				seed,
				size,
				level,
				offline: opts.offline ?? false,
				models: MODELS,
				character
			});
			let dungeon;
			try {
				dungeon = await generate({
					seed,
					size,
					level,
					journal,
					...opts.onProgress ? { onProgress: opts.onProgress } : {},
					...opts.signal ? { signal: opts.signal } : {}
				});
			} catch (e) {
				journal.log({
					kind: "error",
					where: "session:generate",
					message: describeFailure(e)
				});
				console.error("[session] generation failed:", e);
				throw e;
			}
			journal.log({
				kind: "dungeon",
				dungeon
			});
			store.getState().start(dungeon, character);
			await turn().enterRoom();
		},
		restore(saved, existingId) {
			begun = true;
			wire(existingId ?? runId(saved.dungeon.seeds.dungeonSeed));
			store.setState({
				dungeon: saved.dungeon,
				run: saved.run,
				lastEvents: []
			});
		},
		async enterRoom() {
			await turn()?.enterRoom();
		},
		async submit(text) {
			await turn()?.submit(text);
		},
		async roll() {
			await turn()?.roll();
		},
		async retry() {
			await turn()?.retry();
		},
		/**
		* A local run walks away too.
		*
		* There is no server to tell and no roster to free a character on, so this
		* is the stage and nothing else — but the control exists on the play screen
		* and interface work is done under `?stub`, so a button that did nothing
		* there would be a button nobody could look at.
		*/
		async abandon() {
			const run = store.getState().run;
			if (!run || isTerminal(run.stage)) return;
			journal?.log({
				kind: "stage",
				from: run.stage,
				to: "abandoned",
				step: run.step
			});
			store.getState().setStage("abandoned", run.step);
		}
	};
}
//#endregion
//#region src/runtime/journal-render.ts
/**
* THE JOURNAL, AS SOMETHING YOU WOULD ACTUALLY READ
* =================================================
*
* `journal.jsonl` is the record and this is the reading. Same events, one
* projection each: the file this produces drops the prompts, the token counts,
* the latencies and the sequence numbers — about 95% of the bytes — and keeps
* the run as it was played.
*
* It is a pure function of the journal, so it is also disposable: if the two
* ever disagree the journal wins and this can be regenerated from it.
*
* A PURE MODULE ON PURPOSE. It is imported by the Vite dev server as well as by
* the app, so every import here is `import type` and nothing in it touches a
* DOM, a filesystem, or the engine.
*/
var rule = "\n---\n";
/**
* One event, as markdown. `undefined` means it belongs in the record and not
* in the reading — a prompt, a stage transition nobody needs narrated.
*/
function render(r) {
	switch (r.kind) {
		case "run": return [
			`# Run ${r.runId}`,
			``,
			`**Seed** ${r.seed} · **size** ${r.size} · **level** ${r.level}${r.offline ? " · offline dungeon" : ""}`,
			`**Character** ${r.character.name}, level ${r.character.level}, ${r.character.hp.current}/${r.character.hp.max} hp`,
			`**Models** ${Object.entries(r.models).map(([task, model]) => `${task} → ${model}`).join(" · ")}`,
			``,
			`Started ${r.at}.`
		].join("\n");
		case "dungeon": return dungeon(r);
		case "player": return `${rule}\n> ${r.text.replace(/\n/g, "\n> ")}`;
		case "narration": return r.arrival ? `\n## Arrival\n\n${r.text}` : `\n${r.text}`;
		case "roll": return r.source === "player" ? `\n\`${playerRoll(r)}\`` : `\n${r.outcomes.map((o) => `\`referee · ${o.id}: ${o.line}\``).join("\n")}`;
		case "commit": return commit(r);
		case "response": return working(r.text);
		case "stage": return r.to === "dead" || r.to === "goal_met" ? `\n**${r.to === "dead" ? "The run ends here." : "The goal is met."}**` : void 0;
		case "turn": return `\n*Turn ${r.turn} closed — ${r.diffs} change${r.diffs === 1 ? "" : "s"}.*`;
		case "error": return `\n> [!WARNING]\n> **${r.where}** — ${r.message}`;
		case "generation-error": {
			const where = `${r.pass}${r.chunk === void 0 ? "" : ` chunk ${r.chunk}`}`;
			const issues = r.issues.map((i) => `> - \`${i.path}\`: ${i.message}`).join("\n");
			return `\n> [!WARNING]\n> **${where}, attempt ${r.attempt}** — ${r.message}` + (issues ? `\n>\n${issues}` : "") + `\n>\n> ${r.willRetry ? "Retrying." : "Giving up."}`;
		}
		case "generation":
		case "system":
		case "prompt": return;
	}
}
function playerRoll(r) {
	const o = r.outcome;
	const dice = o.rolled.length > 1 ? `[${o.rolled.join(", ")}] keep ${o.kept}` : `${o.kept}`;
	const sign = o.spec.bonus >= 0 ? "+" : "";
	const crit = o.nat20 ? " · CRIT" : o.nat1 ? " · FUMBLE" : "";
	const damage = o.damage ? ` · ${o.damage.expr} → ${o.damage.total}` : "";
	return `player · ${o.spec.ability.toUpperCase()} ${o.spec.kind}: ${dice} ${sign}${o.spec.bonus} = ${o.total} vs ${o.spec.dc} — ${o.success ? "success" : "failure"}${crit}${damage}`;
}
function commit(r) {
	const out = [];
	if (!r.ok) {
		out.push(`\n> [!CAUTION]\n> **Commit refused${r.retry ? " (again)" : ""}** — nothing was applied.`, ...(r.reasons ?? []).map((x) => `> - ${x}`));
		return out.join("\n");
	}
	const prose = r.commit.diffs.filter((d) => d.path === "state" || d.path === "composed");
	const values = r.commit.diffs.filter((d) => d.path !== "state" && d.path !== "composed");
	if (prose.length > 0) out.push(`\n<details><summary>${prose.length} description${prose.length === 1 ? "" : "s"} written</summary>\n`, ...prose.map((d) => `\n**\`${d.entityId}\` · ${d.path}**\n\n${String(d.value)}\n`), `</details>`);
	if (values.length > 0) out.push(`\n<details><summary>${values.length} change${values.length === 1 ? "" : "s"}</summary>\n`, ...values.map((d) => `- \`${describeDiff(d)}\``), `\n</details>`);
	for (const e of r.events ?? []) out.push(`\n*${e.kind}: ${e.detail}*`);
	return out.length ? out.join("\n") : void 0;
}
function working(text) {
	const outside = text.replace(/<post>[\s\S]*?<\/post>/gi, "").trim();
	if (outside === "") return void 0;
	return `\n<details><summary>referee working</summary>\n\n\`\`\`\n${outside}\n\`\`\`\n\n</details>`;
}
/**
* The dungeon, room by room.
*
* The whole thing is in the record as JSON; this is the version you can read
* to judge whether generation did a good job — which is a question about prose,
* so it prints the prose.
*/
function dungeon(r) {
	const d = r.dungeon;
	const e = d.entities;
	const reg = e.registry;
	const base = (x) => x.base?.trim() || (x.narrative?.blueprintId ? reg.groups?.[x.narrative.blueprintId]?.base ?? "" : "") || "";
	const inRoom = (roomId) => {
		const lines = [];
		for (const c of e.creatures.filter((x) => x.roomId === roomId)) lines.push(`  - **${c.name}**${(c.count ?? 1) > 1 ? ` ×${c.count}` : ""} (creature) — ${base(c)}` + (c.activity ? `\n    *doing:* ${c.activity}` : ""));
		for (const f of e.features.filter((x) => x.roomId === roomId)) lines.push(`  - **${f.name}** (feature)${f.isHidden ? " — *hidden*" : ""} — ${base(f)}`);
		for (const i of e.items.filter((x) => x.parentId === roomId)) lines.push(`  - **${i.name}** (item)${i.isHidden ? " — *hidden*" : ""} — ${base(i)}`);
		return lines;
	};
	const rooms = e.rooms.map((room) => {
		const exits = e.connectors.filter((c) => touches(c, room.id)).map((c) => {
			const to = farSide(c, room.id);
			const name = to === null ? "**out of the dungeon**" : e.rooms.find((x) => x.id === to)?.name ?? to;
			return `  - ${c.name} → ${name}${c.conditional ? ` — *blocked: ${c.conditional}*` : ""}${c.isHidden ? " — *concealed*" : ""}`;
		});
		const contents = inRoom(room.id);
		return [
			`\n### ${room.name}`,
			`\`${room.id}\``,
			``,
			base(room),
			contents.length ? `\n**In it**\n${contents.join("\n")}` : `\n*Empty.*`,
			exits.length ? `\n**Ways out**\n${exits.join("\n")}` : ``
		].join("\n");
	});
	return [
		`${rule}`,
		`# The dungeon: ${d.pass.name}`,
		``,
		`**Theme.** ${d.pass.theme}`,
		``,
		`**History.** ${d.pass.history}`,
		``,
		`**Goal.** ${d.pass.goal.summary}`,
		``,
		`> ${d.pass.goal.spec.replace(/\n/g, "\n> ")}`,
		``,
		`${e.rooms.length} rooms · ${e.creatures.length} creature groups · ${e.items.length} items · ${e.features.length} features · ${e.hazards.length} hazards`,
		``,
		e.hazards.length ? `**Hazards.** ${e.hazards.map((h) => `${h.name} — ${base(h)}`).join(" · ")}` : ``,
		``,
		`## Opening`,
		``,
		d.pass.openingProse,
		``,
		`## Rooms`,
		...rooms,
		rule,
		`# The run`
	].join("\n");
}
//#endregion
//#region src/server/db.ts
/**
* THE CONNECTION
* ==============
*
* One pool, made once per process, over Supabase's Supavisor pooler.
*
* WHY THE POOLER AND NOT THE DATABASE DIRECTLY. Postgres charges real memory
* for every connection and tops out in the low hundreds; a serverless platform
* answers a burst of requests by starting a burst of instances, each of which
* would open its own. Supavisor sits in front and multiplexes them, so a
* hundred cold starts are a handful of backend connections. Port 6543 is
* transaction mode — a connection is handed back at the end of each
* transaction rather than held for the life of the client, which is the mode
* that matches a request-shaped workload.
*
* TRANSACTION MODE FORBIDS PREPARED STATEMENTS. A prepared statement lives on
* the backend connection, and in transaction mode the next query may land on a
* different one — so `prepare: false` is not a tuning knob, it is the thing
* that stops "prepared statement s1 already exists" showing up under load and
* never in development. postgres.js prepares by default.
*
* ONE POOL PER PROCESS, module-level, and that is deliberate — the opposite of
* the rule the store and the journal follow. Those hold per-run state and a
* singleton would let two runs see each other. A pool holds no run state at
* all; it is a socket cache, and making one per request would spend a TCP and
* TLS handshake on every turn.
*
* Node only. Nothing under `src/runtime` or `src/store` may import this.
*/
var sql;
/**
* The connection string, from the environment.
*
* Named rather than assembled, because the pooler's host, port and username
* form are Supabase's to change and a template here would be a thing to get
* subtly wrong. Supabase dashboard → Project Settings → Database → Connection
* string → **Transaction pooler**.
*/
function connectionString() {
	const url = process.env.DATABASE_URL;
	if (!url) throw new Error("DATABASE_URL is not set. Copy the TRANSACTION POOLER connection string from the Supabase dashboard (Project Settings → Database) into .env.local.");
	if (!url.includes(":6543")) console.warn("[db] DATABASE_URL is not on port 6543. Serverless wants the transaction pooler.");
	return url;
}
function db() {
	return sql ??= postgres(connectionString(), {
		prepare: false,
		connect_timeout: 10,
		idle_timeout: 20,
		max: 4,
		onnotice: () => {}
	});
}
//#endregion
//#region src/server/repo.ts
/**
* THE DATABASE, AS FUNCTIONS
* ==========================
*
* Every statement the server runs, in one place. Handlers above this file ask
* for things; nothing above this file writes SQL.
*
* Two keyspaces, the same split `src/store/persist.ts` has always made: a
* dungeon is large and written twice — once partial, once complete — and a run
* is small and written on every turn.
*
* THE ONE THING WORTH READING BEFORE THE REST is `commitTurn`. It is the write
* that has to be correct under two requests at once, and everything it does is
* one transaction on purpose. See the note above it.
*
* Node only.
*/
/**
* A document, on its way into a jsonb column.
*
* postgres.js types `sql.json` against its own JSON value union, which nothing
* declared with an interface satisfies structurally. The cast is here, once and
* named, rather than at each of the six call sites — everything passed through
* it is a plain serialisable document and has always been (see the note on
* `GeneratedDungeon`, which has been going in and out of IndexedDB since
* Phase 2).
*/
var doc = (sql, value) => sql.json(value);
/**
* A run's status, from the stage it is standing in.
*
* `departed` is deliberately absent: the store resolves it into `escaped` or
* `goal_met` the moment a commit lands — which ending a departure was depends
* on world state rather than on what the referee remembered — so it can never
* be what is persisted. See `endingOf` in store/game.ts.
*/
function statusOf(stage) {
	if (stage === "dead" || stage === "escaped" || stage === "goal_met") return stage;
	if (stage === "abandoned") return "abandoned";
	return "active";
}
var NO_RECORD = () => ({
	dead: 0,
	abandoned: 0,
	escaped: 0,
	goalMet: 0
});
/**
* The characters screen, in three queries rather than one clever one.
*
* Stitched in TypeScript on purpose. The same thing as a single statement is a
* pair of lateral joins over an aggregate, which is harder to read than the
* three obvious selects and no faster at this size — a player has a handful of
* characters, and both supporting queries hit an index whose leading column is
* the owner.
*
* A CHARACTER WITH NO RUNS GETS ZEROES, not an absent record. The screen renders
* the same row either way, and a caller should never have to ask whether a
* missing count means none or means unknown.
*/
async function listRoster(owner, sql = db()) {
	const [sheets, counts, active] = await Promise.all([
		sql`
      select id, sheet from characters where owner_id = ${owner} order by created_at asc
    `,
		sql`
      select character_id as "characterId", status, count(*)::int as n
        from runs
       where owner_id = ${owner} and character_id is not null and status <> 'active'
       group by character_id, status
    `,
		sql`
      select r.character_id                                    as "characterId",
             r.id                                              as "id",
             r.dungeon_id                                      as "dungeonId",
             coalesce(d.doc -> 'pass' ->> 'name', 'Unnamed')   as "dungeonName",
             coalesce((r.state ->> 'turnCount')::int, 0)       as "turnCount"
        from runs r join dungeons d on d.id = r.dungeon_id
       where r.owner_id = ${owner} and r.status = 'active' and r.character_id is not null
    `
	]);
	const records = /* @__PURE__ */ new Map();
	for (const row of counts) {
		const record = records.get(row.characterId) ?? NO_RECORD();
		if (row.status === "goal_met") record.goalMet = row.n;
		else if (row.status !== "active") record[row.status] = row.n;
		records.set(row.characterId, record);
	}
	const runs = new Map(active.map((r) => [r.characterId, r]));
	return sheets.map(({ id, sheet }) => {
		const run = runs.get(id);
		return {
			sheet,
			record: records.get(id) ?? NO_RECORD(),
			...run ? { activeRun: {
				id: run.id,
				dungeonId: run.dungeonId,
				dungeonName: run.dungeonName,
				turnCount: run.turnCount
			} } : {}
		};
	});
}
/**
* The run this character is in, or nothing.
*
* Asked before a new run is created and before a character is deleted. NOT the
* enforcement — the partial unique index is, and a check here could always lose
* a race with a second request. This is what turns the violation the index
* raises into an answer that names the run, which is the thing the player needs
* in order to do anything about it.
*/
async function activeRunFor(characterId, owner, sql = db()) {
	const [row] = await sql`
    select id, dungeon_id as "dungeonId" from runs
     where owner_id = ${owner} and character_id = ${characterId} and status = 'active'
  `;
	return row;
}
/**
* Insert or replace, keyed on the sheet's own id.
*
* The character carries its id — it was made in the browser and has been in a
* run under that name — so the row takes it rather than minting another.
*
* `and owner_id = ${owner}` ON THE UPDATE BRANCH is what stops one player
* overwriting another's sheet by posting a character carrying their id. Without
* it the `on conflict` would happily update a row it does not own, which is the
* one way an upsert can leak where a plain insert cannot. An attempt to do so
* now updates nothing and reports it, rather than silently succeeding.
*/
async function saveCharacter(pc, owner, sql = db()) {
	if ((await sql`
    insert into characters (id, owner_id, sheet)
    values (${pc.id}, ${owner}, ${doc(sql, pc)})
    on conflict (id) do update
       set sheet = excluded.sheet, updated_at = now()
     where characters.owner_id = ${owner}
    returning id
  `).length === 0) throw new Error(`not yours to save: ${pc.id}`);
	return pc;
}
/**
* WHAT A CHARACTER BRINGS BACK UP.
*
* Called only when a run ended with the player alive and out — `escaped` or
* `goal_met`. The run's own `pc` has been diverging from the sheet since the
* first turn (gear picked up, coin spent, armour worn down) and on a successful
* ending it becomes the sheet. Same id, so the Phase 11 upsert lands on the same
* row.
*
* DEATH AND ABANDONMENT WRITE NOTHING, which is how "the character as they were
* before the run" is achieved: nothing touches `characters.sheet` during a run,
* so the stored sheet is still the pre-run one and there is no snapshot to take
* and no restore to perform. The only trace either leaves is a row in `runs`,
* which is what the counters read.
*
* HIT POINTS RETURN TO MAX, and that is a decision rather than a consequence.
* There is no downtime, no rest and no healing outside a run, so a character who
* surfaces at 1/15 can only die next time — which quietly turns "escaped alive"
* into a delayed death and makes the ending worthless.
*
* ── IF WOUNDS SHOULD CARRY, THIS IS THE WHOLE CHANGE ───────────────────────
*
* The line below is the only thing standing between a survivor and the hit
* points they climbed out on. To keep the damage:
*
*     return pc;                       // and delete the spread above
*
* That is the code. What it needs BESIDE it is the reason this was not done in
* the first place — some way back to full, or the ending stops meaning
* anything. Any one of these would do, cheapest first:
*
*   - a flat heal between runs that is less than everything (half the missing,
*     a die, a point per level), so a bad run costs the next one something
*     without ending it;
*   - rest as a real action with a real cost — rations, a light clock, a
*     wandering-monster roll — which is where Knave already points and which
*     `turnCount` was put in `RunState` for (BUILD-PLAN §6, Phase 2);
*   - healing bought in the shop, which is the other half of Phase 5's
*     equipment step and is still open (CODING-PLAN §3.6).
*
* Whichever one lands, this function is where it goes, and `ownership.dbtest.ts`
* — "keeps what they carried, and heals them, when they got out alive" — is the
* test that has to change with it.
* ───────────────────────────────────────────────────────────────────────────
*/
function carriedOut(pc) {
	return {
		...pc,
		hp: {
			...pc.hp,
			current: pc.hp.max
		}
	};
}
async function deleteCharacter(id, owner, sql = db()) {
	return (await sql`
    delete from characters where id = ${id} and owner_id = ${owner} returning id
  `).length > 0;
}
/**
* The structure pass, stored, and the row id it was given.
*
* Returns the ROW id, which is what every later request names. The caller must
* not assume it can reconstruct this from the seed — that assumption is exactly
* what the key split removed.
*/
async function insertPartialDungeon(gd, owner, sql = db()) {
	const [row] = await sql`
    insert into dungeons (dungeon_key, owner_id, seed, size, level, status, doc)
    values (${gd.id}, ${owner}, ${gd.seeds.dungeonSeed}, ${gd.size}, ${gd.level},
            'partial', ${doc(sql, gd)})
    returning id
  `;
	return row.id;
}
/**
* A dungeon, in full, for the player who owns it.
*
* OWNER IN THE WHERE CLAUSE, not an `if` after the read: someone else's dungeon
* is indistinguishable from one that does not exist, so the API never confirms
* that a row it will not serve is there.
*/
async function getDungeon(id, owner, sql = db()) {
	const [row] = await sql`
    select id, dungeon_key as "dungeonKey", owner_id as "ownerId", status, doc
      from dungeons where id = ${id} and owner_id = ${owner}
  `;
	return row;
}
/** The player's own worlds, newest first. Summaries — nobody needs six `doc`s. */
async function listDungeons(owner, sql = db()) {
	return sql`
    select id,
           coalesce(doc -> 'pass' ->> 'name', 'Unnamed')            as name,
           coalesce(doc -> 'pass' -> 'goal' ->> 'summary', '')      as objective,
           size, level, seed, status,
           created_at as "createdAt"
      from dungeons
     where owner_id = ${owner}
     order by created_at desc
  `;
}
/**
* The finished world, written over the partial.
*
* `where status = 'partial'` so a second `finish` — a retried request, a client
* that fired twice — cannot overwrite a complete dungeon with one built from
* responses that may since have been added to. Returns whether it was this call
* that completed it.
*
* Takes the ROW id explicitly, because `gd.id` is the engine's derived name and
* is no longer the key. Passing `gd` alone would compile and address the wrong
* column forever.
*/
async function completeDungeon(id, gd, owner, sql = db()) {
	return (await sql`
    update dungeons
       set doc = ${doc(sql, gd)}, status = 'complete', updated_at = now()
     where id = ${id} and owner_id = ${owner} and status = 'partial'
    returning id
  `).length > 0;
}
/** How many worlds a batch is, and the most one request may ask for. */
var LIBRARY_BATCH = 12;
var LIBRARY_MAX = 48;
var UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/**
* A cursor, or nothing — and **validated here rather than by Postgres**.
*
* 🔴 THIS IS A REFUSAL, NOT TIDINESS. A cursor arrives from a query string, so
* it is whatever a caller typed. Handed on unchecked, `?cursor=x|y` binds `x` to
* a `timestamptz` parameter and **the driver throws while serialising it**
* (`RangeError: Invalid time value`, inside postgres.js, before the statement is
* sent) — which the API renders as a 500. A malformed page token is not an
* internal error; it is a caller saying nothing legible, and the honest answer
* is the front of the shelf. Found by `ownership.dbtest.ts`.
*
* Split on the FIRST separator: a `timestamptz::text` holds no `|` and a uuid
* holds none, so anything with a different shape is not a cursor this file made.
*/
function readCursor(cursor) {
	if (!cursor) return void 0;
	const cut = cursor.indexOf("|");
	if (cut <= 0) return void 0;
	const at = cursor.slice(0, cut);
	const id = cursor.slice(cut + 1);
	if (!UUID.test(id) || Number.isNaN(Date.parse(at))) return void 0;
	return {
		at,
		id
	};
}
/**
* EVERY COMPLETE WORLD SOMEBODY ELSE MADE, newest first, a batch at a time.
*
* The second of the two cross-owner reads, and it obeys the same rule as
* `duplicateDungeon`: what crosses the line is a SUMMARY. Never `doc`, which is
* every answer in the world — browsing must not be a way to read a dungeon you
* have not walked. `DungeonSummary` has been the shape of that promise since
* Phase 11 with nothing to serve it; this is what it was for.
*
* NO MAKER ATTRIBUTION, deliberately. The only name this project holds for an
* account is `profiles.email`, and a browse screen that printed it would be a
* way to enumerate the invite list. A world is offered on what it is, not on
* whose it was.
*
* KEYSET AND NOT OFFSET. A batch boundary has to survive a dungeon being written
* while the player is scrolling: `offset 12` after an insert shows row 12 twice
* and never shows row 13. `(created_at, id) < (…)` is anchored to the last row
* actually seen, so an insert above the cursor changes nothing below it. The id
* is in the comparison because `created_at` is the transaction clock and two
* rows can share it exactly — see the migration.
*
* THE CURSOR IS BUILT IN SQL, not from the row in TypeScript. `timestamptz` is a
* `Date` by the time the driver is done with it, and formatting one back to
* something Postgres reads identically is a round trip through two libraries'
* opinions about microseconds. `created_at::text` round-trips with itself.
*/
async function listLibrary(viewer, opts = {}, sql = db()) {
	const asked = Math.trunc(Number(opts.limit));
	const limit = Number.isFinite(asked) ? Math.min(Math.max(asked, 1), LIBRARY_MAX) : LIBRARY_BATCH;
	const at = readCursor(opts.cursor);
	const rows = await sql`
    select id,
           coalesce(doc -> 'pass' ->> 'name', 'Unnamed')            as name,
           coalesce(doc -> 'pass' -> 'goal' ->> 'summary', '')      as objective,
           size, level, seed, status,
           created_at                                              as "createdAt",
           created_at::text || '|' || id::text                     as "cursor"
      from dungeons
     where status = 'complete'
       and owner_id <> ${viewer}
       ${at ? sql`and (created_at, id) < (${at.at}::text::timestamptz, ${at.id}::text::uuid)` : sql``}
     order by created_at desc, id desc
     limit ${limit + 1}
  `;
	const more = rows.length > limit;
	const page = rows.slice(0, limit);
	return {
		dungeons: page.map(({ cursor: _cursor, ...summary }) => summary),
		...more && page.length > 0 ? { cursor: page[page.length - 1].cursor } : {}
	};
}
/**
* TAKE A COPY OF A WORLD — the one statement in this file that reads a row
* without asking whose it is.
*
* Every other read here puts the owner in the `where`, and that rule is not
* being bent: what this reads cross-owner is the ROW, and what it does with it
* is write a new one belonging to the caller. Nothing about the source is ever
* returned. A dungeon is the one thing another player may see (§8.1), and this
* is the whole of what "see" means — a copy of your own, not a look at theirs.
*
* WHAT COMES ACROSS, and what does not:
*
*   - the row and its `doc`, under a fresh uuid. The `doc` keeps its own
*     engine-derived `id` untouched, exactly as `insertPartialDungeon` leaves
*     it: that is the name of the WORLD and both copies are that world.
*   - `dungeon_events`, because a run's journal is generation followed by play
*     (`readJournal`) and a copy without them yields a transcript that starts
*     mid-air. It is also where the `kind: "dungeon"` baseline lives, which is
*     what `journal-render.ts` prints when someone wants to judge the writing.
*   - NOT `generation_chunks`. Only `finish` reads those, a complete dungeon
*     never finishes again, and they are the unapplied raw responses — the
*     largest thing in the schema and the least use to anybody holding the
*     applied world.
*
* COMPLETE ONLY. Half a world is not worth copying, and `finish` on the copy
* would have no chunks to finish from.
*
* `undefined` means no such complete dungeon — one answer for "not there" and
* "still being written", because a caller who may not have it either way should
* not learn which.
*/
async function duplicateDungeon(sourceId, owner, sql = db()) {
	return sql.begin(async (tx) => {
		const [source] = await tx`
      select id from dungeons where id = ${sourceId} and status = 'complete'
    `;
		if (!source) return void 0;
		const [mine] = await tx`
      select id from dungeons where owner_id = ${owner} and copied_from = ${sourceId}
    `;
		if (mine) return {
			id: mine.id,
			already: true
		};
		const [copy] = await tx`
      insert into dungeons (dungeon_key, owner_id, seed, size, level, status, doc, copied_from)
      select dungeon_key, ${owner}, seed, size, level, status, doc, id
        from dungeons where id = ${sourceId}
      returning id
    `;
		await tx`
      insert into dungeon_events (dungeon_id, seq, at, kind, payload)
      select ${copy.id}::uuid, seq, at, kind, payload
        from dungeon_events where dungeon_id = ${sourceId}
    `;
		return {
			id: copy.id,
			already: false
		};
	});
}
/**
* One region's answer, unapplied.
*
* `on conflict do nothing` rather than `do update`: the regions are called in
* parallel from separate requests, and a chunk that arrives twice is a retry of
* a call whose answer already landed. Keeping the first is what makes the
* request idempotent — and it has to be, because the client fires N of these
* and any one of them can be retried by anything between here and the browser.
*/
async function saveChunk(dungeonId, result, sql = db()) {
	await sql`
    insert into generation_chunks (dungeon_id, chunk, response)
    values (${dungeonId}, ${result.chunk}, ${doc(sql, result)})
    on conflict (dungeon_id, chunk) do nothing
  `;
}
async function listChunks(dungeonId, sql = db()) {
	return (await sql`
    select response from generation_chunks
     where dungeon_id = ${dungeonId}
     order by chunk asc
  `).map((r) => r.response);
}
/**
* A block's name, and the only thing that decides whether two blocks are one.
*
* Hashed HERE rather than in Postgres, so the id exists before the statement is
* composed — which is what lets the blocks and the events that reference them go
* in as two ordinary inserts instead of a round trip that asks the database what
* it would call this.
*/
var shaOf = (text) => createHash("sha256").update(text, "utf8").digest("hex");
/**
* Events on their way to a column, with each `system` block's text replaced by
* the sha that names it — and the blocks themselves, to be written first.
*
* `chars` rides along beside the sha. It is redundant against `prompt_blocks`
* and worth its twenty bytes: it is what makes the compact form READABLE on its
* own, so a journal pulled straight out of the table still says how much prose
* each call carried without a join to find out.
*
* Everything that is not a `system` event passes through untouched. The other
* repeated payloads — a `generation` prompt, the `dungeon` baseline — are real
* duplication too and are left alone on purpose: they are one write per dungeon
* rather than one per turn, so they do not grow with play, and each would want
* its own decision about what "the same" means.
*/
function dehydrate(events) {
	const blocks = /* @__PURE__ */ new Map();
	return {
		payloads: events.map((e) => {
			if (e.kind !== "system") return JSON.stringify(e);
			const slim = e.blocks.map(({ text, ...rest }) => {
				const sha = shaOf(text);
				if (!blocks.has(sha)) blocks.set(sha, {
					sha,
					chars: text.length,
					text
				});
				return {
					...rest,
					sha,
					chars: text.length
				};
			});
			return JSON.stringify({
				...e,
				blocks: slim
			});
		}),
		blocks: [...blocks.values()]
	};
}
/**
* The blocks an event batch referred to, inserted before the events that refer
* to them.
*
* `on conflict do nothing` is the normal case rather than the exception — after
* the first run in the life of the database, almost every block written here is
* already there. The insert is still worth making: deciding whether to would
* cost the round trip it saves.
*/
async function saveBlocks(sql, blocks) {
	if (blocks.length === 0) return;
	await sql`
    insert into prompt_blocks (sha, chars, text)
    select s.sha, s.chars, s.text
      from unnest(${blocks.map((b) => b.sha)}::text[],
                  ${blocks.map((b) => b.chars)}::int[],
                  ${blocks.map((b) => b.text)}::text[])
        as s(sha, chars, text)
    on conflict (sha) do nothing
  `;
}
/**
* What generation wrote down, which belongs to the dungeon rather than to any
* run — see the migration. Written once, read by every run down this dungeon.
*/
async function appendDungeonEvents(dungeonId, events, sql = db()) {
	if (events.length === 0) return;
	const { payloads, blocks } = dehydrate(events);
	await saveBlocks(sql, blocks);
	await sql`
    insert into dungeon_events (dungeon_id, seq, at, kind, payload)
    select ${dungeonId}::uuid, s.seq, s.at::timestamptz, s.kind, s.payload::jsonb
      from unnest(${events.map((e) => e.seq)}::int[],
                  ${events.map((e) => e.at)}::text[],
                  ${events.map((e) => e.kind)}::text[],
                  ${payloads}::text[])
        as s(seq, at, kind, payload)
    on conflict (dungeon_id, seq) do nothing
  `;
}
/**
* Generation's own sequence, so three requests write one ordered stream rather
* than three that each start at 1. Same reasoning as `lastSeq`.
*/
async function lastDungeonSeq(dungeonId, sql = db()) {
	const [row] = await sql`
    select coalesce(max(seq), 0)::int as seq from dungeon_events where dungeon_id = ${dungeonId}
  `;
	return row?.seq ?? 0;
}
async function readDungeonEvents(dungeonId, sql = db()) {
	return (await sql`
    select rehydrate_blocks(payload) as payload
      from dungeon_events where dungeon_id = ${dungeonId} order by seq asc
  `).map((r) => r.payload);
}
async function createRun(input, sql = db()) {
	const [row] = await sql`
    insert into runs (owner_id, dungeon_id, character_id, state, status)
    values (${input.owner}, ${input.dungeonId}, ${input.characterId ?? null},
            ${doc(sql, input.state)}, ${statusOf(input.state.stage)})
    returning id, version
  `;
	return {
		id: row.id,
		dungeonId: input.dungeonId,
		characterId: input.characterId ?? null,
		state: input.state,
		version: row.version,
		status: statusOf(input.state.stage)
	};
}
/**
* A run, for the player whose run it is.
*
* THERE IS NO OTHER READ PATH. A run is two private things at once — our log
* when something goes wrong, and the player's save file — and neither wants an
* audience. Someone else's run 404s exactly as a missing one does.
*/
async function getRun(id, owner, sql = db()) {
	const [row] = await sql`
    select id, dungeon_id as "dungeonId", character_id as "characterId",
           state, version, status
      from runs where id = ${id} and owner_id = ${owner}
  `;
	return row;
}
async function listRuns(owner, sql = db()) {
	return sql`
    select id, dungeon_id as "dungeonId", status,
           created_at as "createdAt", updated_at as "updatedAt"
      from runs where owner_id = ${owner} order by created_at desc
  `;
}
/**
* Claim a run for the length of a turn.
*
* NOT A CORRECTNESS MECHANISM. `commitTurn` below already makes concurrent
* turns safe by refusing to write against a version that has moved. This only
* turns a duplicate away BEFORE it spends a whole referee conversation — two to
* four model calls — on a turn that would be rejected at the write anyway. A
* double-click should not cost tokens.
*
* An expiry rather than a boolean so a function that dies mid-turn — timeout,
* crash, deploy — does not wedge the run until somebody notices.
*/
async function lockRun(id, owner, holdSeconds = 300, sql = db()) {
	return (await sql`
    update runs
       set locked_until = now() + make_interval(secs => ${holdSeconds})
     where id = ${id} and owner_id = ${owner}
       and (locked_until is null or locked_until < now())
    returning id
  `).length > 0;
}
async function releaseRun(id, owner, sql = db()) {
	await sql`update runs set locked_until = null where id = ${id} and owner_id = ${owner}`;
}
/**
* How many events this run has already written.
*
* A session is built fresh per request and its journal counts from whatever it
* is told — so this is what it is told. Without it the second request into a
* run numbers its events 1, 2, 3 on top of the first request's and collides on
* the primary key. See `createJournal`.
*/
async function lastSeq(runId, sql = db()) {
	const [row] = await sql`
    select coalesce(max(seq), 0)::int as seq from journal_events where run_id = ${runId}
  `;
	return row?.seq ?? 0;
}
/**
* A run's journal, whole: how its world was built, then how it was played.
*
* Two streams concatenated, which is also the order they happened in. They are
* numbered independently — generation's `seq` belongs to the dungeon, play's to
* the run — so the pair is renumbered on the way out. Nothing downstream reads
* `seq` as a key; it reads it as an order, and this is the order.
*/
async function readJournal(runId, dungeonId, sql = db()) {
	const [built, played] = await Promise.all([readDungeonEvents(dungeonId, sql), sql`
      select rehydrate_blocks(payload) as payload
        from journal_events where run_id = ${runId} order by seq asc
    `.then((rows) => rows.map((r) => r.payload))]);
	return [...built, ...played].map((e, i) => ({
		...e,
		seq: i + 1
	}));
}
/**
* A sink that keeps what it is given.
*
* The server cannot write events as they happen: they have to land in the same
* transaction as the state they describe, or a turn that is rejected at the
* write leaves a journal describing a turn that never happened. So a request's
* journal collects, and `commitTurn` decides whether any of it is real.
*/
function collectingSink() {
	const events = [];
	return {
		sink: { write: (r) => events.push(r) },
		events
	};
}
/**
* A finished turn: the new state, and the events that describe it, together.
*
* COMPARE-AND-SWAP. `where version = expected` is what makes two turns at once
* safe. Both read version N; the first writes N+1; the second finds no row to
* update and is told so. It covers the slow version of the same thing as well —
* the second tab that has been open for ten minutes and still has a live Send
* button, whose turn is not simultaneous with anything but is computed against
* a world that has moved on.
*
* A VERSION AND NOT THE STAGE the client believes it is on. The client never
* asserts anything about the rules here: an integer is opaque, so there is no
* value that is more favourable than another, and a client cannot talk its way
* into a roll by claiming to be at step 4.
*
* ONE TRANSACTION, and the journal rows are inside it. A rejected turn must
* leave nothing at all — otherwise the journal, which is the thing the whole
* database exists to keep, ends up describing a turn the state does not have.
*
* The lock is released here too, and unconditionally: the turn is over whether
* or not it was accepted.
*/
async function commitTurn(input, sql = db()) {
	return sql.begin(async (tx) => {
		const rows = await tx`
      update runs
         set state = ${doc(tx, input.state)},
             status = ${statusOf(input.state.stage)},
             version = version + 1,
             locked_until = null,
             updated_at = now()
       where id = ${input.runId} and owner_id = ${input.owner}
         and version = ${input.expectedVersion}
      returning version
    `;
		if (rows.length === 0) {
			await tx`
        update runs set locked_until = null
         where id = ${input.runId} and owner_id = ${input.owner}
      `;
			const current = await getRun(input.runId, input.owner, tx);
			if (!current) return {
				ok: false,
				reason: "gone"
			};
			return {
				ok: false,
				reason: "stale",
				current
			};
		}
		await insertEvents(tx, input.runId, input.events);
		const ending = statusOf(input.state.stage);
		if (ending === "escaped" || ending === "goal_met") {
			const pc = carriedOut(input.state.pc);
			await tx`
        update characters set sheet = ${doc(tx, pc)}, updated_at = now()
         where id = ${pc.id} and owner_id = ${input.owner}
      `;
		}
		return {
			ok: true,
			version: rows[0].version
		};
	});
}
/**
* Events in one statement rather than one per event.
*
* `unnest` over four parallel arrays, because a turn writes a dozen events and
* a round trip each would be a dozen round trips inside a transaction holding a
* pooled connection. The casts are explicit so nothing depends on the driver
* inferring a type for an empty array.
*/
async function insertEvents(tx, runId, events) {
	if (events.length === 0) return;
	const seqs = events.map((e) => e.seq);
	const ats = events.map((e) => e.at);
	const kinds = events.map((e) => e.kind);
	const { payloads, blocks } = dehydrate(events);
	await saveBlocks(tx, blocks);
	await tx`
    insert into journal_events (run_id, seq, at, kind, payload)
    select ${runId}::uuid, s.seq, s.at::timestamptz, s.kind, s.payload::jsonb
      from unnest(${seqs}::int[], ${ats}::text[], ${kinds}::text[], ${payloads}::text[])
        as s(seq, at, kind, payload)
    on conflict (run_id, seq) do nothing
  `;
}
/**
* The first write of a run's journal — generation, and the room entry.
*
* Separate from `commitTurn` because there is no version to swap on yet: the
* run has only just been created, nothing else can be holding it, and the state
* that goes with these events was written by `createRun` a moment ago.
*/
async function appendEvents(runId, events, sql = db()) {
	if (events.length === 0) return;
	await sql.begin((tx) => insertEvents(tx, runId, events));
}
//#endregion
//#region src/server/app.ts
/**
* THE API
* =======
*
* One Hono app, mounted as a single catch-all function. Every route the client
* calls is here; every statement they run is in `repo.ts`.
*
* TWO RULES SHAPE THIS WHOLE FILE.
*
* ONE MODEL CALL PER REQUEST. A Vercel Hobby invocation may run for 300
* seconds, and generation is N+2 calls. So building a dungeon is three routes —
* structure, a region at a time, then apply-and-join — and the client fires the
* middle one N times in parallel. A turn is one request because a turn is one
* exchange; its worst case is `maxRounds` calls, which fits.
*
* THE CLIENT NEVER ASSERTS A RULE. It sends what the player typed and the
* version it last saw. It does not say which stage it is on: a client that
* names its own stage can name a flattering one and be handed a roll it never
* earned. The version is opaque, so there is no value more favourable than
* another — see `commitTurn`.
*
* Node only. This is the file `vite.config.ts` used to fake with two middleware
* shims: the Anthropic proxy and the journal writer.
*/
/**
* WHERE THE MODEL CALLS GO, now that there is no dev proxy.
*
* `llm/client.ts` defaults to the relative `/api/anthropic`, which the Vite dev
* server used to intercept and attach the key to — the arrangement that kept
* the key out of the browser. That proxy is gone and this file is its
* replacement: the API calls Anthropic directly, and the key is read from the
* server's environment. The rule has not moved, only the wall — the key still
* never reaches a browser, because a browser now talks only to this.
*
* Once per process. `configureTransport` is module state in the client, which
* is right for a process that only ever talks to one provider.
*/
function configureAnthropic() {
	const key = process.env.ANTHROPIC_API_KEY;
	if (!key) throw new Error("ANTHROPIC_API_KEY is not set; the API cannot reach the model.");
	configureTransport({
		baseUrl: "https://api.anthropic.com",
		headers: {
			"x-api-key": key,
			"anthropic-version": "2023-06-01"
		}
	});
}
/**
* Who may call this API from a browser.
*
* Was a bare `cors()` — any origin at all — which was survivable while there
* was nothing behind it worth taking. Now there are accounts, and an open CORS
* policy means any page the player visits can spend their tokens with their
* session. `CORS_ORIGINS` exists so a preview deployment or an itch.io embed is
* an environment variable rather than a redeploy.
*/
function allowedOrigins() {
	return [
		"https://aidungeon.vercel.app",
		"http://localhost:5173",
		...(process.env.CORS_ORIGINS ?? "").split(",").map((s) => s.trim()).filter((s) => s !== "")
	];
}
function createApp() {
	configureAnthropic();
	const app = new Hono();
	app.use("/api/*", cors({
		origin: allowedOrigins(),
		credentials: true
	}));
	/**
	* THE GATE. Everything under `/api` needs an account.
	*
	* `/api/health` is the one exception and is registered before this: it is what
	* the twice-weekly Vercel cron hits to stop Supabase pausing the project
	* (§7.8), a cron holds no session, and it reads and writes nothing.
	*
	* Until Phase 11 this API was open, and it spends an Anthropic key. That is
	* the hole this line closes.
	*/
	app.get("/api/health", (c) => c.json({ ok: true }));
	app.use("/api/*", requireUser);
	app.onError((err, c) => {
		if (err instanceof HTTPException) return err.getResponse();
		console.error("[api]", err);
		return c.json({ error: describeFailure(err) }, 500);
	});
	/**
	* The roster: who the player has, what has happened to them, and where they
	* are. Was `PlayerCharacter[]`; a sheet alone can no longer answer the
	* question the screen asks, which is whether this person can be sent anywhere.
	*/
	app.get("/api/characters", async (c) => c.json(await listRoster(currentUser(c).id)));
	/**
	* Save a sheet — a new character, or one that has been to the market.
	*
	* EDITING SOMEBODY WHO IS STILL DOWN THERE IS REFUSED, the same way deleting
	* them is and for a neighbouring reason. A run plays from its own copy of the
	* sheet and writes what survives back when it ends, so a write from up here
	* would either be overwritten without warning or overwrite the run's own
	* result. The shop is the only caller that can reach this with an existing
	* character and it does not offer the button to anyone in a run; this is the
	* rule rather than the manners.
	*/
	app.post("/api/characters", async (c) => {
		const user = currentUser(c);
		const pc = await c.req.json();
		const active = await activeRunFor(pc.id, user.id);
		if (active) return c.json({
			error: "that character is in a run — what they are carrying is the run's now",
			runId: active.id
		}, 409);
		return c.json(await saveCharacter(pc, user.id));
	});
	/**
	* Deleting somebody who is still down there is refused.
	*
	* The foreign key is `on delete set null`, so this would otherwise succeed and
	* leave an active run belonging to nobody: a save file with no way to reach it
	* and no way to end it, holding a lock against a character that no longer
	* exists. Abandon first — that is what the verb is for.
	*/
	app.delete("/api/characters/:id", async (c) => {
		const user = currentUser(c);
		const id = c.req.param("id");
		const active = await activeRunFor(id, user.id);
		if (active) return c.json({
			error: "that character is in a run — abandon it first",
			runId: active.id
		}, 409);
		return c.json({ deleted: await deleteCharacter(id, user.id) });
	});
	/**
	* The structure and the standing fiction.
	*
	* Journalled against the DUNGEON rather than a run: the player has not
	* chosen a character yet, so there is no run for these to belong to. Every
	* run down this dungeon reads them as the opening of its own journal.
	*/
	app.post("/api/dungeons", async (c) => {
		const { seed, size, level } = await c.req.json();
		const { sink, events } = collectingSink();
		const partial = await generateStructure({
			seed,
			size,
			level,
			journal: createJournal(sink)
		});
		const dungeonId = await insertPartialDungeon(partial, currentUser(c).id);
		await appendDungeonEvents(dungeonId, events);
		return c.json({
			dungeonId,
			chunks: chunksOf(partial)
		});
	});
	/**
	* A generation pass whose journal is written WHETHER OR NOT IT SUCCEEDS.
	*
	* This was the hole. A pass that throws never reached `appendDungeonEvents`,
	* so a failed dungeon left the three `generation-error` events on the floor —
	* the exact records §6.7 was built to keep, gone again the moment the runtime
	* moved to a server. The console had them; the database did not, and the
	* console belongs to whoever was tailing the function.
	*
	* Safe to write on failure here, unlike a turn: the sequence belongs to the
	* DUNGEON, and a retry reads `lastDungeonSeq` and appends after these rather
	* than colliding with them. A turn's events are dropped on a throw for that
	* exact reason — see the note in `playTurn`.
	*
	* The structure pass cannot use this: when IT fails there is no dungeon row
	* for the events to belong to. The console is the only record of that one.
	*/
	async function journalled(dungeonId, work) {
		const { sink, events } = collectingSink();
		const journal = createJournal(sink, await lastDungeonSeq(dungeonId));
		try {
			return await work(journal);
		} finally {
			await appendDungeonEvents(dungeonId, events);
		}
	}
	/**
	* One region. The client fires these in parallel, which is the parallelism
	* the single-process pipeline always had — it has just moved up a layer.
	*
	* Idempotent: `saveChunk` keeps the first answer, so a retry of a call whose
	* response already landed costs a model call and changes nothing.
	*/
	app.post("/api/dungeons/:id/chunks/:n", async (c) => {
		const stored = await mustGetDungeon(c.req.param("id"), currentUser(c).id);
		const partial = stored.doc;
		const chunk = Number(c.req.param("n"));
		if (!chunksOf(partial).includes(chunk)) throw new HTTPException(404, { message: `no region ${chunk} in that dungeon` });
		const result = await journalled(stored.id, (journal) => generateChunk(partial, chunk, { journal }));
		await saveChunk(stored.id, result);
		return c.json({
			chunk,
			done: true
		});
	});
	/**
	* Apply every region in ascending order, then write the ways between them.
	*
	* `finishGeneration` refuses if a region is missing, which is the check that
	* turns a lost chunk into a retryable request rather than an unwritten entity
	* discovered at the end of a pass nobody can rerun. See §1.1.
	*/
	app.post("/api/dungeons/:id/finish", async (c) => {
		const stored = await mustGetDungeon(c.req.param("id"), currentUser(c).id);
		if (stored.status === "complete") return c.json({
			dungeonId: stored.id,
			already: true
		});
		const results = await listChunks(stored.id);
		const complete = await journalled(stored.id, async (journal) => {
			const done = await finishGeneration(stored.doc, results, { journal });
			journal.log({
				kind: "dungeon",
				dungeon: done
			});
			return done;
		});
		await completeDungeon(stored.id, complete, currentUser(c).id);
		return c.json({ dungeonId: stored.id });
	});
	/** The player's own worlds. Summaries — nobody needs six whole dungeons. */
	app.get("/api/dungeons", async (c) => c.json(await listDungeons(currentUser(c).id)));
	/**
	* THE LIBRARY — every complete world somebody else made, newest first.
	*
	* Registered before the `:id` routes below because `library` would otherwise
	* be a plausible dungeon id, and a route that can be shadowed by a parameter
	* is a route that works until somebody changes the order.
	*
	* SUMMARIES AND A CURSOR, and the cursor goes back out exactly as it came in.
	* The client never composes one — see `listLibrary`.
	*/
	app.get("/api/dungeons/library", async (c) => {
		const cursor = c.req.query("cursor");
		const limit = Number(c.req.query("limit"));
		return c.json(await listLibrary(currentUser(c).id, {
			...cursor ? { cursor } : {},
			...Number.isFinite(limit) ? { limit } : {}
		}));
	});
	/**
	* TAKE A COPY OF A WORLD.
	*
	* The one route that names a dungeon the caller does not own, and it is why
	* the Phase 11 key split had to happen first: under 10a's schema, where the
	* derived `dungeon_<seed>` name WAS the primary key, a second copy of one
	* world collided on it.
	*
	* IT STILL SERVES NOTHING OF THE SOURCE. The reply is the id of the caller's
	* OWN new row, and the source's `doc` — which is every answer in the world —
	* is never on the wire. What "another player may see a dungeon" means is
	* exactly this: they may have one of their own like it.
	*
	* `already` for the second click, in the shape `/finish` answers in. A copy is
	* recorded as a copy (`dungeons.copied_from`), so pressing the button twice
	* hands back the first copy rather than minting a second half-megabyte row.
	*/
	app.post("/api/dungeons/:id/duplicate", async (c) => {
		const id = c.req.param("id");
		const made = await duplicateDungeon(id, currentUser(c).id);
		if (!made) throw new HTTPException(404, { message: `no such finished dungeon: ${id}` });
		return c.json({
			dungeonId: made.id,
			already: made.already
		});
	});
	app.get("/api/runs", async (c) => c.json(await listRuns(currentUser(c).id)));
	app.get("/api/runs/:id", async (c) => {
		const user = currentUser(c);
		const run = await mustGetRun(c.req.param("id"), user.id);
		const dungeon = await mustGetDungeon(run.dungeonId, user.id);
		return c.json({
			run,
			dungeon: dungeon.doc
		});
	});
	/**
	* A character walks into a finished dungeon.
	*
	* The run's journal opens here, with what this run IS. The generation events
	* above it already exist against the dungeon, and the reader concatenates.
	*/
	app.post("/api/runs", async (c) => {
		const { dungeonId, character } = await c.req.json();
		const user = currentUser(c);
		const stored = await mustGetDungeon(dungeonId, user.id);
		if (stored.status !== "complete") throw new HTTPException(409, { message: "that dungeon is still being written" });
		const busy = await activeRunFor(character.id, user.id);
		if (busy) return c.json({
			error: "in a run",
			runId: busy.id,
			dungeonId: busy.dungeonId
		}, 409);
		const state = newRun(stored.doc, character);
		const run = await createRun({
			dungeonId: stored.id,
			characterId: character.id,
			state,
			owner: user.id
		});
		const { sink, events } = collectingSink();
		createJournal(sink).log({
			kind: "run",
			runId: run.id,
			seed: stored.doc.seeds.dungeonSeed,
			size: stored.doc.size,
			level: stored.doc.level,
			offline: false,
			models: MODELS,
			character
		});
		await appendEvents(run.id, events);
		return c.json({
			run,
			dungeon: stored.doc
		});
	});
	/**
	* WALK AWAY. The one ending that costs nothing.
	*
	* Not a turn and not routed through `playTurn`: there is no referee to ask, no
	* dice to throw and no world to change — the player is closing the book, not
	* doing something in the fiction. So it skips the lock (a turn in flight will
	* simply lose the compare-and-swap, which is the correct outcome for a turn
	* whose run has ended) and writes through the same `commitTurn` everything
	* else writes through, so the version, the status and the release of the lock
	* all happen exactly as they do for any other ending.
	*
	* The run keeps everything. Abandoning ENDS a run; it does not delete one, and
	* the journal, the state and the scrollback are all still there to read.
	*/
	app.post("/api/runs/:id/abandon", async (c) => {
		const id = c.req.param("id");
		const owner = currentUser(c).id;
		const body = await c.req.json().catch(() => ({}));
		const expected = Number(body.version);
		if (!Number.isFinite(expected)) throw new HTTPException(400, { message: "an abandon must say which version it answers" });
		const run = await mustGetRun(id, owner);
		if (run.status !== "active") throw new HTTPException(409, { message: `that run is already over: ${run.status}` });
		const state = {
			...run.state,
			stage: "abandoned"
		};
		const { sink, events } = collectingSink();
		createJournal(sink, await lastSeq(id)).log({
			kind: "stage",
			from: run.state.stage,
			to: "abandoned",
			step: run.state.step
		});
		const result = await commitTurn({
			runId: id,
			owner,
			expectedVersion: expected,
			state,
			events
		});
		if (!result.ok && result.reason === "gone") throw new HTTPException(404, { message: `no such run: ${id}` });
		if (!result.ok) return c.json({
			error: "stale",
			current: result.current
		}, 409);
		return c.json({
			state,
			version: result.version,
			events: []
		});
	});
	app.post("/api/runs/:id/enter", (c) => playTurn(c, (s) => s.enterRoom()));
	app.post("/api/runs/:id/roll", (c) => playTurn(c, (s) => s.roll()));
	app.post("/api/runs/:id/retry", (c) => playTurn(c, (s) => s.retry()));
	app.post("/api/runs/:id/turn", (c) => playTurn(c, async (s, body) => {
		const text = String(body.text ?? "").trim();
		if (text === "") throw new HTTPException(400, { message: "nothing was typed" });
		await s.submit(text);
	}));
	app.get("/api/runs/:id/journal.jsonl", async (c) => {
		const run = await mustGetRun(c.req.param("id"), currentUser(c).id);
		const events = await readJournal(run.id, run.dungeonId);
		return c.text(events.map((e) => JSON.stringify(e)).join("\n"), 200, { "content-type": "application/x-ndjson; charset=utf-8" });
	});
	app.get("/api/runs/:id/transcript.md", async (c) => {
		const run = await mustGetRun(c.req.param("id"), currentUser(c).id);
		const text = (await readJournal(run.id, run.dungeonId)).map(render).filter((t) => t !== void 0).join("\n");
		return c.text(text, 200, { "content-type": "text/markdown; charset=utf-8" });
	});
	return app;
}
/**
* The whole of playing a turn, and the only place run state is written.
*
* The order matters and each step earns its place:
*
*   1. the version, checked BEFORE anything is spent. A stale tab is turned
*      away for free rather than after a referee conversation.
*   2. the lock, which is not a correctness mechanism — `commitTurn` is — but
*      stops a double-click paying for a turn that would be rejected anyway.
*   3. the journal's starting sequence, so this request's events carry on from
*      the last one's instead of colliding with them.
*   4. the turn, against a session rebuilt from the row.
*   5. the compare-and-swap, with the events in the same transaction, so a
*      rejected turn leaves nothing at all behind.
*/
async function playTurn(c, act) {
	const id = c.req.param("id");
	if (!id) throw new HTTPException(400, { message: "no run named" });
	const owner = currentUser(c).id;
	const body = await c.req.json().catch(() => ({}));
	const expected = Number(body.version);
	const run = await mustGetRun(id, owner);
	if (!Number.isFinite(expected)) throw new HTTPException(400, { message: "a turn must say which version it answers" });
	if (expected !== run.version) return c.json({
		error: "stale",
		current: run
	}, 409);
	if (run.status !== "active") throw new HTTPException(409, { message: `that run is over: ${run.status}` });
	if (!await lockRun(id, owner)) return c.json({
		error: "busy",
		current: run
	}, 409);
	const dungeon = await mustGetDungeon(run.dungeonId, owner);
	const { sink, events } = collectingSink();
	const session = createGameSession({
		sink: () => sink,
		startSeq: await lastSeq(id)
	});
	session.restore({
		dungeon: dungeon.doc,
		run: run.state
	}, runId(dungeon.doc.seeds.dungeonSeed));
	try {
		await act(session, body);
	} catch (e) {
		await releaseRun(id, owner);
		throw e;
	}
	const state = session.store.getState().run;
	const result = await commitTurn({
		runId: id,
		owner,
		expectedVersion: expected,
		state,
		events
	});
	if (!result.ok && result.reason === "gone") throw new HTTPException(404, { message: `no such run: ${id}` });
	if (!result.ok) return c.json({
		error: "stale",
		current: result.current
	}, 409);
	return c.json({
		state,
		version: result.version,
		events: session.store.getState().lastEvents
	});
}
/**
* A dungeon, or a 404.
*
* OWNERSHIP IS AN ARGUMENT, NOT AN AFTERTHOUGHT. Both of these take the owner
* and pass it into the `where`, so there is no arrangement of calls in which a
* handler reads a row first and remembers to check it second. "Not yours" and
* "not there" are one answer.
*/
async function mustGetDungeon(id, owner) {
	const stored = await getDungeon(id, owner);
	if (!stored) throw new HTTPException(404, { message: `no such dungeon: ${id}` });
	return stored;
}
async function mustGetRun(id, owner) {
	const run = await getRun(id, owner);
	if (!run) throw new HTTPException(404, { message: `no such run: ${id}` });
	return run;
}
var vercel_default = { fetch: createApp().fetch };
/**
* 300 seconds is the Vercel Hobby maximum, and generation is what needs it: the
* region pass is the longest single call and has run to 50 seconds at size 1.
* No route holds more than one model call, which is why 300 is enough — see the
* note at the top of `src/server/app.ts`.
*/
var config = { maxDuration: 300 };
//#endregion
export { config, vercel_default as default };
