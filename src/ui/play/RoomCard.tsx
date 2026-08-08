/**
 * What is in this room, and the ways out of it.
 *
 * A standing reference so the player does not have to scroll back through the
 * narration to remember what they can act on. It shows only what they are aware
 * of — `roomView` has already dropped anything concealed, and anything inside
 * something concealed.
 */

import { exitLabel, type ExitView, type RoomView } from "../../store/selectors.ts";

const LABEL = "font-mono text-[9px] uppercase tracking-[0.16em] text-graphite";

/**
 * One way out.
 *
 * Where it goes, once they have been — see `exitLabel`. Until then it is only
 * what it looks like, and "unexplored". The way out of the dungeon is always
 * named, and marked: deciding when to leave is most of the game, and it cannot
 * be decided by somebody who has lost track of the door.
 */
function Exit({ exit }: { exit: ExitView }) {
  return (
    <li className="font-prose text-[13px] leading-snug">
      <span
        className={exit.blocked ? "text-graphite" : exit.surface ? "text-torch" : "text-ink"}
      >
        {exitLabel(exit)}
      </span>
      {exit.blocked ? (
        // What blocks it, as it looks from this side — the player's planning
        // information.
        <span className="block font-prose text-[12px] italic text-torch">{exit.requirement}</span>
      ) : (
        !exit.toKnown &&
        !exit.surface && (
          <span className="ml-1 font-mono text-[10px] uppercase tracking-[0.1em] text-pencil">
            unexplored
          </span>
        )
      )}
    </li>
  );
}

export function RoomCard({ room }: { room: RoomView }) {
  const creatures = room.contents.filter((c) => c.kind === "Creature");
  const things = room.contents.filter((c) => c.kind !== "Creature");
  // Already sorted — the way they came, then the known, then the unexplored.
  // Split rather than re-sorted, so the panel and the referee's prompt cannot
  // end up reading the room's exits in two different orders.
  const behind = room.exits.filter((e) => e.cameFrom);
  const ahead = room.exits.filter((e) => !e.cameFrom);

  return (
    <section className="overflow-y-auto p-4">
      <h3 className="mb-1 font-display text-[15px] font-bold leading-tight text-ink">
        {room.name}
      </h3>

      {creatures.length > 0 && (
        <div className="mt-3">
          <div className={`${LABEL} mb-1.5`}>Here with you</div>
          <ul className="space-y-1">
            {creatures.map((c) => (
              <li key={c.id} className="font-prose text-[13px] leading-snug text-ink">
                {c.name}
                {c.count && c.count > 1 && (
                  <span className="ml-1 font-mono text-[11px] text-graphite">×{c.count}</span>
                )}
                {c.activity && (
                  <span className="block font-prose text-[12px] italic text-graphite">
                    {c.activity}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {things.length > 0 && (
        <div className="mt-3">
          <div className={`${LABEL} mb-1.5`}>In this room</div>
          <ul className="space-y-1">
            {things.map((t) => (
              <li key={t.id} className="font-prose text-[13px] leading-snug text-ink">
                {t.name}
                {t.contains.length > 0 && (
                  <span className="ml-1 font-mono text-[10px] text-graphite">
                    ({t.contains.map((c) => c.name).join(", ")})
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* The way they walked in by, on its own above the rule. A player who has
          just arrived somewhere asks two things — what is here, and how do I get
          back — and the second should not have to be hunted for in a list. */}
      {behind.length > 0 && (
        <div className="mt-3">
          <div className={`${LABEL} mb-1.5`}>Behind you</div>
          <ul className="space-y-1">
            {behind.map((e) => (
              <Exit key={e.connectorId} exit={e} />
            ))}
          </ul>
        </div>
      )}

      <div className="mt-3">
        {behind.length > 0 && <div className="mb-3 h-px bg-rule" />}
        <div className={`${LABEL} mb-1.5`}>{behind.length > 0 ? "Other ways out" : "Exits"}</div>
        <ul className="space-y-1">
          {ahead.map((e) => (
            <Exit key={e.connectorId} exit={e} />
          ))}
          {ahead.length === 0 && (
            <li className="font-prose text-[13px] italic text-pencil">
              {behind.length > 0 ? "Nothing but the way you came." : "No way out that you can see."}
            </li>
          )}
        </ul>
      </div>
    </section>
  );
}
