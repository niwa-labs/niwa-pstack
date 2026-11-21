// Feature: the lead traces the subsystem and names the shape the change is built on and the throughput checkpoint;
// an owner lane builds it in a boxed worktree and carries it to a verified pull request.

import type { ScriptApi } from "@niwa-labs/script";

import { change, changedSchema, frame, titleOf } from "./lib/change.ts";
import { playbookInput } from "./lib/inputs.ts";
import { roles } from "./lib/script.ts";
import text from "./texts/feature.json";

declare const workflow: ScriptApi["workflow"];
declare const z: ScriptApi["z"];
declare function phase(title: string): void;

const framed = z.strictObject({ shape: z.string().min(1).max(4000), checkpoint: z.strictObject({ blocking: z.string(), independent: z.string(), shared: z.string(), decomposition: z.string() }) });

export default workflow(
  {
    name: "pstack-feature",
    description: "Design a feature and carry it to a verified pull request",
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
    const got = await frame(text, { task, repo, roles: seats, schema: framed, ask: ["Trace the affected subsystem and name the data shape the change is built on.", "Write the throughput checkpoint: blocking first steps, independent workstreams, shared mutable state, smallest safe decomposition; an item that does not apply says n/a and why."] });
    phase("Build");
    const done = await change("change", { playbook: text, repo, base, worktrees, roles: seats, task, title: titleOf(task), extra: [`The data shape: ${got.shape}`, `The throughput checkpoint: ${JSON.stringify(got.checkpoint)}`] });
    return { ...done, framed: got };
  },
);
