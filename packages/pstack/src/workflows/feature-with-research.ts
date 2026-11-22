import type { ScriptApi } from "@niwa-labs/script";

import { input, output, run } from "./lib/feature.ts";
import { beforePlan } from "./lib/before-plan.ts";

declare const workflow: ScriptApi["workflow"];
declare function phase(title: string): void;

export default workflow(
  {
    name: "pstack-feature",
    description: "Design a feature and carry it to a verified pull request",
    input,
    output,
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
      "forge.checks.read@{repo.host}/{repo.path}",
      "evidence.attest",
      "evidence.covers",
      "evidence.list",
      "pstack.feature.research.settings",
      "pstack.feature.research.report@{repo.local}",
      "box.read@{repo.local}",
    ],
    phases: [
      { title: "Research", detail: "Configured researchers read the repository and record evidence" },
      { title: "Frame", detail: "The lead frames the work, read-only" },
      { title: "Build", detail: "An owner lane carries it to a verified pull request" },
    ],
  },
  async (args) => {
    phase("Research");
    return run(args, await beforePlan(args));
  },
);
