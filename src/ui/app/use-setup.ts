/**
 * WHAT RUN SETUP OFFERS: the player's own worlds and how many runs are left
 * today.
 *
 * READ WHEN THE SETUP SCREEN OPENS rather than kept in step with the roster. It
 * is the one screen that asks, it is asked once per run, and a list fetched at
 * the moment it is shown cannot be a stale list — which the alternative,
 * refreshing it alongside the characters after every save and delete, would be
 * spending two requests to achieve less reliably.
 */

import { useState } from "react";
import { fetchAllowance, type Allowance } from "../../api-client/allowance.ts";
import { listDungeons, type DungeonSummary } from "../../api-client/dungeons.ts";
import { OFFLINE } from "./local-run.ts";

export interface SetupData {
  dungeons: DungeonSummary[] | undefined;
  /**
   * `undefined` is "not known", which the screen treats as no limit — the
   * server is the gate, not this.
   */
  allowance: Allowance | undefined;
  /** Forget the last read and start a new one. */
  load: () => Promise<void>;
}

export function useSetupData(): SetupData {
  const [dungeons, setDungeons] = useState<DungeonSummary[]>();
  const [allowance, setAllowance] = useState<Allowance>();

  return {
    dungeons,
    allowance,
    /**
     * Partial worlds are dropped here rather than in `RunSetup`: a half written
     * dungeon is a failed generation, `POST /api/runs` refuses one, and a
     * control that is offered and then refused is worse than one never shown.
     */
    async load() {
      setDungeons(undefined);
      setAllowance(undefined);
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
    },
  };
}
