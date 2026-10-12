/**
 * The character sheet, never more than a glance away.
 *
 * Everything here is derived — `characterView` computes the numbers so the
 * player does not have to and so nothing on screen can disagree with the state.
 * A defense is always its bonus plus ten; armour defense is the worn pieces
 * added up, or 11; slots are a budget being spent, which is why the meter
 * counts up to capacity rather than filling a bar.
 */

import { useEffect, useRef, useState } from "react";
import type { CharacterView } from "../../store/selectors.ts";

/** How long a change stays marked on the sheet. */
const MARK_MS = 2600;

/**
 * THE SHEET NOTICES WHEN IT CHANGES.
 *
 * Hit points used to change in silence: the number was different and nothing
 * said so. Now a drop flashes and shows the amount beside the number for a
 * couple of seconds, and an item that lost quality flashes in the list. The
 * effects line under the narration is the record; this is the jolt.
 *
 * Compared against the previous render rather than against an event, so it
 * fires however the change arrived — an in-process commit or a whole state
 * landing from the server — and never on first mount, so opening a resumed
 * run does not flash every wound it already had.
 */
function useDrops(pc: CharacterView): { hp?: { delta: number; key: number }; items: Set<string> } {
  const prev = useRef<{ hp: number; q: Map<string, number> } | undefined>(undefined);
  const [mark, setMark] = useState<{ hp?: { delta: number; key: number }; items: Set<string> }>({ items: new Set() });

  const q = new Map(pc.inventory.flatMap((i) => (i.quality ? [[i.id, i.quality.current] as const] : [])));
  const hp = pc.hp.current;

  useEffect(() => {
    const was = prev.current;
    prev.current = { hp, q };
    if (!was) return;

    const delta = hp - was.hp;
    const items = new Set([...q].filter(([id, v]) => (was.q.get(id) ?? v) > v).map(([id]) => id));
    if (delta >= 0 && items.size === 0) return;

    setMark({ ...(delta < 0 ? { hp: { delta, key: Date.now() } } : {}), items });
    const t = setTimeout(() => setMark({ items: new Set() }), MARK_MS);
    return () => clearTimeout(t);
    // `q` is rebuilt every render, so its contents are the dependency, not the map.
  }, [hp, [...q].join(",")]);

  return mark;
}

const LABEL = "font-mono text-[9px] tracking-[0.16em] text-graphite uppercase";

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-5">
      <div className={`${LABEL} mb-2`}>{label}</div>
      {children}
    </div>
  );
}

