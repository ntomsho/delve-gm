# Creature sprite style references

Sent with every creature sprite to hold the drawing style: rough black pen line, mostly
white paper, a little hatching in the deepest shadows, people plain and creatures gnarly.
See *Illustrations*, "2. Creature sprites", in `docs/BUILD-PLAN.md`.

| File | Subject | Round, take |
|---|---|---|
| `P1-sellsword.png` | Battered sellsword: dented mail, chipped shield | 2, b |
| `P2-scholar.png` | Plain middle-aged scholar in a well-kept robe | 3, b |
| `P3-thief.png` | Thief as an ordinary woman, gear in good repair | 4, a |
| `P4-old-woman.png` | Wizened old peasant woman with a stick and basket | 2, b |
| `P5-cultist.png` | Cultist in a frayed cowl, clutching an idol | 2, a |
| `C2-brute.png` | Hulking lopsided brute with a club | 2, a |
| `C3-skeleton.png` | Skeleton warrior in rusted half-armour | 2, a |
| `C4-rat.png` | Mangy giant rat on all fours | 2, b |
| `C6-insect.png` | Pony-sized crawling insect-thing | 2, b |

All nine are our own images, drawn for this project (2026-10-14) by GPT Image 2 at low
quality from a text description of the style alone, with no reference images. Style
references must never be someone else's art: not TSR's, and not a model trained on a
named artist.

Picked for spread: upright, hunched, four-legged and many-legged; cloth, mail, bone, fur
and plate; and two people in good order against three in rags, so that a sprite drawn
against them is not always in rags.

Each was converted to 1-bit (threshold 150), trimmed to the figure with a 24 px margin, and
fitted into 512×768.

Re-create the candidates with `node src/dev/cli-sprites.ts --refs N` for rounds 2, 3 and 4.
They land in `out/sprite-refs-N/<subject>/gpt2-low-<take>.png`. GPT takes no seed, so a
rerun draws different figures; these files are the record.
