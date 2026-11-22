import { makeWorktree } from "@niwa-labs/flow-code";
import type { ScriptApi } from "@niwa-labs/script";
import type { z as Z } from "zod";

import { boundaryArchitecture, changeResult, changedSchema, frame, titleOf } from "./lib/change.ts";
import { compareArchitecture } from "./lib/decision-architecture.ts";
import { interrogate, interrogationSchema } from "./lib/feature-interrogate.ts";
import { gitOut } from "./lib/git.ts";
import { playbookInput } from "./lib/inputs.ts";
import { deliverBuilt } from "./lib/lane.ts";
import { artifactName, evidenceSchema, exactCheckout, localAuthor, publishVerified, replay } from "./lib/parity-proof.ts";
import { roles, stepTag } from "./lib/script.ts";
import { brief } from "./lib/texts.ts";
import text from "./texts/bug-fix.json";

declare const workflow: ScriptApi["workflow"];
declare const z: ScriptApi["z"];
declare function phase(title: string): void;

const detail = z.string().trim().min(1).max(4000);
const command = z.strictObject({ command: detail, failingSignal: detail });
const regression = z.discriminatedUnion("kind", [
  command.extend({ kind: z.literal("test"), paths: z.array(detail).min(1) }),
  z.strictObject({ kind: z.literal("skip"), reason: detail }),
]);
const framed = z.strictObject({ repro: detail, cause: detail, evidence: detail });
const hypothesis = z.strictObject({ id: z.string().min(1).max(80), claim: detail });
const split = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("blocked"), why: detail }),
  z.strictObject({ kind: z.literal("probe"), command: detail, outcomes: z.array(z.strictObject({
    exit: z.number().int().min(0).max(125), signal: detail, rulesOut: z.array(z.string()).min(1),
  })).min(1).max(12) }),
]);
const finding = z.discriminatedUnion("kind", [
  framed.extend({
    kind: z.literal("confirmed"), surface: detail, driver: detail, replay: command, regression,
    crossesBoundary: z.boolean(), history: detail, contested: z.boolean().optional(), challenge: z.boolean().optional(),
    hypotheses: z.array(hypothesis).min(2).max(20).optional(),
  }),
  z.strictObject({ kind: z.literal("blocked"), why: detail }),
]);
const proofSchema = z.strictObject({
  before: evidenceSchema(), after: evidenceSchema(), red: evidenceSchema().nullable(), green: evidenceSchema().nullable(),
  redHead: z.string().nullable(), baseHead: z.string(), surface: detail, driver: detail, mechanism: z.array(evidenceSchema()),
  rejectedRed: z.array(evidenceSchema()),
  challenge: interrogationSchema().optional(),
});
const reviseRed = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("revise"), instruction: detail }),
  z.strictObject({ kind: z.literal("blocked"), why: detail }),
]);

type Receipt = Z.output<ReturnType<typeof evidenceSchema>>;
const blocked = (why: string, proof?: Receipt[], challenge?: Z.output<ReturnType<typeof interrogationSchema>>) => ({
  status: "blocked" as const, why, ...(proof === undefined ? {} : { proof }), ...(challenge === undefined ? {} : { challenge }),
});
const expectedFailure = (run: Receipt, signal: string) =>
  run.complete && run.exit !== null && run.exit > 0 && run.exit < 126 && run.tail.includes(signal);

