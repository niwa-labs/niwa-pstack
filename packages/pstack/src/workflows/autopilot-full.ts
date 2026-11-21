// Autopilot-full: one owner per node of a plan, in parallel off trunk, each carrying its pull request from build to
// verified; then each lands, one at a time in the plan's order, under the merge policy. A node with no go of the
// owner on the plan's current revision stops at verified: the grant covers only what the owner said go for.

import type { ScriptApi } from "@niwa-labs/script";

import { currentPlan, goFound } from "./lib/go.ts";
import { playbookInput } from "./lib/inputs.ts";
import { deliver } from "./lib/lane.ts";
import type { Delivered } from "./lib/lane.ts";
import { openNodes } from "./lib/plan.ts";
import { api, forgeRepo, roles } from "./lib/script.ts";
import { ship } from "./lib/ship.ts";
import type { Shipped } from "./lib/ship.ts";
import text from "./texts/autopilot-full.json";

declare const workflow: ScriptApi["workflow"];
declare const z: ScriptApi["z"];
declare function phase(title: string): void;

export default workflow(
  {
    name: "pstack-autopilot-full",
    description: "Carry a plan with the go to merged pull requests",
    input: playbookInput().extend({
      plan: z.string().min(1).max(200).describe("The plan's subject in niwa"),
      method: z.enum(["merge", "squash", "rebase"]).default("merge"),
    }),
    output: z.strictObject({
      status: z.literal("done"),
      nodes: z.array(z.strictObject({ node: z.string(), pr: z.number().optional(), head: z.string().optional(), verified: z.boolean(), go: z.boolean(), landed: z.json().optional() })),
    }),
    uses: [
      "pstack.roles",
      "session.start",
      "pstack.author.start",
      "session.ask",
      "git.worktree.create",
      "proc.run@{worktrees}/*",
      "forge.pr.ensure@{repo.host}/{repo.path}/pr/*",
      "forge.pr.merge@{repo.host}/{repo.path}/pr/*",
      "forge.pr.read@{repo.host}/{repo.path}",
      "forge.pipeline.read@{repo.host}/{repo.path}",
      "evidence.attest",
      "evidence.covers",
      "evidence.list",
      "plan.get",
    ],
    phases: [
      { title: "Gates", detail: "Which nodes the owner's go covers" },
      { title: "Build", detail: "One owner per node, in parallel off trunk" },
      { title: "Land", detail: "Each verified node lands under the merge policy" },
    ],
  },
  async ({ task, repo, worktrees, base, plan: of, method }) => {
    const seats = await roles();
    const target = forgeRepo(repo);
    const change = `${target.host}/${target.path}`;
    phase("Gates");
    const plan = await currentPlan("plan", of);
    const nodes = openNodes(plan);
    const goes = await goFound("go", { plan, nodes: nodes.map((one) => one.id), change });

    phase("Build");
    const lane = { playbook: text, repo, base, worktrees, roles: seats };
    const delivered = await api().parallel(
      Object.fromEntries(
        nodes.map((node) => [node.id, () => deliver(`node-${node.id}`, { ...lane, task: `${task}\n\nThis pull request: ${node.text}`, title: node.text.split("\n")[0]?.slice(0, 120) ?? node.id })]),
      ) as Record<string, () => Promise<Delivered>>,
    );

    phase("Land");
    const rows: Array<{ node: string; pr?: number; head?: string; verified: boolean; go: boolean; landed?: Shipped }> = [];
    for (const [index, node] of nodes.entries()) {
      const done = delivered[node.id] as Delivered;
      const go = goes[index]?.covered === true;
      if (!done.verified || !go) {
        rows.push({ node: node.id, pr: done.pr.number, head: done.pr.head, verified: done.verified, go });
        continue;
      }
      const landed = await ship(`land-${node.id}`, { repo, number: done.pr.number, author: done.built.author, plan: of, nodes: [node.id], base, cwd: done.built.wt.path, method });
      rows.push({ node: node.id, pr: done.pr.number, head: done.pr.head, verified: true, go, landed });
    }
    return { status: "done" as const, nodes: rows.map((row) => ({ ...row, ...(row.landed === undefined ? {} : { landed: row.landed as never }) })) };
  },
);
