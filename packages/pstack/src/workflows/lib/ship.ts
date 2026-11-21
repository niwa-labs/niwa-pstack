/**
 * Landing a pull request under pstack's merge policy: the owner's go on its plan nodes, verdicts not by its author,
 * green CI on its head, and a green merge result of the pair the forge would merge now. The pipelines are read from
 * the forge when it lands, and the evidence of them is attested from what it read. Trunk that conflicts with it
 * stops it before anything is asked of the forge; any other move of trunk is what the merge result tests. Only then
 * is it merged, at the head the policy was checked on, and read back.
 */

import { durationMs, land } from "@niwa-labs/forge/flow";

import { decide, mergeRequirements } from "../../policy.ts";
import type { Found } from "../../policy.ts";
import { currentPlan, goFound } from "./go.ts";
import { api, forgeRepo, prSubject } from "./script.ts";
import type { Repo, SessionAddress } from "./script.ts";
import { trunkAffects } from "./trunk.ts";

interface LandingRead {
  state: string;
  head: string;
  base: string;
  landing?: {
    targetSha: string;
    conditionalMerge: boolean;
    pipelines: Array<{ pr?: number; pipeline: number; kind: string; state: string; sourceSha: string; targetSha?: string; mergeSha?: string }>;
  };
}

/** How a landing went. */
export type Shipped =
  | { outcome: "merged"; pr: number; sha: string; trunk: string }
  | { outcome: "refused"; pr: number; missing: Array<{ name: string; why: string }>; trunk?: string };

/** Land one pull request under the policy. */
export async function ship(
  key: string,
  opts: { repo: Repo; number: number; author?: SessionAddress | undefined; plan: string; nodes: readonly string[]; cwd: string; method?: "merge" | "squash" | "rebase"; deadline?: string },
): Promise<Shipped> {
  const repo = forgeRepo(opts.repo);
  const subject = prSubject(opts.repo, opts.number);
  const read = (await api().call("forge.pr.read", { repo, number: opts.number }, { label: `${key}-read` })) as LandingRead;
  if (read.state !== "open") return { outcome: "refused", pr: opts.number, missing: [{ name: "pr", why: `the pull request is ${read.state}` }] };
  const head = read.head;

  const { binding } = await api().call("pstack.pr.binding", { repo, number: opts.number, head }, { label: `${key}-binding` }) as { binding?: { author: SessionAddress } };
  if (!binding || (opts.author && (opts.author.harness !== binding.author.harness || opts.author.id !== binding.author.id))) {
    return { outcome: "refused", pr: opts.number, missing: [{ name: "author", why: binding ? "author differs from lane receipt" : "no unambiguous lane receipt for this head" }] };
  }
  const plan = await currentPlan(`${key}-plan`, opts.plan);
  const goes = await goFound(`${key}-go`, { plan, nodes: opts.nodes, change: `${repo.host}/${repo.path}` });

  const trunk = await trunkAffects(`${key}-trunk`, { pr: { repo, number: opts.number }, base: read.base, cwd: opts.cwd });
  if (trunk.kind === "conflict") {
    return { outcome: "refused", pr: opts.number, trunk: trunk.kind, missing: [...goes.filter((one) => !one.covered).map((one) => ({ name: one.name, why: one.why ?? "none" })), { name: "trunk", why: `conflict in ${trunk.files.join(", ")}` }] };
  }

  // CI is what the forge says in this run: the attestations are its receipts, and a claim another caller attested
  // for this head does not stand in for a pipeline the forge reports red.
  const deadline = opts.deadline ?? "2h";
  const until = (await api().now({ label: `${key}-start` })) + durationMs(deadline);
  let current: LandingRead;
  for (let round = 0; ; round++) {
    current = await api().call("forge.pr.read", { repo, number: opts.number, landing: true }, { label: `${key}-landing-${round}` }) as LandingRead;
    if (current.state !== "open" || current.head !== head || current.base !== read.base || !current.landing) break;
    const pending = current.landing.pipelines.some(one => !["success", "failed", "canceled", "skipped"].includes(one.state));
    if (!pending) break;
    const remaining = until - await api().now({ label: `${key}-now-${round}` });
    if (remaining <= 0) break;
    await api().sleep(Math.min(30_000, remaining), { label: `${key}-poll-${round}` });
  }
  if (current.state !== "open" || current.head !== head || current.base !== read.base || !current.landing) {
    return { outcome: "refused", pr: opts.number, missing: [{ name: "pr", why: "pull request moved or current target is unknown" }] };
  }
  const { targetSha, pipelines, conditionalMerge } = current.landing;
  const scoped = pipelines.filter(one => one.pr === opts.number && one.sourceSha === head);
  const headCi = scoped.find(one => one.kind === "head");
  const selected = scoped.find(one => one.kind === "merge-result");
  const headGreen = headCi?.state === "success";
  const mergeGreen = selected?.state === "success" && selected.targetSha === targetSha && selected.mergeSha !== undefined;
  if (headGreen) {
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
  if (!headGreen) found.push({ name: "head-ci", covered: false, why: headCi?.state ?? "none" });
  if (!mergeGreen) found.push({ name: "merge-result", covered: false, why: selected?.targetSha !== targetSha ? "no pipeline for the current target" : selected.state });
  const required = mergeRequirements({ subject, head, author: binding.author, target: { sha: targetSha, ...(selected === undefined ? {} : { pipeline: selected.pipeline }) } });
  for (const one of required) {
    if ((one.name === "head-ci" && !headGreen) || (one.name === "merge-result" && !mergeGreen)) continue;
    const covers = (await api().call("evidence.covers", { requirement: one.requirement }, { label: `${key}-covers-${one.name}` })) as { covered: boolean; why?: string };
    found.push({ name: one.name, covered: covers.covered, ...(covers.why === undefined ? {} : { why: covers.why }) });
  }
  const decision = decide(found);
  if (!decision.land) return { outcome: "refused", pr: opts.number, trunk: trunk.kind, missing: decision.missing };

  if (!conditionalMerge) return { outcome: "refused", pr: opts.number, trunk: trunk.kind, missing: [{ name: "land", why: "forge cannot condition a merge on the target commit" }] };
  const landed = await land(`${key}-land`, { pr: { repo, number: opts.number }, expectHead: head, expectTarget: targetSha, method: opts.method ?? "merge" });
  if (landed.outcome !== "merged") return { outcome: "refused", pr: opts.number, trunk: trunk.kind, missing: [{ name: "land", why: `${landed.outcome}: ${landed.why}` }] };
  // Merged is what the forge says once it is read back, not what the merge call answered.
  const after = (await api().call("forge.pr.read", { repo, number: opts.number }, { label: `${key}-read-back` })) as { state: string };
  if (after.state !== "merged") return { outcome: "refused", pr: opts.number, trunk: trunk.kind, missing: [{ name: "land", why: `the pull request reads ${after.state} after the merge` }] };
  return { outcome: "merged", pr: opts.number, sha: landed.sha, trunk: trunk.kind };
}
