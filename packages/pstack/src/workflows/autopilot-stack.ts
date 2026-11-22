// Autopilot-stack: autopilot without the merge. Every node of the plan is carried to a verified pull request and the
// run stops there, handing the pull requests to the owner. A node that builds on another is stacked on it: built off
// its branch, its pull request based on it. Started with `restack`, the run instead carries the pull requests above a
// lower one onto its new head and prepares a publication handoff with exact head and base preconditions.

import { makeWorktree } from "@niwa-labs/flow-code";
import type { ScriptApi } from "@niwa-labs/script";
import type { output } from "zod";

import { countersign, supervisedDelivery } from "./lib/autopilot.ts";
import { gitOut } from "./lib/git.ts";
import { playbookInput } from "./lib/inputs.ts";
import { prHeadPipeline } from "./lib/lane.ts";
import type { Delivered } from "./lib/lane.ts";
import { currentPlan } from "./lib/go.ts";
import { pinPreparedHead } from "./lib/operations-restack.ts";
import { openNodes } from "./lib/plan.ts";
import { api, forgeRepo, roles } from "./lib/script.ts";
import { restack } from "./lib/trunk.ts";
import text from "./texts/autopilot-stack.json";

declare const workflow: ScriptApi["workflow"];
declare const z: ScriptApi["z"];
declare function phase(title: string): void;

const author = z.strictObject({ kind: z.literal("session"), harness: z.string(), id: z.string() });
const stackRow = z.strictObject({
  node: z.string(), pr: z.number().optional(), branch: z.string().optional(), base: z.string().optional(),
  head: z.string().optional(), worktree: z.string().optional(), verified: z.boolean(), author: author.optional(),
  blocked: z.string().optional(), gate: z.json().optional(),
});

