import { map } from "@niwa-labs/flow";
import { makeWorktree } from "@niwa-labs/flow-code";
import type { Worktree } from "@niwa-labs/flow-code";

import { frame, titleOf } from "./change.ts";
import { gitOut } from "./git.ts";
import { zod } from "./inputs.ts";
import { deliverBuilt } from "./lane.ts";
import { calibrate, calibrationSchema, paired, pairedSchema, separated } from "./parity-benchmark.ts";
import type { Workload } from "./parity-benchmark.ts";
import { artifactName, capture, evidenceSchema, exactCheckout, localAuthor, publishVerified, replay } from "./parity-proof.ts";
import { api, roles, stepTag } from "./script.ts";
import type { Repo, SessionAddress } from "./script.ts";
import { brief } from "./texts.ts";
import type { PlaybookText } from "./texts.ts";

type Row = {
  attempt: number; hypothesis: string; before: number; after: number | null; verdict: "kept" | "reverted";
  change: string; tests: string; note: string; worktree: string;
};
const tsv = (value: unknown) => String(value ?? "").replace(/[\t\r\n]/g, " ");

function attemptSchema() {
  const z = zod();
  return z.strictObject({ number: z.number().int().positive(), head: z.string(), pair: pairedSchema(), gate: evidenceSchema() });
}

export function climbProofSchema() {
  const z = zod();
  return z.strictObject({
    calibration: calibrationSchema(), attempts: z.array(attemptSchema()), ledgerPath: z.string(), ledger: evidenceSchema(),
    why: z.string(), next: z.string(), percentDelta: z.number().nullable(),
    delivery: z.strictObject({ number: z.number(), head: z.string(), verified: z.boolean() }).nullable(),
  });
}

export function climbWakeSchema() {
  const z = zod();
  return z.strictObject({ heartbeatMs: z.number().int().min(1).max(86_400_000), pr: z.number().int().positive().optional() });
}

type Wake = ReturnType<typeof climbWakeSchema>["_output"];

export async function waitForClimb(wake: Wake, repo: Repo, attempt: number) {
  if (wake.pr === undefined) {
    await api().sleep(wake.heartbeatMs, { label: `climb-heartbeat-${attempt}` });
    return;
  }
  const filter = { "pr.repo.host": repo.host, "pr.repo.path": repo.path, "pr.number": wake.pr };
  const { next } = await api().read.records({ types: ["forge.checks"], filter, tail: 1 }, { label: `climb-position-${attempt}` });
  await api().wait("forge.checks", { filter, from: next, timeout: wake.heartbeatMs, label: `climb-wake-${attempt}` });
}

