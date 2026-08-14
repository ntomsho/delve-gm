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

import { farSide, touches } from "../engine/index.ts";
import type { JournalRecord } from "./journal.ts";
import { describeDiff } from "./journal.ts";

const rule = "\n---\n";

/**
 * One event, as markdown. `undefined` means it belongs in the record and not
 * in the reading — a prompt, a stage transition nobody needs narrated.
 */
export function render(r: JournalRecord): string | undefined {
  switch (r.kind) {
    case "run":
      return [
        `# Run ${r.runId}`,
        ``,
        `**Seed** ${r.seed} · **size** ${r.size} · **level** ${r.level}` +
          `${r.offline ? " · offline dungeon" : ""}`,
        `**Character** ${r.character.name}, level ${r.character.level}, ` +
          `${r.character.hp.current}/${r.character.hp.max} hp`,
        `**Models** ${Object.entries(r.models)
          .map(([task, model]) => `${task} → ${model}`)
          .join(" · ")}`,
        ``,
        `Started ${r.at}.`,
      ].join("\n");

    case "dungeon":
      return dungeon(r);

    case "player":
      return `${rule}\n> ${r.text.replace(/\n/g, "\n> ")}`;

    case "narration":
      return r.arrival ? `\n## Arrival\n\n${r.text}` : `\n${r.text}`;

    case "roll":
      return r.source === "player"
        ? `\n\`${playerRoll(r)}\``
        : `\n${r.outcomes.map((o) => `\`referee · ${o.id}: ${o.line}\``).join("\n")}`;

    case "commit":
      return commit(r);

    case "response":
      // The reasoning outside the post. Folded away, because it is long and
      // repetitive — but kept, because when a turn goes wrong this is usually
      // where the answer is.
      return working(r.text);

    case "stage":
      // Only the ones that end the run. The rest are machinery.
      return r.to === "dead" || r.to === "goal_met"
        ? `\n**${r.to === "dead" ? "The run ends here." : "The goal is met."}**`
        : undefined;

    case "turn":
      return `\n*Turn ${r.turn} closed — ${r.diffs} change${r.diffs === 1 ? "" : "s"}.*`;

    case "error":
      return `\n> [!WARNING]\n> **${r.where}** — ${r.message}`;

    // Unlike `generation`, this one belongs in the transcript: a dungeon that
    // failed to build has no rooms to read, and this is the whole document.
    case "generation-error": {
      const where = `${r.pass}${r.chunk === undefined ? "" : ` chunk ${r.chunk}`}`;
      const issues = r.issues.map((i) => `> - \`${i.path}\`: ${i.message}`).join("\n");
      return (
        `\n> [!WARNING]\n> **${where}, attempt ${r.attempt}** — ${r.message}` +
        (issues ? `\n>\n${issues}` : "") +
        `\n>\n> ${r.willRetry ? "Retrying." : "Giving up."}`
      );
    }

    // In the record only.
    case "generation":
    case "system":
    case "prompt":
      return undefined;
  }
}

// ---------------------------------------------------------------------------

function playerRoll(r: Extract<JournalRecord, { kind: "roll"; source: "player" }>): string {
  const o = r.outcome;
  const dice = o.rolled.length > 1 ? `[${o.rolled.join(", ")}] keep ${o.kept}` : `${o.kept}`;
  const sign = o.spec.bonus >= 0 ? "+" : "";
  const crit = o.nat20 ? " · CRIT" : o.nat1 ? " · FUMBLE" : "";
  const damage = o.damage ? ` · ${o.damage.expr} → ${o.damage.total}` : "";

  return (
    `player · ${o.spec.ability.toUpperCase()} ${o.spec.kind}: ${dice} ${sign}${o.spec.bonus}` +
    ` = ${o.total} vs ${o.spec.dc} — ${o.success ? "success" : "failure"}${crit}${damage}`
  );
}

