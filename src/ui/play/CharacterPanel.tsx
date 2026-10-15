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
import type { CharacterView } from "../../gameplay/view/selectors.ts";

/** How long a change stays marked on the sheet. */
export const MARK_MS = 2600;

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
export function useDrops(pc: CharacterView): { hp?: { delta: number; key: number }; items: Set<string> } {
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

/** Low enough to be worth a colour: a third of the maximum or less. */
export const hurt = (pc: CharacterView) => pc.hp.current <= Math.ceil(pc.hp.max / 3);
const signed = (n: number) => `${n >= 0 ? "+" : ""}${n}`;

export function CharacterPanel({
  pc,
  compact = false,
  columns = false,
}: {
  pc: CharacterView;
  compact?: boolean;
  /** the compact sheet, its sections in columns: a phone held sideways */
  columns?: boolean;
}) {
  const { slots } = pc;
  const drops = useDrops(pc);
  if (compact) return <CompactSheet pc={pc} drops={drops} columns={columns} />;
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
            style={{ color: hurt(pc) ? "var(--color-torch-deep)" : "var(--color-ink)" }}
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
            Over capacity. The game master will notice.
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

// ---------------------------------------------------------------------------
// THE PHONE'S SHEET
// ---------------------------------------------------------------------------

const C_LABEL = "font-mono text-[10px] tracking-[0.16em] text-graphite uppercase";

function CRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mt-[22px]">
      <div className={`${C_LABEL} mb-2`}>{label}</div>
      {children}
    </div>
  );
}

/**
 * THE SAME SHEET, A TAB OF ITS OWN.
 *
 * On a phone the sheet is not beside the narration but behind a tab, so it can
 * be read at full width rather than squeezed into a column: the abilities as a
 * grid of six instead of a table, and the inventory's descriptions — a `title`
 * tooltip on the desktop, which a finger cannot raise — opened in place, one row
 * at a time.
 */
