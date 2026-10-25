/**
 * THE APP SHELL: which screen is showing, and which session plays the run.
 *
 * A bare load lands on `Characters`, goes to `RunSetup`, and generation starts
 * when the player confirms. A real run is played by the server; this file
 * holds a store, posts what the player did, and shows what came back.
 *
 * The dev switches bypass the front of the app, because interface work against
 * a real dungeon is unbearable if every iteration costs two clicks and a
 * minute. Any one of them present means: skip the front and start a run with
 * the first saved character.
 *
 *   ?offline=1   the fixture dungeon AND the stub game master, played in the
 *                browser. No model, no server, no account. Spends nothing.
 *   ?seed=       which dungeon. Same seed, same dungeon.
 *   ?size=1..5   how big. Each region is one content-pass call.
 *   ?level=      how dangerous.
 *   ?endings     not a run: the end-of-run screen over fixture data, every
 *                ending a click apart. Read in `main.tsx`, so none of this
 *                file runs.
 *
 * The reading is in `switches.ts`, a pure function of the query string.
 */


import { lazy, Suspense, useEffect, useState } from "react";
import { LoadingScreen } from "../run-setup/LoadingScreen.tsx";
import { Characters } from "../characters/Characters.tsx";
import { Landing } from "../sign-in/Landing.tsx";
import { purse } from "../../rules/knave/character-creation.ts";
import type { PlayerCharacter } from "../../rules/knave/character.ts";
import { saveCharacter } from "../../api-client/characters.ts";
import { listLibrary } from "../../api-client/dungeons.ts";
import { signIn, signInAsGuest, upgradeToGoogle } from "../../api-client/auth.ts";
import { BYPASS, LEVEL, OFFLINE, SEED, SIZE, seedForNewRun } from "./local-run.ts";
import { useAccount } from "./use-account.ts";
import { useRoster } from "./use-roster.ts";
import { useRun } from "./use-run.ts";
import { useSetupData } from "./use-setup.ts";

/**
 * Only the part before a run. Once the dungeon exists, that is what decides.
 *
 * The market is not one of these. It is `shopping` holding a sheet, because a
 * shop with nobody in it is not a state the app can be in — and a screen name
 * that could disagree with the character it is showing is exactly the pair of
 * fields that drift apart.
 */
type Screen = "characters" | "create" | "setup" | "library" | "generating";

/**
 * THE SCREENS PAST THE ROSTER, FETCHED SEPARATELY.
 *
 * A first visit needs the sign-in screen and nothing else, so the play screen
 * (the map, the illustrations, the tooltips), character creation, the market,
 * the level-up modal, the library and run setup are each their own chunk.
 * `preload` starts all of them as soon as the app has mounted, so by the time
 * a player has clicked anything they are already there; the split buys a
 * faster first paint, not a wait later.
 */
const chunks = {
  play: () => import("../play/PlayScreen.tsx"),
  create: () => import("../create/CreateCharacter.tsx"),
  shop: () => import("../shop/Shop.tsx"),
  levelUp: () => import("../characters/LevelUp.tsx"),
  setup: () => import("../run-setup/RunSetup.tsx"),
  library: () => import("../run-setup/Library.tsx"),
};
const PlayScreen = lazy(() => chunks.play().then((m) => ({ default: m.PlayScreen })));
const CreateCharacter = lazy(() => chunks.create().then((m) => ({ default: m.CreateCharacter })));
const Shop = lazy(() => chunks.shop().then((m) => ({ default: m.Shop })));
const LevelUp = lazy(() => chunks.levelUp().then((m) => ({ default: m.LevelUp })));
const RunSetup = lazy(() => chunks.setup().then((m) => ({ default: m.RunSetup })));
const Library = lazy(() => chunks.library().then((m) => ({ default: m.Library })));

function preload() {
  for (const load of Object.values(chunks)) void load();
}

/**
 * The empty desk: the paper colour and nothing on it. Shown while the stored
 * session is read and while a screen's chunk arrives — one paint either way, and
 * a flash of "loading" before a flash of the app is worse than a moment of the
 * desk.
 */
const desk = <div className="min-h-screen" style={{ background: "#EDE7DA" }} />;

export default function App() {
  useEffect(preload, []);
  return (
    <Suspense fallback={desk}>
      <Screens />
    </Suspense>
  );
}

const say = (e: unknown) => (e instanceof Error ? e.message : String(e));

