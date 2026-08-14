/**
 * RUN SETUP — what dungeon, and who goes in.
 *
 * A screen rather than a modal, which is a bet on where this goes: light and
 * ration clocks, difficulty, a named dungeon instead of a number. It will not
 * stay three fields, so it is not housed in something that only works while it
 * is.
 *
 * Size is the only control here that spends the player's real time and real
 * money — it sets the region count and every region is one writing call — so
 * it says so, in rooms and calls, rather than offering five interchangeable
 * numbers. There is no seed control: the seed stays a URL parameter, where it
 * is a dev affordance rather than a decision the player is asked to have an
 * opinion about.
 *
 * Confirm is the one piece of diegetic copy on the screen. Everything else
 * here is plainly the software asking a configuration question, but pressing
 * that is the moment the player commits to going in, and it is the last thing
 * they read before the fiction starts.
 */

import { useState } from "react";
import type { PlayerCharacter, Size } from "../engine/index.ts";

const LABEL = "font-mono text-[9px] tracking-[0.16em] text-graphite uppercase";

const SIZES: Size[] = [1, 2, 3, 4, 5];
const LEVELS = [1, 2, 3, 4, 5];

/** A size-n dungeon is n regions of six rooms, and one writing call per region. */
function costOf(size: Size): string {
  const plural = size === 1 ? "" : "s";
  return `${size * 6} rooms · ${size} region${plural} · ${size} writing call${plural}`;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section className="mb-9">
      <div className={`${LABEL} mb-3`}>{label}</div>
      {children}
    </section>
  );
}

function Segmented<T extends number>({
  options,
  value,
  onChange,
}: {
  options: T[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex gap-[3px]">
      {options.map((o) => (
        <button
          key={o}
          type="button"
          onClick={() => onChange(o)}
          aria-pressed={o === value}
          className={`w-12 border py-2 font-mono text-[13px] transition-colors ${
            o === value
              ? "border-ink bg-ink text-paper"
              : "border-rule bg-paper text-graphite hover:border-graphite hover:text-ink"
          }`}
        >
          {o}
        </button>
      ))}
    </div>
  );
}

export function RunSetup({
  characters,
  initialId,
  onConfirm,
  onBack,
}: {
  characters: PlayerCharacter[];
  /** Whoever the player pressed *Send down* on. Falls back to the first. */
  initialId?: string;
  onConfirm: (opts: { size: Size; level: number; character: PlayerCharacter }) => void;
  onBack: () => void;
}) {
  const [size, setSize] = useState<Size>(2);
  const [level, setLevel] = useState(1);
  const [characterId, setCharacterId] = useState(initialId ?? characters[0]?.id);

  const character = characters.find((c) => c.id === characterId);

  return (
    <main className="min-h-screen bg-desk text-ink">
      <div className="mx-auto w-full max-w-[720px] px-8 py-16">
        <header className="mb-10">
          <button
            type="button"
            onClick={onBack}
            className="mb-6 font-mono text-[10px] uppercase tracking-[0.14em] text-graphite transition-colors hover:text-ink"
          >
            ← Characters
          </button>
          <h1 className="font-display text-[26px] font-bold leading-tight text-ink">
            A new run
          </h1>
          <p className={`${LABEL} mt-1.5`}>Where you are going, and who is going</p>
        </header>

        <Field label="Size">
          <Segmented options={SIZES} value={size} onChange={setSize} />
          <p className="mt-3 font-mono text-[11px] text-graphite">{costOf(size)}</p>
          <p className="mt-1.5 max-w-[46ch] font-prose text-[13px] leading-snug text-graphite">
            {size >= 4
              ? "A big one. The dungeon is written before you go in, and at this size that is several minutes and a real bill."
              : "The dungeon is written before you go in, so this is what the wait will cost."}
          </p>
        </Field>

        <Field label="Level">
          <Segmented options={LEVELS} value={level} onChange={setLevel} />
          <p className="mt-3 max-w-[46ch] font-prose text-[13px] leading-snug text-graphite">
            How dangerous the dungeon is — not how experienced your character is.
            Those are different numbers.
          </p>
        </Field>

        <Field label="Character">
          <ul className="space-y-2">
            {characters.map((pc) => {
              const chosen = pc.id === characterId;
              return (
                <li key={pc.id}>
                  <button
                    type="button"
                    onClick={() => setCharacterId(pc.id)}
                    aria-pressed={chosen}
                    className={`flex w-full items-baseline justify-between gap-4 border px-5 py-3.5 text-left transition-colors ${
                      chosen
                        ? "border-torch bg-torch-wash"
                        : "border-rule bg-paper hover:border-graphite"
                    }`}
                  >
                    <span className="font-display text-[16px] font-bold text-ink">{pc.name}</span>
                    <span className="font-mono text-[11px] text-graphite">
                      Level {pc.level} · {pc.hp.current}/{pc.hp.max} HP
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </Field>

        <div className="border-t border-rule-faint pt-8">
          <button
            type="button"
            disabled={!character}
            onClick={() => character && onConfirm({ size, level, character })}
            className="bg-torch px-6 py-3 font-mono text-[12px] uppercase tracking-[0.14em] text-paper transition-colors hover:bg-torch-deep disabled:bg-rule disabled:text-pencil"
          >
            Go down
          </button>
          <p className="mt-3 font-mono text-[10px] uppercase tracking-[0.14em] text-graphite">
            The dungeon starts being written the moment you press it
          </p>
        </div>
      </div>
    </main>
  );
}
