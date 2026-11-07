/**
 * FROM A PLAN TO A STOCKED DUNGEON.
 *
 * `rollOutline` rolled the dice and the model decided where each thing goes. This
 * builds what the rest of generation reads from those decisions. It does the job of
 * `stockDungeon` from step 4 on: stacking, danger, challenges and rewards still run
 * here, on the rooms as the outline assigned them.
 *
 * Pure and seeded. The caller saves the result once, because the entities built from
 * it have random ids that later steps address.
 */

import { Rng } from "../../../../shared/utils/rng.ts";
import type { Challenge } from "../../../../shared/world/challenges.ts";
import { enumerateChallenges } from "../../challenges.ts";
import { placeRewards, type PlannedKey } from "../../rewards.ts";
import { rollSpecial } from "../../stock/creatures.ts";
import { scoreDanger } from "../../stock/steps.ts";
import type {
  ClueContent,
  Headline,
  MobileEntity,
  PlannedObjective,
  RoomStock,
  StockedConnector,
  StockedDungeon,
} from "../../types.ts";
import { GOAL_KEY, NONE, type Outline } from "./response.ts";
import type { OutlineDraft } from "./roll.ts";

/** Keeps this stream apart from the one that rolled the draft from the same seed. */
const SETTLE_STREAM = 104729;

const GOAL_INSTRUCTION =
  "Write the objective the outline decided on. It must be a thing the party can act on, " +
  "and reaching or resolving it must plausibly satisfy the mission.";

const named = (v: string): string | undefined => (v && v !== NONE ? v : undefined);

