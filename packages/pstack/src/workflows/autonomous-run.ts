// Autonomous run: done is a predicate, a shell command that exits 0 once the work is done, fixed before the first
// iteration and never relaxed. An author boxed to one worktree makes the smallest change the evidence justifies each
// iteration, the predicate is run again, and the run stops when it holds or the iterations run out.

import { makeWorktree } from "@niwa-labs/flow-code";
import type { ScriptApi } from "@niwa-labs/script";

import { gitOut, gitRun } from "./lib/git.ts";
import { playbookInput } from "./lib/inputs.ts";
import { shell } from "./lib/measure.ts";
import { api, authorOptions, stepTag } from "./lib/script.ts";
import { brief } from "./lib/texts.ts";
import text from "./texts/autonomous-run.json";

declare const workflow: ScriptApi["workflow"];
declare const z: ScriptApi["z"];
declare const record: ScriptApi["record"];
declare function phase(title: string): void;

const row = z.strictObject({ iteration: z.number(), held: z.boolean(), change: z.string(), head: z.string() });
const Attempt = record("attempt", row.extend({ worktree: z.string(), exit: z.number().nullable(), evidence: z.string() }));
const wake = z.strictObject({
  heartbeatMs: z.number().int().min(1).max(86_400_000),
  pr: z.number().int().positive().optional().describe("Wake on this project's PR, with a heartbeat as fallback"),
  event: z.enum(["checks", "head", "merged"]).optional(),
}).refine(value => value.event === undefined || value.pr !== undefined, "A forge event needs a pull request");

