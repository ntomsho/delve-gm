/**
 * THE END-OF-RUN PREVIEW — `?endings`
 * ===================================
 *
 * `EndOfRun` over fixture data, with every ending and every branch of it a
 * click apart. Getting to one of the four endings for real means playing a run
 * into it, and getting to all four means four runs; this is for looking at the
 * screen, not for testing whether a run reaches it — `lootOf`, `causeOfDeath`
 * and `shouldTally` have their own tests for that.
 *
 * Nothing here is a run. No session, no store, no account, no model call.
 *
 * THE RULE ABOUT KEEPING THE LOOT IS NOT RESTATED. `keeps` comes from
 * `keepsWhatTheyFound`, the same function the play screen calls, so the
 * preview cannot show a verdict the game would not.
 */

import { useState } from "react";
import { EndOfRun, type Ending } from "../play/EndOfRun.tsx";
import { keepsWhatTheyFound, type DeathReport, type RunLoot } from "../../runtime/loot.ts";
import type { RunTally } from "../../engine/index.ts";

// ---------------------------------------------------------------------------
// FIXTURES
// ---------------------------------------------------------------------------

const SOME_LOOT: RunLoot = {
  found: [
    { id: "reliquary", name: "Silver reliquary", value: 420 },
    { id: "comb", name: "Ivory comb", value: 85 },
    { id: "salts", name: "Smelling salts", amount: "6 doses", value: 30 },
    { id: "map", name: "Waterlogged map fragment", value: 0 },
  ],
  coin: 112,
  total: 647,
};

const NO_LOOT: RunLoot = { found: [], coin: 0, total: 0 };

const FULL_TALLY: RunTally = {
  awards: [
    { challengeId: "ch:a", about: "a creature's weakness", risk: "high", xp: 200, why: "Killed the ghoul in the Chapel of Rust" },
    { challengeId: "ch:b", about: "a blocked way", risk: "moderate", xp: 100, why: "Talked past the warden at the flooded gate" },
    { challengeId: "ch:c", about: "a hidden thing", risk: "low", xp: 50, why: "Found the drain behind the altar" },
    { challengeId: "ch:d", about: "the objective", risk: "high", xp: 200, why: "Carried the reliquary out" },
  ],
  total: 550,
  unrated: [],
};

const EMPTY_TALLY: RunTally = { awards: [], total: 0, unrated: [] };

const DEATH_KNOWN: DeathReport = {
  where: "the Chapel of Rust",
  turn: 23,
  killer: "Ghoul",
  lastAction: "swing at it again",
  present: ["Ghoul", "Thrall (3)"],
};

const DEATH_UNKNOWN: DeathReport = { where: "the Sunken Stair", turn: 9, present: [] };

const LEVEL = 1;

/** The character's career total before this run, for each XP case. */
const XP_BEFORE = {
  /** this run's award crosses the track */
  waiting: 700,
  /** this run's award leaves them short of it */
  distance: 0,
} as const;

// ---------------------------------------------------------------------------
// THE CONTROLS
// ---------------------------------------------------------------------------

const TABS: { stage: Ending; label: string }[] = [
  { stage: "dead", label: "Died" },
  { stage: "goal_met", label: "Escaped with goal" },
  { stage: "escaped", label: "Escaped without goal" },
  { stage: "abandoned", label: "Conceded" },
];

type LootCase = "some" | "none";
type TallyCase = "arrived" | "pending" | "empty";
type XpCase = keyof typeof XP_BEFORE;
type KillerCase = "known" | "unknown";

interface Options {
  loot: LootCase;
  tally: TallyCase;
  xp: XpCase;
  killer: KillerCase;
  roster: boolean;
}

