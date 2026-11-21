// Benny's reproduction: a report his triage found to be a bug is reproduced twice before any code is touched; a bug
// that does not reproduce is said to be so and nothing is changed. A reproduced one goes to an owner lane that fixes
// the cause the evidence shows and opens a draft pull request, verified by sessions that did not write it. Benny never
// merges or deploys.

import type { ScriptApi } from "@niwa-labs/script";

import { change, changedSchema, titleOf } from "./lib/change.ts";
import { api, roles, seatOptions, stepTag } from "./lib/script.ts";
import text from "./texts/benny-reproduce.json";
import worker from "./texts/worker.json";

declare const workflow: ScriptApi["workflow"];
declare const z: ScriptApi["z"];

/** The triage, as Benny's triage records it. */
interface Triaged {
  report: string;
  owner: string;
  summary: string;
  repo: { host: string; path: string; local: string };
  worktrees: string;
  base: string;
}

const reproduced = z.strictObject({
  reproduced: z.boolean(),
  runs: z.array(z.string().min(1).max(2000)).max(2).describe("What each of the two runs showed"),
});

export default workflow(
  {
    name: "pstack-benny-reproduce",
    description: "Reproduce a confirmed bug and fix it in a draft request",
    on: [{ type: "wf.pstack-benny-triage.triaged", filter: { verdict: "bug" } }],
    output: z.discriminatedUnion("status", [
      z.strictObject({ status: z.literal("not-reproduced"), runs: z.array(z.string()) }),
      changedSchema().extend({ status: z.enum(["verified", "unverified"]), runs: z.array(z.string()) }),
    ]),
    uses: [
      "pstack.roles",
      "session.start.*",
      "session.start",
      "session.ask",
      "pstack.author.start",
      "git.worktree.create",
      "proc.run@{data.worktrees}/*",
      "forge.pr.ensure@{data.repo.host}/{data.repo.path}/pr/*",
      "forge.pr.read@{data.repo.host}/{data.repo.path}",
      "forge.pipeline.read@{data.repo.host}/{data.repo.path}",
      "evidence.attest",
      "evidence.covers",
    ],
  },
  async ({ data }: { data: Triaged }) => {
    const seats = await roles();
    const repro = await api().agent(
      [
        stepTag("benny-reproduce", "reproduce"),
        "",
        worker.text.trim(),
        "",
        text.text.trim(),
        "",
        `Reproduce this bug twice on the real surface, without changing code. The triage: ${data.summary} (owned by ${data.owner}).`,
        "",
        "<report>",
        data.report,
        "</report>",
      ].join("\n"),
      { ...seatOptions(seats.lead), mode: "ask", cwd: data.repo.local, schema: reproduced, label: "reproduce" },
    );
    if (!repro.reproduced || repro.runs.length < 2) return { status: "not-reproduced" as const, runs: repro.runs };
    const task = `Fix the bug Benny reproduced: ${data.summary}\n\nWhat the two runs showed:\n${repro.runs.map((one) => `- ${one}`).join("\n")}`;
    const done = await change("fix", {
      playbook: { name: "benny-reproduce", title: text.title, text: text.text },
      repo: data.repo,
      base: data.base,
      worktrees: data.worktrees,
      roles: seats,
      task,
      title: titleOf(`fix: ${data.summary}`),
      extra: ["Commit the failing repro first, then the fix; smoke the blast radius."],
      draft: true,
    });
    return { ...done, runs: repro.runs };
  },
);
