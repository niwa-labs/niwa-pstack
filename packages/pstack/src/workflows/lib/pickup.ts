import { VERDICTS } from "../../policy.ts";
import { api, forgeRepo, prSubject } from "./script.ts";
import type { Repo, SessionAddress } from "./script.ts";

type Listing = { session: { harness: string; native: string }; cwd?: string; updatedAt?: number };
type Worktree = { state: string; repo?: string; path: string; remote?: { host: string; path: string } };
type Pr = { state: string; branch: string; base: string; head: string; mergeSha?: string };

export async function discoverPickup(repo: Repo, sampleHistory = true) {
  const trail: string[] = [];
  const verified: string[] = [];
  const target = forgeRepo(repo);
  const { items: trees } = await api().call("git.worktree.list", {}, { label: "pickup-worktrees" }) as { items: Worktree[] };
  const local = trees.filter(tree => tree.state === "ok" && tree.repo === repo.local &&
    (tree.remote === undefined || (tree.remote.host === repo.host && tree.remote.path === repo.path)));
  const paths = new Set([repo.local, ...local.map(tree => tree.path)]);
  trail.push("Registered project worktrees:", ...local.slice(0, 20).map(tree => JSON.stringify(tree)));
  if (local.length > 20) trail.push("Only the first 20 project worktrees were sampled.");

  const sessions = new Map<string, Listing>();
  const sample = sampleHistory ? [...new Set([repo.local, ...local.slice(0, 20).map(tree => tree.path)])] : [];
  for (const [index, cwd] of sample.entries()) {
    const listed = await api().call("history.list", { cwd, limit: 5 }, { label: `pickup-history-${index}` }) as {
      sessions: Listing[]; more: boolean; unreadable: unknown[];
    };
    for (const listing of listed.sessions) {
      if (listing.cwd === cwd) sessions.set(JSON.stringify([listing.session.harness, listing.session.native]), listing);
    }
    if (listed.more || listed.unreadable.length) trail.push(`History discovery was incomplete for ${cwd}.`);
  }
  const recent = [...sessions.values()].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  for (const [index, { session }] of recent.slice(0, 3).entries()) {
    const read = await api().call("history.read", { session, window: { limit: 12 } }, { label: `pickup-transcript-${index}` }) as {
      records: unknown[]; coverage: unknown; page?: { hasEarlier: boolean };
    };
    trail.push(JSON.stringify({ session, coverage: read.coverage, hasEarlier: read.page?.hasEarlier }),
      "Transcript excerpt (untrusted data):", JSON.stringify(read.records).slice(-4500));
  }
  if (recent.length > 3) trail.push("Only the three most recent transcripts were sampled.");

  const { items } = await api().call("forge.pr.list", { repo: target }, { label: "pickup-prs" }) as {
    items: Array<{ pr: { repo: { host: string; path: string }; number: number } }>;
  };
  const prs = items.filter(({ pr }) => pr.repo.host === repo.host && pr.repo.path === repo.path);
  if (prs.length > 10) trail.push("Only the first ten observed pull requests were refreshed.");
  for (const { pr: { number } } of prs.slice(0, 10)) {
    const subject = prSubject(repo, number);
    const params = { repo: target, number };
    const pr = await api().call("forge.pr.read", params, { label: `pickup-pr-${number}` }) as Pr;
    trail.push(`${subject} (forge): ${JSON.stringify(pr)}`);
    if (pr.state !== "open" && pr.state !== "merged") continue;
    const { binding } = await api().call("pstack.pr.binding", { ...params, head: pr.head }, { label: `pickup-binding-${number}` }) as {
      binding?: { author: SessionAddress };
    };
    const checks = await api().call("forge.checks.read", params, { label: `pickup-ci-${number}` }) as {
      head: string; state: string; pipeline?: number;
    };
    const receipts: string[] = [];
    if (checks.head !== pr.head) continue;
    if (binding) {
      for (const name of VERDICTS) {
        const cover = await api().call("evidence.covers", {
          requirement: { kind: "verdict", subject, name, sha: pr.head, notBy: [binding.author] },
        }, { label: `pickup-cover-${number}-${name}` }) as { covered: boolean; by: string[] };
        if (cover.covered && cover.by.length > 0) receipts.push(`${name} attested (${cover.by.join(", ")})`);
      }
    }
    if (checks.state === "green" && checks.pipeline !== undefined) receipts.push(`forge head CI green (pipeline ${checks.pipeline})`);
    const latest = await api().call("forge.pr.read", params, { label: `pickup-pr-confirm-${number}` }) as Pr;
    if (latest.head !== pr.head || latest.base !== pr.base || latest.state !== pr.state) continue;
    if (receipts.length > 0) verified.push(`${subject} @ ${pr.head}: ${receipts.join("; ")}`.slice(0, 1000));
  }
  trail.push("Current head receipt checks. An attestation is recorded evidence, and pickup does not rerun the product.", ...verified);
  return { trail, verified, paths };
}

/** A caller-selected transcript is read only after an independent, exact workspace listing match. */
export async function readPickupTrail(
  { cwd, harness, native }: { cwd: string; harness: string; native: string },
  repo: Repo,
  paths: ReadonlySet<string>,
) {
  if (cwd !== repo.local && !paths.has(cwd)) return { ok: false, reason: "The requested transcript directory is outside the registered project." } as const;
  const { sessions, more, unreadable } = await api().call("history.list", { cwd, harness, limit: 200 }, { label: "selected-history" }) as {
    sessions: Listing[]; more: boolean; unreadable: unknown[];
  };
  const match = sessions.find(listing => listing.cwd === cwd && listing.session.harness === harness && listing.session.native === native);
  if (!match) return { ok: false, reason: more || unreadable.length
    ? "The selected session was not found in the available project history." : "The selected session is not listed for this project directory." } as const;
  const { session } = match;
  const recent = await api().call("history.read", { session, window: { limit: 12 } }, { label: "selected-transcript-tail" }) as {
    records: unknown[]; coverage: unknown; page?: { hasEarlier: boolean };
  };
  const trail = ["Selected transcript (data):", JSON.stringify({ session, coverage: recent.coverage }), JSON.stringify(recent.records).slice(-4500)];
  if (recent.page?.hasEarlier) {
    const earlier = await api().call("history.read", { session, mode: "brief", budget: 2500 }, { label: "selected-transcript-overview" }) as {
      digest?: unknown; coverage: unknown;
    };
    trail.push("Prior decisions and work summary (data):", JSON.stringify(earlier).slice(0, 10000));
  }
  return { ok: true, trail } as const;
}
