/**
 * THE ROSTER: the player's characters, and the one line of news shown over them.
 *
 * Everything that changes a character from outside a run goes through here, so
 * that every one of them re-reads the list afterwards and reports a refusal in
 * the server's own words.
 */

import { useEffect, useState } from "react";
import { authedFetch, type Account } from "../../api-client/auth.ts";
import {
  deleteCharacter,
  listRoster,
  saveCharacter,
  NO_RECORD,
  type ActiveRun,
  type CharacterEntry,
} from "../../api-client/characters.ts";
import type { PlayerCharacter } from "../../rules/knave/character.ts";
import { fixtures, OFFLINE } from "./local-run.ts";

const say = (e: unknown) => (e instanceof Error ? e.message : String(e));

export interface Roster {
  characters: CharacterEntry[] | undefined;
  /** A refusal from the server, in its own words, shown on the roster. */
  notice: string | undefined;
  setNotice: (notice: string | undefined) => void;
  /** The roster, re-read. Every ending changes something on it. */
  refresh: () => Promise<void>;
  /**
   * Save a sheet, and say so on the roster if it did not save. A purchase or a
   * level IS the sheet, so a failed save is one that did not happen, and the
   * player should not be left believing they are carrying a lantern.
   */
  save: (pc: PlayerCharacter) => Promise<void>;
  remove: (pc: PlayerCharacter) => Promise<void>;
  abandon: (active: ActiveRun) => Promise<void>;
}

/**
 * `onLoaded` runs with the list each time it is first read for an account — the
 * dev switches use it to start a run with the first character.
 */
export function useRoster(account: Account | undefined, onLoaded?: (cs: CharacterEntry[]) => void): Roster {
  const [characters, setCharacters] = useState<CharacterEntry[]>();
  const [notice, setNotice] = useState<string>();

  async function refresh() {
    if (OFFLINE) return;
    setCharacters(await listRoster());
  }

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
      onLoaded?.(cs);
    })();
  }, [account?.id]);

  return {
    characters,
    notice,
    setNotice,
    refresh,

    async save(pc) {
      try {
        await saveCharacter(pc);
      } catch (e) {
        setNotice(say(e));
      }
      await refresh();
    },

    async remove(pc) {
      setNotice(undefined);
      try {
        await deleteCharacter(pc.id);
      } catch (e) {
        // The server's own sentence. "That character is in a run" is a thing
        // the player can do something about, and a button that silently did
        // nothing would not tell them what.
        setNotice(say(e));
      }
      await refresh();
    },

    /**
     * Walk away from a run WITHOUT being in it.
     *
     * The play path abandons through the session, which holds the run's version.
     * From the roster there is no session and no version, so this reads the run,
     * abandons it, and re-reads the list. Two requests where the play path makes
     * one, and worth it: the alternative is minting a whole session to end a run
     * the player is not looking at.
     */
    async abandon(active) {
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
        await refresh();
      } catch (e) {
        setNotice(say(e));
      }
    },
  };
}
