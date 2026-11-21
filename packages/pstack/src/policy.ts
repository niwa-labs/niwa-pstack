/**
 * pstack's merge policy, as data: what must be attested before a pull request lands, and whether what was found
 * clears it.
 *
 * A pull request lands only when every one of these holds at its current head:
 *
 * - the owner's go covers each plan node it delivers, given on the plan's current revision for this change;
 * - the `gates` and `live` verdicts passed on this head, from someone other than the author of the patch;
 * - the pipeline of this head is green;
 * - the merge result of this head into the target the forge would merge it into now is green: a merge result of
 *   another target commit, or an ordinary pipeline in its place, does not count.
 *
 * Green CI alone never clears it, and none of it is the author's to give. The checks are evidence requirements, read
 * through `evidence.covers`, except the go, whose author must be the owner or a run: `covers` can only exclude
 * authors, so the go is read through `evidence.list` and its authors are checked here.
 */

import { createHash } from "node:crypto";

/** An address, as evidence records an author. */
export type Address = { kind: string; id?: string; harness?: string };

/** A plan as the go names it: its subject and revision. */
export interface PlanRevision {
  readonly of: string;
  readonly rev: number;
}

/** The verdicts a pull request needs, besides its pipelines: the gates run again and the behaviour shown live. */
export const VERDICTS = ["gates", "live"] as const;
export type VerdictName = (typeof VERDICTS)[number];

/** The name of the verdict a go is attested as. */
export const GO = "go";

/** The subject a go of one node is attested on: `plan/<of>/rev-<rev>/<node>`, the plan's subject percent-encoded. */
export function goSubject(plan: PlanRevision, node: string): string {
  return `plan/${encodeURIComponent(plan.of)}/rev-${String(plan.rev)}/${encodeURIComponent(node)}`;
}

/**
 * The commit-shaped digest a go is attested with: the sha256 of what the owner approved, the plan revision, the node
 * and the change it lands in. A go given for another revision, node or change has another digest and covers nothing.
 */
export function goDigest(plan: PlanRevision, node: string, change: string): string {
  return createHash("sha256").update(JSON.stringify([plan.of, plan.rev, node, change])).digest("hex");
}

/** An attestation as `evidence.list` answers it, as much of it as the policy reads. */
export interface Listed {
  readonly id: string;
  readonly author: Address;
  readonly claim: { kind: string; name?: string; outcome?: string; sha?: string };
}

/** Whether an author may give a go: the owner, or a run that asked the owner. A session never may. */
export function mayGiveGo(author: Address): boolean {
  return author.kind === "owner" || (author.kind === "client" && typeof author.id === "string" && author.id.startsWith("run:"));
}

/** Whether these attestations of a node's subject hold a passing go for this revision, node and change, by one who may give it. */
export function goCovers(listed: readonly Listed[], plan: PlanRevision, node: string, change: string): { covered: boolean; by: string[]; why?: string } {
  const digest = goDigest(plan, node, change);
  const goes = listed.filter((one) => one.claim.kind === "verdict" && one.claim.name === GO && one.claim.sha === digest);
  if (goes.length === 0) return { covered: false, by: [], why: "none" };
  const allowed = goes.filter((one) => mayGiveGo(one.author));
  if (allowed.length === 0) return { covered: false, by: [], why: "not-the-owner" };
  const last = allowed.at(-1);
  if (last?.claim.outcome !== "pass") return { covered: false, by: [], why: "withdrawn" };
  return { covered: true, by: [last.id] };
}

/** The state of a pull request the policy is held to. */
export interface MergeSubject {
  /** The pull request, as evidence names it: `<host>/<path>/pr/<n>`. */
  readonly subject: string;
  /** Its head now. */
  readonly head: string;
  /** The author of the patch, as the binding gives its address. */
  readonly author: Address;
  /** The merge result the forge selected for this head now: the target commit and the pipeline. */
  readonly target: { readonly sha: string; readonly pipeline?: number };
}

/** One requirement of the policy, in the words of `evidence.covers`, with the name a refusal gives it. */
export interface Required {
  readonly name: string;
  readonly requirement: Record<string, unknown>;
}

/** The evidence requirements of a pull request at its head: the verdicts not by its author, green head CI, and a green merge result of the current pair. */
export function mergeRequirements(of: MergeSubject): Required[] {
  return [
    ...VERDICTS.map((name) => ({ name, requirement: { kind: "verdict", subject: of.subject, name, sha: of.head, notBy: [of.author] } })),
    { name: "head-ci", requirement: { kind: "ci", at: "head", subject: of.subject, sha: of.head } },
    {
      name: "merge-result",
      requirement: { kind: "ci", at: "merge-result", subject: of.subject, sourceSha: of.head, targetSha: of.target.sha, ...(of.target.pipeline === undefined ? {} : { pipeline: of.target.pipeline }) },
    },
  ];
}

/** What a check of the policy found: covered, or why not. */
export interface Found {
  readonly name: string;
  readonly covered: boolean;
  readonly why?: string;
}

/** Whether the pull request may land: every check covered, else what is missing and why. */
export function decide(found: readonly Found[]): { land: true } | { land: false; missing: Array<{ name: string; why: string }> } {
  const missing = found.filter((one) => !one.covered).map((one) => ({ name: one.name, why: one.why ?? "none" }));
  if (found.length === 0) return { land: false, missing: [{ name: "policy", why: "nothing was checked" }] };
  return missing.length === 0 ? { land: true } : { land: false, missing };
}
