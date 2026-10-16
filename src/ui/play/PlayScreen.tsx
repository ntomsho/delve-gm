/**
 * The play screen: three regions, as the brief lays them out.
 *
 *   narration   primary, the conversation
 *   map         secondary, fog of war
 *   character   persistent, never more than a glance away
 *
 * Desktop-first and must not break at tablet width. Above 1200px it is three
 * columns; below, the map and room card band across the top and the narration
 * and sheet sit side by side, so the reading column keeps its measure rather
 * than being squeezed.
 *
 * ON A PHONE (`PHONE`, 640px and under) it is none of those: the same panels,
 * built here exactly once, are handed to `PhonePlay` as three tabs. Width picks
 * the layout; whether a tap or a hover inspects is picked separately, by `TOUCH`
 * — see `src/ui/shared/media.ts`.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { CharacterPanel } from "./CharacterPanel.tsx";
import { DungeonMap, MapHeader } from "./DungeonMap.tsx";
import { ActionPill, HoverProvider, InspectSheet } from "./hover.tsx";
import { EndOfRun, type Ending } from "./EndOfRun.tsx";
import { GameMenu } from "./GameMenu.tsx";
import { InputArea } from "./InputArea.tsx";
import { Narration, type NarrationItem } from "./Narration.tsx";
import { PhonePlay, type Tab } from "./PhonePlay.tsx";
import { Illustration } from "./Illustration.tsx";
import { RoomCard } from "./RoomCard.tsx";
import { floorplanLayout, pointLayout } from "../../generation/floorplan/map-layout.ts";
import { placedThings } from "../../gameplay/mechanics/occupancy.ts";
import { causeOfDeath, keepsWhatTheyFound, lootOf } from "../../gameplay/mechanics/loot.ts";
import { acceptsInput, isTerminal } from "../../shared/types/turn.ts";
import { mapView, type MapView } from "../../gameplay/view/map.ts";
import { characterView } from "../../gameplay/view/character.ts";
import { roomView, shownRoom } from "../../gameplay/view/room.ts";
import type { GeneratedDungeon } from "../../generation/generate.ts";
import type { RunState } from "../../gameplay/state/store.ts";
import { roomFigures, type IllustrationAnswer } from "../../illustrations/room-illustration.ts";
import type { SpriteAnswer } from "../../illustrations/sprites.ts";
import { drawableCreatures, type IllustrationFigure } from "../../illustrations/figures.ts";
import { PHONE, PHONE_LANDSCAPE, TOUCH, useMediaQuery } from "../shared/media.ts";

export interface PlayScreenProps {
  dungeon: GeneratedDungeon;
  run: RunState;
  items: NarrationItem[];
  onSubmit(text: string): void;
  onRoll(): void;
  onRetry(): void;
  /** End the run where it stands. No game master, no dice, no world change. */
  onAbandon(): void;
  /** Back to the roster once it is over. Absent on a local run — see `InputArea`. */
  onLeave?: () => void;
  /**
   * Back to the roster WITHOUT ending the run — see `GameMenu`. Absent on a
   * local run, which has no roster to go back to.
   */
  onMainMenu?: () => void;
  /** a room's illustration for its first arrival. Absent on a local run, which never asks. */
  illustration?: (roomId: string) => Promise<IllustrationAnswer>;
  /** the dungeon's cover, above the opening. Absent on a local run. */
  cover?: () => Promise<IllustrationAnswer>;
  /** a creature's sprite, to stand it in the current room's illustration. Absent on a local run. */
  sprite?: (spriteId: string) => Promise<SpriteAnswer>;
}

