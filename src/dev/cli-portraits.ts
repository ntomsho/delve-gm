/**
 * CHARACTER PORTRAITS, WITHOUT THE GAME
 * =====================================
 *
 *   node src/dev/cli-portraits.ts                 # three characters, a random seed
 *   node src/dev/cli-portraits.ts --count 5       # more
 *   node src/dev/cli-portraits.ts --seed 4201     # the same three characters again
 *   node src/dev/cli-portraits.ts --dry           # roll them and write the prompts; draw nothing
 *
 * Rolls characters the way creation does, draws each one's portrait with the
 * prompt, model, references and crop the server uses, and writes a contact
 * sheet to out/portraits/<seed>/index.html: the whole figure, the
 * head-and-shoulders thumbnail at the sizes the screens show it, the sheet it
 * was drawn from, and the prompt.
 *
 * No database and no bucket: nothing is stored, counted or put on the spend
 * ledger. Needs FAL_KEY in the environment or .env.local. About $0.03 an image.
 *
 * The script is `lib/portraits.ts`; see `cli-sprites.ts` for why this file
 * only teaches Node `?raw` and imports it.
 */

import { registerRawMarkdown } from "./lib/raw-md.ts";

registerRawMarkdown();
await import("./lib/portraits.ts");
