# Room illustration style references

Sent with every interior room illustration, after the guide image, to hold the drawing style:
clean black ink line art, mostly white paper, sparing hatching. See
`docs/ARCHITECTURE.md` §10.

| File | Subject | Drawn by |
|---|---|---|
| `I7.png` | Barracks: an occupied dressed-stone room | FLUX.2 [klein] 4B, no guide, style "sparse" |
| `I8.png` | Flooded nave: a ruined abbey hall under water | FLUX.2 [klein] 4B, no guide, style v2 |
| `I9.png` | Overgrown temple: rough-hewn stone taken by roots | FLUX.2 [klein] 4B, no guide, style "sparse" |
| `I10.png` | Forge cave: a working smithy in raw rock | FLUX.2 [klein] 4B, no guide, style v2 |

All four are our own images, generated for this project in the illustration spike (2026-10-13).
Style references must never be someone else's art: not TSR's, and not a model trained on
a named artist.

They are the exact files the approved spike results were drawn with:
- converted to 1-bit (threshold 150);
- any frame the model drew cropped away;
- shrunk to fit 768×512.

The shrinking reintroduced some grey, so they are larger than a true 1-bit PNG would be.
They were left as they are because changing them changes the look.

Re-create them with `node src/dev/cli-illustrate.ts --refs I7,I8,I9,I10 ...`; the prepared
copies land in `out/illustrate-v2-refs/refs/`. A room is never sent its own reference.
