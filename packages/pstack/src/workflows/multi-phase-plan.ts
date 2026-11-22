// Multi-phase plan: the lead writes the plan, a list of pull requests in landing order with what each depends on, as
// a revision of a plan in niwa; the owner's go is then asked for that revision and attested node by node. The plan is
// the deliverable: nothing is implemented. A change too small to plan is said to be so, and nothing is written.

import type { ScriptApi } from "@niwa-labs/script";

import { runBuiltin } from "./lib/catalog.ts";
import { askGo } from "./lib/go.ts";
import { playbookInput } from "./lib/inputs.ts";
import { INTERACTION_REVIEW } from "./lib/plan.ts";
import { api, forgeRepo, roles, seatOptions, stepTag } from "./lib/script.ts";
import { brief } from "./lib/texts.ts";
import text from "./texts/multi-phase-plan.json";

declare const workflow: ScriptApi["workflow"];
declare const z: ScriptApi["z"];
declare function phase(title: string): void;

const node = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,40}$/),
  text: z.string().min(1).max(2000),
  after: z.array(z.string()).max(20).default([]),
  files: z.array(z.string()).max(50).default([]),
  interaction: z.string().trim().min(1).max(1200).optional(),
  verification: z.strictObject({
    unit: z.string().min(1),
    live: z.strictObject({ scenario: z.string().min(1), pass: z.string().min(1) }),
    perf: z.strictObject({ metric: z.string().min(1), probe: z.string().min(1), trunk: z.string().min(1), fail: z.string().min(1) }),
  }).optional(),
});
const written = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("plan"), goal: z.string().min(1).max(2000), nodes: z.array(node).min(1).max(30) }),
  z.strictObject({ kind: z.literal("skip"), why: z.string().min(1).max(2000) }),
  z.strictObject({ kind: z.literal("prototype"), question: z.string().trim().min(1).max(2000) }),
  z.strictObject({ kind: z.literal("preference"), question: z.string().trim().min(1).max(2000) }),
]);

export default workflow(
  {
    name: "pstack-multi-phase-plan",
    description: "Write a plan of pull requests and ask the owner's go",
    input: playbookInput().extend({
      plan: z.string().min(1).max(200).describe("The plan's subject in niwa"),
      ask: z.boolean().default(true).describe("Ask the owner's go once the plan is written"),
      reviewInteractions: z.boolean().default(false).describe("Offer a review of planned interactions before asking for go"),
    }),
    output: z.discriminatedUnion("status", [
      z.strictObject({ status: z.literal("planned"), plan: z.strictObject({ of: z.string(), rev: z.number() }), nodes: z.array(node), go: z.boolean() }),
      z.strictObject({ status: z.literal("skipped"), why: z.string() }),
    ]),
    uses: [
      "pstack.roles", "session.start.*", "plan.set", "request.ask", "evidence.attest",
      "workflow.list", "workflow.start", "session.ask", "session.end", "pstack.author.options",
      "git.worktree.create", "proc.run@{worktrees}/*",
    ],
    phases: [
      { title: "Plan", detail: "The lead writes the pull requests in landing order" },
      { title: "Go", detail: "The owner can review interactions and give go on this revision" },
    ],
  },
  async ({ task, repo, worktrees, base, plan, ask, reviewInteractions }) => {
    const seats = await roles();
    phase("Plan");
    const context: string[] = [];
    for (let attempt = 1; ; attempt++) {
      const result = await api().scope("plan-revision-" + attempt, undefined, async () => {
        phase("Plan");
        const wrote = await api().ask(
          { ...seatOptions(seats.lead), mode: "ask", cwd: repo.local, schema: written, label: "plan" },
          brief(stepTag("multi-phase-plan", "plan"), text, task, [
            "Answer the plan as nodes, one per pull request in landing order: an id, the one change it builds with its visible result and verification, the ids it waits for, and the files it may touch.",
            "When the change is one or two files with an obvious approach, answer skip with why.",
            "If an open question can be settled by a prototype, return prototype before writing the plan. Use preference only for a product choice a run cannot settle.",
            "For each PR name unit checks, a live scenario and pass predicate, and the performance metric, probe, trunk baseline and failing threshold. Describe changed interactions that need the operator before merge.",
            ...context,
          ]),
        );
        if (wrote.kind === "skip") return { status: "skipped" as const, why: wrote.why };
        if (wrote.kind === "prototype") {
          const artifact = await runBuiltin("prototype", "prototype", { task: wrote.question, repo, worktrees, base, handoff: false });
          return { context: "Prototype decision and evidence: " + JSON.stringify(artifact) };
        }
        if (wrote.kind === "preference") {
          if (!ask) return { status: "skipped" as const, why: wrote.question };
          const preference = await api().ask.text(wrote.question, { label: "preference" });
          return { context: "Owner product decision: " + preference };
        }
        const ids = new Set<string>();
        for (const one of wrote.nodes) {
          if (ids.has(one.id)) throw new Error("Duplicate plan node: " + one.id);
          const unknown = one.after.filter((id) => !ids.has(id));
          if (unknown.length > 0) throw new Error(`the node ${one.id} waits for ${unknown.join(", ")}, which the plan does not hold before it`);
          ids.add(one.id);
        }
        const missing = wrote.nodes.filter((one) => one.verification === undefined).map((one) => one.id);
        if (missing.length > 0) throw new Error("The plan is missing unit, live or performance verification for " + missing.join(", "));
        const items = wrote.nodes.map((one) => ({
          id: one.id,
          text: planItem(one),
          state: "open",
          note: [
            one.after.length > 0 ? `after ${one.after.join(", ")}` : `independent, branch from ${base}`,
            one.files.length > 0 ? `files ${one.files.join(", ")}` : "",
          ].filter(Boolean).join("; "),
        }));
        const set = await api().call("plan.set", { of: plan, goal: wrote.goal, items }, { label: "set" }) as { of: string; rev: number };
        const revision = { of: set.of, rev: set.rev };
        const planned = { status: "planned" as const, plan: revision, nodes: wrote.nodes, go: false };
        if (!ask) return planned;
        phase("Go");
        for (const one of reviewInteractions ? wrote.nodes : []) {
          if (one.interaction === undefined) continue;
          const decision = await api().ask.choice(
            `Review the planned interaction for ${one.id} in revision ${revision.rev}. The live change still needs review before merge.\n\n${planItem(one)}`,
            ["accept", "edit", "stop"], { label: "interaction-" + one.id },
          );
          if (decision === "stop") return planned;
          if (decision === "edit") {
            const feedback = await api().ask.text("What should change in " + one.id + "?", { label: "edit-" + one.id });
            return { context: JSON.stringify({ revision, previous: wrote, node: one.id, feedback }) };
          }
        }
        const target = forgeRepo(repo);
        const go = await askGo("go", { plan: revision, nodes: items, change: `${target.host}/${target.path}` });
        return { ...planned, go };
      });
      if (result.status !== undefined) return result;
      context.push(result.context);
    }
  },
);

function planItem(one: import("zod").z.output<typeof node>) {
  const { interaction, verification } = one;
  return [
    one.text,
    ...(verification === undefined ? [] : [
      `- [ ] Unit: ${verification.unit}`,
      `- [ ] Live: ${verification.live.scenario}. Pass: ${verification.live.pass}`,
      `- [ ] Perf: ${verification.perf.metric}. Probe: ${verification.perf.probe}. Measure trunk first: ${verification.perf.trunk}. Fail: ${verification.perf.fail}`,
    ]),
    ...(interaction === undefined ? [] : [INTERACTION_REVIEW + interaction]),
  ].join("\n");
}
