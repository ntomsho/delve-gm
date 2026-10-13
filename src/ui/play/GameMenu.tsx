/**
 * THE GAME MENU — top left of the play screen.
 *
 * One item today: back to the main menu, which is the roster. It does NOT end
 * the run. Every commit is already saved server-side, so leaving is nothing
 * more than dropping this screen's session; the roster shows the character as
 * in a run and resumes it the same way it resumes one left by closing the tab.
 * Ending a run is Abandon, under the input, and the two are deliberately far
 * apart.
 *
 * ITS OWN COMPONENT BECAUSE IT IS GOING TO GROW. The plan is a dropdown for
 * settings and options, anchored here; the play screen hands it actions and
 * does not know how they are presented, so turning this button into a menu
 * touches this file and nothing else.
 *
 * TOP LEFT, not top right: it is navigation, and navigation on every other
 * screen (`← Characters` on the library, the run setup, character creation) is
 * a back link in the top-left corner in this same type.
 *
 * DISABLED WHILE THE REFEREE IS WORKING. A turn in flight finishes on the
 * server whether or not anyone is watching, and a resume that loaded the run
 * before that save landed would be a version behind it. The error stage is
 * not working, so a stuck run can always be left.
 */

export interface GameMenuProps {
  /** Back to the roster. The run stays live and resumable. */
  onMainMenu(): void;
  /** a turn is in flight */
  busy: boolean;
  /**
   * The phone's top bar: shorter words, a finger's height, and no `title`,
   * which a finger cannot raise — the link is the whole affordance.
   */
  compact?: boolean;
}

export function GameMenu({ onMainMenu, busy, compact = false }: GameMenuProps) {
  return (
    <nav aria-label="Game menu" className={compact ? "shrink-0" : "mb-3 shrink-0"}>
      <button
        type="button"
        onClick={onMainMenu}
        disabled={busy}
        title={
          compact
            ? undefined
            : busy
              ? "Waiting on the referee — your run is saved either way"
              : "Your run is saved; resume it from your characters"
        }
        className={`font-mono text-[10px] uppercase tracking-[0.14em] text-graphite transition-colors hover:text-ink active:text-torch disabled:text-pencil ${
          compact ? "h-11 pr-2" : ""
        }`}
      >
        {compact ? "← Menu" : "← Main menu"}
      </button>
    </nav>
  );
}
