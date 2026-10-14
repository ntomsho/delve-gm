/**
 * A WHOLE RUN, IN A TERMINAL — the way in.
 *
 *   node src/dev/cli-play.ts --seed 1005 --size 1
 *   node src/dev/cli-play.ts --offline                 # fixture everything, free
 *   node src/dev/cli-play.ts --seed 1005 --stub        # real dungeon, stub game master
 *   echo "I search the floor" | node src/dev/cli-play.ts --offline
 *
 * Ten lines rather than one file, because the playbook is imported as raw
 * markdown and Node has to be taught what that means BEFORE anything that
 * reaches the game master is imported — and a static import would be hoisted above
 * the teaching. See `raw-md.ts`. The actual CLI is `play.ts`.
 */

import { registerRawMarkdown } from "./lib/raw-md.ts";

registerRawMarkdown();
await import("./lib/play.ts");
