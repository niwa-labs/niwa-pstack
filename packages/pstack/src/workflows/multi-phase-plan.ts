// Multi-phase plan: the lead writes the plan, a list of pull requests in landing order with what each depends on, as
// a revision of a plan in niwa; the owner's go is then asked for that revision and attested node by node. The plan is
// the deliverable: nothing is implemented. A change too small to plan is said to be so, and nothing is written.

import type { ScriptApi } from "@niwa-labs/script";

import { askGo } from "./lib/go.ts";
import { playbookInput } from "./lib/inputs.ts";
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
});
const written = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("plan"), goal: z.string().min(1).max(2000), nodes: z.array(node).min(1).max(30) }),
  z.strictObject({ kind: z.literal("skip"), why: z.string().min(1).max(2000) }),
]);

export default workflow(
  {
    name: "pstack-multi-phase-plan",
    description: "Write a plan of pull requests and ask the owner's go",
    input: playbookInput().extend({
      plan: z.string().min(1).max(200).describe("The plan's subject in niwa"),
      ask: z.boolean().default(true).describe("Ask the owner's go once the plan is written"),
    }),
    output: z.discriminatedUnion("status", [
      z.strictObject({ status: z.literal("planned"), plan: z.strictObject({ of: z.string(), rev: z.number() }), nodes: z.array(node), go: z.boolean() }),
      z.strictObject({ status: z.literal("skipped"), why: z.string() }),
    ]),
    uses: ["pstack.roles", "session.start.*", "plan.set", "request.ask", "evidence.attest"],
    phases: [
      { title: "Plan", detail: "The lead writes the pull requests in landing order" },
      { title: "Go", detail: "The owner's go on this revision, one attestation per node" },
    ],
  },
  async ({ task, repo, plan, ask }) => {
    const seats = await roles();
    phase("Plan");
    const wrote = await api().ask(
      { ...seatOptions(seats.lead), mode: "ask", cwd: repo.local, schema: written, label: "plan" },
      brief(stepTag("multi-phase-plan", "plan"), text, task, [
        "Answer the plan as nodes, one per pull request in landing order: an id, the one change it builds with its visible result and verification, the ids it waits for, and the files it may touch.",
        "When the change is one or two files with an obvious approach, answer skip with why.",
      ]),
    );
    if (wrote.kind === "skip") return { status: "skipped" as const, why: wrote.why };
    const ids = new Set(wrote.nodes.map((one) => one.id));
    for (const one of wrote.nodes) {
      const unknown = one.after.filter((id) => !ids.has(id) || id === one.id);
      if (unknown.length > 0) throw new Error(`the node ${one.id} waits for ${unknown.join(", ")}, which the plan does not hold before it`);
    }
    const set = (await api().call(
      "plan.set",
      {
        of: plan,
        goal: wrote.goal,
        items: wrote.nodes.map((one) => ({
          id: one.id,
          text: one.text,
          state: "open",
          ...(one.after.length + one.files.length === 0 ? {} : { note: [one.after.length > 0 ? `after ${one.after.join(", ")}` : "", one.files.length > 0 ? `files ${one.files.join(", ")}` : ""].filter(Boolean).join("; ") }),
        })),
      },
      { label: "set" },
    )) as { of: string; rev: number };
    const revision = { of: set.of, rev: set.rev };
    if (!ask) return { status: "planned" as const, plan: revision, nodes: wrote.nodes, go: false };
    phase("Go");
    const target = forgeRepo(repo);
    const go = await askGo("go", { plan: revision, nodes: wrote.nodes, change: `${target.host}/${target.path}` });
    return { status: "planned" as const, plan: revision, nodes: wrote.nodes, go };
  },
);
