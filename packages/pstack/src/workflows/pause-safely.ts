// Pause safely: a clean stop with a checkpoint a cold start resumes from. An author boxed to the worktree the work is
// in commits what is uncommitted as one `wip:` commit on its branch, takes nothing irreversible, and writes the resume
// note; the run answers the note and the commit. It runs only when asked: "keep going" is not a pause.

import type { ScriptApi } from "@niwa-labs/script";

import { gitOut } from "./lib/git.ts";
import { playbookInput } from "./lib/inputs.ts";
import { api, authorOptions, roles, seatOptions, stepTag } from "./lib/script.ts";
import { brief } from "./lib/texts.ts";
import text from "./texts/pause-safely.json";

declare const workflow: ScriptApi["workflow"];
declare const z: ScriptApi["z"];
declare const record: ScriptApi["record"];
declare function phase(title: string): void;

const note = z.strictObject({
  intent: z.string().min(1).max(2000),
  state: z.string().min(1).max(2000),
  verified: z.array(z.string().max(1000)).max(20),
  next: z.string().min(1).max(2000),
  files: z.array(z.string().max(500)).max(30),
  gotchas: z.array(z.string().max(1000)).max(20),
});
const paused = z.strictObject({ status: z.literal("paused"), head: z.string(), clean: z.boolean(), note });
const Checkpoint = record("checkpoint", paused.extend({ worktree: z.string(), run: z.string().optional() }));

export default workflow(
  {
    name: "pstack-pause-safely",
    description: "Stop cleanly with a checkpoint to resume from",
    input: playbookInput().extend({
      worktree: z.string().min(1).describe("The niwa worktree the work is in"),
      run: z.string().min(1).optional().describe("The run to pause at a safe boundary with its descendants"),
    }),
    output: z.discriminatedUnion("status", [paused, z.strictObject({ status: z.literal("pending"), run: z.string(), why: z.string() })]),
    uses: ["session.start.*", "pstack.roles", "pstack.author.options", "session.ask", "session.end", "workflow.pause", "proc.run@{worktrees}/*"],
    emits: [Checkpoint],
    phases: [{ title: "Checkpoint", detail: "A wip commit and the resume note" }],
  },
  async ({ task, worktree, run }) => {
    phase("Checkpoint");
    if (run !== undefined) {
      let state: { state: string; manualPause?: { state: string } };
      try {
        state = await api().call("workflow.pause", { run }, { label: "pause-run" }) as typeof state;
      } catch (error) {
        if (!(error instanceof Error) || error.name !== "Denied") throw error;
        return { status: "pending" as const, run, why: "Niwa requires the target run's starter or host owner to pause it. No checkpoint was taken." };
      }
      if (state.state !== "finished" && state.manualPause?.state !== "paused") return { status: "pending" as const, run, why: "The target run has not reached a pause boundary. No checkpoint was taken." };
    }
    const dirty = await gitOut("before-status", worktree, ["status", "--porcelain"]);
    const before = await gitOut("before-head", worktree, ["rev-parse", "HEAD"]);
    const prompt = brief(stepTag("pause-safely", "checkpoint"), text, task, [
      `Stop at a safe boundary in ${worktree}. Push nothing new.`,
      dirty === "" ? "The checkout is clean. Inspect it and make no edits." : "Commit the task-owned pending work as one wip: commit. Preserve any unrelated changes.",
      "Answer the resume note.",
    ]);
    const written = await (async () => {
      if (dirty === "") return api().ask({ ...seatOptions((await roles()).lead), mode: "ask", cwd: worktree, visible: [], schema: note, label: "checkpoint" }, prompt);
      const author = await api().session({ ...await authorOptions("author", worktree), box: { only: ["project", "toolchains"] }, visible: [], label: "author" });
      try {
        return await author.ask(prompt, { schema: note, label: "checkpoint" });
      } finally {
        await author.end();
      }
    })();
    const head = await gitOut("head", worktree, ["rev-parse", "HEAD"]);
    const status = await gitOut("status", worktree, ["status", "--porcelain"]);
    if (dirty === "" && status !== "") throw new Error("The checkout changed while taking its read-only pause checkpoint");
    if (head !== before) {
      const parents = await gitOut("parents", worktree, ["show", "-s", "--format=%P", head]);
      const subject = await gitOut("subject", worktree, ["log", "-1", "--format=%s"]);
      if (dirty === "" || parents !== before || !subject.startsWith("wip:")) throw new Error("Unexpected commit in pause checkpoint");
    }
    const checkpoint = { status: "paused" as const, head, clean: status === "", note: written };
    await api().emit(Checkpoint, { ...checkpoint, worktree, ...(run === undefined ? {} : { run }) }, { label: "resume-note" });
    return checkpoint;
  },
);
