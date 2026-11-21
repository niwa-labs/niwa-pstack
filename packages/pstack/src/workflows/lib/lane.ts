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
import { untilPipeline } from "@niwa-labs/forge/flow";

import { VERDICTS } from "../../policy.ts";
import type { VerdictName } from "../../policy.ts";
import { gitOut } from "./git.ts";
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
export async function build(key: string, opts: LaneOpts & { task: string; extra?: string[] }): Promise<Built> {
  const z = zod();
  const wt = await makeWorktree({ repo: opts.repo.local, base: opts.base, description: `${opts.playbook.title}: ${opts.task}`.slice(0, 120) });
  const canDelegate = AUTHOR_CAN_DELEGATE.has(opts.playbook.name);
  const author = await api().session({
    ...await authorOptions(`${key}-author`, wt.path, canDelegate),
    label: `${key}-author`,
  });
  const done = await author.ask(
    brief(stepTag(opts.playbook.name, "build"), opts.playbook, opts.task, [
      `Work in ${wt.path}, on the branch ${wt.branch}. Commit the change there and publish the branch to the forge.`,
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
  opts: LaneOpts & { subject: string; sha: string; cwd: string; author: SessionAddress; task: string; names?: readonly VerdictName[] },
): Promise<VerdictFound[]> {
  const z = zod();
  const found: VerdictFound[] = [];
  for (const name of opts.names ?? VERDICTS) {
    const verifier = await api().session({
      ...seatOptions(opts.roles.verifier),
      label: `${key}-${name}-start`,
      cwd: opts.cwd,
      visible: ["evidence.attest"],
    });
    const what =
      name === "gates"
        ? "Run the repository's gates (type check, lint, tests) on this commit yourself."
        : "Drive the real surface the change touches and show its load-bearing behaviour on this commit.";
    const said = await verifier.ask(
      brief(stepTag(opts.playbook.name, `verify-${name}`), opts.playbook, opts.task, [
        `You did not write this change. Verify ${opts.subject} at ${opts.sha} in ${opts.cwd}. ${what}`,
        `Then attest what you found with evidence.attest: subject "${opts.subject}", claim { kind: "verdict", name: "${name}", outcome: "pass" or "fail", sha: "${opts.sha}" }.`,
        "Answer the outcome and the evidence it rests on.",
      ]),
      { schema: z.strictObject({ outcome: z.enum(["pass", "fail"]), evidence: z.string().min(1).max(4000) }), label: `${key}-${name}` },
    );
    await verifier.end();
    const covers = (await api().call(
      "evidence.covers",
      { requirement: { kind: "verdict", subject: opts.subject, name, sha: opts.sha, notBy: [opts.author] } },
      { label: `${key}-${name}-covers` },
    )) as { covered: boolean; why?: string };
    found.push({ name, covered: covers.covered, ...(covers.why === undefined ? {} : { why: covers.why }), outcome: said.outcome, evidence: said.evidence });
  }
  return found;
}

/** Wait for the pipeline of a pull request's head, and attest it when it is green. */
export async function headCi(key: string, opts: { repo: Repo; subject: string; sha: string; deadline?: string }): Promise<{ outcome: "green" | "red" | "timed-out"; pipeline?: number }> {
  const ci = await untilPipeline(key, { repo: forgeRepo(opts.repo), sha: opts.sha, kind: "head", deadline: opts.deadline ?? "2h" });
  if (ci.outcome === "green" && ci.pipeline !== undefined) {
    await api().call("evidence.attest", { subject: opts.subject, claim: { kind: "ci", at: "head", sha: opts.sha, pipeline: ci.pipeline } }, { label: `${key}-attest` });
  }
  return ci;
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
export async function deliver(key: string, opts: LaneOpts & { task: string; title: string; extra?: string[]; draft?: boolean }): Promise<Delivered> {
  const built = await build(`${key}-build`, opts);
  const pr = await openPr(`${key}-pr`, {
    repo: opts.repo,
    base: opts.base,
    built,
    title: opts.title,
    description: `## Why\n\n${opts.task}\n\n## What changed\n\n${built.summary}`,
    ...(opts.draft === undefined ? {} : { draft: opts.draft }),
  });
  const verdicts = await verify(`${key}-verify`, { ...opts, subject: pr.subject, sha: pr.head, cwd: built.wt.path, author: built.author });
  const ci = await headCi(`${key}-ci`, { repo: opts.repo, subject: pr.subject, sha: pr.head });
  return { built, pr, verdicts, ci, verified: verdicts.every((one) => one.covered) && ci.outcome === "green" };
}
