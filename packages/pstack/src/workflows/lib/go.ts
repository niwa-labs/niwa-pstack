/**
 * The owner's go on plan nodes: asked once for a list of nodes of one revision of a plan, for one change, and
 * attested once per node, bound by its digest to that revision, node and change. A new revision of the plan needs a
 * new go: the old one covers nothing of it.
 */

import { GO, goCovers, goDigest, goSubject } from "../../policy.ts";
import type { Listed, PlanRevision } from "../../policy.ts";
import { api } from "./script.ts";

/** A node of a plan, as the go names it. */
export interface PlanNode {
  id: string;
  text: string;
}

/** Ask the owner for a go on these nodes, and attest one per node when it is given. */
export async function askGo(key: string, opts: { plan: PlanRevision; nodes: readonly PlanNode[]; change: string }): Promise<boolean> {
  const lines = opts.nodes.map((node) => `- ${node.id}: ${node.text}`);
  const yes = await api().ask.confirm([`Go for revision ${String(opts.plan.rev)} of the plan ${opts.plan.of}, landing in ${opts.change}?`, "", ...lines].join("\n"), { label: `${key}-ask` });
  if (!yes) return false;
  for (const node of opts.nodes) {
    await api().call(
      "evidence.attest",
      { subject: goSubject(opts.plan, node.id), claim: { kind: "verdict", name: GO, outcome: "pass", sha: goDigest(opts.plan, node.id, opts.change) } },
      { label: `${key}-attest-${node.id}` },
    );
  }
  return true;
}

/** A plan as `plan.get` answers it. */
export interface PlanView {
  of: string;
  rev: number;
  items: Array<{ id: string; text: string; state: string; note?: string }>;
}

/** The plan's current revision. */
export async function currentPlan(key: string, of: string): Promise<PlanView> {
  return (await api().call("plan.get", { of }, { label: key })) as PlanView;
}

/** Whether the go of each node covers the plan's current revision for this change: per node, covered or why not. */
export async function goFound(key: string, opts: { plan: PlanView; nodes: readonly string[]; change: string }): Promise<Array<{ name: string; covered: boolean; why?: string }>> {
  const found: Array<{ name: string; covered: boolean; why?: string }> = [];
  for (const node of opts.nodes) {
    if (!opts.plan.items.some((item) => item.id === node)) {
      found.push({ name: `go:${node}`, covered: false, why: "not-in-plan" });
      continue;
    }
    const revision = { of: opts.plan.of, rev: opts.plan.rev };
    const items: Listed[] = [];
    let after: number | undefined;
    do {
      const page = await api().call("evidence.list",
        { subject: goSubject(revision, node), ...(after === undefined ? {} : { after }) },
        { label: `${key}-${node}-${after ?? "start"}` },
      ) as { items: Listed[]; next?: number };
      items.push(...page.items);
      if (page.next !== undefined && page.next <= (after ?? -1)) throw new Error("Evidence cursor did not advance");
      after = page.next;
    } while (after !== undefined);
    const covers = goCovers(items, revision, node, opts.change);
    found.push({ name: `go:${node}`, covered: covers.covered, ...(covers.why === undefined ? {} : { why: covers.why }) });
  }
  return found;
}
