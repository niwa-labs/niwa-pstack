// Bug fix: the lead reproduces the bug and narrows it to the cause the evidence leaves; the owner lane commits the
// failing repro before the fix, and verifiers that did not write it show the repro passing.

import type { ScriptApi } from "@niwa-labs/script";

import { change, changedSchema, frame, titleOf } from "./lib/change.ts";
import { playbookInput } from "./lib/inputs.ts";
import { roles } from "./lib/script.ts";
import text from "./texts/bug-fix.json";

declare const workflow: ScriptApi["workflow"];
declare const z: ScriptApi["z"];
declare function phase(title: string): void;

const framed = z.strictObject({ repro: z.string().min(1).max(4000), cause: z.string().min(1).max(4000), evidence: z.string().min(1).max(4000) });

export default workflow(
  {
    name: "pstack-bug-fix",
    description: "Find a bug's cause and carry its fix to a pull request",
    input: playbookInput(),
    output: changedSchema().extend({ framed }),
    uses: [
      "pstack.roles",
      "session.start.*",
      "harness.list",
      "session.start",
      "session.ask",
      "session.end",
      "pstack.author.options",
      "box.net@{repo.host}",
      "git.worktree.create",
      "proc.run@{worktrees}/*",
      "pstack.pr.bind",
      "forge.pr.ensure@{repo.host}/{repo.path}/pr/*",
      "forge.pr.read@{repo.host}/{repo.path}",
      "forge.pipeline.read@{repo.host}/{repo.path}",
      "evidence.attest",
      "evidence.covers",
    ],
    phases: [
      { title: "Frame", detail: "The lead frames the work, read-only" },
      { title: "Build", detail: "An owner lane carries it to a verified pull request" },
    ],
  },
  async ({ task, repo, worktrees, base }) => {
    const seats = await roles();
    phase("Frame");
    const got = await frame(text, { task, repo, roles: seats, schema: framed, ask: ["Reproduce the bug on the surface it shows on, and narrow it to the one cause runtime evidence leaves.", "Answer the repro, the cause, and the evidence that confirms it."] });
    phase("Build");
    const done = await change("change", { playbook: text, repo, base, worktrees, roles: seats, task, title: titleOf(task), extra: [`The repro: ${got.repro}`, `The cause: ${got.cause}`, "Commit the failing repro first, then the fix on top of it."] });
    return { ...done, framed: got };
  },
);
