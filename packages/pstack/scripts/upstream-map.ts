// Measure the mapping of the upstream snapshot: `bun packages/pstack/scripts/upstream-map.ts <command>`.
//
//   check    [--upstream <checkout>] [--head <rev> | --worktree] [--out <file>] [--summary]
//            validate the mapping, report coverage of the upstream text, and what became of each entry's ranges since
//            the commits they were recorded at. Draws no conclusion. `--out` writes the whole report as JSON;
//            `--summary` prints one line of JSON numbers instead of the text.
//   advance  [--upstream <checkout>] [--head <rev>]   record the unchanged entries at the current commits
//   accept   <id>... [--upstream <checkout>] [--head <rev>]   record the named entries at the carried positions
//   assemble [--check]   write the texts the scripts import from the mapping; with `--check`, only compare them
//   refresh  <checkout> [<commit>]   take a new snapshot of an upstream checkout, at a commit of it
//
// `--upstream` is needed only when the mapping has ranges at an upstream commit other than the snapshot's.

import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { Git, OursTexts, UpstreamTexts, WORKTREE, accept, advance, analyze, assemble, formatMapping, formatReport, jsonOf, parseMapping, summaryOf, writeTexts } from "../src/mapping/index.ts";
import { MAPPING_FILE, PACKAGE_DIR, TEXTS_DIR, UPSTREAM_DIR, refreshUpstream } from "../src/upstream.ts";

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

const { flags, words } = parse(rest, ["--upstream", "--head", "--out"]);
const text = (flag: string): string | undefined => {
  const value = flags.get(flag);
  return typeof value === "string" ? value : undefined;
};
const repoRoot = new Git(PACKAGE_DIR).out(["rev-parse", "--show-toplevel"]).trim();
const open = () => {
  const upstreamCheckout = text("--upstream");
  const upstream = new UpstreamTexts(UPSTREAM_DIR, upstreamCheckout === undefined ? undefined : resolve(upstreamCheckout));
  const ours = new OursTexts(repoRoot, flags.has("--worktree") ? WORKTREE : (text("--head") ?? "HEAD"));
  const mapping = parseMapping(readFileSync(MAPPING_FILE, "utf8"));
  return { upstream, ours, mapping, report: analyze(mapping, upstream, ours) };
};

if (command === "check") {
  const { report } = open();
  const out = text("--out");
  if (out !== undefined) writeFileSync(resolve(out), `${JSON.stringify(report, null, 2)}\n`);
  console.log(flags.has("--summary") ? JSON.stringify(summaryOf(report)) : formatReport(report));
  process.exit(report.problems.length === 0 ? 0 : 1);
} else if (command === "advance" || command === "accept") {
  const { mapping, report } = open();
  if (report.problems.length > 0) throw new Error(`the mapping has ${String(report.problems.length)} problems: run check`);
  const next = command === "advance" ? advance(mapping, report) : accept(mapping, report, words);
  writeFileSync(MAPPING_FILE, formatMapping(next));
  console.log(`${command === "advance" ? "advanced" : "accepted"}: ${String(next.entries.filter((one, index) => JSON.stringify(one) !== JSON.stringify(mapping.entries[index])).length)} entries recorded`);
} else if (command === "assemble") {
  const { mapping, upstream, ours } = open();
  const made = assemble(mapping, upstream, ours);
  if (flags.has("--check")) {
    const wrong = made.filter((one) => {
      try {
        return readFileSync(join(TEXTS_DIR, `${one.name}.json`), "utf8") !== jsonOf(one);
      } catch {
        return true;
      }
    });
    if (wrong.length > 0) {
      console.error(`these texts differ from the mapping: ${wrong.map((one) => one.name).join(", ")}`);
      process.exit(1);
    }
    console.log(`${String(made.length)} texts match the mapping`);
  } else {
    writeTexts(made, TEXTS_DIR);
    console.log(`${String(made.length)} texts written`);
  }
} else if (command === "refresh") {
  const [checkout, commit] = words;
  if (checkout === undefined) usage();
  const source = refreshUpstream(resolve(checkout as string), commit === undefined ? {} : { commit });
  console.log(`snapshot taken at ${source.commit}`);
} else usage();

