// Visual parity: the lead lists how a surface differs from its reference; the owner lane closes the gap, and the live
// verdict is a side-by-side of the two on the real surface.

import type { ScriptApi } from "@niwa-labs/script";

import { change, changedSchema, frame, titleOf } from "./lib/change.ts";
import { playbookInput } from "./lib/inputs.ts";
import { roles } from "./lib/script.ts";
import text from "./texts/visual-parity.json";

declare const workflow: ScriptApi["workflow"];
declare const z: ScriptApi["z"];
declare function phase(title: string): void;

const framed = z.strictObject({ reference: z.string().min(1).max(2000), surface: z.string().min(1).max(2000), differences: z.array(z.string().max(500)).max(30) });

export default workflow(
  {
    name: "pstack-visual-parity",
    description: "Match a surface to its reference and verify it live",
    input: playbookInput(),
    output: changedSchema().extend({ framed }),
    uses: [
      "pstack.roles",
      "session.start.*",
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
    const got = await frame(text, { task, repo, roles: seats, schema: framed, ask: ["Name the reference, the surface that must match it, and the differences between them now."] });
    phase("Build");
    const done = await change("change", { playbook: text, repo, base, worktrees, roles: seats, task, title: titleOf(task), extra: [`The reference: ${got.reference}`, `The surface: ${got.surface}`, `The differences: ${got.differences.join("; ")}`] });
    return { ...done, framed: got };
  },
);
