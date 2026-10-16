/**
 * What is in this room, and the ways out of it.
 *
 * A standing reference so the player does not have to scroll back through the
 * narration to remember what they can act on. It shows only what they are aware
 * of — `roomView` has already dropped anything concealed, and anything inside
 * something concealed.
 *
 * EVERY ROW IS A HOVER, and the same hover the map gives — same three lines,
 * same words, and pointing at either one lights the other. The card is the more
 * likely place to reach for, so a thing named in the prose can be inspected
 * there too.
 */

import { createContext, useContext, type ReactNode } from "react";
import { CARD_TIP, ThingTooltip, useAnchor, useHover } from "./hover.tsx";
import { thingVerb, wayVerb } from "./verbs.ts";
import { exitLabel, type ExitView, type RoomView } from "../../gameplay/view/room.ts";
import type { EntityView } from "../../gameplay/view/entities.ts";

const LABEL = "font-mono text-[9px] uppercase tracking-[0.16em] text-graphite";
/** The phone's: a size up, because it is read at arm's length. */
const LABEL_COMPACT = "font-mono text-[10px] uppercase tracking-[0.16em] text-graphite";

/**
 * A row the cursor is on: torch rule down the left, torch wash behind.
 *
 * The negative margin pulls the ground out past the padding so the highlight
 * reads as a band across the panel rather than as a box drawn round the words,
 * and the transparent border keeps the text from stepping sideways when it lights.
 */
const ROW = "-mx-1.5 border-l-2 px-1.5 transition-colors";
/**
 * The phone's: every row a 48px button, ruled off from the next, because a
 * finger has to be able to pick one row out of a list of them.
 */
const ROW_COMPACT =
  "-mx-2 flex min-h-12 items-center justify-between gap-3 border-b border-l-2 border-b-rule-faint py-2 pl-2.5 pr-2 transition-colors";

/** Whether the card is being drawn for a phone. Read by the rows. */
const Compact = createContext(false);
const LIT = "border-torch bg-torch-wash";
const UNLIT = "border-transparent";
// Left side only, so the rule under each phone row keeps its own colour.
const LIT_COMPACT = "border-l-torch bg-torch-wash";
const UNLIT_COMPACT = "border-l-transparent";

/**
 * One way out.
 *
 * Where it goes, once they have been — see `exitLabel`. Until then it is only
 * what it looks like, and "unexplored". The way out of the dungeon is always
 * named, and marked: deciding when to leave is most of the game, and it cannot
 * be decided by somebody who has lost track of the door.
 *
 * Its hover is the wall it cuts — the same phrase the game master was handed, so a
 * player checking "is the ramp really at the north wall's eastern end" is
 * reading the map's own answer rather than the narration's.
 */
function Exit({ exit }: { exit: ExitView }) {
  const anchor = useAnchor(CARD_TIP);
  const { lit: litId, reachable } = useHover();
  const lit = litId === exit.connectorId;
  const compact = useContext(Compact);

  return (
    <li
      className={`font-prose leading-snug ${compact ? `text-[15px] ${ROW_COMPACT}` : `text-[13px] ${ROW}`} ${compact ? (lit ? LIT_COMPACT : UNLIT_COMPACT) : lit ? LIT : UNLIT}`}
      {...anchor(
        exit.connectorId,
        {
          title: exit.name || (exit.surface ? "The way out" : "A way through"),
          note: exit.wall,
          body: exit.surface
            ? "Out of the dungeon — stepping through ends the run."
            : exit.blocked
              ? exit.requirement
              : undefined,
        },
        // `toUnknown` on the map is `!toKnown` here: the near side of an exit in
        // the room you are standing in is known by definition, so the two views
        // are saying the same thing in their own words. See `Wayish`.
        wayVerb({ ...exit, toUnknown: !exit.toKnown }, reachable.has(exit.connectorId))
      )}
    >
      <span className={compact ? "min-w-0" : undefined}>
        <span
          className={exit.blocked ? "text-graphite" : exit.surface ? "text-torch" : "text-ink"}
        >
          {exitLabel(exit)}
        </span>
        {exit.blocked && (
          // What blocks it, as it looks from this side — the player's planning
          // information.
          <span className={`block font-prose italic text-torch ${compact ? "text-[13px]" : "text-[12px]"}`}>
            {exit.requirement}
          </span>
        )}
      </span>
      {!exit.blocked && !exit.toKnown && !exit.surface && (
        <span
          className={`font-mono uppercase tracking-[0.1em] text-pencil ${compact ? "shrink-0 text-[9px]" : "ml-1 text-[10px]"}`}
        >
          unexplored
        </span>
      )}
    </li>
  );
}

