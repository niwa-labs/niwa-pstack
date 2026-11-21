/**
 * Landing a pull request under pstack's merge policy: the owner's go on its plan nodes, verdicts not by its author,
 * green CI on its head, and a green merge result of the pair the forge would merge now. The pipelines are read from
 * the forge when it lands, and the evidence of them is attested from what it read. Trunk that conflicts with it
 * stops it before anything is asked of the forge; any other move of trunk is what the merge result tests. Only then
 * is it merged, at the head the policy was checked on, and read back.
 */

import { land, untilPipeline } from "@niwa-labs/forge/flow";

import { decide, mergeRequirements } from "../../policy.ts";
import type { Found } from "../../policy.ts";
import { currentPlan, goFound } from "./go.ts";
import { api, forgeRepo, prSubject } from "./script.ts";
import type { Repo, SessionAddress } from "./script.ts";
import { trunkAffects } from "./trunk.ts";

/** A merge-result pipeline as `forge.pipeline.read` answers it. */
interface MergePipeline {
  pipeline: number;
  kind: "merge-result" | "train";
  sourceSha: string;
  targetSha?: string;
  mergeSha?: string;
}

/** How a landing went. */
export type Shipped =
  | { outcome: "merged"; pr: number; sha: string; trunk: string }
  | { outcome: "refused"; pr: number; missing: Array<{ name: string; why: string }>; trunk?: string };

/** Land one pull request under the policy. */
export async function ship(
  key: string,
  opts: { repo: Repo; number: number; author: SessionAddress; plan: string; nodes: readonly string[]; base: string; cwd: string; method?: "merge" | "squash" | "rebase"; deadline?: string },
): Promise<Shipped> {
  const repo = forgeRepo(opts.repo);
  const subject = prSubject(opts.repo, opts.number);
  const read = (await api().call("forge.pr.read", { repo, number: opts.number }, { label: `${key}-read` })) as { state: string; head: string };
  if (read.state !== "open") return { outcome: "refused", pr: opts.number, missing: [{ name: "pr", why: `the pull request is ${read.state}` }] };
  const head = read.head;

  const plan = await currentPlan(`${key}-plan`, opts.plan);
  const goes = await goFound(`${key}-go`, { plan, nodes: opts.nodes, change: `${repo.host}/${repo.path}` });

  const trunk = await trunkAffects(`${key}-trunk`, { pr: { repo, number: opts.number }, base: opts.base, cwd: opts.cwd });
  if (trunk.kind === "conflict") {
    return { outcome: "refused", pr: opts.number, trunk: trunk.kind, missing: [...goes.filter((one) => !one.covered).map((one) => ({ name: one.name, why: one.why ?? "none" })), { name: "trunk", why: `conflict in ${trunk.files.join(", ")}` }] };
  }

  // CI is what the forge says in this run: the attestations are its receipts, and a claim another caller attested
  // for this head does not stand in for a pipeline the forge reports red.
  const deadline = opts.deadline ?? "2h";
  const headCi = await untilPipeline(`${key}-head`, { repo, sha: head, kind: "head", deadline });
  const ci = await untilPipeline(`${key}-merge-result`, { repo, sha: head, kind: "merge-result", deadline });
  const results = (await api().call("forge.pipeline.read", { repo, sha: head, kind: "merge-result" }, { label: `${key}-pipelines` })) as { items: MergePipeline[] };
  const selected = results.items[0];
  const mergeGreen = ci.outcome === "green" && selected !== undefined && selected.pipeline === ci.pipeline && selected.targetSha !== undefined && selected.mergeSha !== undefined;
  if (headCi.outcome === "green" && headCi.pipeline !== undefined) {
    await api().call("evidence.attest", { subject, claim: { kind: "ci", at: "head", sha: head, pipeline: headCi.pipeline } }, { label: `${key}-attest-head` });
  }
  if (mergeGreen) {
    await api().call(
      "evidence.attest",
      { subject, claim: { kind: "ci", at: "merge-result", sourceSha: head, targetSha: selected.targetSha, mergeSha: selected.mergeSha, pipeline: selected.pipeline, pipelineKind: selected.kind } },
      { label: `${key}-attest-merge-result` },
    );
  }

  const found: Found[] = [...goes];
  if (headCi.outcome !== "green") found.push({ name: "head-ci", covered: false, why: headCi.outcome });
  if (!mergeGreen) found.push({ name: "merge-result", covered: false, why: selected === undefined ? "none" : ci.outcome });
  const required = mergeRequirements({ subject, head, author: opts.author, target: { sha: selected?.targetSha ?? head, ...(selected === undefined ? {} : { pipeline: selected.pipeline }) } });
  for (const one of required) {
    if ((one.name === "head-ci" && headCi.outcome !== "green") || (one.name === "merge-result" && !mergeGreen)) continue;
    const covers = (await api().call("evidence.covers", { requirement: one.requirement }, { label: `${key}-covers-${one.name}` })) as { covered: boolean; why?: string };
    found.push({ name: one.name, covered: covers.covered, ...(covers.why === undefined ? {} : { why: covers.why }) });
  }
  const decision = decide(found);
  if (!decision.land) return { outcome: "refused", pr: opts.number, trunk: trunk.kind, missing: decision.missing };

  const landed = await land(`${key}-land`, { pr: { repo, number: opts.number }, expectHead: head, method: opts.method ?? "merge" });
  if (landed.outcome !== "merged") return { outcome: "refused", pr: opts.number, trunk: trunk.kind, missing: [{ name: "land", why: `${landed.outcome}: ${landed.why}` }] };
  // Merged is what the forge says once it is read back, not what the merge call answered.
  const after = (await api().call("forge.pr.read", { repo, number: opts.number }, { label: `${key}-read-back` })) as { state: string };
  if (after.state !== "merged") return { outcome: "refused", pr: opts.number, trunk: trunk.kind, missing: [{ name: "land", why: `the pull request reads ${after.state} after the merge` }] };
  return { outcome: "merged", pr: opts.number, sha: landed.sha, trunk: trunk.kind };
}
