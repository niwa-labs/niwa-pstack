// Shipping: land a verified stack, bottom up, one pull request at a time, each under the merge policy at its current
// head; the first one the policy refuses stops the rest, which wait on it.

import { makeWorktree, removeWorktree } from "@niwa-labs/flow-code";
import type { ScriptApi } from "@niwa-labs/script";
import type { output } from "zod";

import { isRefusal } from "./lib/catalog.ts";
import { gitRun } from "./lib/git.ts";
import { currentPlan } from "./lib/go.ts";
import { playbookInput } from "./lib/inputs.ts";
import { pinPreparedHead } from "./lib/operations-restack.ts";
import { api, forgeRepo } from "./lib/script.ts";
import { ship } from "./lib/ship.ts";
import type { Shipped } from "./lib/ship.ts";
import { restack } from "./lib/trunk.ts";

declare const workflow: ScriptApi["workflow"];
declare const z: ScriptApi["z"];
declare function phase(title: string): void;

type Pr = { state: string; branch: string; base: string; head: string; mergeSha?: string; autoMerge?: boolean };
const handoff = z.strictObject({
  pr: z.number(), reason: z.string(), worktree: z.string().optional(), localRef: z.string().optional(),
  head: z.string().optional(), expectedHead: z.string().optional(), expectedBase: z.string().optional(),
  targetBase: z.string().optional(), patchKept: z.boolean().optional(),
});