/**
 * One thing in the room.
 *
 * `position` and `composed` are the map marker's own two fields, read from the
 * same view — so the card and the dot say the same words about the same thing
 * rather than merely agreeing.
 *
 * A CREATURE LIGHTS NOTHING ON THE MAP, because creature markers do not exist
 * yet (ROADMAP, *Creature markers*). The row still hovers, and it will link the day they do: the
 * link is keyed on the entity id, which a creature already has.
 */
function Content({ e, detail }: { e: EntityView; detail?: ReactNode }) {
  const anchor = useAnchor(CARD_TIP);
  const lit = useHover().lit === e.id;
  const compact = useContext(Compact);

  return (
    <li
      className={`font-prose leading-snug text-ink ${compact ? `text-[15px] ${ROW_COMPACT}` : `text-[13px] ${ROW}`} ${compact ? (lit ? LIT_COMPACT : UNLIT_COMPACT) : lit ? LIT : UNLIT}`}
      {...anchor(e.id, { title: e.name, note: e.position, body: e.composed }, thingVerb(e.name))}
    >
      <span className={compact ? "min-w-0" : undefined}>
        {e.name}
        {detail}
      </span>
    </li>
  );
}

export function RoomCard({ room, compact = false }: { room: RoomView; compact?: boolean }) {
  const label = compact ? LABEL_COMPACT : LABEL;
  const group = compact ? "mt-4" : "mt-3";
  const list = compact ? "" : "space-y-1";
  const creatures = room.contents.filter((c) => c.kind === "Creature");
  const things = room.contents.filter((c) => c.kind !== "Creature");
  // Already sorted — the way they came, then the known, then the unexplored.
  // Split rather than re-sorted, so the panel and the game master's prompt cannot
  // end up reading the room's exits in two different orders.
  const behind = room.exits.filter((e) => e.cameFrom);
  const ahead = room.exits.filter((e) => !e.cameFrom);

  return (
    <Compact.Provider value={compact}>
    <section className={compact ? "px-4 pb-6 pt-4" : "overflow-y-auto p-4"}>
      {compact && <div className={`${LABEL_COMPACT} mb-1`}>You are in</div>}
      <h3
        className={`mb-1 font-display font-bold leading-tight text-ink ${compact ? "text-[18px]" : "text-[15px]"}`}
      >
        {room.name}
      </h3>

      {creatures.length > 0 && (
        <div className={group}>
          <div className={`${label} mb-1.5`}>Here with you</div>
          <ul className={list}>
            {creatures.map((c) => (
              <Content
                key={c.id}
                e={c}
                detail={
                  <>
                    {c.count && c.count > 1 && (
                      <span className="ml-1 font-mono text-[11px] text-graphite">×{c.count}</span>
                    )}
                    {c.activity && (
                      <span className={`block font-prose italic text-graphite ${compact ? "text-[13px]" : "text-[12px]"}`}>
                        {c.activity}
                      </span>
                    )}
                  </>
                }
              />
            ))}
          </ul>
        </div>
      )}

      {things.length > 0 && (
        <div className={group}>
          <div className={`${label} mb-1.5`}>In this room</div>
          <ul className={list}>
            {things.map((t) => (
              <Content
                key={t.id}
                e={t}
                detail={
                  t.contains.length > 0 && (
                    <span className={`ml-1 font-mono text-graphite ${compact ? "text-[11px]" : "text-[10px]"}`}>
                      ({t.contains.map((c) => c.name).join(", ")})
                    </span>
                  )
                }
              />
            ))}
          </ul>
        </div>
      )}

      {/* WHERE THEY CAN GO, THEN WHERE THEY HAVE BEEN.
          A player standing in a room asks two things — what is here, and where
          can I go next — and the way they walked in by is neither. It stays on
          the card, named and set apart below the rule, because deciding to turn
          back is a real decision and it should not have to be hunted for; it
          just stops being the first thing under the contents. */}
      <div className={group}>
        <div className={`${label} mb-1.5`}>Exits</div>
        <ul className={list}>
          {ahead.map((e) => (
            <Exit key={e.connectorId} exit={e} />
          ))}
          {ahead.length === 0 && (
            <li className={`font-prose italic text-pencil ${compact ? "py-2 text-[15px]" : "text-[13px]"}`}>
              {behind.length > 0 ? "Nothing but the way you came." : "No way out that you can see."}
            </li>
          )}
        </ul>
      </div>

      {behind.length > 0 && (
        <div className={group}>
          <div className="mb-3 h-px bg-rule" />
          <div className={`${label} mb-1.5`}>You came in from</div>
          <ul className={list}>
            {behind.map((e) => (
              <Exit key={e.connectorId} exit={e} />
            ))}
          </ul>
        </div>
      )}

      {/* Portalled to the document. The card is the narrowest panel on the
          sheet and a hover on a row near its edge would otherwise be cut off by
          the panel that draws it. See `hover.tsx`. */}
      <ThingTooltip id={CARD_TIP} />
    </section>
    </Compact.Provider>
  );
}
