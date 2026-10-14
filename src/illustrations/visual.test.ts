/**
 * ROOM ILLUSTRATIONS — the words, without the model
 *
 * What is sent to the condensing call and what comes back into the image
 * prompt, checked on real offline rooms with the model's answer stood in for
 * by the raw fiction (`rawVisual`). The contract: only what is in the picture
 * goes out, and everything that went out comes back into the prompt.
 */

import { describe, expect, it } from "vitest";
import { generateOffline } from "../fixtures/offline.ts";
import { illustrationImagePrompt, rawVisual, visualSubjects } from "./visual.ts";
import { illustrationEntries, illustrationInView, roomIllustration } from "./room-illustration.ts";

describe("visualSubjects and illustrationImagePrompt", () => {
  const d = generateOffline(42, 2);
  const illustrations = d.graph.rooms.flatMap((gr) => {
    const entry = illustrationEntries(d, gr.entityId)[0];
    const p = entry ? roomIllustration(d, gr.entityId, entry) : undefined;
    return p ? [p] : [];
  });

  it("sends exactly what is in the picture, each under a unique ref", () => {
    for (const p of illustrations) {
      const { subjects, refOf } = visualSubjects(p);
      const { drawn, surfaces } = illustrationInView(p);
      expect(subjects.length).toBe(drawn.length + surfaces.length);
      expect(new Set(subjects.map((s) => s.ref)).size).toBe(subjects.length);
      for (const x of [...drawn, ...surfaces]) expect(refOf.has(x.subject.id)).toBe(true);
    }
  });

  it("brings every look back into the prompt, tagged to match the guide", () => {
    for (const p of illustrations) {
      const visual = rawVisual(p);
      const prompt = illustrationImagePrompt(p, "marks", "SETTING LINE", visual);
      expect(prompt).toContain("SETTING LINE");
      for (const x of illustrationInView(p).drawn) {
        expect(prompt).toContain(x.where);
        if (x.tag) expect(prompt).toContain(`[${x.tag}]`);
      }
    }
  });

  it("never names a sound or smell, nor anything out of the picture", () => {
    for (const p of illustrations) {
      const prompt = illustrationImagePrompt(p, "none", "", rawVisual(p));
      for (const x of p.senses) expect(prompt).not.toContain(x.base);
      const inView = new Set([...illustrationInView(p).drawn, ...illustrationInView(p).surfaces].map((x) => x.subject.id));
      for (const f of p.features.filter((x) => !inView.has(x.id))) {
        if (f.base) expect(prompt).not.toContain(f.base);
      }
    }
  });
});
