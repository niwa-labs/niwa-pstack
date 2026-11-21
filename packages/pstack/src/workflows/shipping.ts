// Shipping: land a verified stack, bottom up, one pull request at a time, each under the merge policy at its current
// head; the first one the policy refuses stops the rest, which wait on it.

import { makeWorktree, removeWorktree } from "@niwa-labs/flow-code";
import type { ScriptApi } from "@niwa-labs/script";

import { playbookInput } from "./lib/inputs.ts";
import { ship } from "./lib/ship.ts";
import type { Shipped } from "./lib/ship.ts";

declare const workflow: ScriptApi["workflow"];
declare const z: ScriptApi["z"];
declare function phase(title: string): void;

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
    output: z.strictObject({ status: z.enum(["landed", "stopped"]), prs: z.array(z.json()) }),
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
    // A checkout to read the patches against trunk in: the pull requests' heads are in the local clone.
    const wt = await makeWorktree({ repo: repo.local, base, description: "Read the stack against trunk" });
    const done: Shipped[] = [];
    for (const one of prs) {
      const landed = await ship(`pr-${String(one.number)}`, { repo, number: one.number, author: one.author, plan, nodes: one.nodes, cwd: wt.path, method });
      done.push(landed);
      if (landed.outcome !== "merged") break;
    }
    await removeWorktree(wt, true);
    return { status: done.length === prs.length && done.every((one) => one.outcome === "merged") ? ("landed" as const) : ("stopped" as const), prs: done as never[] };
  },
);
