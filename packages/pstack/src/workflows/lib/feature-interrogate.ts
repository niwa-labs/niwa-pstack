import { isFatal } from "@niwa-labs/flow";
import { makeWorktree } from "@niwa-labs/flow-code";
import type { z as Z } from "zod";

import { commandSchema, decisionProbe } from "./decision-probe.ts";
import { gitOut } from "./git.ts";
import { zod } from "./inputs.ts";
import type { LaneOpts } from "./lane.ts";
import { api, authorOptions, seatOptions, stepTag } from "./script.ts";
import type { Seat } from "./script.ts";
import { brief } from "./texts.ts";

function findingSchema() {
  const z = zod();
  return z.strictObject({
    candidate: z.string(),
    title: z.string().min(1).max(200),
    cause: z.string().trim().min(1).max(1000),
    cmd: commandSchema(),
    expected: z.strictObject({ exit: z.number().int(), output: z.string().max(8000) }),
    observed: z.strictObject({ exit: z.number().int(), output: z.string().max(8000) }),
  });
}

export function interrogationSchema() {
  const z = zod();
  return z.strictObject({
    intent: z.string(),
    responded: z.array(z.number().int().positive()),
    confirmed: z.array(z.strictObject({ proofs: z.array(z.strictObject({
      finding: findingSchema(), sha: z.string(), by: z.array(z.number().int().positive()),
    })) })),
    dropped: z.array(z.strictObject({ adversary: z.number().int().positive(), reason: z.string(), title: z.string().optional() })),
  });
}

export async function interrogate(
  opts: LaneOpts & { task: string },
  intent: string,
  candidates: Record<string, { sha: string; path: string }>,
  seats: Array<Seat | undefined>,
) {
  const z = zod();
  const finding = findingSchema().extend({ candidate: z.string().refine((id) => Object.hasOwn(candidates, id)) });
  const entries = Object.entries(candidates);
  const reports = await api().parallel(seats.map((seat, index) => async () => {
    try {
      if (seat === undefined) return { reason: "Adversary seat is unavailable.", findings: [] };
      const [first, initial] = entries[0]!;
      const wt = await makeWorktree({ repo: opts.repo.local, base: initial.sha, description: `Adversary ${index + 1}: ${first}` });
      if (wt.baseSha !== initial.sha) throw new Error("The adversary checkout does not match its candidate");
      const checkouts = entries.map(([candidate, artifact]) => ({ candidate, sha: artifact.sha }));
      const label = "adversary-" + (index + 1);
      const { model: _authorModel, effort: _authorEffort, ...settings } = await authorOptions(label, wt.path);
      const found = await api().ask({
        ...settings, ...seatOptions(seat), mode: "full", worktree: undefined,
        box: { only: ["project", "toolchains"] }, visible: [], label,
        schema: z.strictObject({ findings: z.array(finding).max(12) }),
      }, brief(stepTag("feature", "interrogate"), opts.playbook, opts.task, [
        "Break the stated intent with runs against the provided exact commits. Use only your own scratch checkout. Switch to the named commit before testing a different candidate. Keep any repro scripts in scratch and return a command that can run in a fresh copy. Report the exact exit and output and what the intent requires. Empty findings are valid.",
        intent, JSON.stringify(checkouts),
      ]));
      return { findings: found.findings };
    } catch (error) {
      if (!(error instanceof Error) || isFatal(error) || error.name === "Cancelled" || error.name === "PauseSignal") throw error;
      return { reason: error.message, findings: [] };
    }
  }));
  const confirmed = new Map<string, { proofs: Array<{ finding: Z.output<typeof finding>; sha: string; by: number[] }> }>();
  const dropped: Array<{ adversary: number; reason: string; title?: string }> = [];
  for (const [index, report] of reports.entries()) {
    if (report.reason !== undefined) dropped.push({ adversary: index + 1, reason: report.reason });
    for (const [number, one] of report.findings.entries()) {
      const sha = candidates[one.candidate]!.sha;
      const wt = await makeWorktree({ repo: opts.repo.local, base: sha, description: `Independent review replay ${index + 1}.${number + 1}` });
      const actual = await decisionProbe(`replay-${index + 1}-${number + 1}`, wt.path, one.cmd);
      const clean = await gitOut(`replay-clean-${index + 1}-${number + 1}`, wt.path, ["status", "--porcelain", "--untracked-files=no"]);
      const head = await gitOut(`replay-head-${index + 1}-${number + 1}`, wt.path, ["rev-parse", "HEAD"]);
      const matches = (expected: typeof one.observed) => actual.exit === expected.exit && actual.output.trimEnd() === expected.output.trimEnd();
      if (wt.baseSha !== sha || head !== sha || clean !== "" || actual.truncated || !matches(one.observed) || matches(one.expected)) {
        dropped.push({ adversary: index + 1, title: one.title, reason: "Independent replay did not reproduce a clean, distinct failure at the exact commit." });
        continue;
      }
      const key = one.cause.trim().toLowerCase().replace(/\s+/g, " ");
      const group = confirmed.get(key) ?? { proofs: [] };
      const previous = group.proofs.find((proof) => proof.sha === sha &&
        JSON.stringify(proof.finding.cmd) === JSON.stringify(one.cmd) &&
        JSON.stringify(proof.finding.expected) === JSON.stringify(one.expected) &&
        JSON.stringify(proof.finding.observed) === JSON.stringify(one.observed));
      if (previous === undefined) group.proofs.push({ finding: one, sha, by: [index + 1] });
      else if (!previous.by.includes(index + 1)) previous.by.push(index + 1);
      confirmed.set(key, group);
    }
  }
  const responded = reports.flatMap((report, index) => report.reason === undefined ? [index + 1] : []);
  return { intent, responded, confirmed: [...confirmed.values()], dropped };
}
