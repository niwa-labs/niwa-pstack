// Autonomous run: done is a predicate, a shell command that exits 0 once the work is done, fixed before the first
// iteration and never relaxed. An author boxed to one worktree makes the smallest change the evidence justifies each
// iteration, the predicate is run again, and the run stops when it holds or the iterations run out.

import { makeWorktree } from "@niwa-labs/flow-code";
import type { ScriptApi } from "@niwa-labs/script";

import { gitOut } from "./lib/git.ts";
import { playbookInput } from "./lib/inputs.ts";
import { shell } from "./lib/measure.ts";
import { api, stepTag } from "./lib/script.ts";
import type { SessionAddress } from "./lib/script.ts";
import { askSession } from "./lib/sessions.ts";
import { brief } from "./lib/texts.ts";
import text from "./texts/autonomous-run.json";

declare const workflow: ScriptApi["workflow"];
declare const z: ScriptApi["z"];
declare function phase(title: string): void;

const row = z.strictObject({ iteration: z.number(), held: z.boolean(), change: z.string(), head: z.string() });

export default workflow(
  {
    name: "pstack-autonomous-run",
    description: "Drive a change until its done predicate holds",
    input: playbookInput().extend({
      predicate: z.string().min(1).max(2000).describe("A shell command, run in the worktree, that exits 0 once the work is done"),
      max: z.number().int().min(1).max(50).default(10),
    }),
    output: z.strictObject({ status: z.enum(["met", "not-met"]), worktree: z.string(), head: z.string(), rows: z.array(row) }),
    uses: ["pstack.author.start", "session.ask", "git.worktree.create", "proc.run@{worktrees}/*"],
    phases: [{ title: "Iterate", detail: "A change, then the predicate, until it holds" }],
  },
  async ({ task, repo, base, predicate, max }) => {
    phase("Iterate");
    const wt = await makeWorktree({ repo: repo.local, base, description: `Autonomous run: ${task}`.slice(0, 120) });
    const author = (await api().call("pstack.author.start", { place: wt.path }, { label: "author" })) as { ref: string; address: SessionAddress };
    const rows: Array<{ iteration: number; held: boolean; change: string; head: string }> = [];
    let last = await shell("check-0", wt.path, predicate);
    for (let iteration = 1; last.exit !== 0 && iteration <= max; iteration += 1) {
      const did = await askSession(
        `attempt-${String(iteration)}`,
        author.ref,
        brief(stepTag("autonomous-run", "attempt"), text, task, [
          `Done is when \`${predicate}\` exits 0 in ${wt.path}. It does not yet; it said:`,
          last.out.trim().slice(-2000),
          "Make the smallest change the evidence justifies and commit it; revert what did not help. Answer what you changed.",
        ]),
        z.strictObject({ change: z.string().min(1).max(2000) }),
      );
      last = await shell(`check-${String(iteration)}`, wt.path, predicate);
      rows.push({ iteration, held: last.exit === 0, change: did.change, head: await gitOut(`head-${String(iteration)}`, wt.path, ["rev-parse", "HEAD"]) });
    }
    const head = await gitOut("head", wt.path, ["rev-parse", "HEAD"]);
    return { status: last.exit === 0 ? ("met" as const) : ("not-met" as const), worktree: wt.path, head, rows };
  },
);
