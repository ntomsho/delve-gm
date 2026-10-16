/**
 * THE DATABASE, AS FUNCTIONS
 * ==========================
 *
 * Every statement the server runs, behind one name. Handlers above this file
 * ask `repo` for things; nothing above it writes SQL. The statements live one
 * file per table beside this one, and this file is the whole of what they
 * offer.
 *
 * Two kinds of record: a dungeon is large and written twice — once partial,
 * once complete — and a run is small and written on every turn.
 *
 * THE ONE THING WORTH READING BEFORE THE REST is `commitTurn`. It is the write
 * that has to be correct under two requests at once, and everything it does is
 * one transaction on purpose. It is in `runs.ts`, with the note that explains it.
 *
 * Node only.
 */

export {
  type CharacterRecord,
  type ActiveRun,
  type CharacterEntry,
  listRoster,
  activeRunFor,
  getCharacter,
  saveCharacter,
  carriedOut,
  deleteCharacter,
} from "./characters.ts";
export {
  type StoredDungeon,
  type DungeonSummary,
  insertPartialDungeon,
  findUnfinishedDungeon,
  getDungeon,
  listDungeons,
  completeDungeon,
  type LibraryPage,
  listLibrary,
  duplicateDungeon,
  saveChunk,
  listChunks,
} from "./dungeons.ts";
export {
  appendDungeonEvents,
  lastDungeonSeq,
  readDungeonEvents,
  lastSeq,
  readJournal,
  collectingSink,
  appendEvents,
} from "./events.ts";
export {
  type StoredRun,
  type RunSummary,
  createRun,
  getRun,
  listRuns,
  lockRun,
  releaseRun,
  type CommitResult,
  commitTurn,
  type RunStatus,
  statusOf,
} from "./runs.ts";
export {
  type IllustrationRow,
  getIllustration,
  claimIllustration,
  finishIllustration,
  failIllustration,
  getIllustrationWords,
  saveIllustrationWords,
  setDungeonCover,
} from "./illustrations.ts";