export function PlayScreen({
  dungeon,
  run,
  items,
  onSubmit,
  onRoll,
  onRetry,
  onAbandon,
  onLeave,
  onMainMenu,
  illustration,
  cover,
  sprite,
}: PlayScreenProps) {
  const [draft, setDraft] = useState("");
  // A phone held sideways is still a phone: the tabs, laid out across the screen.
  const landscape = useMediaQuery(PHONE_LANDSCAPE);
  const phone = useMediaQuery(PHONE) || landscape;
  const touch = useMediaQuery(TOUCH);
  // Chat first: a run starts, and resumes, where it is played.
  const [tab, setTab] = useState<Tab>("chat");
  /*
   * THE END-OF-RUN SCREEN IS ASKED FOR, NOT THRUST UP. It used to start open,
   * over the top of the final post — the death, the escape — so the paragraph
   * most worth reading was the one behind a modal. Now the post stays put and
   * the input area's End Run button raises this.
   *
   * ABANDONING IS THE EXCEPTION. There is no final post: the player pressed a
   * button twice to stop, and making them press a third to see the result
   * would be ceremony. So it opens the moment the run lands there — including
   * on mount, for a run that was already abandoned when the screen came up.
   */
  const [summary, setSummary] = useState(false);
  useEffect(() => {
    if (run.stage === "abandoned") setSummary(true);
  }, [run.stage]);

  // Geometry is fixed for the whole run; only the fog over it changes.
  //
  // The floorplan when there is one, and dots and lines when there is not — a
  // saved run from before the block plan existed comes back without a drawing,
  // and a dungeon with no drawing is completely playable.
  const layout = useMemo(() => {
    if (!dungeon.blockplan) return pointLayout(dungeon.graph);
    const corridors = new Set(
      dungeon.stocked.rooms.filter((r) => r.isCorridor).map((r) => r.index)
    );
    return floorplanLayout(dungeon.blockplan, dungeon.graph, {
      isCorridor: (i) => corridors.has(i),
      // From the GENERATED entities, not the run's. `place` is written once at
      // generation and is not on the applier's writable-path allowlist, so the
      // footprints genuinely are fixed for the whole run and this memo stays
      // honest. Which of them the player may see is `mapView`'s question, and
      // it answers it against the run copy by id.
      placed: placedThings(dungeon.entities),
    });
  }, [dungeon.blockplan, dungeon.graph, dungeon.stocked, dungeon.entities]);

  const map = useMemo(() => mapView(run, dungeon, layout), [run, dungeon, layout]);
  // The room the player has READ, which lags where they are standing for as long
  // as an arrival is being written — see `shownRoom`. Undefined until the first
  // arrival lands, and then there is nothing honest to put in the panel.
  const shown = shownRoom(run);
  const room = useMemo(
    () => (shown === undefined ? undefined : roomView(run, dungeon, shown)),
    [run, dungeon, shown]
  );
  const pc = useMemo(() => characterView(run), [run]);
  /**
   * The rooms this screen came up with already arrived in: on a resumed run,
   * every room behind the player. Read once, at mount. Their illustrations are not
   * asked for; only the room they are in gets its picture.
   */
  const [resumed] = useState(
    () => new Set(run.log.flatMap((e) => (e.kind === "arrival" && e.roomId ? [e.roomId] : [])))
  );
  const here = useMemo(() => {
    if (shown === undefined) return undefined;
    const cameFrom = room?.exits.find((e) => e.cameFrom)?.connectorId;
    return { roomId: shown, ...(cameFrom ? { cameFrom } : {}) };
  }, [shown, room]);
  const explored = useMemo(() => map.rooms.filter((r) => r.known).length, [map]);
  /**
   * The creatures in the room they are reading about, stood in its illustration.
   * Worked out again only when who is there changes — arriving, leaving, dying,
   * a pack's count — not on every commit; the illustration's camera search is not free.
   */
  const crowd = here
    ? `${here.roomId}|${drawableCreatures(run.entities.creatures, here.roomId)
        .map((c) => `${c.id}:${c.count ?? 1}`)
        .join(",")}`
    : "";
  const figures = useMemo(
    () => (here && sprite ? roomFigures(dungeon, run, here.roomId) : undefined),
    // `run` is read through `crowd`: the figures depend only on who is in the room.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [crowd, dungeon, sprite !== undefined]
  );

  /**
   * The sweep under the narration: on whenever the game is working.
   *
   * Derived rather than listed. It was three stages written out by hand, and it
   * had already drifted — `rolling` was missing, which nobody saw because in
   * process the dice take microseconds. Played through the server they are part
   * of a request, and a hand-kept copy of `BUSY_STAGES` would have been wrong
   * for the length of it. One source of truth, in shared/types/turn.ts.
   */
  const busy = !acceptsInput(run.stage) && !isTerminal(run.stage);

  /**
   * The ways out of the room they are standing in — the doors a click may offer
   * to walk through rather than merely to examine.
   *
   * A door across the map is a route rather than a step: `routeTo` will walk one,
   * but only over ground the player has already crossed, and a far door worth
   * clicking is by definition one whose far side they have not seen. Rather than
   * send a sentence the runtime is not tested for, a distant door offers Examine
   * and the player clicks the ROOM they want to reach. See `wayVerb`.
   *
   * `busy` is not tested here — `acting` below is the one gate on whether
   * anything is offered at all, and a second one would be a second place for it
   * to be wrong.
   */
  const reachable = useMemo(() => {
    if (!room || shown !== run.currentRoomId) return new Set<string>();
    return new Set(room.exits.map((e) => e.connectorId));
  }, [room, shown, run.currentRoomId]);

  /**
   * A pill answered. Identical to the player having typed the sentence — same
   * turn path, same heuristic — which is the whole reason the click sends TEXT
   * rather than a move.
   */
  const act = useCallback(
    (sentence: string) => {
      setDraft("");
      onSubmit(sentence);
    },
    [onSubmit]
  );

  /**
   * THE END OF THE RUN, and everything it needs.
   *
   * All derived from the saved run rather than written when it happened, so a
   * resumed run that ended while the tab was closed comes back to exactly the
   * same screen — see `loot.ts`.
   *
   * The overlay opens on End Run (or by itself on an abandon — see `summary`).
   * On a live run `ending` is undefined and none of this renders.
   */
  const ending = asEnding(run.stage);
  const loot = useMemo(() => lootOf(run, dungeon), [run, dungeon]);
  const death = useMemo(() => causeOfDeath(run, dungeon), [run, dungeon]);
  // What the sheet will say once this lands. `run.pc` is the character as they
  // went down, so the run's own award is not on it yet and is added here —
  // `carriedOut` does the same sum against the database.
  const xpTotal = (run.pc.xp ?? 0) + (run.tally?.total ?? 0);

  // Each panel built once, and laid out by whichever shell is showing.
  const scrollback = (
      <Narration
        items={items}
        busy={busy}
        resolving={run.stage === "resolving"}
        compact={phone}
        {...(illustration ? { illustration } : {})}
        {...(cover ? { cover } : {})}
        {...(sprite && figures ? { sprite, figures } : {})}
        map={map}
        resumed={resumed}
        {...(here ? { here } : {})}
      />
  );
  const input = (
      <InputArea
        stage={run.stage}
        roll={run.pendingRoll}
        turns={run.turnCount}
        draft={draft}
        onDraft={setDraft}
        onSubmit={(text) => {
          setDraft("");
          onSubmit(text);
        }}
        onRoll={onRoll}
        onRetry={onRetry}
        onAbandon={onAbandon}
        onShowSummary={() => setSummary(true)}
        compact={phone}
      />
  );
  // Sideways, the input stands in its own column to the right of the chat,
  // settled at the bottom like the end of the scrollback beside it.
  const narration = landscape ? (
    <div className="flex min-h-0 flex-1" data-chat-columns>
      <div className="flex min-w-0 flex-1 flex-col">{scrollback}</div>
      <div className="flex w-[min(42%,340px)] shrink-0 flex-col justify-end overflow-y-auto border-l border-rule">
        {input}
      </div>
    </div>
  ) : (
    <>
      {scrollback}
      {input}
    </>
  );

  /*
   * THE ENDING, OVER THE TOP OF EVERYTHING.
   *
   * Up on its own the moment the run ends, and dismissable back to this
   * screen — the map and the scrollback are the record of what just
   * happened and the player should be able to read back through them
   * without leaving. `RunOver` in the input area brings it back.
   *
   * `abandoned` is included: it is the one ending with nothing to score
   * and nothing kept, and saying so is exactly what the screen is for.
   */
  const endOfRun = ending && summary && (
    <EndOfRun
      stage={ending}
      turns={run.turnCount}
      loot={loot}
      keeps={keepsWhatTheyFound(run.stage)}
      {...(run.tally ? { tally: run.tally } : {})}
      xpTotal={xpTotal}
      level={run.pc.level}
      {...(death ? { death } : {})}
      onDismiss={() => setSummary(false)}
      {...(onLeave ? { onLeave } : {})}
    />
  );

  return (
    // The map and the room card are two drawings of one room, and the provider
    // is what lets them agree about which thing in it the player is pointing at:
    // hover a row, the marker lights; hover the marker, the row lights. It also
    // carries what a click on either one may offer — see `ActionPill`. On a
    // touch screen the same is true of a tap, and `InspectSheet` does the
    // offering.
    <HoverProvider
      acting={acceptsInput(run.stage)}
      reachable={reachable}
      onAct={act}
      touch={touch}
      scope={phone ? tab : undefined}
    >
      {phone ? (
        <>
          <PhonePlay
            stage={run.stage}
            busy={busy}
            narrated={items.length}
            explored={explored}
            pc={pc}
            tab={tab}
            onTab={setTab}
            {...(onMainMenu ? { onMainMenu } : {})}
            landscape={landscape}
            map={
              landscape ? (
                // Sideways: the map on the left half, where you are on the right.
                <div className="grid h-full grid-cols-2" data-map-columns>
                  <div className="flex min-h-0 flex-col border-r border-rule pb-2">
                    <MapHeader name={dungeon.pass.name} map={map} compact />
                    <div data-no-swipe className="mx-4 min-h-0 flex-1 border border-rule-faint bg-paper">
                      <DungeonMap map={map} className="h-full w-full" controls />
                    </div>
                  </div>
                  <div className="min-h-0 overflow-y-auto bg-panel">{room && <RoomCard room={room} compact />}</div>
                </div>
              ) : (
              <>
                <MapHeader name={dungeon.pass.name} map={map} compact />
                {/* The map takes every drag for itself — panning — so a swipe
                    that starts on it is not a swipe. See `PhonePlay`. */}
                <div data-no-swipe className="mx-4 h-[360px] border border-rule-faint bg-paper">
                  <DungeonMap map={map} className="h-full w-full" controls />
                </div>
                <p className="mx-4 mt-1.5 font-mono text-[9px] uppercase tracking-[0.14em] text-ash">
                  Tap anything to inspect · drag to pan
                </p>
                {room && (
                  <div className="mt-3.5 border-t border-rule bg-panel">
                    <RoomCard room={room} compact />
                  </div>
                )}
              </>
              )
            }
            chat={narration}
            room={
              <RoomTab
                name={room?.name}
                {...(illustration && here ? { load: () => illustration(here.roomId), roomId: here.roomId } : {})}
                {...(here?.cameFrom ? { cameFrom: here.cameFrom } : {})}
                {...(sprite && figures ? { sprite, figures } : {})}
                map={map}
                fill={landscape}
              />
            }
            sheet={<CharacterPanel pc={pc} compact columns={landscape} />}
          />
          {endOfRun}
        </>
      ) : (
        <main className="grid h-screen bg-paper text-ink [grid-template-areas:'map_narr_char''card_narr_char'] [grid-template-columns:320px_minmax(0,1fr)_300px] [grid-template-rows:minmax(0,1fr)_auto] max-[1200px]:[grid-template-areas:'map_card''narr_char'] max-[1200px]:[grid-template-columns:minmax(0,1fr)_296px] max-[1200px]:[grid-template-rows:220px_minmax(0,1fr)]">
          <div className="flex min-h-0 flex-col border-r border-rule p-4 [grid-area:map] max-[1200px]:border-b">
            {onMainMenu && <GameMenu onMainMenu={onMainMenu} busy={busy} />}
            <MapHeader name={dungeon.pass.name} map={map} />
            <div className="flex min-h-0 flex-1 items-center justify-center">
              <DungeonMap map={map} className="h-full w-full" />
            </div>
          </div>

          <div className="min-h-0 border-r border-rule bg-panel [grid-area:card] max-[1200px]:border-b max-[1200px]:border-r-0">
            {room && <RoomCard room={room} />}
          </div>

          <div className="flex min-h-0 flex-col [grid-area:narr]">{narration}</div>

          <div className="min-h-0 border-l border-rule [grid-area:char]">
            <CharacterPanel pc={pc} />
          </div>

          {/* One mount for both panels, portalled to the document like the hover
              cards. It finds its anchors by attribute, so it does not care which
              panel raised it nor where in the grid that panel sits. Absent on a
              touch screen, which gets the sheet instead — a tablet held
              landscape is this grid with a finger. */}
          <ActionPill />
          <InspectSheet className="fixed inset-x-0 bottom-0 z-40 mx-auto max-w-[480px] border-x" />

          {endOfRun}
        </main>
      )}
    </HoverProvider>
  );
}