export default workflow(
  {
    name: "pstack-autopilot-stack",
    description: "Carry a plan to verified, stacked pull requests",
    input: playbookInput().extend({
      plan: z.string().min(1).max(200).describe("The plan's subject in niwa"),
      restack: z
        .strictObject({
          lower: z.number().int().positive(),
          from: z.string().regex(/^[0-9a-f]{40}$/).describe("The lower head the upper pull requests were built on"),
          upper: z.array(z.strictObject({ number: z.number().int().positive(), author })).min(1),
        })
        .optional(),
    }),
    output: z.discriminatedUnion("status", [
      z.strictObject({
        status: z.enum(["verified", "unverified"]),
        nodes: z.array(stackRow),
      }),
      z.strictObject({
        status: z.literal("prepared"), worktree: z.string(), blocked: z.string(),
        prs: z.array(z.strictObject({
          pr: z.number(), expectHead: z.string(), head: z.string(), patchKept: z.boolean(), branch: z.string(),
          expectBase: z.string(), targetBase: z.string(), localRef: z.string(),
        })),
      }),
    ]),
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
      "pstack.pr.binding",
      "forge.pr.ensure@{repo.host}/{repo.path}/pr/*",
      "forge.pr.read@{repo.host}/{repo.path}",
      "forge.pipeline.read@{repo.host}/{repo.path}",
      "forge.checks.read@{repo.host}/{repo.path}",
      "evidence.attest",
      "evidence.covers",
      "evidence.list",
      "plan.get",
    ],
    phases: [
      { title: "Build", detail: "Each node to a verified pull request, stacked on the one it builds on" },
      { title: "Restack", detail: "The pull requests above a lower one carried onto its new head" },
    ],
  },
  async ({ task, repo, worktrees, base, plan: of, restack: moved }) => {
    if (moved !== undefined) {
      phase("Restack");
      const wt = await makeWorktree({ repo: repo.local, base, description: `restack above ${String(moved.lower)}` });
      const target = { host: repo.host, path: repo.path };
      const prepared = await restack("restack", {
        lower: { repo: target, number: moved.lower }, from: moved.from, cwd: wt.path, trunk: base,
        upper: moved.upper.map(({ number }) => ({ repo: target, number })),
      });
      const prs = [];
      for (const [index, one] of prepared.entries()) {
        const { binding } = await api().call("pstack.pr.binding", { repo: target, number: one.pr.number, head: one.before }, { label: `receipt-${index}` }) as {
          binding?: { author: output<typeof author>; worktree: { branch: string; repo: string } };
        };
        const expected = moved.upper[index]!.author;
        if (!binding || binding.author.harness !== expected.harness || binding.author.id !== expected.id ||
            binding.worktree.branch !== one.branch || binding.worktree.repo !== repo.local) {
          throw new Error(`PR ${one.pr.number} has no matching authoring receipt for this branch and head`);
        }
      }
      for (const { pr, before, branch, head, patchKept, expectBase, targetBase } of prepared) {
        const localRef = await pinPreparedHead(`pin-${pr.number}`, wt, pr.number, head);
        prs.push({ pr: pr.number, expectHead: before, branch, head, patchKept, expectBase, targetBase, localRef });
      }
      return { status: "prepared" as const, worktree: wt.path, prs, blocked: "Publication requires a branch lease and, when the base changes, a conditional forge retarget. No verified head has been published by this run." };
    }

    phase("Build");
    const seats = await roles();
    const plan = await currentPlan("plan", of);
    const nodes = openNodes(plan);
    const target = forgeRepo(repo);
    const current = async (key: string, delivered: Delivered, base: string) => {
      const params = { repo: target, number: delivered.pr.number };
      const pr = await api().call("forge.pr.read", params, { label: `${key}-pr` }) as { head: string; branch: string; base: string; autoMerge: boolean; state: string };
      if (pr.state !== "open" || pr.autoMerge || pr.head !== delivered.pr.head || pr.branch !== delivered.built.wt.branch || pr.base !== base) return false;
      const ci = await prHeadPipeline(`${key}-ci`, { repo, number: delivered.pr.number, sha: pr.head });
      return ci?.state === "success";
    };
    const done = new Map<string, Delivered>();
    const open = new Set(nodes.map(({ id }) => id));
    for (const node of nodes) {
      if (node.after.filter((id) => open.has(id)).length > 1) throw new Error("A stacked PR can have only one open parent: " + node.id);
    }
    const rows: Array<output<typeof stackRow>> = [];
    for (const node of nodes) {
      if ((await currentPlan(`dispatch-${node.id}-plan`, of)).rev !== plan.rev) {
        rows.push({ node: node.id, verified: false, blocked: "The stack plan changed before dispatch. Review the existing PRs against the current plan." });
        continue;
      }
      // A node stacks on the one it builds on: off its branch, based on it; the root of the stack on trunk.
      const lower = node.after.map((id) => done.get(id)).find((one) => one !== undefined);
      if (node.after.some(id => open.has(id) && !done.has(id))) {
        rows.push({ node: node.id, verified: false, blocked: "The parent is unverified." });
        continue;
      }
      const onto = lower === undefined ? base : lower.built.wt.branch;
      if (lower !== undefined) {
        const parent = rows.find(one => one.pr === lower.pr.number);
        if (!parent?.base || !await current(`parent-${node.id}`, lower, parent.base) ||
            await gitOut(`parent-${node.id}-local`, lower.built.wt.path, ["rev-parse", `refs/heads/${onto}`]) !== lower.pr.head) {
          rows.push({ node: node.id, verified: false, blocked: "The parent moved or lost exact-head CI. Refresh the parent's verdict before stacking." });
          continue;
        }
      }
      const opts = { playbook: text, repo, base: onto, worktrees, roles: seats, task: `${task}\n\nThis pull request: ${node.text}`, title: node.text.split("\n")[0]?.slice(0, 120) ?? node.id };
      const result = await supervisedDelivery(`node-${node.id}`, opts);
      if (!result.delivered) {
        rows.push({ node: node.id, verified: false, blocked: result.reason });
        continue;
      }
      const delivered = result.delivered;
      const gate = delivered.verified ? await countersign(`gate-${node.id}`, opts, delivered) : undefined;
      const verified = gate?.decision === "unchanged" || gate?.decision === "approved";
      if (verified) done.set(node.id, delivered);
      rows.push({
        node: node.id,
        pr: delivered.pr.number,
        branch: delivered.built.wt.branch,
        base: onto,
        head: delivered.pr.head,
        worktree: delivered.built.wt.path,
        verified,
        author: delivered.built.author,
        ...(gate === undefined ? {} : { gate }),
      });
    }
    const handoffPlan = await currentPlan("handoff-plan", of);
    for (const row of rows) {
      const delivered = done.get(row.node);
      const node = nodes.find(one => one.id === row.node)!;
      if (delivered && row.base && (handoffPlan.rev !== plan.rev ||
          node.after.some(id => open.has(id) && !done.has(id)) || !await current(`handoff-${row.node}`, delivered, row.base))) {
        done.delete(row.node);
        row.verified = false;
        row.blocked = handoffPlan.rev !== plan.rev ? "The stack plan changed before handoff."
          : "The PR or its parent no longer matches the verified stack at handoff.";
      }
    }
    return { status: rows.every((row) => row.verified) ? "verified" as const : "unverified" as const, nodes: rows };
  },
);
