// The merge policy as data: what it asks evidence for, how a go is bound to the plan, and what clears a landing.

import { expect, test } from "bun:test";

import { coverage } from "@niwa-labs/evidence";
import type { Attestation } from "@niwa-labs/evidence";

import { decide, goCovers, goDigest, goSubject, mayGiveGo, mergeRequirements } from "../src/policy.ts";
import type { Listed } from "../src/policy.ts";

const sha = (c: string) => c.repeat(40);
const author = { kind: "session", harness: "author", id: "native-1" } as const;
const verifier = { kind: "session", harness: "verifier", id: "native-2" } as const;
const subject = "gitlab.example.com/acme/billing/pr/7";
const plan = { of: "billing/q4", rev: 3 };

test("a go is bound to the plan's revision, the node and the change", () => {
  const digest = goDigest(plan, "n1", "gitlab.example.com/acme/billing");
  expect(digest).toMatch(/^[0-9a-f]{64}$/);
  expect(goDigest({ ...plan, rev: 4 }, "n1", "gitlab.example.com/acme/billing")).not.toBe(digest);
  expect(goDigest(plan, "n2", "gitlab.example.com/acme/billing")).not.toBe(digest);
  expect(goDigest(plan, "n1", "gitlab.example.com/acme/payroll")).not.toBe(digest);
  expect(goSubject(plan, "n1")).toBe("plan/billing%2Fq4/rev-3/n1");
});

const go = (id: string, by: Listed["author"], sha: string, outcome = "pass"): Listed => ({ id, author: by, claim: { kind: "verdict", name: "go", outcome, sha } });

test("a go counts only from the owner or a run, for the revision it was given on", () => {
  const change = "gitlab.example.com/acme/billing";
  const digest = goDigest(plan, "n1", change);
  expect(goCovers([go("a", { kind: "client", id: "run:run-1" }, digest)], plan, "n1", change)).toEqual({ covered: true, by: ["a"] });
  expect(goCovers([go("a", { kind: "owner" }, digest)], plan, "n1", change).covered).toBe(true);
  // An author's own session cannot give itself a go.
  expect(goCovers([go("a", author, digest)], plan, "n1", change)).toMatchObject({ covered: false, why: "not-the-owner" });
  // A go of the revision before does not cover the revised plan.
  expect(goCovers([go("a", { kind: "owner" }, goDigest({ ...plan, rev: 2 }, "n1", change))], plan, "n1", change)).toMatchObject({ covered: false, why: "none" });
  // A go withdrawn later is withdrawn.
  expect(goCovers([go("a", { kind: "owner" }, digest), go("b", { kind: "owner" }, digest, "fail")], plan, "n1", change)).toMatchObject({ covered: false, why: "withdrawn" });
  expect(mayGiveGo({ kind: "client", id: "session:x" })).toBe(false);
});

/** The attestations the evidence module would hold, with ids in order. */
function attestations(...items: Array<{ author: Attestation["author"]; claim: Attestation["claim"] }>): Attestation[] {
  return items.map((one, index) => ({ id: `e${String(index)}`, seq: index + 1, at: index, subject, ...one }));
}

const pair = { sha: sha("b"), pipeline: 12 };
const required = mergeRequirements({ subject, head: sha("a"), author, target: pair });

/** What the policy decides over these attestations, held to the evidence module's own coverage. */
const decideOver = (held: Attestation[]) => decide(required.map(({ name, requirement }) => ({ name, ...coverage(held, requirement as never) })));

const green = [
  { author: verifier, claim: { kind: "verdict", name: "gates", outcome: "pass", sha: sha("a") } },
  { author: verifier, claim: { kind: "verdict", name: "live", outcome: "pass", sha: sha("a") } },
  { author: { kind: "client", id: "run:r" }, claim: { kind: "ci", at: "head", sha: sha("a"), pipeline: 11 } },
  { author: { kind: "client", id: "run:r" }, claim: { kind: "ci", at: "merge-result", sourceSha: sha("a"), targetSha: sha("b"), mergeSha: sha("c"), pipeline: 12, pipelineKind: "merge-result" } },
] as const satisfies ReadonlyArray<{ author: Attestation["author"]; claim: Attestation["claim"] }>;

test("a pull request lands when every requirement is covered at its head", () => {
  expect(decideOver(attestations(...green))).toEqual({ land: true });
});

test("a verdict by the author of the patch does not count", () => {
  const byAuthor = green.map((one) => (one.claim.kind === "verdict" && one.claim.name === "live" ? { ...one, author } : one));
  expect(decideOver(attestations(...byAuthor))).toEqual({ land: false, missing: [{ name: "live", why: "excluded-author" }] });
});

test("green CI alone never clears a landing", () => {
  expect(decideOver(attestations(...green.filter((one) => one.claim.kind === "ci")))).toEqual({
    land: false,
    missing: [
      { name: "gates", why: "none" },
      { name: "live", why: "none" },
    ],
  });
});

test("a merge result of a target that moved, or a head pipeline in its place, does not cover the pair", () => {
  const moved = green.map((one) => (one.claim.kind === "ci" && one.claim.at === "merge-result" ? { ...one, claim: { ...one.claim, targetSha: sha("d") } } : one));
  expect(decideOver(attestations(...moved))).toEqual({ land: false, missing: [{ name: "merge-result", why: "target-moved" }] });
  // GitLab ran an ordinary pipeline of the head where the merge result was selected.
  const headOnly = green
    .filter((one) => !(one.claim.kind === "ci" && one.claim.at === "merge-result"))
    .map((one) => (one.claim.kind === "ci" ? { ...one, claim: { ...one.claim, pipeline: 12 } } : one));
  expect(decideOver(attestations(...headOnly))).toEqual({ land: false, missing: [{ name: "merge-result", why: "not-merge-result" }] });
});

test("a verdict on an older head does not cover the new one, and red head CI is missing", () => {
  const older = green.map((one) => (one.claim.kind === "verdict" && one.claim.name === "gates" ? { ...one, claim: { ...one.claim, sha: sha("e") } } : one));
  expect(decideOver(attestations(...older))).toEqual({ land: false, missing: [{ name: "gates", why: "none" }] });
  const noHead = green.filter((one) => !(one.claim.kind === "ci" && one.claim.at === "head"));
  expect(decideOver(attestations(...noHead))).toEqual({ land: false, missing: [{ name: "head-ci", why: "none" }] });
});

test("nothing checked is not a landing", () => {
  expect(decide([])).toEqual({ land: false, missing: [{ name: "policy", why: "nothing was checked" }] });
});
