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
 * **A WORLD OUTLIVES THE RUN PLAYED IN IT** — Phase 13a, and the first question
 * on the screen rather than a footnote under the last one. Every run before this
 * bought a fresh dungeon whether or not the player already had one they wanted
 * to go back down, because there was no way to say so; a dungeon was written,
 * played once and then unreachable. So the screen asks WHICH WORLD first, and
 * size and level appear only under the branch that is actually rolling one —
 * they are facts about a world that already exists, and offering them beside a
 * chosen dungeon would be offering controls that do nothing.
 *
 * Confirm is the one piece of diegetic copy on the screen. Everything else
 * here is plainly the software asking a configuration question, but pressing
 * that is the moment the player commits to going in, and it is the last thing
 * they read before the fiction starts.
 */

import { useState } from "react";
import type { DungeonSummary } from "../store/dungeons.ts";
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

/**
 * What confirming means, and the two things it can mean are different requests.
 *
 * A tagged union rather than a bag with optional fields, so there is no way to
 * hand back a dungeon id AND a size — which would be two answers to one
 * question and leave the server deciding which it believed.
 */
export type RunChoice =
  | { world: "new"; size: Size; level: number; character: PlayerCharacter }
  | { world: "existing"; dungeonId: string; character: PlayerCharacter };

/**
 * One choosable world, and "a new one" is one of them.
 *
 * Deliberately the same mark as the character rows below it: these are two
 * lists of things to pick, and a screen that styled them differently would be
 * claiming a difference that is not there.
 *
 * The objective is shown because it is the one line that distinguishes two
 * worlds of the same size and level at a glance — six months from now the list
 * is a dozen holes and "Size 2 · Level 1" names none of them.
 */
function WorldRow({
  chosen,
  onClick,
  name,
  detail,
  objective,
}: {
  chosen: boolean;
  onClick: () => void;
  name: string;
  detail: string;
  objective?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={chosen}
      className={`w-full border px-5 py-3.5 text-left transition-colors ${
        chosen ? "border-torch bg-torch-wash" : "border-rule bg-paper hover:border-graphite"
      }`}
    >
      <span className="flex items-baseline justify-between gap-4">
        <span className="font-display text-[16px] font-bold text-ink">{name}</span>
        <span className="shrink-0 font-mono text-[11px] text-graphite">{detail}</span>
      </span>
      {objective && (
        <span className="mt-1 block max-w-[52ch] font-prose text-[13px] leading-snug text-graphite">
          {objective}
        </span>
      )}
    </button>
  );
}

export function RunSetup({
  characters,
  dungeons = [],
  initialId,
  onConfirm,
  onBack,
}: {
  characters: PlayerCharacter[];
  /**
   * The player's own worlds. Only the finished ones can be walked into —
   * `POST /api/runs` refuses a partial — and `App` has already dropped the rest,
   * because a control that is offered and then refused is worse than one that
   * was never there.
   */
  dungeons?: DungeonSummary[];
  /** Whoever the player pressed *Send down* on. Falls back to the first. */
  initialId?: string;
  onConfirm: (choice: RunChoice) => void;
  onBack: () => void;
}) {
  const [size, setSize] = useState<Size>(2);
  const [level, setLevel] = useState(1);
  const [characterId, setCharacterId] = useState(initialId ?? characters[0]?.id);
  /**
   * Which world, as an id or the absence of one.
   *
   * `undefined` IS "a new one" rather than a third state, because that is what
   * this screen has always meant by pressing Go down and it is what a player
   * with no saved worlds gets without being asked a question that has one
   * answer.
   */
  const [dungeonId, setDungeonId] = useState<string>();

  const character = characters.find((c) => c.id === characterId);
  const world = dungeons.find((d) => d.id === dungeonId);
  // A world chosen and then no longer on the list — the roster refreshed under
  // the screen — is nothing rather than a run into a dungeon we cannot name.
  const fresh = !world;

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

        {/* THE FIRST QUESTION, because it decides whether the next two are
            questions at all. A player with no saved worlds still sees it — the
            list is empty and the new-world row is chosen — which is the honest
            way to teach that worlds are kept. */}
        <Field label="World">
          <ul className="space-y-2">
            <li>
              <WorldRow
                chosen={fresh}
                onClick={() => setDungeonId(undefined)}
                name="A new one"
                detail="Rolled and written now"
              />
            </li>
            {dungeons.map((d) => (
              <li key={d.id}>
                <WorldRow
                  chosen={d.id === dungeonId}
                  onClick={() => setDungeonId(d.id)}
                  name={d.name}
                  detail={`Size ${d.size} · Level ${d.level}`}
                  {...(d.objective ? { objective: d.objective } : {})}
                />
              </li>
            ))}
          </ul>
          {!fresh && (
            <p className="mt-3 max-w-[46ch] font-prose text-[13px] leading-snug text-graphite">
              Already written, so there is nothing to wait for and nothing to
              pay. The world is exactly as you left it — what you did down there
              last time is not undone.
            </p>
          )}
        </Field>

        {/* Only under the branch that is rolling one. Beside a chosen dungeon
            these would be controls that change nothing, which is a worse thing
            to show a player than an absence. */}
        {fresh && (
          <>
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
          </>
        )}

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
            onClick={() =>
              character &&
              onConfirm(
                world
                  ? { world: "existing", dungeonId: world.id, character }
                  : { world: "new", size, level, character }
              )
            }
            className="bg-torch px-6 py-3 font-mono text-[12px] uppercase tracking-[0.14em] text-paper transition-colors hover:bg-torch-deep disabled:bg-rule disabled:text-pencil"
          >
            Go down
          </button>
          <p className="mt-3 font-mono text-[10px] uppercase tracking-[0.14em] text-graphite">
            {fresh
              ? "The dungeon starts being written the moment you press it"
              : "Straight down — this one is already written"}
          </p>
        </div>
      </div>
    </main>
  );
}