export default workflow(
  {
    name: "pstack-bug-fix",
    description: "Find a bug's cause and carry its fix to a pull request",
    input: playbookInput(),
    output: z.discriminatedUnion("status", [changedSchema().extend({ framed, proof: proofSchema }), z.strictObject({
      status: z.literal("blocked"), why: detail, proof: z.array(evidenceSchema()).optional(), challenge: interrogationSchema().optional(),
    })]),
    uses: [
      "pstack.roles", "session.start.*", "session.ask", "session.end", "pstack.author.options", "box.net@{repo.host}",
      "git.worktree.create", "git.worktree.get", "proc.run@{worktrees}/*", "pstack.pr.bind",
      "forge.pr.ensure@{repo.host}/{repo.path}/pr/*", "forge.pr.read@{repo.host}/{repo.path}",
      "forge.pipeline.read@{repo.host}/{repo.path}", "forge.checks.read@{repo.host}/{repo.path}",
      "evidence.attest", "evidence.covers", "evidence.list",
    ],
    phases: [{ title: "Frame" }, { title: "Reproduce" }, { title: "Build" }, { title: "Verify" }],
  },
  async ({ task, repo, worktrees, base }) => {
    const seats = await roles();
    phase("Frame");
    const got = await frame(text, {
      task, repo, roles: seats, schema: finding,
      ask: [
        "Use the matching control surface yourself. Synthesize a trigger or instrument it if needed. Give an executable replay with its expected failure text, surface and driver. Block with the specific gap if unavailable.",
        "Use Why: read introducing and later commits and relevant PR discussion when accessible. Cite authors' rationale separately from inference. Split competing hypotheses with runtime probes. Confirm the mechanism before scoping the fix.",
        "If plausible alternatives remain after the initial investigation, provide their distinct hypothesis IDs and claims. The workflow will execute discriminating probes before authorizing the fix.",
        "Choose a cheap focused regression test and exact test-only paths, or explain why the test is impractical. Mark any function boundary crossing and whether multiple architecture shapes remain viable. Request an independent challenge if concrete adversarial probes could disprove the surviving mechanism.",
      ],
    });
    if (got.kind === "blocked") return blocked(got.why);
    phase("Reproduce");
    const wt = await makeWorktree({ repo: repo.local, base, description: "Reproduce and fix the bug" });
    const start = await exactCheckout(wt, "repro-base");
    const before = await replay("repro-before", wt.path, got.replay.command);
    await exactCheckout(wt, "repro-base-after", start);
    if (!expectedFailure(before, got.replay.failingSignal)) return blocked("The matching-surface replay did not reproduce the expected failure", [before]);

    const mechanism: Receipt[] = [];
    let cause = got.cause;
    if (got.hypotheses) {
      let survivors = got.hypotheses;
      if (new Set(survivors.map(({ id }) => id)).size !== survivors.length) return blocked("Hypotheses need distinct IDs", [before]);
      while (survivors.length > 1) {
        const label = `diagnose-${mechanism.length + 1}`;
        const next = await frame(text, { task, repo, roles: seats, schema: split, label, ask: [
          "Choose a runtime probe on the reproduced surface that splits the largest remaining set. Specify distinct exit/signal outcomes and the hypothesis IDs each outcome rules out. Block if no trustworthy observation is available.",
          JSON.stringify({ survivors, observations: [before, ...mechanism].map(({ exit, tail }) => ({ exit, tail })) }),
        ] });
        if (next.kind === "blocked") return blocked(next.why, [before, ...mechanism]);
        const result = await replay(label, wt.path, next.command);
        await exactCheckout(wt, `${label}-head`, start);
        mechanism.push(result);
        const matched = next.outcomes.filter(({ exit, signal }) => result.complete && result.exit === exit && result.tail.includes(signal));
        const ruledOut = new Set(matched[0]?.rulesOut);
        const remaining = survivors.filter(({ id }) => !ruledOut.has(id));
        if (matched.length !== 1 || remaining.length === 0 || survivors.length - remaining.length !== ruledOut.size) {
          return blocked("The runtime probe did not distinguish the remaining hypotheses", [before, ...mechanism]);
        }
        survivors = remaining;
      }
      cause = survivors[0]!.claim;
    }
    const context = [cause, got.evidence, got.history, before.tail, ...mechanism.map(({ tail }) => tail)];
    const challenge = got.challenge ? await interrogate({ playbook: text, task, repo, base, worktrees, roles: seats },
      `Try to disprove the observed bug mechanism. Preserve this intended behavior: ${task}\n${context.join("\n")}`,
      { mechanism: { sha: start, path: wt.path } }, [seats.reviewer, seats.verifier, seats.judge]) : undefined;
    if (challenge) {
      context.push(JSON.stringify(challenge));
      if (challenge.confirmed.length) {
        const decision = await frame(text, { task, repo, roles: seats, label: "challenge-decision", schema: z.discriminatedUnion("kind", [
          z.strictObject({ kind: z.literal("retain"), evidence: detail }),
          z.strictObject({ kind: z.literal("blocked"), why: detail }),
        ]), ask: [
          "Review the independently replayed counterexamples. Retain the mechanism only if the counterexamples are consistent with it. Otherwise block and record what the diagnosis must revisit.",
          ...context,
        ] });
        if (decision.kind === "blocked") return blocked(decision.why, [before, ...mechanism], challenge);
        context.push(decision.evidence);
      }
    }
    if (got.crossesBoundary && got.contested) {
      const compared = await compareArchitecture({ playbook: text, task, cwd: repo.local, seats, context: context.join("\n") });
      context.push(JSON.stringify(compared));
    }
    const plan = got.crossesBoundary ? await boundaryArchitecture(text, {
      task, repo, roles: seats, evidence: context,
    }) : null;
    if (plan?.kind === "blocked") return blocked(plan.why, [before, ...mechanism], challenge);

    phase("Build");
    const author = await localAuthor("bug-author", wt);
    let red: Receipt | null = null;
    let green: Receipt | null = null;
    let redHead: string | null = null;
    const rejectedRed: Receipt[] = [];
    let fixed: { summary: string };
    let head: string;
    try {
      const test = got.regression.kind === "test" ? got.regression : null;
      if (test) {
        let instructions = "Add only the focused failing test and commit it. Leave implementation unchanged.";
        for (let attempt = 1; ; attempt += 1) {
          const label = attempt === 1 ? "red" : `red-${attempt}`;
          await author.ask(brief(stepTag("bug-fix", "red"), text, task, [instructions, JSON.stringify(test)]),
            { schema: z.strictObject({ summary: detail }), label });
          redHead = await exactCheckout(wt, `${label}-head`);
          const parents = await gitOut(`${label}-parent`, wt.path, ["rev-list", "--parents", "-n", "1", redHead]);
          const paths = await gitOut(`${label}-paths`, wt.path, ["diff", "--no-renames", "--name-only", "-z", start, redHead]);
          if (parents !== `${redHead} ${start}` || !paths || paths.split("\0").filter(Boolean).some((path) => !test.paths.includes(path))) {
            return blocked("The red commit must be one test-only commit directly on the reproduced base", [before, ...rejectedRed]);
          }
          red = await replay(`test-${label}`, wt.path, test.command);
          await exactCheckout(wt, `test-${label}-head`, redHead);
          if (expectedFailure(red, test.failingSignal)) break;
          rejectedRed.push(red);
          const revision = await frame(text, { task, repo, roles: seats, schema: reviseRed, label: `${label}-decision`, ask: [
            "The focused test did not fail for the reproduced bug. Decide whether to correct the test within its existing scope or block with a specific reason. Do not change the implementation or weaken the intended behavior.",
            JSON.stringify({ test, before: before.tail, result: red }),
          ] });
          if (revision.kind === "blocked") return blocked(revision.why, [before, ...rejectedRed]);
          instructions = `Amend the test-only commit in this isolated worktree. Keep its original parent and leave the implementation unchanged. ${revision.instruction}`;
        }
      }
      fixed = await author.ask(brief(stepTag("bug-fix", "fix"), text, task, [
        `Implement and commit the smallest fix for ${cause}.`,
        ...context.slice(1),
        plan?.shape ?? "Keep the change inside the affected function boundary.",
        redHead === null ? `Regression test skipped: ${got.regression.kind === "skip" ? got.regression.reason : ""}` : `Keep the test from ${redHead} unchanged.`,
      ]), { schema: z.strictObject({ summary: detail }), label: "fix" });
      head = await exactCheckout(wt, "fixed-head");
      const parent = redHead ?? start;
      if (await gitOut("fix-parent", wt.path, ["rev-list", "--parents", "-n", "1", head]) !== `${head} ${parent}`) {
        return blocked("The fix must preserve the demonstrated history and add one focused commit", red ? [before, red] : [before]);
      }
      if (test && red) {
        const edits = await gitOut("test-preserved", wt.path, ["diff", "--no-renames", "--name-only", parent, head, "--", ...test.paths.map((path) => `:(literal)${path}`)]);
        if (edits) return blocked("The fix changed the previously demonstrated test", [before, red]);
        green = await replay("test-green", wt.path, test.command);
        if (!green.complete || green.exit !== 0) return blocked("The regression test did not pass on the fix", [before, red, green]);
      }
    } finally {
      await author.end();
    }
    phase("Verify");
    const after = await replay("repro-after", wt.path, got.replay.command);
    await exactCheckout(wt, "repro-fixed-after", head);
    if (!after.complete || after.exit !== 0 || after.tail.includes(got.replay.failingSignal)) {
      return blocked("The original matching-surface replay did not pass on the fix", [before, ...[red, green].filter((one) => one !== null), after]);
    }
    await publishVerified("bug-publish", wt, head);
    const evidence = `${got.surface} via ${got.driver}: before ${artifactName(before)}, after ${artifactName(after)}.`;
    const done = await deliverBuilt("change", {
      playbook: text, repo, base, worktrees, roles: seats, task, title: titleOf(task), prEvidence: evidence,
      verification: [`Independently replay ${got.replay.command} on ${got.surface} via ${got.driver}.`, evidence],
    }, { wt, author: author.address, sha: head, summary: fixed.summary });
    return {
      ...changeResult(done), framed: { cause, repro: got.repro, evidence: got.evidence },
      proof: { before, after, red, green, redHead, baseHead: start, surface: got.surface, driver: got.driver, mechanism, rejectedRed, challenge },
    };
  },
);
