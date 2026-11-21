// The entry: the lead reads the request, picks the playbook it needs, and the entry runs that playbook as a child
// run with the same repository. Its rights are given by target templates, filled from the repository it is started
// on, so a run of the entry merges, opens pull requests and runs commands only there.

import type { ScriptApi } from "@niwa-labs/script";

import { runBuiltin } from "./lib/catalog.ts";
import { repoSchema } from "./lib/inputs.ts";
import { api, roles, seatOptions, stepTag } from "./lib/script.ts";
import worker from "./texts/worker.json";

declare const workflow: ScriptApi["workflow"];
declare const z: ScriptApi["z"];
declare function phase(title: string): void;

/** The playbooks the lead may pick, with what each is for. */
const PLAYBOOKS = {
  investigation: "a read-only question about the code, answered with sources",
  "multi-phase-plan": "a change of several pull requests that needs a plan and the owner's go before anything is built",
  "autopilot-full": "carry out a plan the owner said go for, to merged pull requests",
  "autopilot-stack": "carry out a plan to verified pull requests without merging, stacked where one builds on another",
  shipping: "land a verified stack of pull requests",
} as const;

const NAMES = Object.keys(PLAYBOOKS) as [keyof typeof PLAYBOOKS, ...Array<keyof typeof PLAYBOOKS>];

const decision = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("run"),
    playbook: z.enum(NAMES),
    task: z.string().min(1).max(4000),
    more: z.record(z.string(), z.json()).default({}).describe("What else the playbook takes, by field: the plan's subject, a pull request's number"),
  }),
  z.strictObject({ kind: z.literal("finish"), summary: z.string().min(1).max(2000) }),
]);

export default workflow(
  {
    name: "pstack-entry",
    description: "Pick the playbook a request needs and run it",
    input: z.strictObject({
      request: z.string().min(1).max(4000),
      repo: repoSchema(),
      worktrees: z.string().min(1).describe("The real path of the folder niwa keeps its worktrees in, <home>/worktrees"),
      base: z.string().min(1).default("main"),
      pins: z.record(z.string(), z.string()).default({}).describe("Versions of the playbooks to run, by name: the suite tries a set this way"),
    }),
    output: z.discriminatedUnion("status", [
      z.strictObject({ status: z.literal("ran"), playbook: z.string(), result: z.json() }),
      z.strictObject({ status: z.literal("finished"), summary: z.string() }),
    ]),
    uses: [
      "forge.pr.merge@{repo.host}/{repo.path}/pr/*",
      "forge.pr.ensure@{repo.host}/{repo.path}/pr/*",
      "proc.run@{worktrees}/*",
      "git.*@{repo.local}",
      // The git module's actions carry no target, so the rule above cannot reach them: worktrees are named here.
      "git.worktree.create",
      "git.worktree.get",
      "git.worktree.list",
      "git.worktree.remove",
      "forge.pr.read@{repo.host}/{repo.path}",
      "forge.checks.read@{repo.host}/{repo.path}",
      "forge.pipeline.read@{repo.host}/{repo.path}",
      "forge.comment.read@{repo.host}/{repo.path}",
      "pstack.roles",
      "session.start.*",
      "session.start",
      "pstack.author.start",
      "session.ask",
      "request.ask",
      "workflow.list",
      "workflow.get",
      "workflow.start",
      "niwa.records.read",
      "evidence.attest",
      "evidence.covers",
      "evidence.list",
      "plan.set",
      "plan.get",
    ],
    phases: [
      { title: "Route", detail: "The lead picks the playbook" },
      { title: "Run", detail: "The playbook runs as a child of the entry" },
    ],
  },
  async ({ request, repo, worktrees, base, pins }) => {
    const seats = await roles();
    phase("Route");
    const picked = await api().agent(
      [
        stepTag("entry", "route"),
        "",
        worker.text.trim(),
        "",
        "You lead pstack. Pick the one playbook this request needs and restate the task for it, or finish with the reason none fits.",
        "Give in `more` what else the playbook takes that the request names, such as the subject of a plan.",
        "Do not do the work yourself.",
        "",
        ...Object.entries(PLAYBOOKS).map(([name, what]) => `- ${name}: ${what}`),
        "",
        `Request: ${request}`,
      ].join("\n"),
      { ...seatOptions(seats.lead), mode: "ask", cwd: repo.local, schema: decision, label: "route" },
    );
    if (picked.kind === "finish") return { status: "finished" as const, summary: picked.summary };
    phase("Run");
    const result = await runBuiltin("play", picked.playbook, { ...picked.more, task: picked.task, repo, worktrees, base }, pins);
    return { status: "ran" as const, playbook: picked.playbook, result: result as never };
  },
);
