// Hillclimb: one metric, one change at a time. The baseline is measured first; each attempt is one hypothesis an
// author boxed to the worktree commits, measured with the same command, and kept only when the metric moved the way
// that counts, else reverted in full. It stops when the target is met after the least number of attempts, or when the
// attempts run out; every attempt is a row of the decision log.

import { makeWorktree } from "@niwa-labs/flow-code";
import type { ScriptApi } from "@niwa-labs/script";

import { gitOut } from "./lib/git.ts";
import { climbProofSchema, climbWakeSchema, runMeasuredClimb, waitForClimb } from "./lib/hillclimb-loop.ts";
import { workloadSchema } from "./lib/parity-benchmark.ts";
import { playbookInput } from "./lib/inputs.ts";
import { better, measure, shell } from "./lib/measure.ts";
import { api, authorOptions, stepTag } from "./lib/script.ts";
import { brief } from "./lib/texts.ts";
import text from "./texts/hillclimb.json";

declare const workflow: ScriptApi["workflow"];
declare const z: ScriptApi["z"];
declare function phase(title: string): void;

const row = z.strictObject({
  attempt: z.number(),
  hypothesis: z.string(),
  before: z.number(),
  after: z.number().nullable(),
  verdict: z.enum(["kept", "reverted"]),
});

export default workflow(
  {
    name: "pstack-hillclimb",
    description: "Improve one metric an attempt at a time",
    input: playbookInput().extend({
      metric: z.string().min(1).max(2000).describe("A shell command, run in the worktree, whose last printed number is the metric"),
      direction: z.enum(["lower", "higher"]),
      target: z.number(),
      min: z.number().int().min(1).max(100).default(3).describe("The least number of attempts before the target may end the run"),
      max: z.number().int().min(1).max(100).default(10),
      gate: z.string().min(1).max(2000).optional().describe("Regression-gate command; the metric command must include it if omitted"),
      noise: z.number().nonnegative().default(0),
      workload: workloadSchema().optional(),
      wake: climbWakeSchema().optional(),
      publish: z.boolean().optional().describe("Publish accepted calibrated fixes. Set false for a local-only climb"),
    }),
    output: z.strictObject({ status: z.enum(["reached", "stopped"]), baseline: z.number().nullable(), final: z.number().nullable(), worktree: z.string(), head: z.string(), rows: z.array(row.extend({ change: z.string().optional(), tests: z.string().optional(), note: z.string().optional(), worktree: z.string().optional() })), proof: climbProofSchema().optional() }),
    uses: ["session.start.*", "harness.list", "session.start", "pstack.author.options", "session.ask", "session.end", "git.worktree.create", "proc.run@{worktrees}/*", "proc.run@{worktrees}", "git.worktree.get", "pstack.roles",
      "box.net@{repo.host}", "pstack.pr.bind", "forge.pr.ensure@{repo.host}/{repo.path}/pr/*",
      "forge.pr.read@{repo.host}/{repo.path}", "forge.pipeline.read@{repo.host}/{repo.path}", "forge.checks.read@{repo.host}/{repo.path}",
      "evidence.attest", "evidence.covers", "evidence.list", "niwa.records.read"],
    phases: [
      { title: "Baseline", detail: "The metric before any change" },
      { title: "Climb", detail: "One change, one measurement, keep or revert" },
    ],
  },
  async ({ task, repo, base, worktrees, metric, direction, target, min, max, gate, noise, workload, publish, wake }) => {
    if (min > max) throw new Error("Minimum attempts exceeds maximum attempts");
    phase("Baseline");
    const wt = await makeWorktree({ repo: repo.local, base, description: `Hillclimb: ${task}`.slice(0, 120) });
    if (workload) return runMeasuredClimb({
      text, task, repo, base, worktrees, metric, direction, target, min, max, noise, workload, publish: publish ?? true, wake,
    }, wt, () => phase("Climb"));
    const baseline = await measure("baseline", wt.path, metric);
    if (baseline === null) throw new Error(`the metric \`${metric}\` printed no number on trunk: fix the measurement before climbing`);
    if (gate !== undefined && (await shell("baseline-gate", wt.path, gate)).exit !== 0) throw new Error("Regression gate failed before the first attempt");
    phase("Climb");
    const author = await api().session({ ...await authorOptions("author", wt.path, true), label: "author" });
    const rows: Array<{ attempt: number; hypothesis: string; before: number; after: number | null; verdict: "kept" | "reverted" }> = [];
    let best = baseline;
    const reached = () => (direction === "lower" ? best <= target : best >= target);
    for (let attempt = 1; attempt <= max && !(reached() && attempt > min); attempt += 1) {
      if (attempt > 1 && wake) await waitForClimb(wake, repo, attempt);
      const before = await gitOut(`before-${String(attempt)}`, wt.path, ["rev-parse", "HEAD"]);
      const was = best;
      const tried = await author.ask(
        brief(stepTag("hillclimb", "attempt"), text, task, [
          `The metric is \`${metric}\`; ${direction} is better; it is ${String(best)} now, the target ${String(target)}.`,
          `The log so far: ${JSON.stringify(rows)}`,
          `If you use a helper, start it on ${author.address.harness}.`,
          "Make one change for one hypothesis that names its mechanism, and commit it. Leave the measurement and regression commands unchanged and keep the checkout clean. The workflow alone keeps or reverts the attempt. Answer the hypothesis.",
        ]),
        { schema: z.strictObject({ hypothesis: z.string().min(1).max(2000) }), label: `attempt-${String(attempt)}` },
      );
      const after = await measure(`measure-${String(attempt)}`, wt.path, metric);
      const green = gate === undefined || (await shell(`gate-${attempt}`, wt.path, gate)).exit === 0;
      const kept = green && after !== null && better(after, best, direction) && Math.abs(after - best) > noise;
      if (kept) best = after;
      else await gitOut(`revert-${String(attempt)}`, wt.path, ["reset", "-q", "--hard", before]);
      rows.push({ attempt, hypothesis: tried.hypothesis, before: was, after, verdict: kept ? "kept" : "reverted" });
    }
    await author.end();
    const head = await gitOut("head", wt.path, ["rev-parse", "HEAD"]);
    return { status: reached() ? ("reached" as const) : ("stopped" as const), baseline, final: best, worktree: wt.path, head, rows };
  },
);