export default workflow(
  {
    name: "pstack-shipping",
    description: "Land a verified stack bottom up under the merge policy",
    input: playbookInput().extend({
      plan: z.string().min(1).max(200).describe("The plan whose nodes the pull requests deliver"),
      prs: z
        .array(
          z.strictObject({
            number: z.number().int().positive(),
            nodes: z.array(z.string().min(1)).min(1),
            author: z.strictObject({ kind: z.literal("session"), harness: z.string(), id: z.string() }).optional().describe("Optional assertion of the author in the lane receipt"),
          }),
        )
        .min(1)
        .describe("The stack, bottom first"),
      method: z.enum(["merge", "squash", "rebase"]).default("merge"),
    }),
    output: z.strictObject({ status: z.enum(["landed", "stopped"]), prs: z.array(z.json()), handoff: handoff.optional() }),
    uses: [
      "git.worktree.create",
      "git.worktree.get",
      "git.worktree.remove",
      "proc.run@{worktrees}/*",
      "pstack.pr.binding",
      "forge.pr.merge@{repo.host}/{repo.path}/pr/*",
      "forge.pr.read@{repo.host}/{repo.path}",
      "forge.pipeline.read@{repo.host}/{repo.path}",
      "evidence.attest",
      "evidence.covers",
      "evidence.list",
      "plan.get",
    ],
    phases: [{ title: "Land", detail: "Bottom up, one at a time" }],
  },
  async ({ repo, base, plan, prs, method }) => {
    phase("Land");
    if (new Set(prs.map(({ number }) => number)).size !== prs.length) throw new Error("Shipping needs distinct pull requests in bottom-up order.");
    const revision = await currentPlan("shipping-plan", plan);
    const target = forgeRepo(repo);
    const read = async (label: string, number: number) => await api().call("forge.pr.read", { repo: target, number }, { label }) as Pr;
    // A checkout to read the patches against trunk in: the pull requests' heads are in the local clone.
    const wt = await makeWorktree({ repo: repo.local, base, description: "Read the stack against trunk" });
    const done: Shipped[] = [];
    let next: output<typeof handoff> | undefined;
    let continued: { head: string; branch: string } | undefined;
    try {
      for (const [index, one] of prs.entries()) {
        const pr = await read(`preflight-${one.number}`, one.number);
        if (pr.autoMerge) {
          next = { pr: one.number, reason: "The forge already owns a queued landing. Wait for its result before continuing." };
          break;
        }
        if (continued && (pr.head !== continued.head || pr.branch !== continued.branch || pr.base !== base || pr.state !== "open" || pr.autoMerge)) {
          next = { pr: one.number, reason: "The next PR changed after the forge's retarget was confirmed." };
          break;
        }
        continued = undefined;
        const upper = prs[index + 1];
        const child = upper ? await read(`stack-child-${one.number}`, upper.number) : undefined;
        const landed = await ship(`pr-${one.number}`, { repo, number: one.number, author: one.author, plan, nodes: one.nodes,
          cwd: wt.path, method, trunk: base, expectHead: pr.head, expectPlan: revision.rev });
        if (landed.outcome !== "merged") {
          done.push(landed);
          break;
        }
        const confirmed = await read(`confirm-trunk-${one.number}`, one.number);
        if (confirmed.state !== "merged" || confirmed.head !== pr.head || confirmed.base !== base || confirmed.mergeSha !== landed.sha) {
          done.push({ outcome: "refused", pr: one.number, missing: [{ name: "merge", why: "Could not confirm the exact merge result into trunk." }] });
          break;
        }
        done.push(landed);
        if (!upper || !child || child.base !== pr.branch) continue;
        const fresh = await read(`after-parent-${upper.number}`, upper.number);
        if (fresh.state !== "open" || fresh.branch !== child.branch || fresh.head !== child.head || fresh.autoMerge || (fresh.base !== child.base && fresh.base !== base)) {
          next = { pr: upper.number, reason: "The next PR moved or queued while its parent was landing." };
          break;
        }
        const { binding } = await api().call("pstack.pr.binding", { repo: target, number: upper.number, head: child.head }, { label: `child-binding-${upper.number}` }) as {
          binding?: { author: typeof upper.author; worktree: { branch: string; repo: string } };
        };
        if (!binding || binding.worktree.branch !== fresh.branch || binding.worktree.repo !== repo.local ||
            (upper.author && (!binding.author || binding.author.id !== upper.author.id || binding.author.harness !== upper.author.harness))) {
          next = { pr: upper.number, reason: "The next PR has no matching authoring receipt for its current branch and head." };
          break;
        }
        // Some forges retarget the child themselves. If the old and new patch bases are identical,
        // the existing branch needs no publication. The next iteration still runs the full landing policy.
        if (fresh.base === base && landed.sha === pr.head &&
            (await gitRun(`child-ancestor-${upper.number}`, wt.path, ["merge-base", "--is-ancestor", landed.sha, fresh.head])).exit === 0) {
          continued = { head: fresh.head, branch: fresh.branch };
          continue;
        }
        try {
          const [prepared] = await restack(`after-${one.number}`, { lower: { repo: target, number: one.number }, from: pr.head,
            upper: [{ repo: target, number: upper.number }], cwd: wt.path, trunk: base });
          if (prepared && prepared.before === fresh.head && prepared.branch === fresh.branch) {
            const localRef = await pinPreparedHead(`pin-child-${upper.number}`, wt, upper.number, prepared.head);
            next = { pr: upper.number, worktree: wt.path, localRef, expectedHead: prepared.before, head: prepared.head,
              expectedBase: prepared.expectBase, targetBase: prepared.targetBase, patchKept: prepared.patchKept,
              reason: "The prepared patch needs lease-protected publication, conditional retarget if needed, and fresh head CI and verdict coverage before landing." };
          } else {
            next = { pr: upper.number, reason: "The next PR moved during local restack preparation." };
          }
        } catch (error) {
          if (!isRefusal(error)) throw error;
          next = { pr: upper.number, worktree: wt.path, expectedHead: fresh.head, expectedBase: fresh.base, targetBase: base,
            reason: `Local restack failed after the parent landed: ${(error as Error).message}` };
        }
        break;
      }
    } finally {
      if (next?.worktree === undefined) await removeWorktree(wt, true);
    }
    return { status: done.length === prs.length && done.every((one) => one.outcome === "merged") ? "landed" as const : "stopped" as const,
      prs: done.map(result => z.json().parse(result)), ...(next === undefined ? {} : { handoff: next }) };
  },
);
