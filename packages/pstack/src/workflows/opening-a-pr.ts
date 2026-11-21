// Opening a PR: a branch the work is on, published, becomes a pull request that is ready for review: the lead reads
// the branch against trunk and writes the title and the one-minute briefing under the headings upstream asks for.

import { makeWorktree, removeWorktree } from "@niwa-labs/flow-code";
import type { ScriptApi } from "@niwa-labs/script";

import { gitOut } from "./lib/git.ts";
import { playbookInput } from "./lib/inputs.ts";
import { api, forgeRepo, roles, seatOptions, stepTag } from "./lib/script.ts";
import { brief } from "./lib/texts.ts";
import text from "./texts/opening-a-pr.json";

declare const workflow: ScriptApi["workflow"];
declare const z: ScriptApi["z"];
declare function phase(title: string): void;

const HEADINGS = ["Why", "What changed", "Scope", "Tradeoffs", "Blast Radius", "Verification"] as const;

const written = z.strictObject({
  title: z.string().regex(/^[a-z]+(\([^)]+\))?: .+$/, "type(scope): subject").max(120),
  sections: z.array(z.strictObject({ heading: z.enum(HEADINGS), body: z.string().min(1).max(4000) })).min(1),
});

/** The body: the sections in upstream's order, empty ones dropped, at most 40 lines. */
function bodyOf(sections: Array<{ heading: (typeof HEADINGS)[number]; body: string }>): string {
  const ordered = HEADINGS.flatMap((heading) => sections.filter((one) => one.heading === heading).map((one) => `## ${heading}\n\n${one.body.trim()}`));
  const lines = ordered.join("\n\n").split("\n");
  return lines.length <= 40 ? lines.join("\n") : [...lines.slice(0, 39), "(trimmed to 40 lines)"].join("\n");
}

export default workflow(
  {
    name: "pstack-opening-a-pr",
    description: "Open a ready pull request for a published branch",
    input: playbookInput().extend({
      branch: z.string().min(1).max(200).describe("The published branch the work is on"),
      number: z.number().int().positive().optional().describe("The pull request of the branch, when one is open: it is made ready and rewritten"),
    }),
    output: z.strictObject({ status: z.literal("opened"), pr: z.number(), head: z.string(), title: z.string(), body: z.string() }),
    uses: ["pstack.roles", "session.start.*", "git.worktree.create", "git.worktree.get", "git.worktree.remove", "proc.run@{worktrees}/*", "forge.pr.ensure@{repo.host}/{repo.path}/pr/*"],
    phases: [
      { title: "Write", detail: "The title and the briefing from the branch" },
      { title: "Open", detail: "Ready for review, not a draft" },
    ],
  },
  async ({ task, repo, base, branch, number }) => {
    const seats = await roles();
    phase("Write");
    const wt = await makeWorktree({ repo: repo.local, base: branch, description: `Read ${branch} against ${base}` });
    const log = await gitOut("log", wt.path, ["log", "--oneline", `${base}..HEAD`]);
    const stat = await gitOut("stat", wt.path, ["diff", "--stat", `${base}...HEAD`]);
    await removeWorktree(wt, true);
    const got = await api().ask(
      { ...seatOptions(seats.lead), mode: "ask", cwd: repo.local, schema: written, label: "write" },
      brief(stepTag("opening-a-pr", "write"), text, task, [`The branch ${branch} against ${base}:`, log, stat, "Answer the title as type(scope): subject, and the sections of the body."]),
    );
    phase("Open");
    const body = bodyOf(got.sections);
    const opened = (await api().call("forge.pr.ensure", { repo: forgeRepo(repo), ...(number === undefined ? {} : { number }), branch, base, title: got.title, description: body, draft: false }, { label: "open" })) as { pr: { number: number }; head: string };
    return { status: "opened" as const, pr: opened.pr.number, head: opened.head, title: got.title, body };
  },
);
