import { makeWorktree } from "@niwa-labs/flow-code";

import { commandSchema, decisionProbe } from "./decision-probe.ts";
import { localArtifact } from "./feature-artifacts.ts";
import { gitOut } from "./git.ts";
import { zod } from "./inputs.ts";
import type { LaneOpts } from "./lane.ts";
import { scratchFileSchema } from "./prototype-evidence.ts";
import { api, seatOptions, stepTag } from "./script.ts";
import { brief } from "./texts.ts";

export async function reshape(opts: LaneOpts & {
  task: string; contract: string; pin: string; target: string; broad: boolean;
}) {
  const z = zod();
  const detail = z.string().trim().min(1).max(3000);
  const unitSchema = z.strictObject({
    hypothesis: detail, change: detail, files: z.array(scratchFileSchema()).min(1).max(50).optional(),
  });
  const planned = await api().ask({
    ...seatOptions(opts.roles.lead), mode: "ask", cwd: opts.repo.local, visible: [], label: "characterize",
    schema: z.strictObject({
      predicate: detail,
      probe: commandSchema(),
      compare: z.enum(["output", "verdict"]).default("output"),
      checkpoint: detail.optional(),
      phases: z.array(unitSchema).min(1).max(12),
    }),
  }, brief(stepTag(opts.playbook.name, "characterize"), opts.playbook, opts.task, [
    `Contract: ${opts.contract}`, `Pin: ${opts.pin}`, `Target: ${opts.target}`,
    "Name a repeatable characterization command that exercises real behavior on trunk and each phase. Use output to compare stable observations and verdict when the command checks a pinned characterization case by exit status. Compilation or lint alone is insufficient.",
    "Name each unit's files and symbols. Use a checkpoint only when a long or high-impact run warrants explicit owner review of the phases.",
    opts.broad
      ? "Design the Figure-it-out workflow. Quantify the scope and blockers, set the rigor in the predicate, and order isolated hypotheses by risk. Settle one-way architecture decisions before implementation."
      : "Plan small behavior-preserving units. Subtract before reshaping. Migrate every caller in the same wave and avoid compatibility shims.",
  ]));
  if (opts.broad && planned.checkpoint !== undefined && !await api().ask.confirm(
    `Proceed with these phases? ${planned.checkpoint}\n\n${JSON.stringify(planned, null, 2)}`, { label: "approve-phases" },
  )) return { status: "stopped" as const, why: "The owner declined the designed phases.", receipts: [] };

  const baseline = await makeWorktree({ repo: opts.repo.local, base: opts.base, description: "Pre-refactor behavior" });
  const capture = await decisionProbe("characterization-baseline", baseline.path, planned.probe);
  const receipts = [JSON.stringify({ sha: baseline.baseSha, path: baseline.path, predicate: planned.predicate, capture })];
  if (capture.exit !== 0 || capture.truncated || (planned.compare === "output" && capture.output.trim() === "") ||
      await gitOut("baseline-head", baseline.path, ["rev-parse", "HEAD"]) !== baseline.baseSha ||
      await gitOut("baseline-clean", baseline.path, ["status", "--porcelain", "--untracked-files=no"]) !== "") {
    return { status: "stopped" as const, why: "The baseline did not capture comparable behavior.", receipts };
  }

  let startAt = baseline.baseSha;
  let accepted: Awaited<ReturnType<typeof localArtifact>> | undefined;
  const remaining = [...planned.phases];
  for (let index = 0; remaining.length > 0; index++) {
    const unit = remaining.shift()!;
    const result = await api().scope("reshape-" + (index + 1), undefined, async () => {
      const artifact = await localArtifact("reshape", {
        ...opts, seat: opts.roles.author, startAt, files: unit.files,
        directions: [`Hold this contract: ${opts.contract}`, `Target: ${opts.target}`, JSON.stringify(unit), `Keep this behavior pin green: ${JSON.stringify(planned.probe)}`],
      });
      const replay = await makeWorktree({ repo: opts.repo.local, base: artifact.sha, description: "Replay refactoring contract" });
      const observed = await decisionProbe("equivalence", replay.path, planned.probe);
      const proof = JSON.stringify({ before: startAt, after: artifact.sha, path: replay.path, hypothesis: unit.hypothesis, observed });
      if (observed.exit !== 0 || observed.truncated || (planned.compare === "output" && observed.output !== capture.output) ||
          replay.baseSha !== artifact.sha ||
          await gitOut("equivalence-head", replay.path, ["rev-parse", "HEAD"]) !== artifact.sha ||
          await gitOut("equivalence-clean", replay.path, ["status", "--porcelain", "--untracked-files=no"]) !== "") {
        return { kind: "reject" as const, why: "The new artifact did not replay the baseline.", proof };
      }
      const review = await api().ask({
        ...seatOptions(opts.roles.reviewer), mode: "ask", cwd: artifact.path, visible: [], label: "reader-load",
        schema: z.strictObject({ keep: z.boolean(), why: detail }),
      }, brief(stepTag(opts.playbook.name, "reader-load"), opts.playbook, opts.task, [
        "Inspect before and after. Keep the unit only if this shape reduces indirection, hidden state or the effort of tracing callers. Identify the actual difference and look for missed callers and workarounds.",
        proof,
      ]));
      const trail = JSON.stringify({ proof, review });
      return review.keep ? { kind: "keep" as const, artifact, proof: trail } : { kind: "reject" as const, why: review.why, proof: trail };
    });
    receipts.push(result.proof);
    if (result.kind === "reject") {
      if (!opts.broad) return { status: "stopped" as const, why: result.why, receipts };
      const decision = await api().scope("replan-" + (index + 1), undefined, () => api().ask({
        ...seatOptions(opts.roles.lead), mode: "ask", cwd: opts.repo.local, visible: [], label: "revise-phases",
        schema: z.discriminatedUnion("kind", [
          z.strictObject({ kind: z.literal("retry"), why: detail, phases: z.array(unitSchema).min(1).max(12) }),
          z.strictObject({ kind: z.literal("stop"), why: detail }),
          z.strictObject({ kind: z.literal("finish"), why: detail }),
        ]),
      }, brief(stepTag(opts.playbook.name, "revise-phases"), opts.playbook, opts.task, [
        `The rejected unit has been retained for inspection. Resume from the last accepted commit ${startAt}.`,
        "Replan the remaining hypotheses against the same predicate and baseline. If the gate itself is wrong or the contract changed, stop and explain the prerequisite for a new run. Finish with the accepted units only if they already achieve the objective.",
        JSON.stringify({ unit, remaining, result, receipts }),
      ])));
      receipts.push(JSON.stringify({ accepted: startAt, decision }));
      if (decision.kind === "stop") return { status: "stopped" as const, why: decision.why, receipts };
      if (decision.kind === "finish") break;
      remaining.splice(0, remaining.length, ...decision.phases);
      continue;
    }
    accepted = result.artifact;
    startAt = accepted.sha;
  }
  if (accepted === undefined) return { status: "stopped" as const, why: "No refactoring unit met the contract.", receipts };
  return { status: "ready" as const, artifact: accepted, receipts };
}
