/**
 * What the narration column shows, as data: the stored scrollback turned into
 * items to render.
 *
 * Apart from `Narration.tsx` so that `ui/app/use-run.ts` can build the items
 * without importing the column. That import would pull the whole play screen
 * (the map, the illustrations, the tooltips) into the first chunk the browser
 * downloads, ahead of the sign-in screen that needs none of it.
 */

import type { LogEntry } from "../../gameplay/state/store.ts";
import type { RolledOutcome } from "../../shared/types/turn.ts";
import type { Effect, FoeRoll } from "../../gameplay/mechanics/effects.ts";

export interface Arrival {
  kind: "arrival";
  roomName: string;
  /** e.g. "ROOM 14 · DESCENT III" */
  label?: string;
  prose: string;
  /** which room, for its illustration */
  roomId?: string;
  /** the first arrival in this room: the only one that carries its illustration */
  first?: boolean;
}

/**
 * The briefing, above the first room.
 *
 * `objective` is the goal as its own line. It is also inside the prose — the
 * Dungeon Pass is told to say it plainly there — but it is repeated here
 * because the one thing a player must be able to find again an hour in is what
 * they came for, and hunting for it in a paragraph they read once is not
 * finding it.
 */
export interface Opening {
  kind: "opening";
  dungeonName: string;
  objective: string;
  prose: string;
}

export type NarrationItem =
  | Opening
  | Arrival
  | { kind: "game-master"; prose: string }
  | { kind: "player"; text: string }
  /** `outcome` is absent on rolls logged before it was kept; those stay text */
  | { kind: "roll"; text: string; outcome?: RolledOutcome }
  | { kind: "effects"; effects: Effect[] }
  | { kind: "foe"; foe: FoeRoll[] };

/**
 * Turn the stored scrollback into something renderable.
 *
 * From `log`, not `transcript`: the transcript is what the game master is shown and
 * is cleared every time a turn closes. `roomName` has to be looked up because
 * the log stores an id — names are never writable, so the current one is always
 * the right one.
 */
export function toItems(
  log: LogEntry[],
  roomName: (id: string) => string,
  dungeon?: { name: string; objective: string }
): NarrationItem[] {
  const seen = new Set<string>();
  return log.map((e) => {
    switch (e.kind) {
      case "opening":
        return {
          kind: "opening",
          dungeonName: dungeon?.name ?? "",
          objective: dungeon?.objective ?? "",
          prose: e.text,
        } as const;
      case "arrival": {
        const roomId = e.roomId ?? "";
        const first = roomId !== "" && !seen.has(roomId);
        seen.add(roomId);
        return { kind: "arrival", roomName: roomName(roomId), prose: e.text, roomId, first } as const;
      }
      case "player":
        return { kind: "player", text: e.text } as const;
      case "effects":
        return { kind: "effects", effects: e.effects ?? [] } as const;
      case "foe":
        return { kind: "foe", foe: e.foe ?? [] } as const;
      case "roll":
        return { kind: "roll", text: e.text, ...(e.outcome ? { outcome: e.outcome } : {}) } as const;
      default:
        return { kind: "game-master", prose: e.text } as const;
    }
  });
}
