// Pause safely: a clean stop with a checkpoint a cold start resumes from. An author boxed to the worktree the work is
// in commits what is uncommitted as one `wip:` commit on its branch, takes nothing irreversible, and writes the resume
// note; the run answers the note and the commit. It runs only when asked: "keep going" is not a pause.

import type { ScriptApi } from "@niwa-labs/script";

import { gitOut } from "./lib/git.ts";
import { playbookInput } from "./lib/inputs.ts";
import { api, stepTag } from "./lib/script.ts";
import type { SessionAddress } from "./lib/script.ts";
import { askSession } from "./lib/sessions.ts";
import { brief } from "./lib/texts.ts";
import text from "./texts/pause-safely.json";

declare const workflow: ScriptApi["workflow"];
declare const z: ScriptApi["z"];
declare function phase(title: string): void;

const note = z.strictObject({
  intent: z.string().min(1).max(2000),
  state: z.string().min(1).max(2000),
  verified: z.array(z.string().max(1000)).max(20),
  next: z.string().min(1).max(2000),
  files: z.array(z.string().max(500)).max(30),
  gotchas: z.array(z.string().max(1000)).max(20),
});

export default workflow(
  {
    name: "pstack-pause-safely",
    description: "Stop cleanly with a checkpoint to resume from",
    input: playbookInput().extend({ worktree: z.string().min(1).describe("The niwa worktree the work is in") }),
    output: z.strictObject({ status: z.literal("paused"), head: z.string(), clean: z.boolean(), note }),
    uses: ["pstack.author.start", "session.ask", "proc.run@{worktrees}/*"],
    phases: [{ title: "Checkpoint", detail: "A wip commit and the resume note" }],
  },
  async ({ task, worktree }) => {
    phase("Checkpoint");
    const author = (await api().call("pstack.author.start", { place: worktree }, { label: "author" })) as { ref: string; address: SessionAddress };
    const written = await askSession(
      "checkpoint",
      author.ref,
      brief(stepTag("pause-safely", "checkpoint"), text, task, [
        `Stop at a safe boundary in ${worktree}. Commit what is uncommitted as one commit whose message starts with "wip:", and push nothing new.`,
        "Answer the resume note.",
      ]),
      note,
    );
    const head = await gitOut("head", worktree, ["rev-parse", "HEAD"]);
    const status = await gitOut("status", worktree, ["status", "--porcelain"]);
    return { status: "paused" as const, head, clean: status === "", note: written };
  },
);
