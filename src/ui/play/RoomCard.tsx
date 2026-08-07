/**
 * What is in this room, and the ways out of it.
 *
 * A standing reference so the player does not have to scroll back through the
 * narration to remember what they can act on. It shows only what they are aware
 * of — `roomView` has already dropped anything concealed, and anything inside
 * something concealed.
 */

import { exitLabel, type RoomView } from "../../store/selectors.ts";

const LABEL = "font-mono text-[9px] uppercase tracking-[0.16em] text-graphite";

export function RoomCard({ room }: { room: RoomView }) {
  const creatures = room.contents.filter((c) => c.kind === "Creature");
  const things = room.contents.filter((c) => c.kind !== "Creature");

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

      <div className="mt-3">
        <div className={`${LABEL} mb-1.5`}>Exits</div>
        <ul className="space-y-1">
          {room.exits.map((e) => (
            <li key={e.connectorId} className="font-prose text-[13px] leading-snug">
              {/* Where it goes, once they have been — see `exitLabel`. Until
                  then it is only what it looks like, and "unexplored". The way
                  out of the dungeon is always named, and marked: deciding when
                  to leave is most of the game, and it cannot be decided by
                  somebody who has lost track of the door. */}
              <span
                className={e.blocked ? "text-graphite" : e.surface ? "text-torch" : "text-ink"}
              >
                {exitLabel(e)}
              </span>
              {e.blocked ? (
                // What blocks it, as it looks from this side — the player's
                // planning information.
                <span className="block font-prose text-[12px] italic text-torch">
                  {e.requirement}
                </span>
              ) : (
                !e.toKnown &&
                !e.surface && (
                  <span className="ml-1 font-mono text-[10px] uppercase tracking-[0.1em] text-pencil">
                    unexplored
                  </span>
                )
              )}
            </li>
          ))}
          {room.exits.length === 0 && (
            <li className="font-prose text-[13px] italic text-pencil">No way out that you can see.</li>
          )}
        </ul>
      </div>
    </section>
  );
}
