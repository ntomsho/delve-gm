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
 * THE BADGES ARRIVED IN PHASE 12, having been deferred here since Phase 5 with
 * the note that a badge computed from a field nobody writes is worse than no
 * badge. Nobody wrote a field in the end: **IN A RUN** is a row in `runs` with
 * `status = 'active'`, and the record beneath a name is those rows grouped by
 * how they ended. Both are derived on read and neither can drift.
 *
 * A CHARACTER IN A RUN IS NOT OFFERED A NEW ONE. The door out of this screen is
 * the run they are already in — resume it, or walk away from it — because they
 * may hold exactly one at a time and the interface should not offer a move the
 * game will refuse.
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
import type { ActiveRun, CharacterEntry, CharacterRecord } from "../store/characters.ts";

const ABILITIES = ["str", "dex", "con", "int", "wis", "cha"] as const;

/**
 * WHAT HAS HAPPENED TO THEM, and nothing when nothing has.
 *
 * Ordered worst to best on purpose — this is a Knave character and the honest
 * summary of one leads with how many times they have died. A character with a
 * clean sheet gets no line at all rather than four zeroes: the absence says
 * "new" more clearly than the numbers would.
 */
function Record({ record }: { record: CharacterRecord }) {
  const parts: string[] = [];
  if (record.dead) parts.push(`${record.dead} DIED`);
  if (record.abandoned) parts.push(`${record.abandoned} WALKED AWAY`);
  if (record.escaped) parts.push(`${record.escaped} OUT EMPTY-HANDED`);
  if (record.goalMet) parts.push(`${record.goalMet} DONE`);
  if (parts.length === 0) return null;

  return (
    <div className="mt-2 font-mono text-[10px] uppercase tracking-[0.14em] text-pencil">
      {parts.join(" · ")}
    </div>
  );
}

function Row({
  entry,
  onSend,
  onBrowse,
  onResume,
  onAbandon,
  onShop,
  onDelete,
}: {
  entry: CharacterEntry;
  onSend: () => void;
  /** Absent on a local run, which has no library to browse. */
  onBrowse?: () => void;
  onResume: () => void;
  onAbandon: () => void;
  onShop: () => void;
  onDelete: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const { sheet: pc, activeRun } = entry;
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
          {/* Where they are, which outranks anything else on the row: it is the
              one fact that decides what the buttons opposite can do. */}
          {activeRun && (
            <span className="border border-torch bg-torch-wash px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.14em] text-torch-deep">
              In a run · {activeRun.dungeonName} · turn {activeRun.turnCount + 1}
            </span>
          )}
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

        <Record record={entry.record} />
      </div>

      <div className="flex flex-col items-stretch gap-2">
        {/*
         * THE PRIMARY DOOR IS WHICHEVER ONE IS OPEN.
         *
         * One button in the same place either way, because a player scanning
         * six rows should not have to work out per row which control they are
         * looking at. Only the verb changes, and it changes because the game
         * changed — a character in a run cannot be sent anywhere.
         */}
        {activeRun ? (
          <Button tone="secondary" onClick={onResume} className="px-5 py-2.5 text-[12px]">
            Resume run
          </Button>
        ) : (
          <Button tone="secondary" onClick={onSend} className="px-5 py-2.5 text-[12px]">
            Send down
          </Button>
        )}

        {/*
         * THE SHELF, and it is a second door rather than a field on the first.
         *
         * `Send down` rolls a world. This one picks a world somebody else
         * already wrote — the same destination by a different road, and the
         * roads are far enough apart to be separate buttons: one costs a minute
         * and a real bill, the other costs neither and cannot be undone by
         * choosing again, because taking a copy is free and idempotent.
         *
         * Absent while they are in a run, like everything else that would start
         * a second one. A character holds exactly one at a time.
         */}
        {!activeRun && onBrowse && (
          <Button tone="ghost" onClick={onBrowse} className="px-5 py-2.5 text-[12px]">
            Browse worlds
          </Button>
        )}

        {/*
         * THE MARKET, for anybody who is not underground.
         *
         * Shown at an empty purse too, rather than only to the characters who
         * took the copper: a door that appears and disappears depending on a
         * number the row does not print is a door nobody learns. The shop says
         * the purse is empty far more clearly than a missing button does, and
         * the price list is worth reading either way.
         *
         * Absent while they are in a run, like Delete and for the same reason —
         * the sheet on the server is the one the run is playing from, and
         * editing it out from under a live run is a save fighting itself.
         */}
        {!activeRun && (
          <Button tone="ghost" onClick={onShop} className="px-5 py-2.5 text-[12px]">
            Shop
          </Button>
        )}

        {/*
         * ABANDON REPLACES DELETE while there is a run, rather than joining it.
         * Deleting is refused by the server anyway — a live run with no owner is
         * a save nobody can reach — and offering a button that can only say no
         * is worse than offering the one thing that actually helps. Delete comes
         * back the moment the run ends.
         */}
        {activeRun ? (
          leaving ? (
            <div className="flex gap-2">
              <Button
                tone="ghost"
                onClick={onAbandon}
                className="flex-1 border-torch px-3 py-2.5 text-[12px] text-torch hover:border-torch hover:text-torch-deep"
              >
                Abandon
              </Button>
              <Button tone="ghost" onClick={() => setLeaving(false)} className="flex-1 px-3 py-2.5 text-[12px]">
                Keep it
              </Button>
            </div>
          ) : (
            <Button tone="ghost" onClick={() => setLeaving(true)} className="px-5 py-2.5 text-[12px]">
              Abandon run
            </Button>
          )
        ) : confirming ? (
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
  onBrowse,
  onResumeRun,
  onAbandonRun,
  onShop,
  onCreate,
  onDelete,
  notice,
  account,
  onSignOut,
}: {
  characters?: CharacterEntry[];
  onStartRun: (pc: PlayerCharacter) => void;
  /**
   * Take this character to the shelf of worlds other people wrote.
   *
   * OPTIONAL, and absent on a `?offline` or `?stub` run for the same reason the
   * sign-out control is: the library is a table in Postgres, and a local run has
   * no account to read it with. The button is simply not there.
   */
  onBrowse?: (pc: PlayerCharacter) => void;
  /** Pick the run this character is in back up. Only ever called with one. */
  onResumeRun: (run: ActiveRun) => void;
  onAbandonRun: (run: ActiveRun) => void;
  /** Take them to the market. Only ever called for somebody not in a run. */
  onShop: (pc: PlayerCharacter) => void;
  onCreate: () => void;
  onDelete: (pc: PlayerCharacter) => void;
  /**
   * A refusal from the server, said in its own words.
   *
   * Deleting somebody who is still down there is the one that happens, and "that
   * character is in a run" is an instruction the player can act on — where a
   * silently-failed button is not.
   */
  notice?: string;
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

        {notice && (
          <p
            className="mt-6 border-l-2 border-torch py-2 pl-3 font-mono text-[12px] text-torch-deep"
            role="status"
          >
            {notice}
          </p>
        )}

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
              {characters.map((entry) => (
                <Row
                  key={entry.sheet.id}
                  entry={entry}
                  onSend={() => onStartRun(entry.sheet)}
                  {...(onBrowse ? { onBrowse: () => onBrowse(entry.sheet) } : {})}
                  onResume={() => entry.activeRun && onResumeRun(entry.activeRun)}
                  onAbandon={() => entry.activeRun && onAbandonRun(entry.activeRun)}
                  onShop={() => onShop(entry.sheet)}
                  onDelete={() => onDelete(entry.sheet)}
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