function CompactSheet({
  pc,
  drops,
  columns,
}: {
  pc: CharacterView;
  drops: ReturnType<typeof useDrops>;
  columns: boolean;
}) {
  const { slots } = pc;
  const [open, setOpen] = useState<string>();

  return (
    <aside className="bg-panel px-4 pb-7 pt-5">
      <header className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="font-display text-[24px] font-bold leading-tight text-ink">{pc.name}</h2>
          <div className={`${C_LABEL} mt-1`}>Level {pc.level} · Knave</div>
        </div>
        <div
          key={drops.hp?.key}
          className="-mx-1 flex shrink-0 items-baseline gap-1.5 px-1"
          style={drops.hp ? { animation: `flash ${MARK_MS}ms ease-out` } : undefined}
        >
          {drops.hp && (
            <span className="font-mono text-[13px] font-bold text-torch-deep" aria-live="polite">
              −{Math.abs(drops.hp.delta)}
            </span>
          )}
          <span
            className="font-display text-[34px] font-bold leading-none"
            style={{ color: hurt(pc) ? "var(--color-torch-deep)" : "var(--color-ink)" }}
          >
            {pc.hp.current}
          </span>
          <span className="font-mono text-[13px] text-graphite">/ {pc.hp.max} HP</span>
        </div>
      </header>

      {/* Sideways the sections flow into three columns, each kept whole. */}
      <div className={columns ? "mt-[22px] columns-3 gap-8 [&>div]:mb-5 [&>div]:mt-0 [&>div]:break-inside-avoid" : ""}>
      <CRow label="Ability · bonus · def">
        <div className="grid grid-cols-3 gap-px border border-rule bg-rule">
          {pc.abilities.map((a) => (
            <div key={a.key} className="bg-paper px-2.5 pb-2 pt-2.5">
              <div className="font-mono text-[10px] uppercase text-graphite">{a.key}</div>
              <div className="flex items-baseline justify-between">
                <span className="font-display text-[22px] font-bold leading-tight text-ink">{signed(a.bonus)}</span>
                <span className="font-mono text-[12px] text-graphite">{a.defense}</span>
              </div>
            </div>
          ))}
        </div>
      </CRow>

      <CRow label="Derived">
        <dl className="grid grid-cols-3 gap-3">
          {[
            ["Armor def", String(pc.armorDefense)],
            ["Melee", signed(pc.meleeBonus)],
            ["Ranged", signed(pc.rangedBonus)],
          ].map(([k, v]) => (
            <div key={k}>
              <dt className="font-mono text-[10px] uppercase tracking-[0.1em] text-graphite">{k}</dt>
              <dd className="font-display text-[18px] font-bold text-ink">{v}</dd>
            </div>
          ))}
        </dl>
      </CRow>

      {pc.conditions.length > 0 && (
        <CRow label="Conditions">
          <ul className="flex flex-wrap gap-1.5">
            {pc.conditions.map((c) => (
              <li
                key={c}
                className="border border-torch bg-torch-wash px-2 py-[2px] font-prose text-[14px] text-torch"
              >
                {c}
              </li>
            ))}
          </ul>
        </CRow>
      )}

      <CRow label="Equipped">
        <ul className="space-y-1.5 font-mono text-[12px]">
          {pc.equipped.map((e) => (
            <li key={e.slot} className="flex justify-between gap-3">
              <span className="uppercase tracking-[0.08em] text-graphite">{e.slot}</span>
              <span className={e.item ? "text-right text-ink" : "text-right text-pencil"}>
                {e.item?.name ?? "—"}
              </span>
            </li>
          ))}
        </ul>
      </CRow>

      <CRow label={`Slots — ${slots.used} of ${slots.capacity}`}>
        <div className="mb-2 flex gap-[2px]">
          {Array.from({ length: Math.max(slots.capacity, slots.used) }, (_, i) => (
            <span
              key={i}
              className={`h-3 flex-1 ${i >= slots.capacity ? "bg-torch" : i < slots.used ? "bg-ink" : "bg-rule"}`}
            />
          ))}
        </div>
        {slots.overburdened && (
          <p className="mb-2 font-prose text-[13px] italic text-torch">Over capacity. The game master will notice.</p>
        )}
        <ul className="font-mono text-[12px]">
          {pc.inventory.map((i) => {
            const isOpen = open === i.id;
            const about = i.composed ?? i.base;
            return (
              <li
                key={i.id}
                className={`-mx-2 border-b border-rule-faint ${isOpen ? "bg-paper" : ""}`}
                style={drops.items.has(i.id) ? { animation: `flash ${MARK_MS}ms ease-out` } : undefined}
              >
                <button
                  type="button"
                  aria-expanded={isOpen}
                  disabled={!about}
                  onClick={() => setOpen(isOpen ? undefined : i.id)}
                  className="flex min-h-11 w-full items-center justify-between gap-3 px-2 text-left disabled:cursor-default"
                >
                  <span className="min-w-0 text-ink">
                    {i.name}
                    {i.quality && i.quality.current < i.quality.original && (
                      <span className="text-torch-deep">
                        {" "}
                        · {i.quality.current <= 0 ? "broken" : `worn ${i.quality.current}/${i.quality.original}`}
                      </span>
                    )}
                    {i.amount && <span className="text-graphite"> ({i.amount})</span>}
                  </span>
                  <span className="flex shrink-0 items-baseline gap-3">
                    <span className="text-graphite">{i.slots ?? 1}</span>
                    <span className="w-3 text-center text-pencil" aria-hidden>
                      {about ? (isOpen ? "−" : "+") : ""}
                    </span>
                  </span>
                </button>
                {isOpen && about && (
                  <p className="pb-3 pl-2 pr-7 font-prose text-[14px] leading-[1.5] text-graphite">{about}</p>
                )}
              </li>
            );
          })}
          {pc.inventory.length === 0 && (
            <li className="font-prose text-[14px] italic text-pencil">Carrying nothing.</li>
          )}
        </ul>
      </CRow>
      </div>
    </aside>
  );
}
