// Authoring a skill: the lead names the skill, the decisions behind its text and how it is validated; the owner lane
// writes it and the verifiers check it.

import { makeWorktree } from "@niwa-labs/flow-code";
import type { ScriptApi } from "@niwa-labs/script";

import { changedSchema, frame } from "./lib/change.ts";
import { deliverDecision } from "./lib/decision-delivery.ts";
import { commandSchema, decisionProbe } from "./lib/decision-probe.ts";
import { localArtifact } from "./lib/feature-artifacts.ts";
import { playbookInput } from "./lib/inputs.ts";
import { scratchFileSchema } from "./lib/prototype-evidence.ts";
import { api, roles, seatOptions, stepTag } from "./lib/script.ts";
import { validateSkill } from "./lib/skill-validation.ts";
import { brief } from "./lib/texts.ts";
import text from "./texts/authoring-a-skill.json";

declare const workflow: ScriptApi["workflow"];
declare const z: ScriptApi["z"];
declare function phase(title: string): void;

const framed = z.strictObject({ skill: z.string().min(1).max(500), decisions: z.array(z.string().max(1000)).max(10), validation: z.string().min(1).max(2000) });
const plan = z.strictObject({
  path: scratchFileSchema().refine((path) => path.endsWith("/SKILL.md") || path === "SKILL.md"),
  guidance: z.string().min(1).max(4000),
  references: z.array(z.string().trim().min(1).max(500)).max(30).optional(),
  cases: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("structural"), commands: z.array(commandSchema()).min(1).max(10) }),
    z.strictObject({ kind: z.literal("subjective"), why: z.string().min(1).max(2000) }),
  ]),
});

export default workflow(
  {
    name: "pstack-authoring-a-skill",
    description: "Write or change a skill and carry it to a pull request",
    input: playbookInput(),
    output: changedSchema().extend({ framed, authoring: plan, receipts: z.array(z.string()) }),
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
      "forge.checks.read@{repo.host}/{repo.path}",
      "evidence.attest",
      "evidence.covers",
      "evidence.list",
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
    const authoring = await api().ask({
      ...seatOptions(seats.lead), mode: "ask", cwd: repo.local, visible: [], label: "create-skill", schema: plan,
    }, brief(stepTag("authoring-a-skill", "create-skill"), text, task, [
      "Act as the skill-authoring pass. Identify the actual SKILL.md path, its trigger and decisions, structural sources to link, and the shortest usable procedure. Keep the skill's voice local to its scope.",
      "List file references that will be written without Markdown links, including cross-skill targets. Use paths relative to SKILL.md, or paths beginning with skills/ from the project root.",
      "Use structural case commands when the authored instructions have observable triggers, protocol or outputs. For subjective guidance, record why case execution is inapplicable. Frontmatter and local links are validated in either case.",
      JSON.stringify(got),
    ]));
    phase("Build");
    const lane = { playbook: text, repo, base, worktrees, roles: seats, task };
    const baseline = await makeWorktree({ repo: repo.local, base, description: "Skill authoring baseline" });
    const artifact = await localArtifact("author-skill", {
      ...lane, seat: seats.author, startAt: baseline.baseSha,
      directions: [
        JSON.stringify(got), JSON.stringify(authoring),
        "Create or edit the named skill. Keep only prose that changes a decision, use direct instructions, and link to the types, README or config that owns each structural rule. Link other skills by path. Avoid repeating their instructions.",
      ],
    });
    const structure = await validateSkill(artifact.path, authoring.path, authoring.references);
    const receipts = ["Skill structure: " + structure.output];
    if (authoring.cases.kind === "subjective") receipts.push("Subjective guidance, cases skipped: " + authoring.cases.why);
    else {
      for (const [index, cmd] of authoring.cases.commands.entries()) {
        const checked = await decisionProbe("skill-case-" + index, artifact.path, cmd);
        if (checked.exit !== 0 || checked.truncated) throw new Error("Skill case did not pass: " + JSON.stringify(checked));
        receipts.push("Case passed: " + JSON.stringify(checked));
      }
    }
    const done = await deliverDecision("change", { ...lane, receipts, verification: [`Recheck skill structure and applicable cases at ${authoring.path}.`] }, artifact);
    return { ...done, framed: got, authoring, receipts };
  },
);
