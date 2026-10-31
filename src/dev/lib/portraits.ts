/**
 * The CLI behind `dev/cli-portraits.ts`, which teaches Node `?raw` first and
 * then imports this. Usage is in that file.
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import sharp from "sharp";
import { fal } from "@fal-ai/client";
import { Rng } from "../../shared/utils/rng.ts";
import { randomSeed } from "../../generation/seeds.ts";
import {
  bonusesOf,
  finishCharacter,
  rollAbilities,
  rollHp,
  rollKit,
  rollName,
  rollTraits,
} from "../../rules/knave/character-creation.ts";
import { WEAPONS } from "../../rules/knave/tables.ts";
import { GENDERS, type PlayerCharacter } from "../../rules/knave/character.ts";
import { portraitImagePrompt } from "../../illustrations/portrait-prompt.ts";
import { IMAGE_MODELS, SPRITE_MODEL } from "../../llm/models.ts";
import { inkPng } from "../../server/illustrations/image.ts";
import { headAndShoulders } from "../../server/illustrations/portraits.ts";
import { SPRITE_DRAW, SPRITE_QUALITY, SPRITE_REFS_DIR } from "../../server/illustrations/sprites.ts";
import { describePerson } from "../../ui/shared/person.ts";

interface Args {
  count: number;
  seed: number;
  dry: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { count: 3, seed: randomSeed(), dry: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--dry") a.dry = true;
    else if (flag === "--count") a.count = Number(argv[++i]);
    else if (flag === "--seed") a.seed = Number(argv[++i]);
    else throw new Error(`unknown flag ${flag}; see src/dev/cli-portraits.ts`);
  }
  if (!(a.count >= 1 && a.count <= 12)) throw new Error("--count is 1 to 12");
  if (!Number.isFinite(a.seed)) throw new Error("--seed is a number");
  return a;
}

function envKey(name: string): string | undefined {
  if (process.env[name]) return process.env[name];
  try {
    for (const line of readFileSync(resolve(".env.local"), "utf8").split("\n")) {
      const m = line.match(new RegExp(`^\\s*${name}\\s*=\\s*(.*?)\\s*$`));
      if (m) return m[1].replace(/^["']|["']$/g, "") || undefined;
    }
  } catch {
    // no .env.local: the caller says what is missing
  }
  return undefined;
}

/**
 * A character as creation rolls one, with a weapon picked rather than the
 * screen's default sword, and a gender picked where the player would choose one.
 */
function rollCharacter(rng: Rng): PlayerCharacter {
  const weapon = rng.pick(WEAPONS);
  const gender = rng.pick(GENDERS);
  return finishCharacter({
    gender,
    mode: "normal",
    name: rollName(rng),
    abilities: bonusesOf(rollAbilities(rng, "normal")),
    traits: rollTraits(rng),
    hp: rollHp(rng, "normal").hp,
    kit: rollKit(rng, weapon),
  });
}

