/**
 * STEP 5 — NAME AND CONFIRM.
 *
 * The whole sheet, and the only button in the flow that writes anything. The
 * character shown here IS the character saved — the same `PlayerCharacter` the
 * step is handed, rather than one built again on the press, so there is no gap
 * between the review and the record.
 *
 * Beside it, the portrait: drawn from this sheet on a press, a few a day, or
 * the player's own picture uploaded. Shown only where there is a server to ask.
 */

import { useRef } from "react";

import { ABILITIES } from "../../rules/knave/character-creation.ts";
import {
  armorDefense as pcArmorDefense,
  slotCapacity,
  slotsUsed,
  type PlayerCharacter,
} from "../../rules/knave/character.ts";
import { describePerson } from "../shared/person.ts";
import { Button, LABEL, RerollGlyph } from "./shared.tsx";
import { signed } from "../../shared/utils/format.ts";
import { untilReset, type Allowance } from "../../api-client/allowance.ts";
import { PortraitImage } from "../shared/portrait.tsx";

function Stat({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div>
      <div className="font-display text-[9px] uppercase tracking-[0.14em] text-graphite">{label}</div>
      <div className={`font-mono text-[24px] font-bold ${warn ? "text-torch" : "text-ink"}`}>{value}</div>
    </div>
  );
}

/** What the step needs to offer a portrait. Absent, it offers none. */
export interface PortraitControls {
  /** today's count, once read; until then the buttons say nothing about it */
  allowance?: Allowance;
  busy?: "drawing" | "uploading";
  /** the last refusal or failure, in the server's words */
  error?: string;
  onDraw: () => void;
  onUpload: (file: File) => void;
}

/** "2 of 3 drawings left today", or when more come. Nothing for an unlimited account. */
function drawingsLeft(a: Allowance): string | undefined {
  if (a.portraitsLimit === null || a.portraitsLeft === null) return undefined;
  if (a.portraitsLeft === 0) return `No drawings left today · more ${untilReset(a.resetsAt)}`;
  return `${a.portraitsLeft} of ${a.portraitsLimit} drawing${a.portraitsLimit === 1 ? "" : "s"} left today`;
}

