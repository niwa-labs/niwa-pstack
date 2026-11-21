// Measure the mapping of the upstream snapshot: `bun packages/pstack/scripts/upstream-map.ts <command>`.
//
//   check    [--upstream <checkout>] [--head <rev> | --worktree] [--map <file>] [--out <file>] [--summary]
//            validate the mapping, report coverage of the upstream text, and what became of each entry's ranges since
//            the commits they were recorded at. Draws no conclusion. `--out` writes the whole report as JSON;
//            `--summary` prints one line of JSON numbers instead of the text. A map that cannot be read at all is one
//            problem, said in the same form. It also holds the texts the scripts import to the map, counted apart (`textProblems`):
//            the exit is 1 whenever the map or a text has a problem.
//   advance  [--upstream <checkout>] [--head <rev>]   record the unchanged entries at the current commits
//   accept   <id>... [--upstream <checkout>] [--head <rev>]   record the named entries at the carried positions
//   assemble [--check]   write the texts the scripts import from the mapping; with `--check`, only compare them
//   refresh  <checkout> [<commit>]   take a new snapshot of an upstream checkout, at a commit of it
//
// `--upstream` is needed only when the mapping has ranges at an upstream commit other than the snapshot's.

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { Git, WORKTREE, differingTexts, formatReport, openMap, recordMap, summaryOf, unreadable, writeAssembled } from "../src/mapping/index.ts";
import type { ToolContext } from "../src/mapping/index.ts";
import { PACKAGE_DIR, PACKAGE_PATHS, refreshUpstream } from "../src/upstream.ts";

const [command, ...rest] = process.argv.slice(2);

/** The value of a flag, and the arguments that are not flags. */
function parse(args: readonly string[], valued: readonly string[]): { flags: Map<string, string | true>; words: string[] } {
  const flags = new Map<string, string | true>();
  const words: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (!arg.startsWith("--")) words.push(arg);
    else if (valued.includes(arg)) flags.set(arg, args[(i += 1)] ?? "");
    else flags.set(arg, true);
  }
  return { flags, words };
}

const usage = (): never => {
  console.error("usage: upstream-map check|advance|accept|assemble|refresh (see the head of this file)");
  process.exit(2);
};

const { flags, words } = parse(rest, ["--upstream", "--head", "--out", "--map"]);
const text = (flag: string): string | undefined => {
  const value = flags.get(flag);
  return typeof value === "string" ? value : undefined;
};
const context = (): ToolContext => ({
  paths: PACKAGE_PATHS,
  root: new Git(PACKAGE_DIR).out(["rev-parse", "--show-toplevel"]).trim(),
  ...(text("--upstream") === undefined ? {} : { checkout: text("--upstream") as string }),
  head: flags.has("--worktree") ? WORKTREE : (text("--head") ?? "HEAD"),
  ...(text("--map") === undefined ? {} : { map: text("--map") as string }),
});

if (command === "check") {
  const out = text("--out");
  let opened: ReturnType<typeof openMap>;
  try {
    opened = openMap(context());
  } catch (error) {
    // A map that cannot be read at all (bad JSON, a schema error, a commit that is not there) is a problem of the
    // map, said as one: whoever reads the numbers gets a line to act on, not a crash.
    const said = unreadable(error);
    if (out !== undefined) writeFileSync(resolve(out), `${JSON.stringify({ error: said.error }, null, 2)}\n`);
    console.log(flags.has("--summary") ? JSON.stringify(said) : `PROBLEMS 1\n  the map could not be read: ${said.error}`);
    process.exit(1);
  }
  const { report } = opened;
  if (out !== undefined) writeFileSync(resolve(out), `${JSON.stringify(report, null, 2)}\n`);
  console.log(flags.has("--summary") ? JSON.stringify(summaryOf(report)) : formatReport(report));
  process.exit(report.problems.length === 0 && report.texts.length === 0 ? 0 : 1);
} else if (command === "advance" || command === "accept") {
  const changed = recordMap(context(), command === "advance" ? "unchanged" : words);
  console.log(`${command === "advance" ? "advanced" : "accepted"}: ${String(changed)} entries recorded`);
} else if (command === "assemble") {
  if (flags.has("--check")) {
    const wrong = differingTexts(context());
    if (wrong.length > 0) {
      console.error(`these texts differ from the mapping: ${wrong.join(", ")}`);
      process.exit(1);
    }
    console.log("the texts match the mapping");
  } else console.log(`${String(writeAssembled(context()))} texts written`);
} else if (command === "refresh") {
  const [checkout, commit] = words;
  if (checkout === undefined) usage();
  const source = refreshUpstream(resolve(checkout as string), commit === undefined ? {} : { commit });
  console.log(`snapshot taken at ${source.commit}`);
} else usage();
