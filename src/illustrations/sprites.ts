/**
 * CREATURE SPRITES — who is drawn, and the words for it
 * =====================================================
 *
 * One sprite per `spriteKeyOf` (src/illustrations/figures.ts): a solo, a leader
 * or a named person each; a group's nameless members all one. Drawn the first
 * time a run meets the kind, and shared by every run after, like an illustration.
 *
 * The subject is read from the run's entities rather than the dungeon's, so a
 * creature the game master brought in mid-run can be drawn too. A base is never
 * written at runtime (§2.4), so for a generated creature the two agree and its
 * sprite's key is the same in every run of the dungeon.
 */

import { z } from "zod";
import { figureRole, spriteKeyOf, type FigureSize } from "./figures.ts";
import { resolveBase } from "../shared/world/entities.ts";
import { SPRITE_LOOK_SYSTEM, spriteLookMessage } from "./sprite-prompt.ts";
import type { EntityPassResult } from "../shared/world/entities.ts";
import { callForJson, type Usage } from "../llm/client.ts";

/** What a sprite is drawn from. */
export interface SpriteSubject {
  key: string;
  name: string;
  base: string;
  /** one typical member of a group, rather than an individual */
  member: boolean;
}

/** The creature a sprite key draws, from any one entity that carries it. */
export function spriteSubject(entities: EntityPassResult, key: string): SpriteSubject | undefined {
  const c = entities.creatures.find((x) => spriteKeyOf(x) === key);
  if (!c) return undefined;
  const role = figureRole(c);
  const member = role === "group" || (role === "solo" && entities.registry.groups[c.narrative.blueprintId] !== undefined);
  return { key, name: c.name, base: resolveBase(c, entities.registry) ?? "", member };
}

/** What Haiku answers for one sprite. */
export interface SpriteLook {
  look: string;
  size: FigureSize;
}

const lookSchema = z.object({
  look: z.string().min(1),
  size: z.enum(["tiny", "small", "medium", "large", "huge"]),
});

export async function requestSpriteLook(s: SpriteSubject, theme: string): Promise<{ value: SpriteLook; usage: Usage }> {
  const res = await callForJson({
    task: "sprite-look",
    system: SPRITE_LOOK_SYSTEM,
    messages: [{ role: "user", content: spriteLookMessage({ theme, name: s.name, base: s.base, member: s.member }) }],
    schema: lookSchema,
    toolName: "sprite_look",
    toolDescription: "What the figure looks like, and its size.",
  });
  return { value: res.value, usage: res.usage };
}

/**
 * What the server says about a sprite. Ready carries the size word, which the
 * page turns into a height (`FIGURE_SIZE_FT`, `FIGURE_SCALE`).
 *
 * The image is two masks side by side, each half the width: the left is the
 * figure's body (the paper it hides the illustration behind with), the right its ink.
 */
export type SpriteAnswer =
  | { status: "ready"; url: string; size: FigureSize }
  | { status: "pending" }
  | { status: "none" };
