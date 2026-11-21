// Autopilot-stack: autopilot without the merge. Every node of the plan is carried to a verified pull request and the
// run stops there, handing the pull requests to the owner. A node that builds on another is stacked on it: built off
// its branch, its pull request based on it. Started with `restack`, the run instead carries the pull requests above a
// lower one onto its new head; one whose patch the move left unchanged keeps the verdicts it had.

import { makeWorktree } from "@niwa-labs/flow-code";
import type { ScriptApi } from "@niwa-labs/script";

import { VERDICTS } from "../policy.ts";
import { playbookInput } from "./lib/inputs.ts";
import { deliver } from "./lib/lane.ts";
import type { Delivered } from "./lib/lane.ts";
import { currentPlan } from "./lib/go.ts";
import { openNodes } from "./lib/plan.ts";
import { api, prSubject, roles } from "./lib/script.ts";
import { restack } from "./lib/trunk.ts";
import text from "./texts/autopilot-stack.json";

declare const workflow: ScriptApi["workflow"];
declare const z: ScriptApi["z"];
declare function phase(title: string): void;

const author = z.strictObject({ kind: z.literal("session"), harness: z.string(), id: z.string() });

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
        status: z.literal("verified"),
        nodes: z.array(z.strictObject({ node: z.string(), pr: z.number(), branch: z.string(), base: z.string(), head: z.string(), worktree: z.string(), verified: z.boolean(), author })),
      }),
      z.strictObject({ status: z.literal("restacked"), prs: z.array(z.strictObject({ pr: z.number(), head: z.string(), patchKept: z.boolean(), carried: z.array(z.string()) })) }),
    ]),
    uses: [
      "pstack.roles",
      "session.start",
      "pstack.author.start",
      "box.net@{repo.host}",
      "session.ask",
      "git.worktree.create",
      "proc.run@{worktrees}/*",
      "forge.pr.ensure@{repo.host}/{repo.path}/pr/*",
      "forge.pr.read@{repo.host}/{repo.path}",
      "forge.pipeline.read@{repo.host}/{repo.path}",
      "evidence.attest",
      "evidence.covers",
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
      const carried = await restack("restack", { lower: { repo: target, number: moved.lower }, from: moved.from, upper: moved.upper.map((one) => ({ repo: target, number: one.number })), cwd: wt.path });
      const prs: Array<{ pr: number; head: string; patchKept: boolean; carried: string[] }> = [];
      for (const [index, one] of carried.entries()) {
        const upper = moved.upper[index];
        const kept: string[] = [];
        if (one.patchKept && upper !== undefined) {
          const subject = prSubject(repo, one.pr.number);
          const read = (await api().call("forge.pr.read", { repo: target, number: one.pr.number }, { label: `old-${String(index)}` })) as { head: string };
          for (const name of VERDICTS) {
            const had = (await api().call("evidence.covers", { requirement: { kind: "verdict", subject, name, sha: read.head, notBy: [upper.author] } }, { label: `had-${String(index)}-${name}` })) as { covered: boolean };
            if (!had.covered) continue;
            // The same patch on a new base: the verdict on it carries over to the new head.
            await api().call("evidence.attest", { subject, claim: { kind: "verdict", name, outcome: "pass", sha: one.head } }, { label: `carry-${String(index)}-${name}` });
            kept.push(name);
          }
        }
        prs.push({ pr: one.pr.number, head: one.head, patchKept: one.patchKept, carried: kept });
      }
      return { status: "restacked" as const, prs };
    }

    phase("Build");
    const seats = await roles();
    const plan = await currentPlan("plan", of);
    const nodes = openNodes(plan);
    const done: Record<string, Delivered> = {};
    const rows: Array<{ node: string; pr: number; branch: string; base: string; head: string; worktree: string; verified: boolean; author: { kind: "session"; harness: string; id: string } }> = [];
    for (const node of nodes) {
      // A node stacks on the one it builds on: off its branch, based on it; the root of the stack on trunk.
      const lower = node.after.map((id) => done[id]).find((one) => one !== undefined);
      const onto = lower === undefined ? base : lower.built.wt.branch;
      const delivered = await deliver(`node-${node.id}`, { playbook: text, repo, base: onto, worktrees, roles: seats, task: `${task}\n\nThis pull request: ${node.text}`, title: node.text.split("\n")[0]?.slice(0, 120) ?? node.id });
      done[node.id] = delivered;
      rows.push({
        node: node.id,
        pr: delivered.pr.number,
        branch: delivered.built.wt.branch,
        base: onto,
        head: delivered.pr.head,
        worktree: delivered.built.wt.path,
        verified: delivered.verified,
        author: delivered.built.author,
      });
    }
    return { status: "verified" as const, nodes: rows };
  },
);
