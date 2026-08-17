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
 */

import { useCallback, useMemo, useState } from "react";
import { CharacterPanel } from "./CharacterPanel.tsx";
import { DungeonMap, MapHeader } from "./DungeonMap.tsx";
import { ActionPill, HoverProvider } from "./hover.tsx";
import { InputArea } from "./InputArea.tsx";
import { Narration, type NarrationItem } from "./Narration.tsx";
import { RoomCard } from "./RoomCard.tsx";
import { floorplanLayout, pointLayout } from "../../runtime/layout.ts";
import { placedThings } from "../../runtime/occupancy.ts";
import { acceptsInput, isTerminal } from "../../runtime/types.ts";
import { characterView, mapView, roomView, shownRoom } from "../../store/selectors.ts";
import type { GeneratedDungeon } from "../../runtime/generate.ts";
import type { RunState } from "../../store/game.ts";

export interface PlayScreenProps {
  dungeon: GeneratedDungeon;
  run: RunState;
  items: NarrationItem[];
  onSubmit(text: string): void;
  onRoll(): void;
  onRetry(): void;
  /** End the run where it stands. No referee, no dice, no world change. */
  onAbandon(): void;
  /** Back to the roster once it is over. Absent on a local run — see `InputArea`. */
  onLeave?: () => void;
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
}: PlayScreenProps) {
  const [draft, setDraft] = useState("");

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
   * The sweep under the narration: on whenever the game is working.
   *
   * Derived rather than listed. It was three stages written out by hand, and it
   * had already drifted — `rolling` was missing, which nobody saw because in
   * process the dice take microseconds. Played through the server they are part
   * of a request, and a hand-kept copy of `BUSY_STAGES` would have been wrong
   * for the length of it. One source of truth, in runtime/types.ts.
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

  return (
    // The map and the room card are two drawings of one room, and the provider
    // is what lets them agree about which thing in it the player is pointing at:
    // hover a row, the marker lights; hover the marker, the row lights. It also
    // carries what a click on either one may offer — see `ActionPill`.
    <HoverProvider acting={acceptsInput(run.stage)} reachable={reachable} onAct={act}>
      <main className="grid h-screen bg-paper text-ink [grid-template-areas:'map_narr_char''card_narr_char'] [grid-template-columns:320px_minmax(0,1fr)_300px] [grid-template-rows:minmax(0,1fr)_auto] max-[1200px]:[grid-template-areas:'map_card''narr_char'] max-[1200px]:[grid-template-columns:minmax(0,1fr)_296px] max-[1200px]:[grid-template-rows:220px_minmax(0,1fr)]">
        <div className="flex min-h-0 flex-col border-r border-rule p-4 [grid-area:map] max-[1200px]:border-b">
          <MapHeader name={dungeon.pass.name} map={map} />
          <div className="flex min-h-0 flex-1 items-center justify-center">
            <DungeonMap map={map} className="h-full w-full" />
          </div>
        </div>

        <div className="min-h-0 border-r border-rule bg-panel [grid-area:card] max-[1200px]:border-b max-[1200px]:border-r-0">
          {room && <RoomCard room={room} />}
        </div>

        <div className="flex min-h-0 flex-col [grid-area:narr]">
          <Narration items={items} busy={busy} />
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
            {...(onLeave ? { onLeave } : {})}
          />
        </div>

        <div className="min-h-0 border-l border-rule [grid-area:char]">
          <CharacterPanel pc={pc} />
        </div>

        {/* One mount for both panels, portalled to the document like the hover
            cards. It finds its anchors by attribute, so it does not care which
            panel raised it nor where in the grid that panel sits. */}
        <ActionPill />
      </main>
    </HoverProvider>
  );
}
