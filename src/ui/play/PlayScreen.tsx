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
import { pointLayout } from "../../runtime/layout.ts";
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

  // Geometry is fixed for the whole run; only the fog over it changes.
  const layout = useMemo(() => pointLayout(dungeon.graph), [dungeon.graph]);
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

  return (
    <main className="grid h-screen bg-paper text-ink [grid-template-areas:'map_narr_char''card_narr_char'] [grid-template-columns:320px_minmax(0,1fr)_300px] [grid-template-rows:minmax(0,1fr)_auto] max-[1200px]:[grid-template-areas:'map_card''narr_char'] max-[1200px]:[grid-template-columns:minmax(0,1fr)_296px] max-[1200px]:[grid-template-rows:220px_minmax(0,1fr)]">
      <div className="flex min-h-0 items-center justify-center border-r border-rule p-4 [grid-area:map] max-[1200px]:border-b">
        <DungeonMap map={map} className="h-full w-full" />
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
    </main>
  );
}
