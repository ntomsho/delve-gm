/**
 * DESIGN TOKENS
 * =============
 *
 * From the design plan artifact. The names are the design's own — ink, torch,
 * graphite, pencil — because they carry the reasoning: this is a game about
 * ink, dice, torchlight, graph paper and a character sheet you erase a lot, and
 * the palette is that and not generic dark fantasy.
 *
 * Values live here rather than in Tailwind config so the SVG map, which cannot
 * use utility classes, draws from the same source as everything else.
 */

export const color = {
  /** page behind the sheet — the desk */
  desk: "#EDE7DA",
  /** the sheet itself, and anything raised off the desk */
  paper: "#F6F2E8",
  /** a panel set slightly into the sheet */
  panel: "#F1EBDF",
  /** ruled lines, borders, the grain of the paper */
  rule: "#CFC7B4",
  /** a lighter rule, for divisions that should not assert themselves */
  ruleFaint: "#DED6C4",

  /** body text, headings — pencil pressed hard */
  ink: "#22201C",
  /** secondary text, labels, anything read second */
  graphite: "#6B6659",
  /** on a dark ground, where graphite disappears */
  pencil: "#A69E8D",
  /** the faintest legible text — an epitaph, a hint */
  ash: "#8F8778",

  /** the one accent: torchlight. Used only where the game wants something. */
  torch: "#B4521E",
  /** torch, a shade down, so a small label still holds */
  torchDeep: "#9C4417",
  /** torch on paper, as a wash */
  torchWash: "#F7EDE4",

  /** ink of a different bottle — links, and the player's own words */
  indigo: "#1D3A57",
} as const;

/**
 * Three faces, three jobs.
 *
 * The narration is the game, and it is read for an hour at a time, so it gets a
 * serif with a real text design. Everything the software says is monospaced,
 * which keeps the machine voice and the fiction's voice visibly apart — the
 * brief asks for exactly that separation. Space Grotesk is for names and
 * numbers: the character sheet, room titles, the things you read at a glance.
 */
export const font = {
  /** referee prose and player actions — the reading column */
  prose: "'Source Serif 4', Georgia, serif",
  /** labels, stage names, stat blocks, anything the software says */
  mono: "'JetBrains Mono', ui-monospace, monospace",
  /** names, headings, numbers read at a glance */
  display: "'Space Grotesk', system-ui, sans-serif",
} as const;

/**
 * How each stage looks, and the rule behind it: torch means the game wants
 * something from you, ink means it is your turn, faint means wait.
 *
 * `rule` is the hairline above the input; `label` runs a shade darker so an
 * 11px uppercase label still holds against it.
 */
export interface StageTone {
  rule: string;
  label: string;
}

const WANTS_YOU: StageTone = { rule: color.torch, label: color.torchDeep };
const YOUR_TURN: StageTone = { rule: color.ink, label: color.ink };
const WAIT: StageTone = { rule: color.ruleFaint, label: color.graphite };
/** turned away — quieter than your turn, but not a machine state */
const ASIDE: StageTone = { rule: color.rule, label: color.graphite };

import type { Stage } from "../runtime/types.ts";

export const STAGE_TONE: Record<Stage, StageTone> = {
  roll_offered: WANTS_YOU,
  rolling: WANTS_YOU,
  error: WANTS_YOU,

  awaiting_action: YOUR_TURN,
  clarifying: YOUR_TURN,

  rejected: ASIDE,

  room_entry: WAIT,
  thinking: WAIT,
  resolving: WAIT,
  dead: WAIT,
  // `departed` is never stored — the store resolves it into one of the two
  // below. Mapped anyway so the table stays total and nothing needs a fallback.
  departed: WAIT,
  escaped: WAIT,
  goal_met: WAIT,
};

/** What the game is doing, in its own voice. Shown above the input. */
export const STAGE_NAME: Record<Stage, string> = {
  room_entry: "ARRIVING",
  awaiting_action: "YOUR MOVE",
  thinking: "REFEREE THINKING",
  clarifying: "REFEREE ASKING",
  rejected: "ACTION TURNED AWAY",
  roll_offered: "ROLL OFFERED",
  rolling: "DICE IN FLIGHT",
  resolving: "WRITING THE OUTCOME",
  error: "NO RESPONSE",
  dead: "RUN OVER",
  departed: "OUT",
  escaped: "OUT, ALIVE, EMPTY-HANDED",
  goal_met: "OUT, WITH IT, ALIVE",
};

/** What the game wants from the player, under the input. */
export const STAGE_HINT: Record<Stage, string> = {
  room_entry: "INPUT LOCKED WHILE THE ROOM ARRIVES",
  awaiting_action: "TYPE ANYTHING · PLAIN LANGUAGE",
  thinking: "YOUR ACTION IS SENT",
  clarifying: "ANSWER, OR SAY SOMETHING ELSE",
  rejected: "TRY SOMETHING ELSE",
  roll_offered: "…OR SAY SOMETHING ELSE INSTEAD OF ROLLING",
  rolling: "DICE IN FLIGHT",
  resolving: "INPUT LOCKED WHILE THE OUTCOME IS WRITTEN",
  error: "YOUR TEXT IS STILL HERE",
  dead: "INPUT CLOSED",
  departed: "INPUT CLOSED",
  escaped: "INPUT CLOSED",
  goal_met: "INPUT CLOSED",
};
