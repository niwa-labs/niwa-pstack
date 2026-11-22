/**
 * A lane: one change carried by one owner from its worktree to a verified pull request.
 *
 * The author works in a box tied to its checked worktree and publishes its branch. The lane opens the pull request
 * only for the commit the author reported. The
 * verifiers, sessions that did not write the code, re-run the gates and show the behaviour live, and attest each
 * verdict under their own name; a verdict counts only when evidence says it covers the head and is not the author's.
 */

import { makeWorktree } from "@niwa-labs/flow-code";
import type { Worktree } from "@niwa-labs/flow-code";
import { durationMs } from "@niwa-labs/forge/flow";
import { pipelinesOfPr } from "@niwa-labs/forge/records";
import type { Pipeline } from "@niwa-labs/forge/records";

import { VERDICTS } from "../../policy.ts";
import type { VerdictName } from "../../policy.ts";
import { gitOut, gitRun } from "./git.ts";
import { zod } from "./inputs.ts";
import { api, authorOptions, forgeRepo, prSubject, seatOptions, stepTag } from "./script.ts";
import type { Repo, Roles, SessionAddress } from "./script.ts";
import { brief } from "./texts.ts";
import type { PlaybookText } from "./texts.ts";

/** A lane would not go on: what it refused, and why. */
export class LaneRefused extends Error {
  override name = "LaneRefused";
}

/** What a lane built: the worktree, the author's address and the commit it made. */
export interface Built {
  wt: Worktree;
  author: SessionAddress;
  sha: string;
  summary: string;
}

/** What the lanes of a playbook are given. */
export interface LaneOpts {
  playbook: PlaybookText;
  repo: Repo;
  base: string;
  worktrees: string;
  roles: Roles;
}

const AUTHOR_CAN_DELEGATE = new Set(["bug-fix", "feature", "perf-issue", "refactoring"]);

/** Build a change: a worktree off `base`, an author boxed to it, and the commit the author made and published there. */
type Progress = (stage: { stage: string; wt: Worktree; pr?: { number: number; head: string } }) => void;

export async function build(key: string, opts: LaneOpts & { task: string; extra?: string[]; progress?: Progress }): Promise<Built> {
  const z = zod();
  const wt = await makeWorktree({ repo: opts.repo.local, base: opts.base, description: `${opts.playbook.title}: ${opts.task}`.slice(0, 120) });
  opts.progress?.({ stage: "author", wt });
  const canDelegate = AUTHOR_CAN_DELEGATE.has(opts.playbook.name);
  const author = await api().session({
    ...await authorOptions(`${key}-author`, wt.path, canDelegate),
    label: `${key}-author`,
  });
  const done = await author.ask(
    brief(stepTag(opts.playbook.name, "build"), opts.playbook, opts.task, [
      `Work in ${wt.path}, on the branch ${wt.branch}. Commit the change there and publish the branch to the forge.`,
      "The workflow opens the PR, runs independent verification and decides whether it is ready. Do not open, merge or retarget it.",
      "Answer the commit you published and one paragraph on what changed.",
      ...(canDelegate ? [`If you use a helper, start it on ${author.address.harness}.`] : []),
      ...(opts.extra ?? []),
    ]),
    { schema: z.strictObject({ sha: z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/), summary: z.string().min(1).max(4000) }), label: `${key}-build` },
  );
  await author.end();
  const head = await gitOut(`${key}-head`, wt.path, ["rev-parse", "HEAD"]);
  if (head !== done.sha) throw new LaneRefused(`the author answered ${done.sha}, but its worktree is at ${head}`);
  return { wt, author: author.address, sha: head, summary: done.summary };
}

/** Open the pull request of a built change, only for the commit the author made. */
export async function openPr(key: string, opts: { repo: Repo; base: string; built: Built; title: string; description: string; draft?: boolean }): Promise<{ number: number; head: string; subject: string }> {
  const out = (await api().call(
    "forge.pr.ensure",
    {
      repo: forgeRepo(opts.repo),
      branch: opts.built.wt.branch,
      base: opts.base,
      title: opts.title,
      description: opts.description,
      ...(opts.draft === undefined ? {} : { draft: opts.draft }),
    },
    { label: key },
  )) as { pr: { number: number }; head: string };
  if (out.head !== opts.built.sha) {
    throw new LaneRefused(`the forge has ${out.head} at the head of ${opts.built.wt.branch}, not ${opts.built.sha} the author made: a push the lane did not make`);
  }
  const { id, path, branch, repo } = opts.built.wt;
  await api().call("pstack.pr.bind", {
    repo: forgeRepo(opts.repo), number: out.pr.number, head: out.head, author: opts.built.author, worktree: { id, path, branch, repo },
  }, { label: `${key}-bind` });
  return { number: out.pr.number, head: out.head, subject: prSubject(opts.repo, out.pr.number) };
}

