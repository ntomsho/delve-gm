/**
 * THE PORTRAITS PREVIEW — `?portraits`
 * ====================================
 *
 * The three screens that show a portrait, over pictures drawn by
 * `node src/dev/cli-portraits.ts` into `out/portraits/<seed>/<n>/`, which Vite
 * serves from the project root in development:
 *
 *   - Creation: the real `CreateCharacter`, with a portrait service that hands
 *     back those drawings in turn after a short wait, and takes an upload as the
 *     file itself (uncropped: the server's crop is not here).
 *   - Characters: the real roster, with the drawn characters on it.
 *   - Run setup: the real `RunSetup`, with the drawn characters on its list.
 *   - Play: the real `CharacterPanel`, desktop and phone, over a fixture run.
 *
 * Nothing here is a run or an account: no session, no server, no database, no
 * model call. It exists so the portraits can be looked at before the
 * `portraits` migration is applied anywhere.
 */

import { useMemo, useState } from "react";
import { CreateCharacter } from "../create/CreateCharacter.tsx";
import { RunSetup } from "../run-setup/RunSetup.tsx";
import { Characters } from "../characters/Characters.tsx";
import { NO_RECORD } from "../../api-client/characters.ts";
import { CharacterPanel } from "../play/CharacterPanel.tsx";
import { characterView } from "../../gameplay/view/character.ts";
import { newRun } from "../../gameplay/state/store.ts";
import { generateOffline } from "../../fixtures/offline.ts";
import type { PlayerCharacter, Portrait } from "../../rules/knave/character.ts";
import type { Allowance } from "../../api-client/allowance.ts";
import type { PortraitService } from "../../api-client/portraits.ts";

// ---------------------------------------------------------------------------
// WHAT THE SCRIPT DREW
// ---------------------------------------------------------------------------

/** Every sheet the script wrote, by path: `/out/portraits/<seed>/<n>/sheet.json`. */
const SHEETS = import.meta.glob<PlayerCharacter>("/out/portraits/*/*/sheet.json", { eager: true, import: "default" });

/** The drawn characters, each with its portrait, newest seed folder first. Only those whose drawing came out. */
const DRAWN: PlayerCharacter[] = Object.entries(SHEETS)
  .sort(([a], [b]) => b.localeCompare(a, undefined, { numeric: true }))
  .map(([path, sheet]) => {
    const dir = path.replace(/\/sheet\.json$/, "");
    const portrait: Portrait = { id: dir, url: `${dir}/ink.png`, thumbUrl: `${dir}/thumb.png`, source: "drawn" };
    return { ...sheet, portrait };
  });

const allowanceFor = (guest: boolean, used: number): Allowance => {
  const limit = guest ? 1 : 3;
  return {
    guest,
    unlimited: false,
    used: 0,
    limit: guest ? 1 : 3,
    left: guest ? 1 : 3,
    turnsUsed: 0,
    turnsLimit: guest ? 30 : 60,
    turnsLeft: guest ? 30 : 60,
    portraitsUsed: used,
    portraitsLimit: limit,
    portraitsLeft: Math.max(0, limit - used),
    maxSize: 1,
    resetsAt: new Date(Date.now() + 5 * 3600_000).toISOString(),
    unplayed: [],
    closed: false,
  };
};

/** Hands back the script's drawings in turn, counting against a pretend day like the server's. */
function fakeService(guest: boolean): PortraitService {
  let used = 0;
  let next = 0;
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  return {
    allowance: async () => allowanceFor(guest, used),
    async draw() {
      await wait(1500);
      const limit = guest ? 1 : 3;
      if (used >= limit) {
        throw Object.assign(new Error(`That is your ${limit} portrait${limit === 1 ? "" : "s"} for today. (Preview.)`), {
          allowance: allowanceFor(guest, used),
        });
      }
      const pc = DRAWN[next++ % DRAWN.length];
      used++;
      return { portrait: pc.portrait!, allowance: allowanceFor(guest, used) };
    },
    async upload(file) {
      await wait(500);
      const url = URL.createObjectURL(file);
      return { portrait: { id: `upload-${Date.now()}`, url, thumbUrl: url, source: "uploaded" } };
    },
  };
}

// ---------------------------------------------------------------------------
// THE PAGE
// ---------------------------------------------------------------------------