export function EndingsPreview() {
  const [stage, setStage] = useState<Ending>("dead");
  const [o, setO] = useState<Options>({
    loot: "some",
    tally: "arrived",
    xp: "waiting",
    killer: "known",
    roster: true,
  });
  /** "Look around" was pressed. In a run that is the map; here it is a way back. */
  const [dismissed, setDismissed] = useState(false);

  const set = <K extends keyof Options>(k: K, v: Options[K]) => setO((p) => ({ ...p, [k]: v }));

  // Which controls mean anything for this ending — the rest are shown disabled
  // rather than hidden, so the strip does not jump about between tabs.
  const scored = stage === "goal_met" || stage === "escaped";
  const tally = !scored
    ? undefined
    : o.tally === "arrived"
      ? FULL_TALLY
      : o.tally === "empty"
        ? EMPTY_TALLY
        : undefined;

  return (
    <div className="flex h-screen flex-col bg-paper">
      <div
        className="shrink-0 border-b px-4 py-2.5"
        style={{ borderColor: "var(--color-rule)" }}
      >
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <span className="font-mono text-[9px] uppercase tracking-[0.18em] text-pencil">
            End-of-run preview
          </span>
          {TABS.map((t) => (
            <Choice
              key={t.stage}
              on={stage === t.stage}
              onClick={() => {
                setStage(t.stage);
                setDismissed(false);
              }}
            >
              {t.label}
            </Choice>
          ))}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-1.5">
          <Toggle label="Loot" value={o.loot} options={["some", "none"]} onPick={(v) => set("loot", v)} />
          <Toggle
            label="Tally"
            value={o.tally}
            options={["arrived", "pending", "empty"]}
            onPick={(v) => set("tally", v)}
            disabled={!scored}
          />
          <Toggle
            label="XP"
            value={o.xp}
            options={["waiting", "distance"]}
            onPick={(v) => set("xp", v)}
            disabled={!scored || o.tally !== "arrived"}
          />
          <Toggle
            label="Killer"
            value={o.killer}
            options={["known", "unknown"]}
            onPick={(v) => set("killer", v)}
            disabled={stage !== "dead"}
          />
          <Toggle
            label="Roster button"
            value={o.roster ? "shown" : "hidden"}
            options={["shown", "hidden"]}
            onPick={(v) => set("roster", v === "shown")}
          />
        </div>
      </div>

      {/*
        * A TRANSFORMED ANCESTOR IS THE CONTAINING BLOCK FOR `position: fixed`.
        * `EndOfRun` covers the viewport with `fixed inset-0`, which would cover
        * the controls too; the transform pins it to this region instead, so the
        * strip stays usable and the screen is otherwise drawn exactly as a run
        * draws it.
        */}
      <div className="relative min-h-0 flex-1" style={{ transform: "translateZ(0)" }}>
        {dismissed ? (
          <div className="flex h-full flex-col items-center justify-center gap-3">
            <p className="font-prose text-[14px] text-graphite">
              Dismissed. In a run this is the map and the scrollback.
            </p>
            <Choice on={false} onClick={() => setDismissed(false)}>
              Bring it back
            </Choice>
          </div>
        ) : (
          <EndOfRun
            // Remount per ending so the dialog's label and key handler are fresh.
            key={stage}
            stage={stage}
            turns={23}
            loot={o.loot === "some" ? SOME_LOOT : NO_LOOT}
            keeps={keepsWhatTheyFound(stage)}
            {...(tally ? { tally } : {})}
            {...(scored ? { xpTotal: XP_BEFORE[o.xp] + (tally?.total ?? 0), level: LEVEL } : {})}
            {...(stage === "dead" ? { death: o.killer === "known" ? DEATH_KNOWN : DEATH_UNKNOWN } : {})}
            onDismiss={() => setDismissed(true)}
            {...(o.roster ? { onLeave: () => setDismissed(true) } : {})}
          />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function Choice({
  on,
  onClick,
  disabled,
  children,
}: {
  on: boolean;
  onClick(): void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.12em] transition-colors disabled:opacity-35 ${
        on ? "border-ink bg-ink text-paper" : "border-rule text-graphite enabled:hover:text-ink"
      }`}
    >
      {children}
    </button>
  );
}

function Toggle<T extends string>({
  label,
  value,
  options,
  onPick,
  disabled,
}: {
  label: string;
  value: T;
  options: readonly T[];
  onPick(v: T): void;
  disabled?: boolean;
}) {
  return (
    <span className="flex items-center gap-1.5">
      <span
        className={`font-mono text-[9px] uppercase tracking-[0.14em] text-pencil ${disabled ? "opacity-35" : ""}`}
      >
        {label}
      </span>
      {options.map((v) => (
        <Choice key={v} on={value === v} onClick={() => onPick(v)} disabled={disabled}>
          {v}
        </Choice>
      ))}
    </span>
  );
}