/** The figure on white, as the sprite worker draws it, without the spend ledger. */
async function draw(prompt: string, refs: string[]): Promise<Buffer> {
  const res = await fal.subscribe(IMAGE_MODELS[SPRITE_MODEL].guided, {
    input: { prompt, quality: SPRITE_QUALITY, image_size: SPRITE_DRAW, output_format: "png", image_urls: refs },
  });
  const url = (res.data as { images?: { url: string }[] }).images?.[0]?.url;
  if (!url) throw new Error(`no image in the response: ${JSON.stringify(res.data).slice(0, 300)}`);
  const got = await fetch(url);
  if (!got.ok) throw new Error(`fetching the image failed (${got.status})`);
  return Buffer.from(await got.arrayBuffer());
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** One character's card on the contact sheet. */
function card(pc: PlayerCharacter, dir: string, drawn: boolean, error?: string): string {
  const thumbs = [40, 52, 56, 128]
    .map((px) => `<figure><img src="${dir}/thumb.png" width="${px}" height="${px}" class="thumb"><figcaption>${px}px</figcaption></figure>`)
    .join("");
  const picture = drawn
    ? `<img src="${dir}/ink.png" class="full"><div class="thumbs">${thumbs}</div>`
    : `<div class="full empty">${error ? esc(error) : "not drawn (--dry)"}</div>`;
  const carrying = pc.inventory.map((i) => esc(i.name)).join(" · ");
  return `<section>
  <h2>${esc(pc.name)}</h2>
  ${picture}
  <p class="person">${esc(describePerson(pc.traits))}</p>
  <p class="gear">${carrying}</p>
  <details><summary>Prompt</summary><pre>${esc(readFileSync(join(OUT, dir, "prompt.txt"), "utf8"))}</pre></details>
  <p class="links"><a href="${dir}/raw.png">as drawn</a></p>
</section>`;
}

const args = parseArgs(process.argv.slice(2));
const OUT = resolve("out/portraits", String(args.seed));
mkdirSync(OUT, { recursive: true });

const rng = new Rng(args.seed);
const characters = Array.from({ length: args.count }, () => rollCharacter(rng));

const refDir = resolve(SPRITE_REFS_DIR);
const refFiles = readdirSync(refDir).filter((f) => f.endsWith(".png")).sort();

let refUrls: string[] = [];
if (!args.dry) {
  const key = envKey("FAL_KEY");
  if (!key) throw new Error("no FAL_KEY in the environment or .env.local (run with --dry to skip images)");
  fal.config({ credentials: key });
  refUrls = await Promise.all(
    refFiles.map((f) => fal.storage.upload(new Blob([readFileSync(join(refDir, f))], { type: "image/png" })))
  );
}

console.log(`seed ${args.seed}: ${args.count} character${args.count === 1 ? "" : "s"}${args.dry ? " (dry)" : `, about $${(args.count * 0.03).toFixed(2)}`}`);

const cards = await Promise.all(
  characters.map(async (pc, i) => {
    const dir = `${i + 1}`;
    mkdirSync(join(OUT, dir), { recursive: true });
    const prompt = portraitImagePrompt(pc, refFiles.length);
    writeFileSync(join(OUT, dir, "prompt.txt"), prompt);
    writeFileSync(join(OUT, dir, "sheet.json"), JSON.stringify(pc, null, 2));
    if (args.dry) return card(pc, dir, false);
    try {
      const raw = await draw(prompt, refUrls);
      if ((await sharp(raw).greyscale().stats()).channels[0].mean < 5) throw new Error("blank image (moderated)");
      const ink = await inkPng(raw);
      writeFileSync(join(OUT, dir, "raw.png"), raw);
      writeFileSync(join(OUT, dir, "ink.png"), ink);
      writeFileSync(join(OUT, dir, "thumb.png"), await headAndShoulders(ink));
      console.log(`  ${dir}. ${pc.name}: drawn`);
      return card(pc, dir, true);
    } catch (e) {
      console.log(`  ${dir}. ${pc.name}: FAILED ${(e as Error).message}`);
      return card(pc, dir, false, (e as Error).message);
    }
  })
);

// The page's own paper and ink, so the drawings sit as they will in the game.
writeFileSync(
  join(OUT, "index.html"),
  `<!doctype html><meta charset="utf-8"><title>Portraits · seed ${args.seed}</title>
<style>
  body { background: #e9e3d6; color: #22201c; font: 15px/1.45 Georgia, serif; margin: 24px; }
  h1 { font-size: 20px; }
  main { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 20px; }
  section { background: #f6f1e6; border: 1px solid #c9bfab; padding: 16px; }
  h2 { margin: 0 0 10px; font-size: 18px; }
  .full { display: block; width: 100%; aspect-ratio: 2 / 3; object-fit: contain; background: #fbf8f1; }
  .empty { display: flex; align-items: center; justify-content: center; color: #8a8170; font-style: italic; }
  .thumbs { display: flex; align-items: end; gap: 12px; margin-top: 12px; }
  .thumb { border: 1px solid #c9bfab; background: #fbf8f1; display: block; }
  figure { margin: 0; } figcaption { font: 10px monospace; color: #8a8170; }
  .person { font-style: italic; } .gear { font-size: 13px; color: #5c5547; }
  pre { white-space: pre-wrap; font-size: 11px; background: #fbf8f1; padding: 8px; }
  a { color: #a4431c; font-size: 12px; }
</style>
<h1>Portraits · seed ${args.seed}</h1>
<main>${cards.join("\n")}</main>
`
);
console.log(`\n${join(OUT, "index.html")}`);
