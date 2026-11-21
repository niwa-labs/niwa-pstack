// The suite: before the host runs a new version of pstack's entry or playbooks, it runs the scenarios on the
// candidates, each started by its version, and promotes the whole set in one action when every scenario passes.
// The playbooks the entry starts are pinned to the set under trial, so the set is tried as it will run.

import type { ScriptApi } from "@niwa-labs/script";

import { isRefusal, registered, tryVersion } from "./lib/catalog.ts";
import { repoSchema } from "./lib/inputs.ts";
import { api } from "./lib/script.ts";
import { OPTIONAL, SCENARIOS } from "./scenarios.ts";
import type { Context, Ended, Fixture } from "./scenarios.ts";

declare const workflow: ScriptApi["workflow"];
declare const z: ScriptApi["z"];
declare function phase(title: string): void;

const row = z.strictObject({ builtin: z.string(), scenario: z.string(), passed: z.boolean(), why: z.string().optional() });

export default workflow(
  {
    name: "pstack-suite",
    description: "Run the scenarios on candidate playbooks and promote them",
    input: z.strictObject({
      repo: repoSchema().describe("A repository the scenarios may change, on a forge project they may merge into"),
      worktrees: z.string().min(1).describe("The real path of the folder niwa keeps its worktrees in, <home>/worktrees"),
      base: z.string().min(1).default("main"),
    }),
    output: z.discriminatedUnion("status", [
      z.strictObject({ status: z.literal("nothing"), why: z.string() }),
      z.strictObject({ status: z.literal("promoted"), versions: z.array(z.strictObject({ builtin: z.string(), version: z.string() })), rows: z.array(row) }),
      z.strictObject({ status: z.literal("failed"), rows: z.array(row) }),
    ]),
    uses: [
      "workflow.builtin.promote",
      "forge.pr.merge@{repo.host}/{repo.path}/pr/*",
      "forge.pr.ensure@{repo.host}/{repo.path}/pr/*",
      "proc.run@{worktrees}/*",
      "git.*@{repo.local}",
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
      "workflow.cancel",
      "evidence.attest",
      "evidence.covers",
      "evidence.list",
      "plan.set",
      "plan.get",
    ],
    phases: [
      { title: "Find", detail: "Which built-ins have a candidate version" },
      { title: "Try", detail: "Each scenario runs on its candidate" },
      { title: "Promote", detail: "The tried set is promoted in one action" },
    ],
  },
  async ({ repo, worktrees, base }) => {
    phase("Find");
    const all = await registered("builtins");
    const candidates = Object.values(all).filter((one) => one.candidate !== undefined && one.name !== "suite");
    if (candidates.length === 0) return { status: "nothing" as const, why: "no built-in of pstack has a candidate version" };
    const pins: Record<string, string> = {};
    for (const one of Object.values(all)) {
      const version = one.candidate ?? one.accepted;
      if (version !== undefined) pins[one.name] = version;
    }
    const fixture: Fixture = { repo, worktrees, base, pins, run: String(await api().random({ label: "run" })).slice(2, 10) };

    phase("Try");
    const rows: Array<{ builtin: string; scenario: string; passed: boolean; why?: string }> = [];
    for (const one of candidates) {
      if (!SCENARIOS.some((scenario) => scenario.builtin === one.name)) rows.push({ builtin: one.name, scenario: "-", passed: false, why: "the built-in has no scenario" });
    }
    // Every scenario runs, on the version of the set under trial, in order: one hands its plan to the next.
    const context: Context = {};
    for (const [index, scenario] of SCENARIOS.entries()) {
      const found = all[scenario.builtin];
      const version = pins[scenario.builtin];
      if (found === undefined && OPTIONAL.has(scenario.builtin)) continue;
      if (found === undefined || version === undefined) {
        rows.push({ builtin: scenario.builtin, scenario: scenario.name, passed: false, why: "the built-in is not registered" });
        continue;
      }
      const key = `try-${String(index)}`;
      let ended: Ended;
      try {
        ended = await tryVersion(key, found.id, version, await scenario.args(fixture, context));
      } catch (error) {
        if (!isRefusal(error)) throw error;
        ended = { ok: false, error: { name: (error as Error).name, message: (error as Error).message } };
      }
      const why = scenario.check(ended, context);
      rows.push({ builtin: scenario.builtin, scenario: scenario.name, passed: why === null, ...(why === null ? {} : { why }) });
    }
    if (rows.some((one) => !one.passed)) return { status: "failed" as const, rows };

    phase("Promote");
    await api().call("workflow.builtin.promote", { versions: candidates.map((one) => ({ workflow: one.id, version: one.candidate })) }, { label: "promote" });
    return { status: "promoted" as const, versions: candidates.map((one) => ({ builtin: one.name, version: one.candidate as string })), rows };
  },
);
