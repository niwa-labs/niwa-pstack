// Perf issue: the lead names the measurement and the target; the baseline is measured on trunk in a worktree of its
// own, an owner lane carries the fix to a verified pull request, and the same measurement runs on the fix. The
// numbers are measured, never read off the source.

import { makeWorktree, removeWorktree } from "@niwa-labs/flow-code";
import type { ScriptApi } from "@niwa-labs/script";

import { boundaryArchitecture, changeResult, changedSchema, frame, titleOf } from "./lib/change.ts";
import { compareArchitecture } from "./lib/decision-architecture.ts";
import { playbookInput } from "./lib/inputs.ts";
import { build, deliverBuilt } from "./lib/lane.ts";
import { measure } from "./lib/measure.ts";
import { calibrate, calibrationSchema, paired, pairedSchema, profileRun, profileSchema, separated, workloadSchema } from "./lib/parity-benchmark.ts";
import { artifactName, evidenceSchema, exactCheckout, localAuthor, publishVerified, replay } from "./lib/parity-proof.ts";
import { traceResultSchema } from "./lib/trace-reduction.ts";
import { gitOut } from "./lib/git.ts";
import { brief } from "./lib/texts.ts";
import { roles, stepTag } from "./lib/script.ts";
import text from "./texts/perf-issue.json";

declare const workflow: ScriptApi["workflow"];
declare const z: ScriptApi["z"];
declare function phase(title: string): void;

const mantra = z.enum(["remove", "reuse", "reduce", "defer", "hide", "parallelize", "cheapen"]);
const attempt = z.strictObject({ mantra, hypothesis: z.string().min(1), crossesBoundary: z.boolean(), contested: z.boolean().optional() });
const planSchema = z.strictObject({
  attempts: z.array(attempt).max(7),
  skipped: z.string().min(1),
});
const hot = traceResultSchema().shape.hot;
const blockedAttempt = z.strictObject({ attempt, blocked: z.string(), head: z.string().optional() });
const measuredAttempt = z.strictObject({
  attempt, head: z.string(), profile: profileSchema(), gate: evidenceSchema(), pair: pairedSchema(),
  traceDelta: z.strictObject({ format: z.string(), samples: z.number(), weight: z.number(), beforeHot: hot, afterHot: hot }).nullable(),
});
const attemptEvidence = z.union([blockedAttempt, measuredAttempt]);
const proof = z.strictObject({ calibration: calibrationSchema(), attempts: z.array(attemptEvidence) });
const framed = z.strictObject({
  measure: z.string().min(1).max(2000).describe("A shell command whose last printed number is the metric"),
  direction: z.enum(["lower", "higher"]),
  target: z.number(),
  workload: workloadSchema().optional(),
});

