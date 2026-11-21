// Hillclimb: one metric, one change at a time. The baseline is measured first; each attempt is one hypothesis an
// author boxed to the worktree commits, measured with the same command, and kept only when the metric moved the way
// that counts, else reverted in full. It stops when the target is met after the least number of attempts, or when the
// attempts run out; every attempt is a row of the decision log.

import { makeWorktree } from "@niwa-labs/flow-code";
import type { ScriptApi } from "@niwa-labs/script";

import { gitOut } from "./lib/git.ts";
import { playbookInput } from "./lib/inputs.ts";
import { better, measure } from "./lib/measure.ts";
import { api, stepTag } from "./lib/script.ts";
import type { SessionAddress } from "./lib/script.ts";
import { askSession } from "./lib/sessions.ts";
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
    }),
    output: z.strictObject({ status: z.enum(["reached", "stopped"]), baseline: z.number().nullable(), final: z.number().nullable(), worktree: z.string(), head: z.string(), rows: z.array(row) }),
    uses: ["pstack.author.start", "session.ask", "git.worktree.create", "proc.run@{worktrees}/*"],
    phases: [
      { title: "Baseline", detail: "The metric before any change" },
      { title: "Climb", detail: "One change, one measurement, keep or revert" },
    ],
  },
  async ({ task, repo, base, metric, direction, target, min, max }) => {
    phase("Baseline");
    const wt = await makeWorktree({ repo: repo.local, base, description: `Hillclimb: ${task}`.slice(0, 120) });
    const baseline = await measure("baseline", wt.path, metric);
    if (baseline === null) throw new Error(`the metric \`${metric}\` printed no number on trunk: fix the measurement before climbing`);
    phase("Climb");
    const author = (await api().call("pstack.author.start", { place: wt.path }, { label: "author" })) as { ref: string; address: SessionAddress };
    const rows: Array<{ attempt: number; hypothesis: string; before: number; after: number | null; verdict: "kept" | "reverted" }> = [];
    let best = baseline;
    const reached = () => (direction === "lower" ? best <= target : best >= target);
    for (let attempt = 1; attempt <= max && !(reached() && attempt > min); attempt += 1) {
      const before = await gitOut(`before-${String(attempt)}`, wt.path, ["rev-parse", "HEAD"]);
      const was = best;
      const tried = await askSession(
        `attempt-${String(attempt)}`,
        author.ref,
        brief(stepTag("hillclimb", "attempt"), text, task, [
          `The metric is \`${metric}\`; ${direction} is better; it is ${String(best)} now, the target ${String(target)}.`,
          `The log so far: ${JSON.stringify(rows)}`,
          "Make one change for one hypothesis that names its mechanism, and commit it. Answer the hypothesis.",
        ]),
        z.strictObject({ hypothesis: z.string().min(1).max(2000) }),
      );
      const after = await measure(`measure-${String(attempt)}`, wt.path, metric);
      const kept = after !== null && better(after, best, direction);
      if (kept) best = after;
      else await gitOut(`revert-${String(attempt)}`, wt.path, ["reset", "-q", "--hard", before]);
      rows.push({ attempt, hypothesis: tried.hypothesis, before: was, after, verdict: kept ? "kept" : "reverted" });
    }
    const head = await gitOut("head", wt.path, ["rev-parse", "HEAD"]);
    return { status: reached() ? ("reached" as const) : ("stopped" as const), baseline, final: best, worktree: wt.path, head, rows };
  },
);
