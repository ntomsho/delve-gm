/**
 * CHARACTERS — the landing screen, and the only one outside a run.
 *
 * Two doors: make a character, or take one into a dungeon. One of them is shut
 * until Phase 5, and the design brief is specific about how that should read —
 * *not yet*, rather than broken or locked behind an accomplishment. So the
 * button is plainly disabled with a plain sentence next to it, and there is no
 * padlock anywhere on this screen.
 *
 * The cards are read-only. Loading and deleting arrive with creation, because
 * all three are the same Phase 5 work and a delete button over a stock of
 * exactly one seeded character would be a trap rather than a feature.
 */

import {
  pcArmorDefense,
  slotCapacity,
  slotsUsed,
  type PlayerCharacter,
} from "../engine/index.ts";

const LABEL = "font-mono text-[9px] tracking-[0.16em] text-graphite uppercase";

const ABILITIES = ["str", "dex", "con", "int", "wis", "cha"] as const;

/** The traits that read as a person at a glance. The other seven are on the sheet. */
const AT_A_GLANCE = ["physique", "face", "virtue", "vice", "background"] as const;

function CharacterCard({ pc }: { pc: PlayerCharacter }) {
  const used = slotsUsed(pc);
  const capacity = slotCapacity(pc);

  return (
    <li className="border border-rule bg-paper px-6 py-5">
      <div className="flex items-baseline justify-between gap-4">
        <h2 className="font-display text-[19px] font-bold leading-tight text-ink">{pc.name}</h2>
        <span className={LABEL}>Level {pc.level}</span>
      </div>

      <p className="mt-1.5 font-prose text-[13px] italic leading-snug text-graphite">
        {AT_A_GLANCE.map((t) => pc.traits[t]).join(" · ")}
      </p>

      <div className="mt-4 flex flex-wrap items-baseline gap-x-6 gap-y-2 font-mono text-[11px]">
        <span>
          <span className="text-graphite">HP </span>
          <span className="text-ink">
            {pc.hp.current}/{pc.hp.max}
          </span>
        </span>

        {ABILITIES.map((k) => (
          <span key={k}>
            <span className="uppercase text-graphite">{k} </span>
            <span className="text-ink">
              {pc.abilities[k] >= 0 ? "+" : ""}
              {pc.abilities[k]}
            </span>
          </span>
        ))}

        <span>
          <span className="text-graphite">ARMOR DEF </span>
          <span className="text-ink">{pcArmorDefense(pc)}</span>
        </span>

        <span>
          <span className="text-graphite">SLOTS </span>
          <span className={used > capacity ? "text-torch" : "text-ink"}>
            {used}/{capacity}
          </span>
        </span>
      </div>
    </li>
  );
}

export function Characters({
  characters,
  onStartRun,
}: {
  characters?: PlayerCharacter[];
  onStartRun: () => void;
}) {
  return (
    <main className="min-h-screen bg-desk text-ink">
      <div className="mx-auto w-full max-w-[720px] px-8 py-16">
        <header>
          <h1 className="font-display text-[26px] font-bold leading-tight text-ink">Characters</h1>
          <p className={`${LABEL} mt-1.5`}>Who you have to send in</p>
        </header>

        {/* One frame against an in-memory array, a real wait against a
            database. The line is here so the second case does not need a new
            screen when it arrives. */}
        {characters === undefined ? (
          <p className="mt-10 font-prose text-[14px] italic text-pencil">Reading the roll…</p>
        ) : characters.length === 0 ? (
          // Currently unreachable — creation is off and the stock is seeded.
          // The designed empty state is deferred with the flow that can cause it.
          <p className="mt-10 font-prose text-[15px] italic text-graphite">
            Nobody yet.
          </p>
        ) : (
          <ul className="mt-8 space-y-3">
            {characters.map((pc) => (
              <CharacterCard key={pc.id} pc={pc} />
            ))}
          </ul>
        )}

        <div className="mt-10 flex flex-wrap items-center gap-4 border-t border-rule-faint pt-8">
          <button
            type="button"
            onClick={onStartRun}
            disabled={!characters?.length}
            className="bg-torch px-5 py-2.5 font-mono text-[11px] uppercase tracking-[0.14em] text-paper transition-colors hover:bg-torch-deep disabled:bg-rule disabled:text-pencil"
          >
            Start a new run
          </button>

          <button
            type="button"
            disabled
            className="cursor-not-allowed border border-rule-faint px-5 py-2.5 font-mono text-[11px] uppercase tracking-[0.14em] text-pencil"
          >
            New character
          </button>

          <p className="font-prose text-[13px] italic text-graphite">
            Rolling one up comes next. For now there is one to take in.
          </p>
        </div>
      </div>
    </main>
  );
}
