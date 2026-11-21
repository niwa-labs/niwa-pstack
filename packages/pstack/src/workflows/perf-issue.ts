// Perf issue: the lead names the measurement and the target; the baseline is measured on trunk in a worktree of its
// own, an owner lane carries the fix to a verified pull request, and the same measurement runs on the fix. The
// numbers are measured, never read off the source.

import { makeWorktree, removeWorktree } from "@niwa-labs/flow-code";
import type { ScriptApi } from "@niwa-labs/script";

import { change, changedSchema, frame, titleOf } from "./lib/change.ts";
import { playbookInput } from "./lib/inputs.ts";
import { measure } from "./lib/measure.ts";
import { roles } from "./lib/script.ts";
import text from "./texts/perf-issue.json";

declare const workflow: ScriptApi["workflow"];
declare const z: ScriptApi["z"];
declare function phase(title: string): void;

const framed = z.strictObject({
  measure: z.string().min(1).max(2000).describe("A shell command whose last printed number is the metric"),
  direction: z.enum(["lower", "higher"]),
  target: z.number(),
});

export default workflow(
  {
    name: "pstack-perf-issue",
    description: "Measure a slow path, fix it, and measure the fix",
    input: playbookInput(),
    output: changedSchema().extend({ framed, baseline: z.number().nullable(), after: z.number().nullable(), met: z.boolean() }),
    uses: [
      "pstack.roles",
      "session.start.*",
      "session.start",
      "session.ask",
      "pstack.author.start",
      "git.worktree.create",
      "git.worktree.get",
      "git.worktree.remove",
      "proc.run@{worktrees}/*",
      "forge.pr.ensure@{repo.host}/{repo.path}/pr/*",
      "forge.pr.read@{repo.host}/{repo.path}",
      "forge.pipeline.read@{repo.host}/{repo.path}",
      "evidence.attest",
      "evidence.covers",
    ],
    phases: [
      { title: "Frame", detail: "The measurement and the target" },
      { title: "Baseline", detail: "Measured on trunk" },
      { title: "Fix", detail: "An owner lane carries the fix to a verified pull request" },
      { title: "Measure", detail: "The same measurement on the fix" },
    ],
  },
  async ({ task, repo, worktrees, base }) => {
    const seats = await roles();
    phase("Frame");
    const got = await frame(text, {
      task,
      repo,
      roles: seats,
      schema: framed,
      ask: ["Name one shell command, run from the repository's root, whose last printed number is the metric; whether lower or higher is better; and the target."],
    });
    phase("Baseline");
    const trunk = await makeWorktree({ repo: repo.local, base, description: "Measure the baseline on trunk" });
    const baseline = await measure("baseline", trunk.path, got.measure);
    await removeWorktree(trunk, true);
    phase("Fix");
    const done = await change("change", {
      playbook: text,
      repo,
      base,
      worktrees,
      roles: seats,
      task,
      title: titleOf(task),
      extra: [`The measurement: ${got.measure}`, `The baseline: ${String(baseline)}; ${got.direction} is better; the target: ${String(got.target)}.`],
    });
    phase("Measure");
    const after = await measure("after", done.worktree, got.measure);
    const met = after !== null && (got.direction === "lower" ? after <= got.target : after >= got.target);
    return { ...done, framed: got, baseline, after, met };
  },
);
