// Autopilot-full: independent nodes build in parallel off trunk. Landing follows plan order and requires a current go.

import type { ScriptApi } from "@niwa-labs/script";
import type { output } from "zod";

import { countersign, supervisedDelivery } from "./lib/autopilot.ts";
import { gitRun } from "./lib/git.ts";
import { currentPlan, goFound } from "./lib/go.ts";
import { playbookInput } from "./lib/inputs.ts";
import { openNodes } from "./lib/plan.ts";
import { api, forgeRepo, roles } from "./lib/script.ts";
import { ship } from "./lib/ship.ts";
import type { Shipped } from "./lib/ship.ts";
import text from "./texts/autopilot-full.json";

declare const workflow: ScriptApi["workflow"];
declare const z: ScriptApi["z"];
declare const record: ScriptApi["record"];
declare function phase(title: string): void;

const row = z.strictObject({
  node: z.string(), pr: z.number().optional(), head: z.string().optional(), verified: z.boolean(), go: z.boolean(),
  worktree: z.string().optional(), branch: z.string().optional(), revision: z.number(),
  blocked: z.string().optional(), gate: z.json().optional(), landed: z.json().optional(),
});
const Checkpoint = record("node", row.extend({ plan: z.string(), project: z.string() }));

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
      nodes: z.array(row),
    }),
    uses: [
      "pstack.roles",
      "session.start.*",
      "pstack.author.options",
      "box.net@{repo.host}",
      "session.ask",
      "session.end",
      "request.ask",
      "git.worktree.create",
      "proc.run@{worktrees}/*",
      "pstack.pr.bind",
      "forge.pr.ensure@{repo.host}/{repo.path}/pr/*",
      "pstack.pr.binding",
      "forge.pr.merge@{repo.host}/{repo.path}/pr/*",
      "forge.pr.read@{repo.host}/{repo.path}",
      "forge.pipeline.read@{repo.host}/{repo.path}",
      "forge.checks.read@{repo.host}/{repo.path}",
      "evidence.attest",
      "evidence.covers",
      "evidence.list",
      "plan.get",
    ],
    emits: [Checkpoint],
    phases: [
      { title: "Gates", detail: "Which nodes the owner's go covers" },
      { title: "Build", detail: "Independent nodes build in parallel off trunk" },
      { title: "Land", detail: "Each verified node lands under the merge policy" },
    ],
  },
  async ({ task, repo, worktrees, base, plan: of, method }) => {
    const seats = await roles();
    const target = forgeRepo(repo);
    const change = `${target.host}/${target.path}`;
    phase("Gates");
    let plan = await currentPlan("plan", of);
    let nodes = openNodes(plan);
    const known = new Set(nodes.map(({ id }) => id));
    const rows = new Map<string, output<typeof row>>();
    const checkpoint = async (item: output<typeof row>) => {
      rows.set(item.node, item);
      await api().emit(Checkpoint, { ...item, plan: of, project: change }, { label: `checkpoint-${item.node}` });
    };
    const merged = new Map<string, { sha: string; cwd: string; text: string; note?: string }>();
    const lane = { playbook: text, repo, base, worktrees, roles: seats };
    let nodeGo = new Map<string, boolean>();
    for (let wave = 0; ; wave++) {
      if (wave > 0) {
        const latest = await currentPlan(`wave-${wave}-plan`, of);
        if (latest.rev !== plan.rev) {
          api().log(`Plan ${of} changed from revision ${plan.rev} to ${latest.rev}. Re-evaluating undispatched nodes with the current owner go.`);
          plan = latest;
          nodes = openNodes(plan);
          for (const node of nodes) known.add(node.id);
          for (const [id, landed] of merged) {
            const item = plan.items.find(item => item.id === id);
            if (item && (item.text !== landed.text || item.note !== landed.note)) merged.delete(id);
          }
        }
      }
      const pending = nodes.filter(node => !rows.has(node.id));
      if (pending.length === 0) break;
      const goes = await goFound(`wave-${wave}-go`, { plan, nodes: pending.map(({ id }) => id), change });
      nodeGo = new Map(pending.map(({ id }, index) => [id, goes[index]?.covered === true]));
      const ready = [];
      for (const node of pending) {
        const prerequisites = node.after.filter(id => known.has(id));
        if (prerequisites.some(id => !merged.has(id))) continue;
        const onTrunk = await Promise.all(prerequisites.map(async id => {
          const { sha, cwd } = merged.get(id)!;
          return (await gitRun(`trunk-${node.id}-${id}`, cwd, ["merge-base", "--is-ancestor", sha, base])).exit === 0;
        }));
        if (onTrunk.every(Boolean)) ready.push(node);
      }
      if (ready.length === 0) break;

      phase("Build");
      const deliveries = await api().parallel(Object.fromEntries(ready.map(node => {
        const opts = { ...lane, task: `${task}\n\nThis pull request: ${node.text}`, title: node.text.split("\n")[0]?.slice(0, 120) ?? node.id };
        return [node.id, async () => ({ opts, result: await supervisedDelivery(`node-${node.id}`, opts) })];
      })));

      phase("Land");
      for (const node of ready) {
        const go = nodeGo.get(node.id) === true;
        const delivery = deliveries[node.id]!;
        const done = delivery.result.delivered;
        if (!done) {
          await checkpoint({ node: node.id, revision: plan.rev, verified: false, go, blocked: delivery.result.reason });
          continue;
        }
        const result = { node: node.id, revision: plan.rev, pr: done.pr.number, head: done.pr.head,
          worktree: done.built.wt.path, branch: done.built.wt.branch, verified: done.verified, go };
        if (!done.verified) {
          await checkpoint(result);
          continue;
        }
        const gate = await countersign(`gate-${node.id}`, delivery.opts, done);
        if (gate.decision === "blocked" || gate.decision === "declined") {
          await checkpoint({ ...result, verified: false, gate });
          continue;
        }
        const landed: Shipped | undefined = go ? await ship(`land-${node.id}`, {
          repo, number: done.pr.number, author: done.built.author, plan: of, nodes: [node.id], cwd: done.built.wt.path,
          method, trunk: base, expectHead: done.pr.head, expectPlan: plan.rev,
        }) : undefined;
        if (landed?.outcome === "merged") {
          const note = plan.items.find(item => item.id === node.id)?.note;
          merged.set(node.id, { sha: landed.sha, cwd: done.built.wt.path, text: node.text, ...(note === undefined ? {} : { note }) });
        }
        await checkpoint({ ...result, gate, ...(landed === undefined ? {} : { landed: z.json().parse(landed) }) });
      }
    }
    return { status: "done" as const, nodes: [...known].map(id => {
      const observed = rows.get(id);
      if (observed) return observed;
      const node = nodes.find(node => node.id === id);
      return { node: id, revision: plan.rev, verified: false, go: node !== undefined && nodeGo.get(id) === true,
        blocked: !node ? "The current plan no longer queues this node."
          : node.after.some(parent => known.has(parent) && !merged.has(parent)) ? "Waiting for a prerequisite to land."
          : `The local ${base} does not contain a prerequisite's observed merge commit.` };
    }) };
  },
);
