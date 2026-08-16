/**
 * CHARACTERS — the landing screen, and the only one outside a run.
 *
 * Two doors: make a character, or take one into a dungeon. Both are open now;
 * the "not yet" copy that stood in for creation through Phase 4.5 is gone with
 * the thing it apologised for.
 *
 * A row is a person, not a record: the name, one sentence of who they are, and
 * the four numbers that decide whether they come back. The prose line is built
 * from the same eleven traits the referee reads, by the same function the
 * confirm step used — so the character you approved and the character listed
 * here describe themselves the same way.
 *
 * DELETING IS REAL AND UNDOABLE ONLY BY ROLLING ANOTHER, so it asks. It is also
 * what finally makes the empty state reachable — `CODING-PLAN.md` §1.2 item 13
 * has been carrying that as a designed-but-unreachable screen since 4.5.
 *
 * DEFERRED, not dropped: the design plan's IN A RUN / DIED · ROOM 3 badges and
 * the epitaph. Those need per-character run state that nothing stores yet, and
 * a badge computed from a field nobody writes would be worse than no badge.
 */

import { useState } from "react";
import {
  pcArmorDefense,
  slotCapacity,
  slotsUsed,
  type PlayerCharacter,
} from "../engine/index.ts";
import { Button } from "./create/shared.tsx";
import { describePerson } from "./person.ts";

const ABILITIES = ["str", "dex", "con", "int", "wis", "cha"] as const;

function Row({
  pc,
  onSend,
  onDelete,
}: {
  pc: PlayerCharacter;
  onSend: () => void;
  onDelete: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const used = slotsUsed(pc);
  const capacity = slotCapacity(pc);

  return (
    <li className="grid items-start gap-6 border-b border-rule py-6 sm:grid-cols-[minmax(0,1fr)_auto]">
      <div>
        <div className="flex flex-wrap items-baseline gap-3">
          <h2 className="font-prose text-[26px] font-semibold leading-tight text-ink">{pc.name}</h2>
          {pc.mode === "hardcore" ? (
            <span className="border border-torch px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.14em] text-torch">
              Hardcore
            </span>
          ) : null}
        </div>

        <p className="mt-1.5 max-w-[56ch] font-prose text-[16px] leading-relaxed text-graphite">
          {describePerson(pc.traits)}
        </p>

        <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1.5 font-mono text-[11px] text-graphite">
          <span>LVL {pc.level}</span>
          <span>
            HP {pc.hp.current}/{pc.hp.max}
          </span>
          <span>
            {ABILITIES.map((k) => `${k.toUpperCase()} ${pc.abilities[k] >= 0 ? "+" : ""}${pc.abilities[k]}`).join(" ")}
          </span>
          <span>ARMOR DEF {pcArmorDefense(pc)}</span>
          <span className={used > capacity ? "text-torch" : undefined}>
            {used}/{capacity} SLOTS
          </span>
        </div>
      </div>

      <div className="flex flex-col items-stretch gap-2">
        <Button tone="secondary" onClick={onSend} className="px-5 py-2.5 text-[12px]">
          Send down
        </Button>
        {confirming ? (
          <div className="flex gap-2">
            <Button
              tone="ghost"
              onClick={onDelete}
              className="flex-1 border-torch px-3 py-2.5 text-[12px] text-torch hover:border-torch hover:text-torch-deep"
            >
              Really
            </Button>
            <Button tone="ghost" onClick={() => setConfirming(false)} className="flex-1 px-3 py-2.5 text-[12px]">
              Keep
            </Button>
          </div>
        ) : (
          <Button tone="ghost" onClick={() => setConfirming(true)} className="px-5 py-2.5 text-[12px]">
            Delete
          </Button>
        )}
      </div>
    </li>
  );
}

export function Characters({
  characters,
  onStartRun,
  onCreate,
  onDelete,
  account,
  onSignOut,
}: {
  characters?: PlayerCharacter[];
  onStartRun: (pc: PlayerCharacter) => void;
  onCreate: () => void;
  onDelete: (pc: PlayerCharacter) => void;
  /**
   * Who is signed in. OPTIONAL, and absent on a `?offline` or `?stub` run —
   * those are played entirely in the browser and require no account, so a
   * sign-out control there would offer to end a session that does not exist.
   */
  account?: { email?: string; name?: string };
  onSignOut?: () => void;
}) {
  return (
    <main className="min-h-screen bg-desk text-ink">
      <div className="mx-auto w-full max-w-[880px] px-10 pb-20 pt-16">
        <header>
          <div className="flex items-baseline justify-between gap-4">
            <div className="font-mono text-[10px] uppercase tracking-[0.26em] text-graphite">Knave 1.0</div>
            {account && onSignOut && (
              <div className="flex items-baseline gap-3 font-mono text-[10px] text-ash">
                <span className="truncate max-w-[24ch]">{account.email ?? account.name}</span>
                <button
                  type="button"
                  onClick={onSignOut}
                  className="uppercase tracking-[0.14em] text-graphite underline decoration-rule underline-offset-4 hover:text-torch"
                >
                  Sign out
                </button>
              </div>
            )}
          </div>
          <h1 className="mt-2.5 font-prose text-[46px] font-semibold leading-none text-ink">Characters</h1>
          <div className="mt-5 h-0.5 bg-ink" />
        </header>

        {/* One frame against an in-memory array, a real wait against a
            database. The line is here so the second case does not need a new
            screen when it arrives. */}
        {characters === undefined ? (
          <p className="mt-10 font-prose text-[15px] italic text-pencil">Reading the roll…</p>
        ) : characters.length === 0 ? (
          <div className="px-0 pb-14 pt-20 text-center">
            <p className="mx-auto max-w-[34ch] font-prose text-[26px] italic leading-snug text-graphite">
              No one here yet. It takes about four minutes to make someone, and they
              probably won't last much longer than that.
            </p>
            <Button tone="primary" onClick={onCreate} className="mt-8 px-8 py-3.5 text-[15px]">
              Roll one up
            </Button>
          </div>
        ) : (
          <>
            <ul className="flex flex-col">
              {characters.map((pc) => (
                <Row
                  key={pc.id}
                  pc={pc}
                  onSend={() => onStartRun(pc)}
                  onDelete={() => onDelete(pc)}
                />
              ))}
            </ul>

            <Button tone="primary" onClick={onCreate} className="mt-9 px-7 py-3.5 text-[14px]">
              Roll up a new one
            </Button>
          </>
        )}
      </div>
    </main>
  );
}
