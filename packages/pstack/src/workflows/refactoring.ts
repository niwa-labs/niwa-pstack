// Refactoring: the lead names the contract, the pin that holds it, and the shape the code should have; the owner
// lane pins the behaviour first and moves the structure under it.

import type { ScriptApi } from "@niwa-labs/script";

import { change, changedSchema, frame, titleOf } from "./lib/change.ts";
import { playbookInput } from "./lib/inputs.ts";
import { roles } from "./lib/script.ts";
import text from "./texts/refactoring.json";

declare const workflow: ScriptApi["workflow"];
declare const z: ScriptApi["z"];
declare function phase(title: string): void;

const framed = z.strictObject({ contract: z.string().min(1).max(4000), pin: z.string().min(1).max(2000), target: z.string().min(1).max(4000) });

export default workflow(
  {
    name: "pstack-refactoring",
    description: "Reshape code behind a pinned contract",
    input: playbookInput(),
    output: changedSchema().extend({ framed }),
    uses: [
      "pstack.roles",
      "session.start.*",
      "session.start",
      "session.ask",
      "pstack.author.start",
      "git.worktree.create",
      "proc.run@{worktrees}/*",
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
    const got = await frame(text, { task, repo, roles: seats, schema: framed, ask: ["Name the behaviour contract the structure keeps, the test or harness that pins it, and the target shape."] });
    phase("Build");
    const done = await change("change", { playbook: text, repo, base, worktrees, roles: seats, task, title: titleOf(task), extra: [`The contract: ${got.contract}`, `Pin it first with: ${got.pin}`, `The target shape: ${got.target}`, "Move in small steps that keep the pin green; no compatibility shims."] });
    return { ...done, framed: got };
  },
);