export default workflow(
  {
    name: "pstack-autonomous-run",
    description: "Drive a change until its done predicate holds",
    input: playbookInput().extend({
      predicate: z.string().min(1).max(2000).describe("A shell command, run in the worktree, that exits 0 once the work is done"),
      wake: wake.optional(),
      attemptTimeoutMs: z.number().int().positive().max(86_400_000).optional(),
      max: z.number().int().min(1).max(50).default(10),
    }),
    output: z.strictObject({ status: z.enum(["met", "not-met"]), worktree: z.string(), head: z.string(), rows: z.array(row), reason: z.string().optional() }),
    uses: ["session.start.*", "harness.list", "session.start", "pstack.author.options", "session.ask", "session.end", "git.worktree.create", "niwa.records.read", "proc.run@{worktrees}/*"],
    emits: [Attempt],
    phases: [{ title: "Iterate", detail: "A change, then the predicate, until it holds" }],
  },
  async ({ task, repo, base, predicate, max, wake: cadence, attemptTimeoutMs }) => {
    phase("Iterate");
    const wt = await makeWorktree({ repo: repo.local, base, description: `Autonomous run: ${task}`.slice(0, 120) });
    const rows: Array<{ iteration: number; held: boolean; change: string; head: string }> = [];
    let head = await gitOut("initial-head", wt.path, ["rev-parse", "HEAD"]);
    const cleanAt = async (key: string, sha: string) =>
      await gitOut(`${key}-head`, wt.path, ["rev-parse", "HEAD"]) === sha &&
      await gitOut(`${key}-status`, wt.path, ["status", "--porcelain"]) === "";
    let last = await shell("check-0", wt.path, predicate);
    if (!await cleanAt("initial-check", head)) {
      return { status: "not-met" as const, worktree: wt.path, head: await gitOut("recovery-head", wt.path, ["rev-parse", "HEAD"]),
        rows, reason: "The predicate changed the checkout. It was retained for recovery." };
    }
    if (last.exit === 0) {
      return { status: "met" as const, worktree: wt.path, head, rows };
    }
    const filter = cadence?.pr === undefined ? undefined : { "pr.repo.host": repo.host, "pr.repo.path": repo.path, "pr.number": cadence.pr };
    const event = cadence?.event === "head" ? "forge.pr.head" : cadence?.event === "merged" ? "forge.pr.merged" : "forge.checks";
    // Capture the first position before the author starts, so events during an attempt can wake the next pass.
    let from = filter === undefined ? undefined
      : (await api().read.records({ types: [event], filter, tail: 1 }, { label: "wake-position" })).next;
    let reason: string | undefined;
    let unchanged = false;
    for (let iteration = 1; last.exit !== 0 && iteration <= max; iteration += 1) {
      if (iteration > 1 && cadence) {
        if (filter === undefined) {
          await api().sleep(cadence.heartbeatMs, { label: `heartbeat-${iteration}` });
        } else {
          const woke = await api().wait(event, { filter, ...(from === undefined ? {} : { from }), timeout: cadence.heartbeatMs, label: `wake-${iteration}` });
          if (!("timedOut" in woke)) from = woke.at;
        }
        if (!await cleanAt(`wake-before-${iteration}`, head)) {
          reason = "The checkout moved while waiting. It was retained for recovery.";
          break;
        }
        last = await shell(`wake-check-${iteration}`, wt.path, predicate);
        if (!await cleanAt(`wake-after-${iteration}`, head)) reason = "The predicate changed the checkout. It was retained for recovery.";
        if (reason || last.exit === 0) break;
      }
      if (last.exit === null) {
        reason = "The predicate did not exit. Inspect the recorded command result before continuing.";
        break;
      }
      const attempt = async () => {
        const label = `author-${iteration}`;
        const author = await api().session({ ...await authorOptions(label, wt.path, true), box: { only: ["project", "toolchains"] }, label });
        try {
          return await author.ask(
            brief(stepTag("autonomous-run", "attempt"), text, task, [
              `Done is when \`${predicate}\` exits 0 in ${wt.path}. It does not yet; it said:`,
              last.out.trim().slice(-2000),
              `If you use a helper, start it on ${author.address.harness}.`,
              ...(unchanged ? ["The last attempt left the same head and predicate result. Change the hypothesis or probe."] : []),
              ...rows.slice(-3).map(one => `Prior attempt ${one.iteration} at ${one.head}: ${one.change}`),
              "Make one reversible, verifiable change. Keep only task-owned improvements and commit them locally. Report the change, discarded work, or a concrete dead end. The workflow owns the fixed predicate.",
            ]),
            { schema: z.strictObject({ change: z.string().min(1).max(2000), deadEnd: z.string().trim().min(1).max(2000).optional() }), label: `attempt-${iteration}` },
          );
        } finally {
          await author.end();
        }
      };
      const did = await api().moveOnAfter(`bounded-attempt-${iteration}`, attemptTimeoutMs ?? "1h", attempt);
      const nextHead = await gitOut(`head-${iteration}`, wt.path, ["rev-parse", "HEAD"]);
      const linear = nextHead === head || (await gitRun(`ancestor-${iteration}`, wt.path, ["merge-base", "--is-ancestor", head, nextHead])).exit === 0;
      const checked = did === undefined ? { exit: null, out: "The authoring attempt timed out." }
        : !linear ? { exit: null, out: "The attempt rewrote previously recorded work." } : await shell(`check-${iteration}`, wt.path, predicate);
      const intact = await cleanAt(`after-${iteration}`, nextHead);
      const checkpoint = { iteration, held: checked.exit === 0 && intact, change: did?.change ?? checked.out, head: nextHead };
      await api().emit(Attempt, { ...checkpoint, worktree: wt.path, exit: checked.exit, evidence: checked.out.slice(-2000) }, { label: `checkpoint-${iteration}` });
      rows.push(checkpoint);
      unchanged = nextHead === head && checked.exit === last.exit && checked.out === last.out;
      head = nextHead;
      last = checked;
      if (did === undefined || !linear || !intact || did.deadEnd && !checkpoint.held) {
        reason = did === undefined || !linear ? checked.out : !intact ? "The checkout changed during the attempt or predicate. It was retained for recovery." : did.deadEnd;
        break;
      }
    }
    if (last.exit !== 0) reason ??= last.exit === null ? "The predicate did not exit." : "Attempt budget exhausted.";
    if (reason !== undefined) head = await gitOut("recovery-head", wt.path, ["rev-parse", "HEAD"]);
    return { status: reason === undefined ? "met" as const : "not-met" as const, worktree: wt.path, head, rows, ...(reason === undefined ? {} : { reason }) };
  },
);
