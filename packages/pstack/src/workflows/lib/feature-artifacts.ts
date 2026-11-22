import { makeWorktree } from "@niwa-labs/flow-code";

import { gitOut, gitRun } from "./git.ts";
import { zod } from "./inputs.ts";
import type { Built, LaneOpts } from "./lane.ts";
import { api, authorOptions, seatOptions, stepTag } from "./script.ts";
import type { Seat } from "./script.ts";
import { brief } from "./texts.ts";

export const commitId = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

export async function ancestor(label: string, path: string, before: string, after: string) {
  if ((await gitRun(label, path, ["merge-base", "--is-ancestor", before, after])).exit !== 0) {
    throw new Error(`Checkout ${path} at ${after} does not contain ${before}`);
  }
}

/** Build unpublished implementation evidence in an independent, local-only author box. */
export async function localArtifact(key: string, opts: LaneOpts & {
  task: string; seat: Seat; startAt: string; directions: string[]; files?: string[]; allowUnchanged?: boolean;
}) {
  const z = zod();
  const wt = await makeWorktree({ repo: opts.repo.local, base: opts.startAt, description: `${opts.playbook.title}: ${key}` });
  const { model: _authorModel, effort: _authorEffort, ...settings } = await authorOptions(key, wt.path);
  if (wt.baseSha !== opts.startAt) throw new Error(`Unexpected base in artifact worktree ${wt.path}`);
  const worker = await api().session({
    ...settings, ...seatOptions(opts.seat),
    box: { only: ["project", "toolchains"] }, visible: [], label: key,
  });
  let result;
  try {
    result = await worker.ask(brief(stepTag(opts.playbook.name, key), opts.playbook, opts.task, [
      `Implement and commit on ${wt.branch} in ${wt.path}. Keep the artifact local.`,
      ...(opts.allowUnchanged ? ["Keep the existing commit if no integration edits are necessary."] : []),
      "Run relevant checks and record the actual output and any missing proof. Leave a clean checkout.",
      "Before each commit, review the staged diff against the task. Remove generated commentary, redundant wrappers and unsupported claims where the evidence warrants it. Keep rationale for external constraints that the code cannot express. Preserve unrelated files and keep the commit independently verifiable.",
      ...opts.directions,
    ]), {
      schema: z.strictObject({ sha: z.string().regex(commitId), observed: z.string().trim().min(1).max(4000) }),
      label: `${key}-artifact`,
    });
  } finally {
    await worker.end();
  }
  const sha = await gitOut(`${key}-head`, wt.path, ["rev-parse", "HEAD"]);
  const branch = await gitOut(`${key}-branch`, wt.path, ["symbolic-ref", "--short", "HEAD"]);
  const dirty = await gitOut(`${key}-status`, wt.path, ["status", "--porcelain", "--untracked-files=all"]);
  if (sha !== result.sha || (!opts.allowUnchanged && sha === wt.baseSha) || branch !== wt.branch || dirty !== "") {
    throw new Error(`Artifact ${key} lacks a clean committed change on ${wt.branch} at ${wt.path}`);
  }
  await ancestor(`${key}-base`, wt.path, wt.baseSha, sha);
  const files = opts.files;
  if (files !== undefined) {
    const modified = await gitRun(`${key}-files`, wt.path, ["diff", "--no-renames", "--name-only", "-z", wt.baseSha, sha]);
    if (modified.exit !== 0 || modified.truncated || modified.out.split("\0").filter(Boolean).some((file) => !files.includes(file))) {
      throw new Error(`Artifact ${key} changed files outside its assigned scope at ${wt.path}`);
    }
  }
  const diff = await gitRun(`${key}-diff`, wt.path, ["diff", "--no-ext-diff", "--no-textconv", wt.baseSha, sha, "--"]);
  if (diff.exit !== 0 || (!opts.allowUnchanged && diff.out.trim() === "")) throw new Error(`Artifact ${key} provides no readable Git diff`);
  return { wt, author: worker.address, sha, path: wt.path, observed: result.observed, diff: diff.truncated ? undefined : diff.out };
}

/** Give publication authority only after the local integration checks have passed. */
export async function publishArtifact(opts: LaneOpts & { task: string }, artifact: Awaited<ReturnType<typeof localArtifact>>): Promise<Built> {
  const { wt, author, sha, observed } = artifact;
  if (await gitOut("ready-head", wt.path, ["rev-parse", "HEAD"]) !== sha ||
      await gitOut("ready-branch", wt.path, ["symbolic-ref", "--short", "HEAD"]) !== wt.branch ||
      await gitOut("ready-status", wt.path, ["status", "--porcelain", "--untracked-files=all"]) !== "") {
    throw new Error("Publication requires the exact clean artifact checkout");
  }
  const z = zod();
  const publisher = await api().session({ ...await authorOptions("publish", wt.path), visible: [], label: "publish" });
  try {
    await publisher.ask(brief(stepTag(opts.playbook.name, "publish"), opts.playbook, opts.task, [
      `Publish the existing commit ${sha} on ${wt.branch} in ${wt.path}. Do not edit any file, create commits, push other refs, or open a PR.`,
      "Report once the exact commit has been published.",
    ]), { schema: z.strictObject({ sha: z.literal(sha) }), label: "publish-artifact" });
  } finally {
    await publisher.end();
  }
  const head = await gitOut("published-head", wt.path, ["rev-parse", "HEAD"]);
  const branch = await gitOut("published-branch", wt.path, ["symbolic-ref", "--short", "HEAD"]);
  const dirty = await gitOut("published-status", wt.path, ["status", "--porcelain", "--untracked-files=all"]);
  if (head !== sha || branch !== wt.branch || dirty !== "") throw new Error("Publication altered the integrated checkout");
  return { wt, author, sha, summary: observed };
}
