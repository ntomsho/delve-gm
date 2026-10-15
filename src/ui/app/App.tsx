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

import { useEffect, useMemo, useState } from "react";
import { PlayScreen } from "../play/PlayScreen.tsx";
import { LoadingScreen } from "../run-setup/LoadingScreen.tsx";
import { Characters } from "../characters/Characters.tsx";
import { CreateCharacter } from "../create/CreateCharacter.tsx";
import { Shop } from "../shop/Shop.tsx";
import { LevelUp } from "../characters/LevelUp.tsx";
import { RunSetup } from "../run-setup/RunSetup.tsx";
import { purse } from "../../rules/knave/character-creation.ts";
import { type PlayerCharacter } from "../../rules/knave/character.ts";
import { toItems } from "../play/Narration.tsx";
import { useGame } from "../shared/use-game.ts";
import {
  deleteCharacter,
  listRoster,
  saveCharacter,
  NO_RECORD,
  type ActiveRun,
  type CharacterEntry,
} from "../../api-client/characters.ts";
import {
  duplicateDungeon,
  listDungeons,
  listLibrary,
  type DungeonSummary,
} from "../../api-client/dungeons.ts";
import { Library } from "../run-setup/Library.tsx";
import { SignIn } from "../sign-in/SignIn.tsx";
import {
  authedFetch,
  linkWasRefused,
  onAuthChange,
  signIn,
  signInAsGuest,
  signOut,
  upgradeToGoogle,
  type Account,
} from "../../api-client/auth.ts";
import { fetchAllowance, type Allowance } from "../../api-client/allowance.ts";
import {
  createGameSession,
  describeFailure,
  type PlayableSession,
  type RunRequest,
} from "../../gameplay/sessions/session.ts";
import { createRemoteSession } from "../../gameplay/sessions/remote-session.ts";
import { type GenerationProgress } from "../../generation/generate.ts";
import { randomSeed } from "../../generation/seeds.ts";
import { readSwitches } from "./switches.ts";

const {
  offline: OFFLINE,
  bypass: BYPASS,
  seed: SEED,
  pinnedSeed: PINNED,
  size: SIZE,
  level: LEVEL,
} = readSwitches(location.search);

/**
 * A run started from the front of the app gets a fresh dungeon unless the URL
 * pinned one. The bypass path keeps its 1005 default, so `?offline=1` on its own
 * returns to the same dungeon every time — which is the whole point of it
 * during interface work.
 */
const seedForNewRun = () => (PINNED ? SEED : randomSeed());

/**
 * THE FIXTURES, loaded only on an offline run.
 *
 * A dynamic import is its own chunk, so a normal visit never downloads the
 * fixture dungeon or the stub game master. `undefined` means this is not an
 * offline run.
 */
const fixtures = OFFLINE ? await loadFixtures() : undefined;

async function loadFixtures() {
  const [offline, stub] = await Promise.all([
    import("../../fixtures/offline.ts"),
    import("../../fixtures/stub-game-master.ts"),
  ]);
  return {
    generate: offline.generateOffline,
    /**
     * The dev quick-start character. Handing every visitor somebody called
     * Testy with +3 in everything is a different proposition from handing one
     * to a developer with `?offline` in the URL, so it lives with the fixtures.
     */
    character: offline.testCharacter,
    gameMaster: stub.stubGameMaster,
  };
}

/**
 * Only the part before a run. Once the dungeon exists, that is what decides.
 *
 * The market is not one of these. It is `shopping` holding a sheet, because a
 * shop with nobody in it is not a state the app can be in — and a screen name
 * that could disagree with the character it is showing is exactly the pair of
 * fields that drift apart.
 */
type Screen = "characters" | "create" | "setup" | "library" | "generating";