/** What a verdict came to: covered at the head by a verifier that is not the author, or why not. */
export type VerdictFound = { name: VerdictName; covered: boolean; why?: string; outcome: "pass" | "fail"; evidence: string };

/**
 * Verify a head: for each verdict, a verifier session that did not write the code checks it in the worktree and
 * attests what it found under its own name; the verdict counts when evidence says so, not the author's.
 */
export async function verify(
  key: string,
  opts: LaneOpts & { subject: string; sha: string; cwd: string; author: SessionAddress; task: string; names?: readonly VerdictName[]; extra?: string[]; liveActions?: readonly string[]; knownLiveFailure?: string },
): Promise<VerdictFound[]> {
  const z = zod();
  const found: VerdictFound[] = [];
  for (const name of opts.names ?? VERDICTS) {
    const clean = await gitRun(key + "-" + name + "-clean", opts.cwd, ["diff", "--quiet", "HEAD", "--"]);
    if (clean.exit !== 0) throw new LaneRefused("cannot verify with uncommitted tracked changes");
    const checked = await gitOut(`${key}-${name}-checkout`, opts.cwd, ["rev-parse", "HEAD"]);
    if (checked !== opts.sha) throw new LaneRefused(`cannot verify ${opts.sha}: the checkout is at ${checked}`);
    const verifier = await api().session({
      ...seatOptions(opts.roles.verifier),
      label: `${key}-${name}-start`,
      cwd: opts.cwd,
      visible: ["evidence.attest", ...(name === "live" ? opts.liveActions ?? [] : [])],
    });
    const what =
      name === "gates"
        ? "Run the repository's gates (type check, lint, tests) on this commit yourself."
        : "Drive the real surface the change touches and show its load-bearing behaviour on this commit.";
    const said = await verifier.ask(
      brief(stepTag(opts.playbook.name, `verify-${name}`), opts.playbook, opts.task, [
        `You did not write this change. Verify ${opts.subject} at ${opts.sha} in ${opts.cwd}. ${what}`,
        "Keep the source and branch unchanged. Give a failing verdict if the check cannot be run, is inconclusive, or targets the wrong surface.",
        ...(opts.extra ?? []),
        `Then attest what you found with evidence.attest: subject "${opts.subject}", claim { kind: "verdict", name: "${name}", outcome: "pass" or "fail", sha: "${opts.sha}" }.`,
        "Answer the outcome and the evidence it rests on.",
      ]),
      { schema: z.strictObject({ outcome: z.enum(["pass", "fail"]), evidence: z.string().min(1).max(4000) }), label: `${key}-${name}` },
    );
    await verifier.end();
    const checkedAfter = await gitOut(key + "-" + name + "-head-after", opts.cwd, ["rev-parse", "HEAD"]);
    const cleanAfter = await gitRun(key + "-" + name + "-clean-after", opts.cwd, ["diff", "--quiet", "HEAD", "--"]);
    const failure = checkedAfter !== opts.sha || cleanAfter.exit !== 0 ? "Verification changed the checkout"
      : said.outcome === "fail" ? said.evidence
      : name === "live" ? opts.knownLiveFailure : undefined;
    if (failure !== undefined) {
      await api().call("evidence.attest", { subject: opts.subject, claim: { kind: "verdict", name, outcome: "fail", sha: opts.sha } }, { label: `${key}-${name}-reported-failure` });
    }
    const covers = failure === undefined
      ? await verifierCoverage(key + "-" + name, { ...opts, name, verifier: verifier.address })
      : { covered: false, why: failure };
    found.push({ name, covered: covers.covered, ...(covers.why === undefined ? {} : { why: covers.why }), outcome: failure === undefined ? "pass" : "fail", evidence: failure ?? said.evidence });
  }
  return found;
}

/** Match the evidence module's winning receipt to the seat that ran this verification. */
async function verifierCoverage(
  key: string,
  opts: { subject: string; name: VerdictName; sha: string; author: SessionAddress; verifier: SessionAddress },
): Promise<{ covered: boolean; why?: string }> {
  const z = zod();
  const result = z.object({ covered: z.boolean(), by: z.array(z.string()), why: z.string().optional() }).parse(await api().call(
    "evidence.covers", { requirement: { kind: "verdict", subject: opts.subject, name: opts.name, sha: opts.sha, notBy: [opts.author] } },
    { label: key + "-covers" },
  ));
  if (!result.covered) return { covered: false, ...(result.why === undefined ? {} : { why: result.why }) };
  const page = z.object({
    items: z.array(z.object({ id: z.string(), author: z.object({ kind: z.string(), harness: z.string().optional(), id: z.string().optional() }) })),
    next: z.number().optional(),
  });
  let after: number | undefined;
  do {
    const got = page.parse(await api().call("evidence.list", { subject: opts.subject, ...(after === undefined ? {} : { after }) }, { label: key + "-receipt-" + (after ?? "start") }));
    const proof = got.items.find((item) => result.by.includes(item.id));
    if (proof !== undefined) {
      if (proof.author.kind === opts.verifier.kind && proof.author.harness === opts.verifier.harness && proof.author.id === opts.verifier.id) return { covered: true };
      break;
    }
    after = got.next;
  } while (after !== undefined);
  return { covered: false, why: "No current verifier receipt" };
}

