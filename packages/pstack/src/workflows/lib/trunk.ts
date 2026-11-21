/**
 * The script helpers that read what trunk did to a pull request, and carry a stack over a new lower head: git in a
 * checkout of the repository, and the pull requests as the forge reads them.
 */

import type { TrunkKind } from "../../trunk.ts";
import { stemsOf, trunkKind } from "../../trunk.ts";
import { gitOut, gitRun, linesOf } from "./git.ts";
import { api } from "./script.ts";

/** A pull request, as the helpers are given one. */
export interface PrRef {
  repo: { host: string; path: string };
  number: number;
}

/** A pull request as `forge.pr.read` answers it, as much as the helpers read. */
interface ReadPr {
  state: "open" | "merged" | "closed";
  branch: string;
  base: string;
  head: string;
  mergeSha?: string;
}

const readPr = async (key: string, pr: PrRef): Promise<ReadPr> =>
  (await api().call("forge.pr.read", { repo: { host: pr.repo.host, path: pr.repo.path }, number: pr.number }, { label: key })) as ReadPr;

/**
 * Whether trunk's changes since the pull request branched can affect it: its head as the forge has it, against `base`
 * (a branch or a commit) in the checkout `cwd`, which must hold both. A conflict is found by merging the two trees
 * without touching the checkout; a dependent is a file trunk changed that names a file of the patch.
 */
export async function trunkAffects(key: string, opts: { pr: PrRef; base: string; cwd: string }): Promise<{ kind: TrunkKind; files: string[] }> {
  const { head } = await readPr(`${key}-pr`, opts.pr);
  const fork = await gitOut(`${key}-fork`, opts.cwd, ["merge-base", opts.base, head]);
  const patch = linesOf(await gitOut(`${key}-patch`, opts.cwd, ["diff", "--name-only", fork, head]));
  const trunk = linesOf(await gitOut(`${key}-trunk`, opts.cwd, ["diff", "--name-only", fork, opts.base]));
  const merged = await gitRun(`${key}-merge`, opts.cwd, ["merge-tree", "--write-tree", "--name-only", "--no-messages", opts.base, head]);
  if (merged.exit !== 0 && merged.exit !== 1) throw new Error(`git merge-tree failed (${String(merged.exit)}): ${merged.out.trim().slice(-500)}`);
  // The first line is the tree; a merge that conflicts lists the files after it.
  const conflicts = merged.exit === 1 ? linesOf(merged.out).slice(1) : [];
  const stems = stemsOf(patch);
  const others = trunk.filter((file) => !patch.includes(file));
  let dependents: string[] = [];
  if (stems.length > 0 && others.length > 0) {
    const grep = await gitRun(`${key}-grep`, opts.cwd, ["grep", "-l", "-F", ...stems.flatMap((stem) => ["-e", stem]), opts.base, "--", ...others]);
    if (grep.exit !== 0 && grep.exit !== 1) throw new Error(`git grep failed (${String(grep.exit)}): ${grep.out.trim().slice(-500)}`);
    dependents = linesOf(grep.out).map((line) => line.slice(line.indexOf(":") + 1));
  }
  return trunkKind({ patch, trunk, conflicts, dependents });
}

/** The patch-id of a range: what stays the same when a patch is carried onto another base unchanged. */
async function patchId(key: string, cwd: string, from: string, to: string): Promise<string> {
  const hashed = (await api().call("proc.run", { cmd: ["sh", "-c", 'git diff --binary "$1" "$2" | git patch-id --stable', "patch-id", from, to], cwd, timeout: 60_000 }, { label: key })) as { exit: number; tail: string };
  if (hashed.exit !== 0) throw new Error(`git patch-id failed: ${hashed.tail.trim().slice(-500)}`);
  return hashed.tail.trim().split(/\s+/)[0] ?? "";
}

/**
 * Carry the pull requests stacked on `lower` onto its new head: each upper one is rebased in the checkout `cwd` from
 * `from`, the lower head it was built on, onto the lower head the forge has now (onto its target when it merged),
 * and answers its new head and whether its patch is the one it was (same patch-id), which keeps its verdicts. The
 * rebased commits are left in the checkout for their authors to publish; a rebase that conflicts is aborted and
 * throws.
 */
export async function restack(key: string, opts: { lower: PrRef; from: string; upper: PrRef[]; cwd: string }): Promise<Array<{ pr: PrRef; head: string; patchKept: boolean }>> {
  const lower = await readPr(`${key}-lower`, opts.lower);
  const onto = lower.state === "merged" ? await gitOut(`${key}-onto`, opts.cwd, ["rev-parse", lower.base]) : lower.head;
  const done: Array<{ pr: PrRef; head: string; patchKept: boolean }> = [];
  let base = { from: opts.from, onto };
  for (const [index, pr] of opts.upper.entries()) {
    const step = `${key}-${String(index)}`;
    const upper = await readPr(`${step}-pr`, pr);
    // Detached: the branch itself stays checked out in its author's worktree.
    await gitOut(`${step}-checkout`, opts.cwd, ["checkout", "-q", "--detach", upper.head]);
    const rebased = await gitRun(`${step}-rebase`, opts.cwd, ["rebase", "-q", "--onto", base.onto, base.from]);
    if (rebased.exit !== 0) {
      await gitRun(`${step}-abort`, opts.cwd, ["rebase", "--abort"]);
      throw new Error(`the pull request ${String(pr.number)} does not rebase onto ${base.onto}: ${rebased.out.trim().slice(-500)}`);
    }
    const head = await gitOut(`${step}-head`, opts.cwd, ["rev-parse", "HEAD"]);
    const before = await patchId(`${step}-before`, opts.cwd, base.from, upper.head);
    const after = await patchId(`${step}-after`, opts.cwd, base.onto, head);
    done.push({ pr, head, patchKept: before === after });
    // The next one up was built on this one's old head.
    base = { from: upper.head, onto: head };
  }
  return done;
}