export default function App() {
  const [progress, setProgress] = useState<GenerationProgress>();

  /**
   * A session, and which KIND of session, decided here and nowhere else.
   *
   * A real run is played by the server. `?offline` is played in the browser:
   * interface work should not need Postgres running, and a fixture dungeon run
   * by a keyword-table game master costs nothing and answers instantly.
   *
   * Both satisfy `PlayableSession`, so everything below this line is the same
   * either way.
   */
  const makeSession = (): PlayableSession =>
    fixtures
      ? createGameSession({
          onProgress: setProgress,
          gameMaster: () => fixtures.gameMaster,
          offline: true,
          generate: async ({ seed, size }) => fixtures.generate(seed, size),
        })
      : createRemoteSession({ onProgress: setProgress, fetch: authedFetch });

  /**
   * The run in hand. Made on the first render — so the store it owns is there
   * to subscribe to before there is a dungeon in it — and replaced only when a
   * failed generation is retried, because a session that has begun refuses to
   * begin again and a half-generated one is not worth resuming.
   *
   * State rather than a ref, because swapping it has to re-render: the
   * subscription below is to *this* store, and the play screen has to follow
   * the new one.
   */
  const [session, setSession] = useState<PlayableSession>(makeSession);

  const { dungeon, run } = useGame(session.store);
  const [screen, setScreen] = useState<Screen>(BYPASS ? "generating" : "characters");
  const [characters, setCharacters] = useState<CharacterEntry[]>();
  /**
   * The player's own worlds, for run setup to offer.
   *
   * READ WHEN THE SETUP SCREEN OPENS rather than kept in step with the roster.
   * It is the one screen that asks, it is asked once per run, and a list
   * fetched at the moment it is shown cannot be a stale list — which the
   * alternative, refreshing it alongside the characters after every save and
   * delete, would be spending two requests to achieve less reliably.
   */
  const [dungeons, setDungeons] = useState<DungeonSummary[]>();
  /**
   * How many runs are left today. Read when run setup opens, for the same
   * reason as `dungeons`: it is the one screen that asks, and a figure fetched
   * as it is shown cannot be stale. `undefined` is "not known", which the
   * screen treats as no limit — the server is the gate, not this.
   */
  const [allowance, setAllowance] = useState<Allowance>();
  /** A refusal from the server, in its own words, shown on the roster. */
  const [notice, setNotice] = useState<string>();

  /**
   * Who is signed in, and whether we have found out yet.
   *
   * `undefined` account plus `!authReady` is the moment before Supabase has read
   * the stored session — a real state and a short one, and rendering the sign-in
   * screen during it would flash a door at somebody who is already through it.
   *
   * AN OFFLINE RUN NEEDS NO ACCOUNT. `?offline` never touches the server,
   * so requiring Google to do interface work would be requiring a login to reach
   * a fixture. `authReady` starts true there and the account stays undefined.
   */
  const [account, setAccount] = useState<Account>();
  const [authReady, setAuthReady] = useState(OFFLINE);
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
  const [error, setError] = useState<string>();
  /** Held so a failed generation can be tried again on the same seed. */
  const [lastRequest, setLastRequest] = useState<RunRequest>();

  async function start(s: PlayableSession, request: RunRequest) {
    setScreen("generating");
    try {
      // A second call on the SAME session is the double-invoke of StrictMode's
      // development mount, and the session drops it — it would otherwise
      // generate a whole second dungeon over the top of the first.
      await s.begin(request);
    } catch (e) {
      // `describeFailure` puts the first few validation complaints into the
      // sentence. The whole error is already on the console and in the journal;
      // this is the part that fits on a screen.
      setError(describeFailure(e));
    }
  }

  async function begin(request: RunRequest) {
    setLastRequest(request);
    await start(session, request);
  }

  /**
   * GO BACK DOWN A WORLD THAT IS ALREADY WRITTEN.
   *
   * One request and no model call — see `beginIn` in `remote-session.ts`. It
   * still borrows the generating screen, because what the player is waiting for
   * is a run being created and that is the screen this app shows while it waits
   * for a run to appear.
   *
   * NO `lastRequest`, so the failure screen offers no retry button. That is
   * correct rather than an omission: the retry it offers is "try that seed
   * again", and there is no seed here — the world exists and a run into it that
   * failed to be created failed for a reason a second identical POST will not
   * fix. Going back to the roster is the honest way on.
   */
  async function beginExisting(dungeonId: string, character: PlayerCharacter) {
    setLastRequest(undefined);
    setScreen("generating");
    try {
      await session.beginIn?.({ dungeonId, character });
    } catch (e) {
      setError(describeFailure(e));
    }
  }

  /**
   * TAKE A COPY OF SOMEBODY ELSE'S WORLD, AND GO DOWN IT.
   *
   * Two requests and no model call. The copy has to happen first and cannot be
   * skipped: `POST /api/runs` reads the dungeon under an owner filter, so the
   * source row is a 404 to this player right up until they hold one of their
   * own. Taking a copy is also idempotent — a world already taken hands back the
   * copy that exists — so a player who browses to the same dungeon twice does
   * not accumulate rows.
   *
   * THROWS RATHER THAN CATCHES. `Library` is showing the card that was pressed
   * and is the right place for this to be reported, next to the thing that
   * failed — where a notice on the roster would be a message about a screen the
   * player is still looking at.
   */
  async function takeAndDescend(dungeon: DungeonSummary, character: PlayerCharacter) {
    const { dungeonId } = await duplicateDungeon(dungeon.id);
    await beginExisting(dungeonId, character);
  }

  /**
   * The worlds this player already has, read when the screen that offers them
   * opens. Partial ones are dropped here rather than in `RunSetup`: a half
   * written dungeon is a failed generation, `POST /api/runs` refuses one, and a
   * control that is offered and then refused is worse than one never shown.
   */
  async function openSetup() {
    setDungeons(undefined);
    setAllowance(undefined);
    setScreen("setup");
    if (OFFLINE) return;
    void fetchAllowance()
      .then(setAllowance)
      .catch((e) => console.warn("[app] could not read the allowance:", e));
    try {
      setDungeons((await listDungeons()).filter((d) => d.status === "complete"));
    } catch (e) {
      // Not fatal and not a notice on a screen the player has just left. The
      // list is simply empty, which offers a new world — the behaviour this
      // screen had before there was a list at all.
      console.warn("[app] could not read the saved worlds:", e);
      setDungeons([]);
    }
  }

  /**
   * PICK A RUN BACK UP.
   *
   * One fetch and the game is on the screen — nothing is replayed, because
   * `runs.state` is the whole save, scrollback included. It borrows the
   * generating screen for the second it takes, which is honest: the game is
   * being fetched, and the loading screen is what this app shows while it waits
   * for a run to appear.
   *
   * Sessions are single-use — `begin` and `resume` both latch — so this takes a
   * fresh one. It matters when a player finishes a run, goes back to the roster
   * and picks up a different character's.
   */
  async function resume(runId: string) {
    const next = makeSession();
    setSession(next);
    setNotice(undefined);
    setScreen("generating");
    try {
      await next.resume?.(runId);
    } catch (e) {
      setError(describeFailure(e));
    }
  }

  /**
   * Back to the roster, from a run that is over or from one being walked away
   * from. A fresh session, so the store the play screen was subscribed to is
   * dropped along with the run in it.
   */
  function toRoster() {
    setSession(makeSession());
    setError(undefined);
    setProgress(undefined);
    setLastRequest(undefined);
    setScreen("characters");
    void refreshRoster();
  }

  /** The roster, re-read. Every ending changes something on it. */
  async function refreshRoster() {
    if (OFFLINE) return;
    setCharacters(await listRoster());
  }

  /**
   * Walk away from a run WITHOUT being in it.
   *
   * The play path abandons through the session, which holds the run's version.
   * From the roster there is no session and no version, so this reads the run,
   * abandons it, and re-reads the list. Two requests where the play path makes
   * one, and worth it: the alternative is minting a whole session to end a run
   * the player is not looking at.
   */
  async function abandonFromRoster(active: ActiveRun) {
    setNotice(undefined);
    try {
      const res = await authedFetch(`/api/runs/${active.id}`);
      if (!res.ok) throw new Error(`could not read that run (${res.status})`);
      const { run: stored } = (await res.json()) as { run: { version: number } };

      const done = await authedFetch(`/api/runs/${active.id}/abandon`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ version: stored.version }),
      });
      if (!done.ok) {
        const detail = (await done.json().catch(() => ({}))) as { error?: string };
        throw new Error(detail.error ?? `could not abandon that run (${done.status})`);
      }
      await refreshRoster();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    }
  }

  /**
   * Try the same seed again, on a session of its own.
   *
   * The same seed on purpose: a generation that failed once usually succeeds on
   * the second attempt — the failure is a model having a bad round rather than
   * a dungeon that cannot be built — and if it fails twice on the same seed
   * that is worth knowing, which a fresh random seed would hide.
   */
  function retryGeneration() {
    if (!lastRequest) return;
    const next = makeSession();
    setSession(next);
    setError(undefined);
    setProgress(undefined);
    void start(next, lastRequest);
  }

  /**
   * Follow the session.
   *
   * `onAuthStateChange` fires once with the stored session on subscribe, so this
   * covers both the first read and every later change — signing in, signing out,
   * and `authedFetch` clearing a session the server rejected. One listener, not
   * a read plus a listener that can disagree with it.
   */
  useEffect(() => {
    if (OFFLINE) return;
    // A guest tried to link a Google account that already has an account of its
    // own. Sign them in to that one: it is theirs, and it is what they asked for
    // by pressing a Google button. See `linkWasRefused`.
    if (linkWasRefused()) void signIn();
    return onAuthChange((who) => {
      setAccount(who);
      setAuthReady(true);
    });
  }, []);

  /**
   * The characters, once there is somebody to have them.
   *
   * Keyed on the account id, so signing out empties the list and signing in as
   * somebody else fetches theirs rather than showing the last player's.
   */
  useEffect(() => {
    if (!OFFLINE && !account) {
      setCharacters(undefined);
      return;
    }
    void (async () => {
      const cs = fixtures ? [{ sheet: fixtures.character(), record: NO_RECORD }] : await listRoster();
      setCharacters(cs);
      if (BYPASS && cs[0]) {
        void begin({ seed: SEED, size: SIZE, level: LEVEL, character: cs[0].sheet });
      }
    })();
  }, [account?.id]);

  const items = useMemo(() => {
    if (!run) return [];
    const name = (id: string) => run.entities.rooms.find((r) => r.id === id)?.name ?? "Somewhere";
    const pass = session.store.getState().dungeon?.pass;
    return toItems(run.log, name, pass && { name: pass.name, objective: pass.goal.summary });
  }, [run?.log]);

  /**
   * THE GATE, and it is ahead of everything including the error screen.
   *
   * Nothing below this line can reach the API, so nothing below it should be
   * reachable without an account. It sits above the generation-error branch
   * deliberately: a failed generation belongs to a run, and a signed-out visitor
   * has none.
   */
  if (!OFFLINE) {
    // The blank frame while the stored session is read. Deliberately empty
    // rather than a spinner — it is one paint, and a flash of "loading" before
    // a flash of the app is worse than a moment of the desk.
    if (!authReady) return <div className="min-h-screen" style={{ background: "#EDE7DA" }} />;
    if (!account) return <SignIn onSignIn={signIn} onGuest={signInAsGuest} />;
  }

  if (error) {
    return (
      <div className="p-8 font-mono text-sm text-torch space-y-4 max-w-3xl">
        <p>Could not build a dungeon: {error}</p>
        {/* Locally the journal is a directory, and without the id on the
            screen the only way to find it is by guessing at the timestamp. A
            remote run has no directory: its journal is in the database, and a
            generation that failed has no run row to point at yet either. */}
        <p className="text-ash">
          The whole failure is on the console
          {session.runId ? `, and in out/runs/${session.runId}/` : ""}
        </p>
        {lastRequest && (
          <button
            type="button"
            className="border border-torch px-3 py-1 transition-colors hover:bg-torch hover:text-ink active:bg-torch-deep active:text-paper"
            onClick={retryGeneration}
          >
            Try seed {lastRequest.seed} again
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
            try {
              await saveCharacter(bought);
            } catch (e) {
              // The purchase IS the sheet, so a failed save is a purchase that
              // did not happen. Say so on the roster rather than dropping them
              // there believing they are carrying a lantern.
              setNotice(e instanceof Error ? e.message : String(e));
            }
            await refreshRoster();
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
        characters={characters}
        onStartRun={(pc) => {
          setNotice(undefined);
          setChosenId(pc.id);
          void openSetup();
        }}
        // AN OFFLINE RUN HAS NO LIBRARY. `?offline` never touches the
        // server, so the button is not there rather than there and refused.
        {...(OFFLINE
          ? {}
          : {
              onBrowse: (pc: PlayerCharacter) => {
                setNotice(undefined);
                setChosenId(pc.id);
                setScreen("library");
              },
            })}
        onResumeRun={(active) => void resume(active.id)}
        onAbandonRun={(active) => void abandonFromRoster(active)}
        onShop={(pc) => {
          setNotice(undefined);
          setShopping(pc);
        }}
        onLevelUp={(pc) => {
          setNotice(undefined);
          setLevelling(pc);
        }}
        onCreate={() => setScreen("create")}
        onDelete={(pc) =>
          void (async () => {
            setNotice(undefined);
            try {
              await deleteCharacter(pc.id);
            } catch (e) {
              // The server's own sentence. "That character is in a run" is a
              // thing the player can do something about, and a button that
              // silently did nothing would not tell them what.
              setNotice(e instanceof Error ? e.message : String(e));
            }
            await refreshRoster();
          })()
        }
        {...(notice ? { notice } : {})}
        account={account}
        onSignOut={() => {
          // A guest has no way back in: signing out IS deleting, as far as they
          // can tell. Say so once rather than letting a habit cost a roster.
          if (
            account?.guest &&
            !window.confirm(
              "A guest account cannot be signed back into. Your characters will be lost. Sign out anyway?"
            )
          ) {
            return;
          }
          void signOut();
        }}
        onUpgrade={() =>
          void upgradeToGoogle().catch((e) =>
            setNotice(e instanceof Error ? e.message : String(e))
          )
        }
      />

      {/*
       * THE LEVEL, over the top of the row it belongs to.
       *
       * Saved exactly like a purchase, and for the same reason: the sheet IS
       * the level, so a save that failed is a level that did not happen, and
       * the roster says so in the server's own words rather than leaving them
       * believing they are two hit points better off than they are.
       */}
      {levelling && (
        <LevelUp
          pc={levelling}
          onCancel={() => setLevelling(undefined)}
          onConfirm={(next) =>
            void (async () => {
              setLevelling(undefined);
              try {
                await saveCharacter(next);
              } catch (e) {
                setNotice(e instanceof Error ? e.message : String(e));
              }
              await refreshRoster();
            })()
          }
        />
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
            await refreshRoster();
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
    const going = (characters ?? []).find((e) => e.sheet.id === chosenId);
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
        onChoose={(d) => takeAndDescend(d, going.sheet)}
        onBack={() => setScreen("characters")}
      />
    );
  }

  if (screen === "setup") {
    return (
      <RunSetup
        // Only those who can actually go. A character in a run is not an option
        // here, and offering one would be offering a move the server refuses.
        characters={(characters ?? []).filter((e) => !e.activeRun).map((e) => e.sheet)}
        {...(dungeons ? { dungeons } : {})}
        {...(allowance ? { allowance } : {})}
        onUpgrade={upgradeToGoogle}
        initialId={chosenId}
        onBack={() => setScreen("characters")}
        onConfirm={(choice) =>
          void (choice.world === "existing"
            ? beginExisting(choice.dungeonId, choice.character)
            : begin({
                seed: seedForNewRun(),
                size: choice.size,
                level: choice.level,
                character: choice.character,
              }))
        }
      />
    );
  }

  if (!dungeon || !run) {
    return <LoadingScreen progress={progress} />;
  }

  return (
    <PlayScreen
      dungeon={dungeon}
      run={run}
      items={items}
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