/**
 * THE ROOM TAB, on a phone: the picture of the room they are standing in, under
 * its name, with its buttons on it — the illustration a desktop keeps stuck to the top
 * of the chat. A local run, which never asks for pictures, says so.
 */
function RoomTab({
  name,
  roomId,
  load,
  cameFrom,
  map,
  sprite,
  figures,
  fill = false,
}: {
  name?: string;
  roomId?: string;
  load?: () => Promise<IllustrationAnswer>;
  cameFrom?: string;
  map: MapView;
  sprite?: (spriteId: string) => Promise<SpriteAnswer>;
  figures?: IllustrationFigure[];
  /** sideways: the name, then the picture as large as the rest of the screen allows */
  fill?: boolean;
}) {
  if (fill) {
    return (
      <div className="flex h-full flex-col px-4 pb-3 pt-2" data-room-fill>
        <h2 className="mb-2 shrink-0 font-display text-[19px] font-bold leading-tight text-ink">{name ?? "Somewhere"}</h2>
        <div className="min-h-0 flex-1 [container-type:size]">
          {roomId && load ? (
            <Illustration
              key={roomId}
              id={roomId}
              subject={name ?? "this room"}
              load={load}
              map={map}
              fill
              {...(cameFrom ? { cameFrom } : {})}
              {...(sprite && figures ? { sprite, figures } : {})}
            />
          ) : (
            <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-ash">No picture of this room</p>
          )}
        </div>
      </div>
    );
  }
  return (
    // Centred in the tab, which is otherwise a picture floating at the top of an empty screen.
    <div className="flex min-h-full flex-col justify-center px-4 py-4 [&>*:last-child]:mb-0">
      <h2 className="mb-3 font-display text-[21px] font-bold leading-tight text-ink">{name ?? "Somewhere"}</h2>
      {roomId && load ? (
        <Illustration
          key={roomId}
          id={roomId}
          subject={name ?? "this room"}
          load={load}
          map={map}
          {...(cameFrom ? { cameFrom } : {})}
          {...(sprite && figures ? { sprite, figures } : {})}
        />
      ) : (
        <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-ash">No picture of this room</p>
      )}
    </div>
  );
}

/**
 * Which of the four endings this is, or nothing for a run still being played.
 *
 * `departed` is deliberately absent: the game master writes it and the store
 * resolves it into `goal_met` or `escaped` before anything is saved, so no
 * stored run is ever standing in it. See the note on `Stage`.
 */
function asEnding(stage: RunState["stage"]): Ending | undefined {
  return stage === "dead" || stage === "escaped" || stage === "goal_met" || stage === "abandoned"
    ? stage
    : undefined;
}
