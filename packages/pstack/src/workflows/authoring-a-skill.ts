// Authoring a skill: the lead names the skill, the decisions behind its text and how it is validated; the owner lane
// writes it and the verifiers check it.

import type { ScriptApi } from "@niwa-labs/script";

import { change, changedSchema, frame, titleOf } from "./lib/change.ts";
import { playbookInput } from "./lib/inputs.ts";
import { roles } from "./lib/script.ts";
import text from "./texts/authoring-a-skill.json";

declare const workflow: ScriptApi["workflow"];
declare const z: ScriptApi["z"];
declare function phase(title: string): void;

const framed = z.strictObject({ skill: z.string().min(1).max(500), decisions: z.array(z.string().max(1000)).max(10), validation: z.string().min(1).max(2000) });

export default workflow(
  {
    name: "pstack-authoring-a-skill",
    description: "Write or change a skill and carry it to a pull request",
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
    const got = await frame(text, { task, repo, roles: seats, schema: framed, ask: ["Name the skill, the decisions that shape its text, and how it is validated: frontmatter, referenced files, links."] });
    phase("Build");
    const done = await change("change", { playbook: text, repo, base, worktrees, roles: seats, task, title: titleOf(task), extra: [`The skill: ${got.skill}`, `Validate it: ${got.validation}`] });
    return { ...done, framed: got };
  },
);