export default workflow(
  {
    name: "pstack-perf-issue",
    description: "Measure a slow path, fix it, and measure the fix",
    input: playbookInput(),
    output: z.discriminatedUnion("status", [
      changedSchema().extend({ framed, baseline: z.number().nullable(), after: z.number().nullable(), met: z.boolean(), proof: proof.extend({ plan: planSchema }).optional() }),
      z.strictObject({ status: z.literal("inconclusive"), why: z.string(), framed, baseline: z.number().nullable(), after: z.number().nullable(), met: z.literal(false), proof }),
    ]),
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
      "git.worktree.get",
      "git.worktree.remove",
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
      { title: "Frame", detail: "The measurement and the target" },
      { title: "Baseline", detail: "Measured on trunk" },
      { title: "Fix", detail: "Build the measured fix in a boxed worktree" },
      { title: "Measure", detail: "The same measurement on the fix" },
      { title: "Verify", detail: "Include the measurements in the pull request and verify it independently" },
    ],
  },
  async ({ task, repo, worktrees, base }) => {
    const seats = await roles();
    phase("Frame");
    const { crossesBoundary, ...got } = await frame(text, {
      task,
      repo,
      roles: seats,
      schema: framed.extend({ crossesBoundary: z.boolean() }),
      ask: [
        "Name one shell command, run from the repository's root, whose last printed number is the metric. Give the direction and target.",
        "For calibrated work, provide the matching-surface workload with JSON work and error counters, a contrasting easier command, the unchanged gate and measurement paths, and a profiling command with the raw capture path.",
        "Trace the affected callers and say whether the proposed fix crosses a function boundary.",
      ],
    });
    phase("Baseline");
    const trunk = await makeWorktree({ repo: repo.local, base, description: "Measure the baseline on trunk" });
    const lane = { playbook: text, repo, base, worktrees, roles: seats, task, title: titleOf(task) };
    if (got.workload) {
      const spec = got.workload;
      const trunkHead = await exactCheckout(trunk, "calibration-head");
      const calibration = await calibrate(trunk.path, got.measure, spec, got.direction);
      await exactCheckout(trunk, "calibration-finished", trunkHead);
      const traces: Array<typeof attemptEvidence["_output"]> = [];
      const inconclusive = (why: string, after: number | null = null) => ({
        status: "inconclusive" as const, why, framed: got, baseline: calibration.reference?.median ?? null, after, met: false as const,
        proof: { calibration: calibration.evidence, attempts: traces },
      });
      try {
        if (!calibration.reference) return inconclusive("Calibration failed to distinguish the realistic workload, confirm the profile or pass its gate");
        const reference = calibration.reference;
        if (got.direction === "lower" ? reference.max <= got.target : reference.min >= got.target) return inconclusive("The calibrated baseline already meets the target");

        phase("Fix");
        const plan = await frame(text, { task, repo, roles: seats, schema: planSchema, label: "performance-plan", ask: [
          `Trace this baseline profile to the bottleneck: ${artifactName(calibration.evidence.profile)} ${JSON.stringify(calibration.evidence.capture?.reduced ?? calibration.evidence.profile.tail)}`,
          "Use the performance mantras in order. Give at most one attempt per applicable mantra and explain omissions. A function-boundary change goes through Architect.",
        ] });
        const options = mantra.options;
        const unique = new Set(plan.attempts.map((one) => one.mantra));
        if (unique.size !== plan.attempts.length) return inconclusive("The lead repeated a performance mantra in the plan");
        const attempts = [...plan.attempts].sort((a, b) => options.indexOf(a.mantra) - options.indexOf(b.mantra));
        let last: number | null = null;
        for (const attempt of attempts) {
          const key = `perf-${attempt.mantra}`;
          const context = [attempt.hypothesis, spec.limiter, artifactName(calibration.evidence.profile)];
          if (attempt.crossesBoundary && attempt.contested) {
            const compared = await compareArchitecture({ playbook: text, task, cwd: repo.local, seats, context: context.join("\n") });
            context.push(JSON.stringify(compared));
          }
          const design = attempt.crossesBoundary ? await boundaryArchitecture(text, {
            task, repo, roles: seats, evidence: context,
          }) : null;
          if (design?.kind === "blocked") { traces.push({ attempt, blocked: design.why }); continue; }
          const wt = await makeWorktree({ repo: repo.local, base: trunkHead, description: `Performance attempt ${attempt.mantra}` });
          const author = await localAuthor(key, wt);
          let summary: string;
          try {
            const answer = await author.ask(brief(stepTag("perf-issue", "attempt"), text, task, [
              attempt.hypothesis, design?.shape ?? "", "Make one focused commit. Preserve the frozen measurement inputs and commands.",
            ]), { label: key, schema: z.strictObject({ summary: z.string().min(1) }) });
            summary = answer.summary;
          } finally {
            await author.end();
          }
          const head = await exactCheckout(wt, `${key}-head`);
          const parent = await gitOut(`${key}-parent`, wt.path, ["rev-list", "--parents", "-n", "1", head]);
          const harnessEdits = spec.harnessPaths.length ? await gitOut(`${key}-harness`, wt.path, ["diff", "--name-only", trunkHead, head, "--", ...spec.harnessPaths.map((path) => `:(literal)${path}`)]) : "";
          if (parent !== `${head} ${trunkHead}` || harnessEdits) { traces.push({ attempt, head, blocked: "The attempt changed the harness or did not add one focused commit" }); continue; }
          phase("Measure");
          const profile = await profileRun(`${key}-profile`, wt.path, spec);
          const pair = await paired(key, trunk.path, wt.path, got.measure, spec, reference.work);
          const gate = await replay(`${key}-gate`, wt.path, spec.gate);
          await exactCheckout(trunk, `${key}-reference-after`, trunkHead);
          await exactCheckout(wt, `${key}-candidate-after`, head);
          const beforeTrace = calibration.evidence.capture?.reduced;
          const afterTrace = profile.capture?.reduced;
          const traceDelta = beforeTrace && afterTrace && beforeTrace.format === afterTrace.format ? {
            format: beforeTrace.format, samples: afterTrace.count - beforeTrace.count, weight: afterTrace.weight - beforeTrace.weight,
            beforeHot: beforeTrace.hot, afterHot: afterTrace.hot,
          } : null;
          traces.push({ attempt, head, profile, gate, pair, traceDelta });
          last = pair.after?.median ?? null;
          const atTarget = pair.after && (got.direction === "lower" ? pair.after.max <= got.target : pair.after.min >= got.target);
          if (!pair.before || !pair.after || !atTarget || !separated(pair.before, pair.after, got.direction) ||
              !beforeTrace || !afterTrace?.count || beforeTrace.format !== afterTrace.format ||
              !gate.complete || gate.exit !== 0) continue;

          phase("Verify");
          const proof = `${spec.surface} via ${spec.driver}: ${pair.before.median} to ${pair.after.median} ${spec.unit}, delta ${pair.after.median - pair.before.median}. Traces ${trunk.path}/${spec.profilePath} (${beforeTrace.sha256}) and ${wt.path}/${spec.profilePath} (${afterTrace.sha256}).`;
          await publishVerified(`${key}-publish`, wt, head);
          const done = await deliverBuilt("change", {
            ...lane, prEvidence: proof, verification: [proof, `Independently run the frozen measurement: ${got.measure}`],
          }, { wt, author: author.address, sha: head, summary });
          return { ...changeResult(done), framed: got, baseline: pair.before.median, after: pair.after.median, met: true, proof: { calibration: calibration.evidence, plan, attempts: traces } };
        }
        return inconclusive("No measured attempt reached the unchanged target beyond run-to-run variation with the regression gate green", last);
      } finally {
        if (!calibration.evidence.capture) await removeWorktree(trunk);
      }
    }
    const baseline = await measure("baseline", trunk.path, got.measure);
    await removeWorktree(trunk, true);
    if (baseline === null) throw new Error("Baseline measurement did not return a finite number; fix the measurement before changing code");
    phase("Fix");
    const metric = "Use the same workload, driver and frozen measurement throughout: " + got.measure;
    const before = "Baseline " + baseline + "; " + got.direction + " is better; target " + got.target + ".";
    const architecture = crossesBoundary ? await boundaryArchitecture(text, {
      task, repo, roles: seats, evidence: [metric, before],
    }) : undefined;
    if (architecture?.kind === "blocked") throw new Error(architecture.why);
    const built = await build("change-build", {
      ...lane, extra: [
        metric, before,
        ...(architecture === undefined ? [] : [`Approved architecture: ${architecture.shape}`]),
        "Trace the bottleneck, choose the earliest applicable performance mantra, and record before/after artifact paths.",
      ],
    });
    phase("Measure");
    const after = await measure("after", built.wt.path, got.measure);
    const met = after !== null && (got.direction === "lower" ? after <= got.target : after >= got.target);
    const proof = before + " After " + (after === null ? "inconclusive" : after + "; delta " + (after - baseline)) + ".";
    phase("Verify");
    const done = changeResult(await deliverBuilt("change", {
      ...lane, prEvidence: proof,
      knownLiveFailure: met ? "Missing calibrated workload, trace and work/error counters" : proof,
      verification: [metric, proof, "Independently repeat the frozen measurement and fail an inconclusive, wrong-surface or out-of-target result."],
    }, built));
    return { ...done, status: "unverified" as const, framed: got, baseline, after, met };
  },
);
