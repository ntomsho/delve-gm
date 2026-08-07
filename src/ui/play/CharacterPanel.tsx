/**
 * The character sheet, never more than a glance away.
 *
 * Everything here is derived — `characterView` computes the numbers so the
 * player does not have to and so nothing on screen can disagree with the state.
 * A defense is always its bonus plus ten; armour defense is the worn pieces
 * added up, or 11; slots are a budget being spent, which is why the meter
 * counts up to capacity rather than filling a bar.
 */

import type { CharacterView } from "../../store/selectors.ts";

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
        <div className="flex items-baseline gap-2">
          <span className="font-display text-[28px] font-bold leading-none text-ink">
            {pc.hp.current}
          </span>
          <span className="font-mono text-[13px] text-graphite">/ {pc.hp.max}</span>
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
            <li key={i.id} className="flex justify-between gap-3">
              <span className="truncate text-ink">{i.name}</span>
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