export function settleOutline(
  draft: OutlineDraft,
  outline: Outline,
  opts: { level: number; seed: number }
): StockedDungeon {
  const rng = new Rng(opts.seed + SETTLE_STREAM);
  const answer = new Map(outline.rooms.map((r) => [r.ref, r]));
  const fictionOf = new Map(draft.fictions.map((f) => [f.ref, f]));
  const cardOf = new Map(draft.cards.map((c) => [c.ref, c]));
  const roomIdOf = new Map(draft.rooms.map((r) => [r.ref, r.roomId]));
  const roomOfCard = new Map(outline.rooms.flatMap((r) => (named(r.card) ? [[r.card, r.ref] as const] : [])));

  const person = named(outline.objective.person);
  const objective: PlannedObjective = {
    type: outline.objective.type,
    form: outline.objective.form,
    ...(person ? { person } : {}),
  };

  const mobiles: MobileEntity[] = [];
  const rooms: RoomStock[] = draft.rooms.map((r) => {
    const a = answer.get(r.ref);
    const fiction = a ? fictionOf.get(a.fiction) : undefined;
    const card = a && named(a.card) ? cardOf.get(a.card) : undefined;
    const detail = r.detail ?? fiction?.detail;
    const storyFeature = a ? named(a.storyFeature) : undefined;

    const headline: Headline =
      r.role === "entrance" ? "none" : (card?.headline ?? (r.role === "goal" ? "special" : "quiet"));

    const occupants: string[] = [];
    if (card?.mobile) {
      const m = { ...card.mobile, locationRoomId: r.roomId };
      mobiles.push(m);
      occupants.push(m.id);
    }

    return {
      roomId: r.roomId,
      index: r.index,
      role: r.role,
      headline,
      // Nothing downstream re-places a room, so this only records why it holds what it holds.
      claimed: r.role !== "normal" || !!card?.mobile?.isBase,
      isCorridor: r.passage,
      ...(r.sizeClass ? { sizeClass: r.sizeClass } : {}),
      identity: r.identity ?? fiction?.identity ?? "",
      ...(detail ? { detail } : {}),
      ...(r.entranceFeature ? { entranceFeature: r.entranceFeature } : {}),
      depth: r.depth,
      degree: r.degree,
      isDeadEnd: r.isDeadEnd,
      danger: 0,
      ...(card?.special ? { special: card.special } : {}),
      rewards: [],
      occupants,
      ...(r.role === "goal"
        ? {
            goalDirective: {
              reward: draft.blueprint.goalSeed.reward,
              mission: draft.blueprint.goalSeed.mission,
              instruction: GOAL_INSTRUCTION,
              objective,
            },
          }
        : {}),
      ...(a ? { story: a.story, journey: a.journey } : {}),
      ...(storyFeature ? { storyFeature } : {}),
    };
  });
  const byRef = (ref: string): RoomStock | undefined => rooms[draft.rooms.findIndex((r) => r.ref === ref)];

  const entrance = byRef(draft.entrance)!;
  const goal = byRef(draft.goalRoom)!;
  const maxDepth = Math.max(0, ...draft.rooms.map((r) => r.depth));

  const formOf = new Map(outline.ways.map((w) => [w.ref, w.form]));
  const connectors: StockedConnector[] = draft.ways.map((w) => {
    const form = formOf.get(w.ref);
    return { ...w.connector, ...(form ? { form } : {}) };
  });

  // --- clues -----------------------------------------------------------------
  const gatedRooms = new Set(connectors.filter((c) => c.gated).flatMap((c) => [c.a, c.b]));
  const pointsAt = new Map(outline.clues.map((c) => [c.card, c.pointsAt]));
  for (const r of draft.rooms) {
    const a = answer.get(r.ref);
    const card = a && named(a.card) ? cardOf.get(a.card) : undefined;
    if (!card?.clue) continue;
    const at = pointsAt.get(card.ref) ?? "objective";
    const targetRef = at === "objective" ? draft.goalRoom : roomIdOf.has(at) ? at : roomOfCard.get(at);
    const target = targetRef ? byRef(targetRef) : undefined;
    const occupant = target?.occupants[0];
    const clue: ClueContent = {
      keyword: card.clue,
      about:
        at === "objective" || target?.role === "goal"
          ? "the objective"
          : target?.special?.kind === "hazard"
            ? "a hazard in another room"
            : occupant
              ? "creatures in another room"
              : target && gatedRooms.has(target.roomId)
                ? "a way that is not obvious"
                : "another room",
      ...(target ? { targetRoomId: target.roomId } : {}),
      ...(occupant ? { targetMobileId: occupant } : {}),
    };
    byRef(r.ref)!.clue = clue;
  }

  // --- stacking, deep rooms only, capped --------------------------------------
  const stackCap = rooms.length >= 18 ? 2 : 1;
  let stacked = 0;
  for (const r of rooms) {
    if (stacked >= stackCap) break;
    if (r.role === "entrance" || r.special) continue;
    const deep = maxDepth ? r.depth / maxDepth : 0;
    if (deep < 0.6) continue;
    if (r.headline === "creature" && rng.chance(0.3)) {
      r.stacked = "special";
      r.special = rollSpecial(rng);
      stacked++;
    }
  }

  for (const r of rooms) r.danger = scoreDanger(r, mobiles, maxDepth);

  // --- challenges, then rewards ------------------------------------------------
  const challenges = enumerateChallenges({ rooms, mobiles, connectors, goalRoomId: goal.roomId });

  // What the goal needs answers no rolled challenge, so each one gets its own.
  const plannedKeys: PlannedKey[] = [];
  outline.keys.forEach((k, i) => {
    const roomId = roomIdOf.get(k.room);
    if (!roomId) return;
    const plan = { kind: k.kind, key: k.key, gotBy: k.gotBy };
    if (k.challenge === GOAL_KEY) {
      const c: Challenge = {
        id: `ch:goal-property:planned:${i}`,
        kind: "goal-property",
        target: "room",
        targetId: goal.roomId,
        roomId: goal.roomId,
        property: k.key,
      };
      challenges.push(c);
      plannedKeys.push({ challengeId: c.id, roomId, plan });
      return;
    }
    const drafted = draft.challenges.find((c) => c.ref === k.challenge);
    const settled =
      drafted &&
      settledChallenge(drafted.challenge, drafted.card, challenges, (card) => {
        const ref = roomOfCard.get(card);
        return ref ? roomIdOf.get(ref) : undefined;
      });
    if (settled) plannedKeys.push({ challengeId: settled.id, roomId, plan });
  });

  const placement = placeRewards({
    rooms,
    connectors,
    mobiles,
    entranceRoomId: entrance.roomId,
    goalRoomId: goal.roomId,
    challenges,
    maxDepth,
    rng,
    plannedKeys,
  });

  const count = (h: Headline) => rooms.filter((r) => r.headline === h).length;
  return {
    seed: opts.seed,
    size: draft.blueprint.size,
    level: opts.level,
    entranceRoomId: entrance.roomId,
    goalRoomId: goal.roomId,
    maxDepth,
    rooms,
    mobiles,
    wandererGroups: draft.wandererGroups,
    connectors,
    cohesion: draft.cohesion,
    quota: { creature: count("creature"), special: count("special"), quiet: count("quiet"), none: count("none") },
    challenges,
    reserve: placement.reserve,
    pot: placement.pot,
    rewardBudget: placement.stats,
  };
}

/**
 * The drafted challenge as it stands now the rooms are real. A hazard or obstacle was
 * enumerated against its card, so its target is whichever room that card went to.
 * Everything else names a mobile or a connector, which keep their ids.
 */
function settledChallenge(
  drafted: Challenge,
  card: string | undefined,
  settled: readonly Challenge[],
  roomOfCard: (card: string) => string | undefined
): Challenge | undefined {
  if (drafted.kind === "goal-location") return settled.find((c) => c.kind === "goal-location");
  const targetId = card && drafted.target === "room" ? roomOfCard(card) : drafted.targetId;
  return settled.find(
    (c) => c.kind === drafted.kind && c.targetId === targetId && c.property === drafted.property
  );
}
