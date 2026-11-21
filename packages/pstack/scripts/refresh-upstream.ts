// Take a new snapshot of the upstream playbooks: `bun packages/pstack/scripts/refresh-upstream.ts <checkout>`, where
// the checkout is the `pstack` folder of a clone of cursor/plugins at the commit to take.

import { resolve } from "node:path";

import { refreshUpstream } from "../src/upstream.ts";

const [checkout] = process.argv.slice(2);
if (checkout === undefined) {
  console.error("usage: refresh-upstream <path to the pstack folder of a cursor/plugins checkout>");
  process.exit(2);
}
const source = refreshUpstream(resolve(checkout));
console.log(`snapshot taken at ${source.commit}`);