export function CharacterPanel({ pc }: { pc: CharacterView }) {
  const { slots } = pc;
  const drops = useDrops(pc);
  // Overburdened is allowed — Knave leaves the consequence to the table — so it
  // is flagged rather than prevented.
  const over = slots.overburdened;

  return (
    <aside className="flex h-full flex-col overflow-y-auto bg-panel px-5 py-6">
      <header className="mb-5">
        <h2 className="font-display text-[20px] font-bold leading-tight text-ink">{pc.name}</h2>
        <div className={`${LABEL} mt-1`}>
          Level {pc.level} · Knave
        </div>
      </header>

      <Row label="Hit points">
        <div
          key={drops.hp?.key}
          className="-mx-1 flex items-baseline gap-2 px-1"
          style={drops.hp ? { animation: `flash ${MARK_MS}ms ease-out` } : undefined}
        >
          <span
            className="font-display text-[28px] font-bold leading-none"
            style={{ color: pc.hp.current <= Math.ceil(pc.hp.max / 3) ? "var(--color-torch-deep)" : "var(--color-ink)" }}
          >
            {pc.hp.current}
          </span>
          <span className="font-mono text-[13px] text-graphite">/ {pc.hp.max}</span>
          {drops.hp && (
            <span className="font-mono text-[13px] font-bold text-torch-deep" aria-live="polite">
              −{Math.abs(drops.hp.delta)}
            </span>
          )}
        </div>
      </Row>

      <Row label="Ability · bonus · def">
        <table className="w-full font-mono text-[12px]">
          <tbody>
            {pc.abilities.map((a) => (
              <tr key={a.key}>
                <td className="py-[3px] uppercase text-graphite">{a.key}</td>
                <td className="py-[3px] text-right text-ink">
                  {a.bonus >= 0 ? "+" : ""}
                  {a.bonus}
                </td>
                <td className="py-[3px] text-right text-graphite">{a.defense}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Row>

      <Row label="Derived">
        <dl className="space-y-[3px] font-mono text-[12px]">
          {[
            ["Armor def", String(pc.armorDefense)],
            ["Melee", `${pc.meleeBonus >= 0 ? "+" : ""}${pc.meleeBonus}`],
            ["Ranged", `${pc.rangedBonus >= 0 ? "+" : ""}${pc.rangedBonus}`],
          ].map(([k, v]) => (
            <div key={k} className="flex justify-between">
              <dt className="text-graphite">{k}</dt>
              <dd className="text-ink">{v}</dd>
            </div>
          ))}
        </dl>
      </Row>

      {pc.conditions.length > 0 && (
        <Row label="Conditions">
          <ul className="flex flex-wrap gap-1.5">
            {pc.conditions.map((c) => (
              <li
                key={c}
                className="border border-torch bg-torch-wash px-2 py-[2px] font-prose text-[13px] text-torch"
              >
                {c}
              </li>
            ))}
          </ul>
        </Row>
      )}

      <Row label="Equipped">
        <ul className="space-y-1 font-mono text-[11px]">
          {pc.equipped.map((e) => (
            <li key={e.slot} className="flex justify-between gap-3">
              <span className="uppercase tracking-[0.08em] text-graphite">{e.slot}</span>
              <span className={e.item ? "text-right text-ink" : "text-right text-pencil"}>
                {e.item?.name ?? "—"}
              </span>
            </li>
          ))}
        </ul>
      </Row>

      <Row label={`Slots — ${slots.used} of ${slots.capacity}`}>
        {/* A budget being spent: one mark per slot, filled left to right, with
            anything past capacity marked in torch rather than hidden. */}
        <div className="mb-2 flex gap-[2px]">
          {Array.from({ length: Math.max(slots.capacity, slots.used) }, (_, i) => (
            <span
              key={i}
              className={`h-[10px] flex-1 ${
                i >= slots.capacity ? "bg-torch" : i < slots.used ? "bg-ink" : "bg-rule"
              }`}
            />
          ))}
        </div>
        {over && (
          <p className="mb-2 font-prose text-[12px] italic text-torch">
            Over capacity. The referee will notice.
          </p>
        )}
        <ul className="space-y-[2px] font-mono text-[11px]">
          {pc.inventory.map((i) => (
            /* The description hangs off the row rather than filling the panel:
               a pack of ten things is a list, and a list of paragraphs is not. */
            <li
              key={i.id}
              className="-mx-1 flex justify-between gap-3 px-1"
              title={i.composed ?? i.base}
              style={drops.items.has(i.id) ? { animation: `flash ${MARK_MS}ms ease-out` } : undefined}
            >
              <span className="truncate text-ink">
                {i.name}
                {/* Wear, once there is any. A whole sword says nothing; a
                    damaged one says how damaged, because the next hit that
                    takes it to zero destroys it. */}
                {i.quality && i.quality.current < i.quality.original && (
                  <span className="text-torch-deep">
                    {" "}
                    · {i.quality.current <= 0 ? "broken" : `worn ${i.quality.current}/${i.quality.original}`}
                  </span>
                )}
                {/* How much is left, which is the only part of a carried thing
                    that changes on its own. Muted and inline: it belongs to the
                    name — "Rations (2 days)" is one thing, not two columns. */}
                {i.amount && <span className="text-graphite"> ({i.amount})</span>}
              </span>
              <span className="shrink-0 text-graphite">{i.slots ?? 1}</span>
            </li>
          ))}
          {pc.inventory.length === 0 && (
            <li className="font-prose text-[13px] italic text-pencil">Carrying nothing.</li>
          )}
        </ul>
      </Row>
    </aside>
  );
}
