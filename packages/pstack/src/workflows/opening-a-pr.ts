// Opening a PR: a branch the work is on, published, becomes a pull request that is ready for review: the lead reads
// the branch against trunk and writes the title and the one-minute briefing under the headings upstream asks for.

import { makeWorktree, removeWorktree } from "@niwa-labs/flow-code";
import type { ScriptApi } from "@niwa-labs/script";

import { playbookInput } from "./lib/inputs.ts";
import { prBriefing } from "./lib/pr-briefing.ts";
import { api, forgeRepo, roles } from "./lib/script.ts";

declare const workflow: ScriptApi["workflow"];
declare const z: ScriptApi["z"];
declare function phase(title: string): void;

export default workflow(
  {
    name: "pstack-opening-a-pr",
    description: "Open a ready pull request for a published branch",
    input: playbookInput().extend({
      branch: z.string().min(1).max(200).describe("The published branch the work is on"),
      number: z.number().int().positive().optional().describe("The pull request of the branch, when one is open: it is made ready and rewritten"),
    }),
    output: z.strictObject({ status: z.literal("opened"), pr: z.number(), head: z.string(), title: z.string(), body: z.string() }),
    uses: ["pstack.roles", "session.start.*", "git.worktree.create", "git.worktree.get", "git.worktree.remove", "proc.run@{worktrees}/*", "forge.pr.read@{repo.host}/{repo.path}", "forge.pr.ensure@{repo.host}/{repo.path}/pr/*"],
    phases: [
      { title: "Write", detail: "The title and the briefing from the branch" },
      { title: "Open", detail: "Ready for review, not a draft" },
    ],
  },
  async ({ task, repo, base, branch, number }) => {
    const seats = await roles();
    phase("Write");
    const wt = await makeWorktree({ repo: repo.local, base: branch, description: `Read ${branch} against ${base}` });
    let briefing;
    try {
      briefing = await prBriefing("write", { task, base, branch, head: wt.baseSha, cwd: wt.path, writer: seats.lead });
    } finally {
      await removeWorktree(wt, true);
    }
    phase("Open");
    const { title, body } = briefing;
    if (number !== undefined) {
      const current = await api().call("forge.pr.read", { repo: forgeRepo(repo), number }, { label: "before-open" }) as {
        head: string; branch: string; base: string;
      };
      if (current.head !== wt.baseSha || current.branch !== branch || current.base !== base) {
        throw new Error("The existing PR no longer matches the briefed head, branch and base");
      }
    }
    const opened = (await api().call("forge.pr.ensure", { repo: forgeRepo(repo), ...(number === undefined ? {} : { number }), branch, base, title, description: body, draft: false }, { label: "open" })) as { pr: { number: number }; head: string };
    if (opened.head !== wt.baseSha || (number !== undefined && opened.pr.number !== number)) {
      throw new Error("The forge returned a different PR or head from the briefing");
    }
    return { status: "opened" as const, pr: opened.pr.number, head: opened.head, title, body };
  },
);