function commit(r: Extract<JournalRecord, { kind: "commit" }>): string | undefined {
  const out: string[] = [];

  if (!r.ok) {
    out.push(
      `\n> [!CAUTION]\n> **Commit refused${r.retry ? " (again)" : ""}** — nothing was applied.`,
      ...(r.reasons ?? []).map((x) => `> - ${x}`)
    );
    return out.join("\n");
  }

  // Prose the model wrote is kept WHOLE. Everything else is a value, and a
  // value reads fine on one line — but `state` and `composed` are writing, and
  // clipping them at 120 characters would throw away the thing this file exists
  // to let you read. (The room's own `composed` also arrives as the arrival
  // narration; an entity's arrives only here.)
  const prose = r.commit.diffs.filter((d) => d.path === "state" || d.path === "composed");
  const values = r.commit.diffs.filter((d) => d.path !== "state" && d.path !== "composed");

  if (prose.length > 0) {
    out.push(
      `\n<details><summary>${prose.length} description${prose.length === 1 ? "" : "s"} written</summary>\n`,
      ...prose.map((d) => `\n**\`${d.entityId}\` · ${d.path}**\n\n${String(d.value)}\n`),
      `</details>`
    );
  }

  if (values.length > 0) {
    out.push(
      `\n<details><summary>${values.length} change${values.length === 1 ? "" : "s"}</summary>\n`,
      ...values.map((d) => `- \`${describeDiff(d)}\``),
      `\n</details>`
    );
  }

  // Consequences the referee did not state and the applier performed anyway.
  // Worth reading every time: this is where an item quietly stopped existing.
  for (const e of r.events ?? []) out.push(`\n*${e.kind}: ${e.detail}*`);

  return out.length ? out.join("\n") : undefined;
}

function working(text: string): string | undefined {
  const outside = text.replace(/<post>[\s\S]*?<\/post>/gi, "").trim();
  if (outside === "") return undefined;
  return `\n<details><summary>referee working</summary>\n\n\`\`\`\n${outside}\n\`\`\`\n\n</details>`;
}

/**
 * The dungeon, room by room.
 *
 * The whole thing is in the record as JSON; this is the version you can read
 * to judge whether generation did a good job — which is a question about prose,
 * so it prints the prose.
 */
function dungeon(r: Extract<JournalRecord, { kind: "dungeon" }>): string {
  const d = r.dungeon;
  const e = d.entities;
  const reg = e.registry;

  const base = (x: { base?: string; narrative?: { blueprintId?: string } }): string =>
    x.base?.trim() ||
    (x.narrative?.blueprintId ? reg.groups?.[x.narrative.blueprintId]?.base ?? "" : "") ||
    "";

  const inRoom = (roomId: string): string[] => {
    const lines: string[] = [];
    for (const c of e.creatures.filter((x) => x.roomId === roomId)) {
      lines.push(
        `  - **${c.name}**${(c.count ?? 1) > 1 ? ` ×${c.count}` : ""} (creature) — ${base(c)}` +
          (c.activity ? `\n    *doing:* ${c.activity}` : "")
      );
    }
    for (const f of e.features.filter((x) => x.roomId === roomId)) {
      lines.push(`  - **${f.name}** (feature)${f.isHidden ? " — *hidden*" : ""} — ${base(f)}`);
    }
    for (const i of e.items.filter((x) => x.parentId === roomId)) {
      lines.push(`  - **${i.name}** (item)${i.isHidden ? " — *hidden*" : ""} — ${base(i)}`);
    }
    return lines;
  };

  const rooms = e.rooms.map((room) => {
    const exits = e.connectors
      .filter((c) => touches(c, room.id))
      .map((c) => {
        const to = farSide(c, room.id);
        const name =
          to === null ? "**out of the dungeon**" : (e.rooms.find((x) => x.id === to)?.name ?? to);
        return `  - ${c.name} → ${name}${c.conditional ? ` — *blocked: ${c.conditional}*` : ""}${
          c.isHidden ? " — *concealed*" : ""
        }`;
      });

    const contents = inRoom(room.id);
    return [
      `\n### ${room.name}`,
      `\`${room.id}\``,
      ``,
      base(room),
      contents.length ? `\n**In it**\n${contents.join("\n")}` : `\n*Empty.*`,
      exits.length ? `\n**Ways out**\n${exits.join("\n")}` : ``,
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
    `${e.rooms.length} rooms · ${e.creatures.length} creature groups · ${e.items.length} items · ` +
      `${e.features.length} features · ${e.hazards.length} hazards`,
    ``,
    // Hazards hang off what they threaten rather than off a room, so they get
    // their own list instead of appearing under a heading they have no field for.
    e.hazards.length
      ? `**Hazards.** ${e.hazards.map((h) => `${h.name} — ${base(h)}`).join(" · ")}`
      : ``,
    ``,
    `## Opening`,
    ``,
    d.pass.openingProse,
    ``,
    `## Rooms`,
    ...rooms,
    rule,
    `# The run`,
  ].join("\n");
}