const TABS = ["Creation", "Characters", "Run setup", "Play"] as const;
type Tab = (typeof TABS)[number];

function Bar({ tab, setTab, guest, setGuest }: { tab: Tab; setTab: (t: Tab) => void; guest: boolean; setGuest: (g: boolean) => void }) {
  const chip = (on: boolean) =>
    `px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.12em] border ${on ? "border-ink bg-ink text-paper" : "border-rule bg-paper text-graphite hover:text-ink"}`;
  return (
    <div className="sticky top-0 z-40 flex flex-wrap items-center gap-2 border-b border-rule bg-desk px-4 py-2">
      <span className="mr-2 font-mono text-[10px] uppercase tracking-[0.14em] text-torch">Portraits preview</span>
      {TABS.map((t) => (
        <button key={t} type="button" className={chip(t === tab)} onClick={() => setTab(t)}>
          {t}
        </button>
      ))}
      {tab === "Creation" && (
        <span className="ml-4 flex gap-2">
          <button type="button" className={chip(guest)} onClick={() => setGuest(true)}>
            Guest · 1 a day
          </button>
          <button type="button" className={chip(!guest)} onClick={() => setGuest(false)}>
            Member · 3 a day
          </button>
        </span>
      )}
    </div>
  );
}

function Empty() {
  return (
    <main className="mx-auto max-w-[640px] px-8 py-16 font-prose text-[18px] text-ink">
      <p>No portraits to show yet. Draw some first:</p>
      <pre className="mt-4 bg-paper p-4 font-mono text-[13px]">node src/dev/cli-portraits.ts</pre>
      <p className="mt-4 text-graphite">Then reload this page.</p>
    </main>
  );
}

function Play() {
  const pc = DRAWN[0];
  const view = useMemo(() => characterView(newRun(generateOffline(1005, 1), pc)), [pc]);
  return (
    <main className="flex flex-wrap items-start gap-10 bg-desk p-8">
      <div>
        <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.14em] text-graphite">Desktop · the sheet beside the narration</div>
        <div className="h-[720px] w-[300px] border border-rule">
          <CharacterPanel pc={view} />
        </div>
      </div>
      <div>
        <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.14em] text-graphite">Phone · the sheet tab</div>
        <div className="w-[390px] border border-rule">
          <CharacterPanel pc={view} compact />
        </div>
      </div>
    </main>
  );
}

/** A character with no portrait, to see the list with both. */
function undrawn({ portrait: _, ...pc }: PlayerCharacter): PlayerCharacter {
  return { ...pc, id: "no-portrait", name: "Somebody Undrawn" };
}

export function PortraitsPreview() {
  // `?portraits=roster`, `=setup` or `=play` opens on that tab, for a screenshot that cannot click.
  const [tab, setTab] = useState<Tab>(() => {
    const asked = new URLSearchParams(location.search).get("portraits");
    return asked === "setup" ? "Run setup" : asked === "play" ? "Play" : asked === "roster" ? "Characters" : "Creation";
  });
  const [guest, setGuest] = useState(false);
  // A new service per tier and per visit, so each starts the pretend day afresh.
  const service = useMemo(() => fakeService(guest), [guest, tab]);

  if (DRAWN.length === 0) return <Empty />;
  return (
    <div className="min-h-screen bg-desk">
      <Bar tab={tab} setTab={setTab} guest={guest} setGuest={setGuest} />
      {tab === "Creation" && <CreateCharacter key={`${guest}`} portraits={service} onCancel={() => {}} onSave={() => {}} />}
      {tab === "Characters" && (
        <Characters
          characters={[...DRAWN.slice(0, 4), undrawn(DRAWN[0])].map((sheet) => ({ sheet, record: NO_RECORD }))}
          onStartRun={() => setTab("Run setup")}
          onResumeRun={() => {}}
          onAbandonRun={() => {}}
          onShop={() => {}}
          onLevelUp={() => {}}
          onCreate={() => setTab("Creation")}
          onDelete={() => {}}
        />
      )}
      {tab === "Run setup" && (
        <RunSetup
          characters={[...DRAWN.slice(0, 4), undrawn(DRAWN[0])]}
          onConfirm={() => {}}
          onBack={() => setTab("Creation")}
        />
      )}
      {tab === "Play" && <Play />}
    </div>
  );
}