/** The latest head pipeline of this PR, independent of merge-result and train CI. */
export async function prHeadPipeline(key: string, opts: { repo: Repo; number: number; sha: string }): Promise<Pipeline | undefined> {
  const { items } = await api().call(
    "forge.pipeline.read", { repo: forgeRepo(opts.repo), sha: opts.sha, kind: "head" }, { label: key },
  ) as { items: Pipeline[] };
  return items.find((one) => one.kind === "head" && one.pr === opts.number && one.sourceSha === opts.sha);
}

/** Wait for the pipeline of a pull request's head, and attest it when it is green. */
export async function headCi(key: string, opts: { repo: Repo; number: number; subject: string; sha: string; deadline?: string }): Promise<{ outcome: "green" | "red" | "timed-out"; pipeline?: number }> {
  const repo = forgeRepo(opts.repo);
  const until = await api().now({ label: key + "-start" }) + durationMs(opts.deadline ?? "2h");
  const query = pipelinesOfPr({ repo, number: opts.number });
  let from: number | undefined;
  for (let round = 1; ; round++) {
    const pipeline = await prHeadPipeline(`${key}-head-read-${round}`, opts);
    const pr = await api().call("forge.pr.read", { repo, number: opts.number }, { label: `${key}-pr-head-${round}` }) as { head: string };
    if (pr.head !== opts.sha) return { outcome: "timed-out" };
    if (pipeline?.state === "failed" || pipeline?.state === "canceled") return { outcome: "red", pipeline: pipeline.pipeline };
    if (pipeline?.state === "success") {
      await api().call("evidence.attest", { subject: opts.subject, claim: { kind: "ci", at: "head", sha: opts.sha, pipeline: pipeline.pipeline } }, { label: key + "-attest" });
      return { outcome: "green", pipeline: pipeline.pipeline };
    }
    const remaining = until - await api().now({ label: `${key}-head-now-${round}` });
    if (remaining <= 0) return { outcome: "timed-out" };
    const waited = await api().wait(query, { ...(from === undefined ? {} : { from }), timeout: Math.min(300_000, remaining), label: `${key}-head-wait-${round}` });
    if (!("timedOut" in waited)) from = waited.at;
  }
}

/** A change carried to a verified pull request: built, opened, verified, and its head pipeline green. */
export interface Delivered {
  built: Built;
  pr: { number: number; head: string; subject: string };
  verdicts: VerdictFound[];
  ci: { outcome: "green" | "red" | "timed-out"; pipeline?: number };
  verified: boolean;
}

/** Carry one change from a worktree to a verified pull request. */
export async function deliver(key: string, opts: LaneOpts & { task: string; title: string; extra?: string[]; verification?: string[]; liveActions?: readonly string[]; draft?: boolean; progress?: Progress }): Promise<Delivered> {
  const built = await build(`${key}-build`, opts);
  return deliverBuilt(key, opts, built);
}

/** Open and verify a change whose author has already finished. */
export async function deliverBuilt(key: string, opts: LaneOpts & { task: string; title: string; verification?: string[]; liveActions?: readonly string[]; knownLiveFailure?: string; prEvidence?: string; draft?: boolean; progress?: Progress }, built: Built): Promise<Delivered> {
  opts.progress?.({ stage: "open PR", wt: built.wt });
  const pr = await openPr(`${key}-pr`, {
    repo: opts.repo,
    base: opts.base,
    built,
    title: opts.title,
    description: ["## Why", opts.task, "## What changed", built.summary, ...(opts.prEvidence === undefined ? [] : ["## Verification", opts.prEvidence])].join("\n\n"),
    ...(opts.draft === undefined ? {} : { draft: opts.draft }),
  });
  opts.progress?.({ stage: "independent verification", wt: built.wt, pr });
  const verdicts = await verify(`${key}-verify`, { ...opts, extra: opts.verification ?? [], subject: pr.subject, sha: pr.head, cwd: built.wt.path, author: built.author });
  opts.progress?.({ stage: "CI", wt: built.wt, pr });
  const ci = await headCi(`${key}-ci`, { repo: opts.repo, number: pr.number, subject: pr.subject, sha: pr.head });
  return { built, pr, verdicts, ci, verified: verdicts.every((one) => one.covered) && ci.outcome === "green" };
}