function PortraitPanel({ pc, controls }: { pc: PlayerCharacter; controls: PortraitControls }) {
  const file = useRef<HTMLInputElement>(null);
  const { allowance, busy, error } = controls;
  const spent = allowance?.portraitsLeft === 0;
  const count = allowance && drawingsLeft(allowance);

  return (
    <div>
      <div className={`${LABEL} mb-2`}>Portrait</div>
      <div className="relative flex aspect-[2/3] w-full items-center justify-center border border-rule bg-paper">
        {pc.portrait ? (
          <PortraitImage portrait={pc.portrait} label={`${pc.name}'s portrait`} className="h-full w-full p-2" />
        ) : (
          !busy && (
            <p className="px-6 text-center font-prose text-[15px] italic leading-snug text-graphite">
              No portrait yet. Have them drawn from everything rolled, or use a picture of your own.
            </p>
          )
        )}
        {busy && (
          <div
            className="absolute inset-0 flex items-center justify-center bg-paper/80"
            role="status"
            aria-label={busy === "drawing" ? "Drawing the portrait" : "Uploading the picture"}
          >
            {/* The same spinner as an illustration being drawn. */}
            <span className="h-6 w-6 animate-spin rounded-full border-2 border-rule border-t-graphite" />
          </div>
        )}
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        <Button onClick={controls.onDraw} disabled={!!busy || spent} className="px-4 py-2 text-[12.5px]">
          {pc.portrait?.source === "drawn" ? "Draw again" : "Draw them"}
        </Button>
        <Button tone="ghost" onClick={() => file.current?.click()} disabled={!!busy} className="px-4 py-2 text-[12.5px]">
          Upload your own
        </Button>
        <input
          ref={file}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          aria-label="Upload a portrait"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            // Cleared, so choosing the same file again is still a change.
            e.target.value = "";
            if (f) controls.onUpload(f);
          }}
        />
      </div>
      {count && <p className="mt-2 font-mono text-[10.5px] text-graphite">{count}</p>}
      {error && (
        <p className="mt-1.5 font-prose text-[13px] leading-snug text-torch-deep" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export function StepConfirm({
  pc,
  name,
  onName,
  onRollName,
  onBack,
  onSave,
  portraits,
}: {
  pc: PlayerCharacter;
  name: string;
  onName: (v: string) => void;
  onRollName: () => void;
  onBack: () => void;
  onSave: () => void;
  portraits?: PortraitControls;
}) {
  const used = slotsUsed(pc);
  const capacity = slotCapacity(pc);

  return (
    <div>
      <h2 className="font-prose text-[38px] font-semibold leading-tight text-ink">Name them</h2>

      <div className="mt-4 flex max-w-[520px] items-center border-b-2 border-ink">
        <input
          type="text"
          value={name}
          onChange={(e) => onName(e.target.value)}
          aria-label="Name"
          placeholder="Nameless"
          className="flex-1 border-0 bg-transparent py-1.5 font-prose text-[34px] text-ink outline-none placeholder:text-pencil"
        />
        <span className="flex items-center gap-1.5 py-1.5 pl-3">
          <RerollGlyph onClick={onRollName} title="Roll a name" label="Roll a name" />
          <span className="font-mono text-[11px] uppercase tracking-[0.1em] text-graphite">
            Roll a name
          </span>
        </span>
      </div>

      <div className={portraits ? "mt-8 grid items-start gap-6 md:grid-cols-[220px_1fr]" : "mt-8"}>
      {portraits && <PortraitPanel pc={pc} controls={portraits} />}
      <div className={`grid border border-rule bg-paper shadow-[4px_4px_0_rgb(34_32_28_/_0.06)] md:grid-cols-2 ${portraits ? "md:mt-[22px]" : ""}`}>
        <div className="border-b border-rule-faint p-6 md:border-b-0 md:border-r">
          <div className={`${LABEL} mb-3`}>Abilities</div>
          <div className="grid grid-cols-6 gap-2 text-center">
            {ABILITIES.map((a) => (
              <div key={a}>
                <div className="font-display text-[10px] uppercase tracking-[0.1em] text-graphite">{a}</div>
                <div className="font-mono text-[22px] font-bold text-ink">{signed(pc.abilities[a])}</div>
                <div className="font-mono text-[11px] text-indigo">{pc.abilities[a] + 10}</div>
              </div>
            ))}
          </div>

          <div className="my-4 h-px bg-rule-faint" />

          <div className="flex flex-wrap gap-7">
            <Stat label="HP" value={`${pc.hp.current}/${pc.hp.max}`} />
            <Stat label="Armor def" value={`${pcArmorDefense(pc)}`} />
            <Stat label="Slots" value={`${used}/${capacity}`} warn={used > capacity} />
            <Stat label="Rules" value={pc.mode === "hardcore" ? "HARDCORE" : "NORMAL"} />
          </div>
        </div>

        <div className="p-6">
          <div className={`${LABEL} mb-3`}>The person</div>
          <p className="font-prose text-[18px] leading-relaxed text-ink text-pretty">
            {describePerson(pc.traits)}
          </p>

          <div className="my-4 h-px bg-rule-faint" />

          <div className={`${LABEL} mb-2`}>Carrying</div>
          <p className="font-prose text-[16px] leading-relaxed text-ink">
            {pc.inventory.map((i) => (i.amount ? `${i.name} (${i.amount})` : i.name)).join(" · ")}
          </p>
        </div>
      </div>
      </div>

      <div className="mt-6 flex flex-wrap items-center justify-between gap-4">
        <Button tone="ghost" onClick={onBack} className="px-5 py-3 text-[13px]">
          ← Back to equipment
        </Button>
        <Button tone="primary" onClick={onSave} className="px-8 py-3.5 text-[15px]">
          Save and send them down
        </Button>
      </div>
      <p className="mt-2 text-right font-mono text-[10px] uppercase tracking-[0.12em] text-graphite">
        Nothing is saved until you press this
      </p>
    </div>
  );
}