export async function runMeasuredClimb(opts: {
  text: PlaybookText; task: string; repo: Repo; base: string; worktrees: string;
  metric: string; direction: "lower" | "higher"; target: number; min: number; max: number; noise: number;
  workload: Workload; publish: boolean; wake?: Wake;
}, initial: Worktree, climb: () => void) {
  const { text, task, repo, base, worktrees, metric, direction, target, min, max, noise, workload } = opts;
  const z = zod();
  const initialHead = await exactCheckout(initial, "calibration-head");
  const calibration = await calibrate(initial.path, metric, workload, direction);
  await exactCheckout(initial, "calibration-finished", initialHead);
  const rows: Row[] = [];
  const attempts: Array<ReturnType<typeof attemptSchema>["_output"]> = [];
  const reference = calibration.reference;
  let best = reference?.median ?? null;
  let winner = initial;
  let head = initialHead;
  let lastAuthor: SessionAddress | null = null;
  let next = "";
  let delivery: null | { number: number; head: string; verified: boolean } = null;
  const ledgerName = `.pstack-hillclimb-${initial.id}/decision.tsv`;
  if (!/^\.pstack-hillclimb-[a-zA-Z0-9_-]+\/decision\.tsv$/.test(ledgerName)) throw new Error("Cannot allocate a safe hillclimb decision log path");
  const ledgerPath = `${worktrees}/${ledgerName}`;
  const writeLedger = async () => {
    const contents = [
      "id\thypothesis\tchange\tbefore\tafter\tdelta\ttests\tverdict\tnote",
      ...rows.map((row) => [
        row.attempt, row.hypothesis, row.change, row.before, row.after,
        row.after === null ? null : row.after - row.before, row.tests, row.verdict, row.note,
      ].map(tsv).join("\t")),
    ].join("\n") + "\n";
    const receipt = await capture(`decision-${rows.length}`, worktrees, [
      "python3", "-c", [
        "import os, pathlib, sys, tempfile",
        "file = pathlib.Path(sys.argv[1])",
        "file.parent.mkdir(mode=0o700, exist_ok=True)",
        "if file.parent.is_symlink() or file.is_symlink(): raise ValueError('Unsafe decision path')",
        "current = file.read_bytes() if file.exists() else b''",
        "contents = sys.argv[2].encode()",
        "if contents != current and not current.startswith(contents):",
        "    if not contents.startswith(current): raise ValueError('Decision history diverged')",
        "    with tempfile.NamedTemporaryFile(dir=file.parent, delete=False) as output:",
        "        output.write(contents)",
        "    os.replace(output.name, file)",
        "sys.stdout.buffer.write(contents)",
      ].join("\n"), ledgerName, contents,
    ]);
    if (receipt.exit !== 0) throw new Error(`Unable to preserve the hillclimb decision log at ${ledgerPath}`);
    return receipt;
  };
  let ledger = await writeLedger();
  const reached = () => best !== null && (direction === "lower" ? best <= target : best >= target);
  const finish = (why: string) => ({
    status: rows.length >= min && reached() ? "reached" as const : "stopped" as const,
    baseline: reference?.median ?? null, final: best, worktree: winner.path, head, rows,
    proof: { calibration: calibration.evidence, attempts, ledgerPath, ledger, why, next, delivery,
      percentDelta: reference && reference.median !== 0 && best !== null ? 100 * (best - reference.median) / Math.abs(reference.median) : null },
  });
  if (!reference) return finish("The frozen harness did not calibrate on contrasting workloads with a green gate and a real profile");

  const seats = await roles();
  const candidate = z.strictObject({ hypothesis: z.string().trim().min(1).max(2000), simplification: z.boolean() });
  const plans = z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("attempts"), hypotheses: z.array(candidate).min(1).max(6) }),
    z.strictObject({ kind: z.literal("stop"), why: z.string().min(1), next: z.string() }),
  ]);
  climb();
  let why = "The attempt budget was spent";
  while (rows.length < max && !(rows.length >= min && reached())) {
    const first = rows.length + 1;
    if (rows.length && opts.wake) await waitForClimb(opts.wake, repo, first);
    const plan = await frame(text, { task, repo, roles: seats, schema: plans, label: `hypotheses-${first}`, ask: [
      `Ground one mechanism per attempt in the architecture and ${workload.limiter}. Order performance hypotheses by remove, reuse, reduce, defer, hide, parallelize, cheapen. Send independent hypotheses together. Do not combine changes that depend on each other.`,
      `Best ${best}, target ${target}, decision log ${ledgerPath}. Pivot category after repeated rejects. Stop if the remaining ideas are marginal and say what you would try next.`,
      JSON.stringify(rows),
    ] });
    if (plan.kind === "stop") { why = plan.why; next = plan.next; break; }
    const batch = plan.hypotheses.slice(0, Math.min(max - rows.length, reached() ? min - rows.length : max));
    const parent = head;
    const indexed = batch.map((idea, index) => ({ idea, attempt: first + index }));
    const builds = await map(`attempts-${first}`, indexed, { key: ({ attempt }) => `approach-${attempt}` },
      async ({ idea, attempt }) => {
        const key = `climb-${attempt}`;
        const wt = await makeWorktree({ repo: repo.local, base: parent, description: `Improve workload approach ${attempt}` });
        const author = await localAuthor(key, wt);
        try {
          await author.ask(brief(stepTag("hillclimb", "attempt"), text, task, [
            idea.hypothesis, "Make one focused commit. Preserve the frozen benchmark and regression gate.",
          ]), { label: key, schema: z.strictObject({ summary: z.string().min(1) }) });
        } finally {
          await author.end();
        }
        const sha = await exactCheckout(wt, `${key}-authored`);
        const lineage = await gitOut(`${key}-parents`, wt.path, ["rev-list", "--parents", "-n", "1", sha]);
        const harnessEdits = workload.harnessPaths.length ? await gitOut(`${key}-harness`, wt.path, ["diff", "--name-only", parent, sha, "--", ...workload.harnessPaths.map((path) => `:(literal)${path}`)]) : "";
        return { wt, sha, author: author.address, valid: lineage === `${sha} ${parent}` && !harnessEdits };
      },
    );
    const measured = [];
    const current = best!;
    for (const [index, result] of builds.entries()) {
      const number = first + index;
      const idea = batch[index]!;
      if (!result.ok || !result.value.valid) {
        measured.push({ index, valid: false as const, row: {
          attempt: number, hypothesis: idea.hypothesis, before: current, after: null, verdict: "reverted" as const,
          tests: "not run", note: result.ok ? "Invalid commit or harness changed" : result.error.message,
          change: result.ok ? result.value.sha : "", worktree: result.ok ? result.value.wt.path : "",
        } });
        continue;
      }
      const build = result.value;
      const key = `climb-${number}`;
      const pair = await paired(key, winner.path, build.wt.path, metric, workload, reference.work);
      const gate = await replay(`${key}-gate`, build.wt.path, workload.gate);
      await exactCheckout(winner, `${key}-reference`, parent);
      await exactCheckout(build.wt, `${key}-measured`, build.sha);
      attempts.push({ number, head: build.sha, pair, gate });
      const green = gate.complete && gate.exit === 0;
      const improved = !!(pair.before && pair.after && green && separated(pair.before, pair.after, direction, noise));
      const same = !!(pair.before && pair.after && green && idea.simplification &&
        (direction === "lower" ? pair.after.max <= pair.before.max + noise : pair.after.min >= pair.before.min - noise));
      measured.push({ index, valid: true as const, improved, same, build, row: {
        attempt: number, hypothesis: idea.hypothesis, before: pair.before?.median ?? current, after: pair.after?.median ?? null, verdict: "reverted" as Row["verdict"],
        tests: `${green ? "green" : "failed"} ${artifactName(gate)}`, change: build.sha, worktree: build.wt.path,
        note: improved || same ? "Parallel alternative retained for review" : "Did not beat noise with a green regression gate",
      } });
    }
    const ranked = measured.flatMap((one) => one.valid && (one.improved || one.same) ? [one] : []);
    ranked.sort((a, b) => Number(b.improved) - Number(a.improved) ||
      (direction === "lower" ? a.row.after! - b.row.after! : b.row.after! - a.row.after!));
    const selected = ranked[0];
    if (selected) {
      selected.row.verdict = "kept";
      selected.row.note = selected.improved ? "Measured improvement with green regression gate" : "Simplification held the metric with green regression gate";
      winner = selected.build.wt;
      lastAuthor = selected.build.author;
      head = selected.build.sha;
      best = selected.row.after;
    }
    for (const one of measured) { rows.push(one.row); ledger = await writeLedger(); }
    if (rows.length >= min && reached()) why = "The target and attempt floor were met";
  }
  if (opts.publish && lastAuthor) {
    await publishVerified("climb-publish", winner, head);
    const done = await deliverBuilt("climb", {
      playbook: text, repo, base, worktrees, roles: seats, task, title: titleOf(task),
      prEvidence: `${reference.median} to ${best} ${workload.unit}. Decision log: ${ledgerPath} (${artifactName(ledger)}).`,
      verification: [`Re-run ${metric} on ${workload.surface} via ${workload.driver}`, `Run the unchanged gate ${workload.gate}`],
    }, { wt: winner, sha: head, author: lastAuthor, summary: rows.filter((one) => one.verdict === "kept").map((one) => one.hypothesis).join("\n") });
    delivery = { number: done.pr.number, head: done.pr.head, verified: done.verified };
  }
  return finish(why);
}
