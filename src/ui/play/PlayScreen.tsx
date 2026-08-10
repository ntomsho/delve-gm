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

import { useMemo, useState } from "react";
import { CharacterPanel } from "./CharacterPanel.tsx";
import { DungeonMap } from "./DungeonMap.tsx";
import { InputArea } from "./InputArea.tsx";
import { Narration, type NarrationItem } from "./Narration.tsx";
import { RoomCard } from "./RoomCard.tsx";
import { TravelConfirm } from "./TravelConfirm.tsx";
import { floorplanLayout, pointLayout } from "../../runtime/layout.ts";
import { placedThings } from "../../runtime/occupancy.ts";
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
}

export function PlayScreen({ dungeon, run, items, onSubmit, onRoll, onRetry }: PlayScreenProps) {
  const [draft, setDraft] = useState("");
  /** The door the player clicked, waiting on a yes. */
  const [going, setGoing] = useState<string>();

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

  const busy = run.stage === "thinking" || run.stage === "resolving" || run.stage === "room_entry";

  /**
   * Only the ways out of the room they are standing in, and only when it is
   * their turn.
   *
   * A door across the map is a route rather than a step, and phrasing a route
   * as a sentence the player never wrote is how the map starts saying things
   * they did not mean. `routeTo` can walk one; deciding what to send is its own
   * problem and not this session's.
   */
  const travelable = useMemo(() => {
    if (busy || !room || shown !== run.currentRoomId) return new Set<string>();
    return new Set(room.exits.map((e) => e.connectorId));
  }, [busy, room, shown, run.currentRoomId]);

  const pending = going ? room?.exits.find((e) => e.connectorId === going) : undefined;

  return (
    <main className="grid h-screen bg-paper text-ink [grid-template-areas:'map_narr_char''card_narr_char'] [grid-template-columns:320px_minmax(0,1fr)_300px] [grid-template-rows:minmax(0,1fr)_auto] max-[1200px]:[grid-template-areas:'map_card''narr_char'] max-[1200px]:[grid-template-columns:minmax(0,1fr)_296px] max-[1200px]:[grid-template-rows:220px_minmax(0,1fr)]">
      <div className="flex min-h-0 items-center justify-center border-r border-rule p-4 [grid-area:map] max-[1200px]:border-b">
        <DungeonMap
          map={map}
          className="h-full w-full"
          travelable={travelable}
          onDoorClick={setGoing}
        />
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
        />
      </div>

      <div className="min-h-0 border-l border-rule [grid-area:char]">
        <CharacterPanel pc={pc} />
      </div>

      {pending && (
        <TravelConfirm
          exit={pending}
          onCancel={() => setGoing(undefined)}
          onConfirm={(text) => {
            setGoing(undefined);
            setDraft("");
            onSubmit(text);
          }}
        />
      )}
    </main>
  );
}
