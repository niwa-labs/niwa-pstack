import { gitOut } from "./git.ts";
import { headCi, verify } from "./lane.ts";
import type { Delivered, deliver } from "./lane.ts";
import { api, forgeRepo, prSubject } from "./script.ts";

type Delivery = Parameters<typeof deliver>[1];
type Progress = Parameters<NonNullable<Delivery["progress"]>>[0];

/** Recover verification of an already-published lane. There is no new author or PR write. */
export async function recoverPublishedLane(key: string, opts: Delivery, { wt, pr }: Progress): Promise<Delivered | undefined> {
  if (!pr) return;
  const target = { repo: forgeRepo(opts.repo), number: pr.number };
  const current = async (label: string) => {
    const read = await api().call("forge.pr.read", target, { label }) as {
      head: string; branch: string; base: string; state: string; autoMerge?: boolean;
    };
    return read.state === "open" && !read.autoMerge && read.head === pr.head && read.branch === wt.branch && read.base === opts.base;
  };
  if (!await current(`${key}-pr`)) return;
  const { binding } = await api().call("pstack.pr.binding", { ...target, head: pr.head }, { label: `${key}-binding` }) as {
    binding?: { author: Delivered["built"]["author"]; worktree: { id: string; path: string; repo: string; branch: string } };
  };
  if (!binding || binding.worktree.id !== wt.id || binding.worktree.path !== wt.path ||
      binding.worktree.repo !== opts.repo.local || binding.worktree.branch !== wt.branch) return;
  if (await gitOut(`${key}-head`, wt.path, ["rev-parse", "HEAD"]) !== pr.head ||
      await gitOut(`${key}-status`, wt.path, ["status", "--porcelain"]) !== "") return;
  api().log(`Recovering independent verification for PR ${pr.number} at ${pr.head} in ${wt.path}`);
  const subject = prSubject(opts.repo, pr.number);
  const verdicts = await verify(`${key}-verify`, {
    ...opts, extra: opts.verification ?? [], subject, sha: pr.head, cwd: wt.path, author: binding.author,
  });
  const ci = await headCi(`${key}-ci`, { repo: opts.repo, number: pr.number, subject, sha: pr.head, deadline: "1h" });
  return {
    built: { wt, author: binding.author, sha: pr.head, summary: "Recovered verification from the bound published commit." },
    pr: { ...pr, subject },
    verdicts, ci,
    verified: verdicts.every(verdict => verdict.covered) && ci.outcome === "green" && await current(`${key}-confirm`),
  };
}
