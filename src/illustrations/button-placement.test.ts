import { describe, expect, it } from "vitest";
import { generateOffline } from "../fixtures/offline.ts";
import { applyPlacement, PLACEMENT_CLEARANCE, placementMessage, type PlacementAnswer } from "./button-placement.ts";
import { illustrationEntries, illustrationSpots, roomIllustration, type IllustrationSpot } from "./room-illustration.ts";

const size = { width: 1536, height: 1024 };

const spots: IllustrationSpot[] = [
  { id: "door", how: "shown", x: 0.5, y: 0.5 },
  { id: "winch", how: "shown", x: 0.2, y: 0.8 },
  { id: "hidden", how: "behind-wall", x: 0.8, y: 0.5 },
  { id: "corner", how: "around", x: 0.1, y: 0.4, turn: "left" },
  { id: "edge", how: "edge", edge: "left", along: 0.5 },
];
const at = (ref: string, x: number, y: number, found = true): PlacementAnswer[number] => ({ ref, found, x, y, on: "it" });

describe("applyPlacement", () => {
  it("moves each button in the picture to its answered pixel", () => {
    const got = applyPlacement(spots, [at("b0", 768, 256), at("b1", 384, 512)], size);
    expect(got[0]).toEqual({ id: "door", how: "shown", x: 0.5, y: 0.25 });
    expect(got[1]).toEqual({ id: "winch", how: "shown", x: 0.25, y: 0.5 });
  });

  it("never moves a corner arrow, a dashed button or an edge arrow, whatever the answer says", () => {
    const got = applyPlacement(spots, [at("b2", 10, 10), at("b3", 10, 10), at("b4", 10, 10)], size);
    expect(got.slice(2)).toEqual(spots.slice(2));
  });

  it("keeps the geometry's point when the answer is missing, not found, or off the picture", () => {
    expect(applyPlacement(spots, [], size)).toEqual(spots);
    expect(applyPlacement(spots, [at("b0", 100, 100, false)], size)[0]).toEqual(spots[0]);
    expect(applyPlacement(spots, [at("b0", 1600, 100)], size)[0]).toEqual(spots[0]);
    expect(applyPlacement(spots, [at("b0", 100, -5)], size)[0]).toEqual(spots[0]);
  });

  it("refuses a move onto a taken spot, and allows one just clear of it", () => {
    const onIt = applyPlacement(spots, [at("b0", 0.8 * 1536 + 5, 0.5 * 1024)], size);
    expect(onIt[0]).toEqual(spots[0]);
    const clear = (PLACEMENT_CLEARANCE + 0.01) * 1536;
    const beside = applyPlacement(spots, [at("b0", 0.8 * 1536 - clear, 0.5 * 1024)], size);
    expect(beside[0]).not.toEqual(spots[0]);
  });
});

describe("placementMessage", () => {
  const d = generateOffline(1005, 1);
  const cases = d.graph.rooms.flatMap((r) =>
    illustrationEntries(d, r.entityId).map((e) => roomIllustration(d, r.entityId, e)!)
  );

  it("lists the buttons in the picture and only those, with the out-of-sight ones as taken spots", () => {
    const p = cases.find((c) => illustrationSpots(c).some((x) => x.how === "shown"));
    expect(p).toBeDefined();
    // A dashed button and a corner arrow, whatever this room happens to have.
    const s: IllustrationSpot[] = [
      { id: "walled-off", how: "behind-wall", x: 0.9, y: 0.5 },
      ...illustrationSpots(p!),
      { id: "round-the-corner", how: "around", x: 0.05, y: 0.4, turn: "right" },
    ];
    const msg = placementMessage(p!, s, size);
    expect(msg).not.toContain("walled-off");
    expect(msg).toContain(JSON.stringify({ x: Math.round(0.9 * 1536), y: 512 }));
    const buttons = JSON.parse(msg.split("Buttons:\n")[1].split("\n\nTaken spots:")[0]);
    const taken = JSON.parse(msg.split("Taken spots:\n")[1]);
    expect(buttons.map((b: { ref: string }) => b.ref)).toEqual(
      s.flatMap((x, i) => (x.how === "shown" ? [`b${i}`] : []))
    );
    expect(taken).toHaveLength(s.filter((x) => x.how === "behind-wall" || x.how === "around").length);
    const first = s.findIndex((x) => x.how === "shown");
    const spot = s[first] as { x: number; y: number };
    expect(buttons[0].estimate).toEqual({ x: Math.round(spot.x * 1536), y: Math.round(spot.y * 1024) });
  });
});