function Screens() {
  const [screen, setScreen] = useState<Screen>(BYPASS ? "generating" : "characters");
  const play = useRun({ onWaiting: () => setScreen("generating") });
  const { account, ready, signOut } = useAccount();
  const roster = useRoster(account, (cs) => {
    if (BYPASS && cs[0]) {
      void play.begin({ seed: SEED, size: SIZE, level: LEVEL, character: cs[0].sheet });
    }
  });
  const setup = useSetupData();

  /** Whoever the player pressed *Send down* on, carried into run setup. */
  const [chosenId, setChosenId] = useState<string>();
  /**
   * Whoever is at the market. The SHEET rather than an id, because the shop
   * edits it and hands back a new one — and because the character arriving
   * straight out of creation is not on the roster this render.
   */
  const [shopping, setShopping] = useState<PlayerCharacter>();
  /**
   * Whoever is taking a level, and the SHEET again for the same reason the shop
   * holds one: the modal builds the next sheet out of the one it was given.
   *
   * NOT A SCREEN. It renders over the roster rather than instead of it — the row
   * it is about is behind it, which is the whole argument for a modal here — so
   * unlike `shopping` this is read inside the characters branch rather than
   * ahead of it.
   */
  const [levelling, setLevelling] = useState<PlayerCharacter>();

  /** Back to the roster, from a run that is over or from one being walked away from. */
  function toRoster() {
    play.leave();
    setScreen("characters");
    void roster.refresh();
  }

  /** The worlds this player already has, read when the screen that offers them opens. */
  function openSetup() {
    setScreen("setup");
    void setup.load();
  }

  /**
   * THE GATE, and it is ahead of everything including the error screen.
   *
   * Nothing below this line can reach the API, so nothing below it should be
   * reachable without an account. It sits above the generation-error branch
   * deliberately: a failed generation belongs to a run, and a signed-out visitor
   * has none.
   */
  if (!OFFLINE) {
    if (!ready) return desk;
    if (!account) return <Landing onSignIn={signIn} onGuest={signInAsGuest} />;
  }

  if (play.error) {
    return (
      <div className="p-8 font-mono text-sm text-torch space-y-4 max-w-3xl">
        <p>Could not build a dungeon: {play.error}</p>
        {/* Locally the journal is a directory, and without the id on the
            screen the only way to find it is by guessing at the timestamp. A
            remote run has no directory: its journal is in the database, and a
            generation that failed has no run row to point at yet either. */}
        <p className="text-ash">
          The whole failure is on the console
          {play.session.runId ? `, and in out/runs/${play.session.runId}/` : ""}
        </p>
        {play.lastRequest && (
          <button
            type="button"
            className="border border-torch px-3 py-1 transition-colors hover:bg-torch hover:text-ink active:bg-torch-deep active:text-paper"
            onClick={play.retry}
          >
            Try seed {play.lastRequest.seed} again
          </button>
        )}
      </div>
    );
  }

  /**
   * THE MARKET, and it is ahead of the roster rather than beside it.
   *
   * `shopping` holding a sheet IS the shop being open — there is no screen name
   * for it — so this has to be tested before the screen it returns to, which is
   * `characters` the whole time somebody is at the counter. Leaving clears the
   * sheet and the roster is already underneath.
   */
  if (shopping) {
    return (
      <Shop
        pc={shopping}
        onLeave={() => setShopping(undefined)}
        onBuy={(bought) =>
          void (async () => {
            await roster.save(bought);
            setShopping(undefined);
            setScreen("characters");
          })()
        }
      />
    );
  }

  if (screen === "characters") {
    return (
      <>
      <Characters
        characters={roster.characters}
        onStartRun={(pc) => {
          roster.setNotice(undefined);
          setChosenId(pc.id);
          openSetup();
        }}
        // AN OFFLINE RUN HAS NO LIBRARY. `?offline` never touches the
        // server, so the button is not there rather than there and refused.
        {...(OFFLINE
          ? {}
          : {
              onBrowse: (pc: PlayerCharacter) => {
                roster.setNotice(undefined);
                setChosenId(pc.id);
                setScreen("library");
              },
            })}
        onResumeRun={(active) => {
          roster.setNotice(undefined);
          void play.resume(active.id);
        }}
        onAbandonRun={(active) => void roster.abandon(active)}
        onShop={(pc) => {
          roster.setNotice(undefined);
          setShopping(pc);
        }}
        onLevelUp={(pc) => {
          roster.setNotice(undefined);
          setLevelling(pc);
        }}
        onCreate={() => setScreen("create")}
        onDelete={(pc) => void roster.remove(pc)}
        {...(roster.notice ? { notice: roster.notice } : {})}
        account={account}
        onSignOut={signOut}
        onUpgrade={() => void upgradeToGoogle().catch((e) => roster.setNotice(say(e)))}
      />

      {/*
       * THE LEVEL, over the top of the row it belongs to.
       *
       * Saved exactly like a purchase, and for the same reason: the sheet IS
       * the level, so a save that failed is a level that did not happen, and
       * the roster says so in the server's own words rather than leaving them
       * believing they are two hit points better off than they are.
       */}
      {/* Its own boundary, so the roster stays painted behind it while it loads. */}
      {levelling && (
        <Suspense fallback={null}>
        <LevelUp
          pc={levelling}
          onCancel={() => setLevelling(undefined)}
          onConfirm={(next) => {
            setLevelling(undefined);
            void roster.save(next);
          }}
        />
        </Suspense>
      )}
      </>
    );
  }

  if (screen === "create") {
    return (
      <CreateCharacter
        onCancel={() => setScreen("characters")}
        onSave={(pc) =>
          void (async () => {
            await saveCharacter(pc);
            await roster.refresh();
            setChosenId(pc.id);
            // TOOK THE MONEY, GOES TO THE MARKET. Derived from the sheet rather
            // than passed down as a flag from the equipment step: a rolled kit
            // carries no copper, so a purse with anything in it IS the buying
            // path, and a character who leaves the shop with change comes back
            // to a roster button rather than to this branch again.
            if (purse(pc) > 0) setShopping(pc);
            setScreen("characters");
          })()
        }
      />
    );
  }

  /**
   * THE SHELF, and it needs whoever is going down.
   *
   * The character is resolved from the roster by id rather than held as a second
   * copy of the sheet — the same lookup `RunSetup` makes from `initialId`, and
   * for the same reason: a screen name and a sheet held beside it are the pair of
   * fields that drift apart. If they are not on the roster any more, there is
   * nobody to send and the roster is the honest place to be.
   */
  if (screen === "library") {
    const going = (roster.characters ?? []).find((e) => e.sheet.id === chosenId);
    if (!going) {
      // Adjusting this component's own state during its own render, which React
      // supports and re-runs immediately — the screen below never paints. It is
      // conditional on a state that the update itself clears, so it cannot loop.
      // The case is a sign-out, or a roster that came back without them.
      setScreen("characters");
      return null;
    }
    return (
      <Library
        character={going.sheet}
        load={listLibrary}
        onChoose={(d) => play.takeAndDescend(d, going.sheet)}
        onBack={() => setScreen("characters")}
      />
    );
  }

  if (screen === "setup") {
    return (
      <RunSetup
        // Only those who can actually go. A character in a run is not an option
        // here, and offering one would be offering a move the server refuses.
        characters={(roster.characters ?? []).filter((e) => !e.activeRun).map((e) => e.sheet)}
        {...(setup.dungeons ? { dungeons: setup.dungeons } : {})}
        {...(setup.allowance ? { allowance: setup.allowance } : {})}
        onUpgrade={upgradeToGoogle}
        initialId={chosenId}
        onBack={() => setScreen("characters")}
        onConfirm={(choice) =>
          void (choice.world === "existing"
            ? play.beginExisting(choice.dungeonId, choice.character)
            : play.begin({
                seed: seedForNewRun(),
                size: choice.size,
                level: choice.level,
                character: choice.character,
              }))
        }
      />
    );
  }

  const { dungeon, run, session } = play;
  if (!dungeon || !run) {
    return <LoadingScreen progress={play.progress} />;
  }

  return (
    <PlayScreen
      dungeon={dungeon}
      run={run}
      items={play.items}
      {...(play.refusal ? { refusal: play.refusal } : {})}
      {...(play.turnsLeft !== undefined ? { turnsLeft: play.turnsLeft } : {})}
      onSubmit={(text) => void session.submit(text)}
      onRoll={() => void session.roll()}
      onRetry={() => void session.retry()}
      onAbandon={() => void session.abandon()}
      // A local run has no roster to go back to, so neither the end card nor
      // the game menu offers one. Same reasoning as the sign-out control on the
      // characters screen. Both are `toRoster`: leaving a live run and leaving
      // a finished one are the same move, because every commit is already saved.
      {...(OFFLINE ? {} : { onLeave: toRoster, onMainMenu: toRoster })}
      // `?offline` never asks for an illustration or a sprite; its session has neither.
      {...(!OFFLINE && session.illustration ? { illustration: (roomId: string) => session.illustration!(roomId) } : {})}
      {...(!OFFLINE && session.cover ? { cover: () => session.cover!() } : {})}
      {...(!OFFLINE && session.sprite ? { sprite: (key: string) => session.sprite!(key) } : {})}
    />
  );
}
