// Clean up the registered checkout of the pull request named by an observed merge.
import { PrMerged } from "@niwa-labs/forge/records";
import type { ScriptApi } from "@niwa-labs/script";

import { isRefusal } from "./lib/catalog.ts";
import { repoSchema } from "./lib/inputs.ts";
import { api } from "./lib/script.ts";

declare const workflow: ScriptApi["workflow"];
declare const z: ScriptApi["z"];

interface MergeTrigger {
  id: string;
  type: string;
  data: unknown;
}

interface Binding {
  worktree: { id: string; repo: string; path: string; branch: string };
}

const manual = z.strictObject({
  kind: z.literal("inventory"), repo: repoSchema(),
  prune: z.strictObject({
    merges: z.array(z.strictObject({ id: z.string().min(1), pr: z.number().int().positive(), head: z.string().regex(/^[0-9a-f]{40,64}$/) })).min(1).max(100),
    protectedPaths: z.array(z.string().min(1)).describe("Worktree paths used by pinned or active conversations, including their children"),
  }).optional(),
});

const kept = z.strictObject({ id: z.string(), why: z.string() });
type Tree = { id: string; path: string; repo?: string; state: string; sessions?: string[]; dirty?: boolean; head?: string; remote?: { host: string; path: string } };

export default workflow(
  {
    name: "pstack-worktree-cleanup",
    description: "Remove the registered checkout of a merged pull request",
    on: ["forge.pr.merged"],
    output: z.strictObject({ removed: z.array(z.string()), kept: z.array(kept), inventory: z.array(z.json()).optional() }),
    uses: ["niwa.records.read", "pstack.pr.binding", "git.worktree.list", "git.worktree.remove"],
  },
  async (input: unknown) => {
    const requested = manual.safeParse(input);
    if (requested.success) {
      const { repo, prune } = requested.data;
      const { items } = await api().call("git.worktree.list", {}, { label: "inventory" }) as { items: Tree[] };
      const trees = items.filter(tree => tree.repo === repo.local && tree.remote?.host === repo.host && tree.remote.path === repo.path);
      const inventory = trees.map(tree => z.json().parse(tree));
      const result = { removed: [] as string[], kept: [] as Array<{ id: string; why: string }>, inventory };
      if (!prune) {
        result.kept = trees.map(tree => ({ id: tree.id, why: tree.state !== "ok" ? `Checkout state: ${tree.state}.`
          : tree.sessions?.length ? "A Niwa session is using the checkout."
          : tree.dirty !== false ? "The checkout has local changes or its cleanliness is unknown."
          : "A matching merge and current protected paths have not been supplied." }));
        return result;
      }
      const byPath = new Map(trees.map(tree => [tree.path, tree]));
      const protectedPaths = new Set(prune.protectedPaths);
      const selected = new Set<string>();
      for (const { id, pr, head } of prune.merges) {
        if (selected.has(id)) continue;
        selected.add(id);
        const checked = await cleanMerge({ id, repo, number: pr, head }, `selected-${pr}-${selected.size}-`, (worktree, checkout, local) => {
          const tree = byPath.get(checkout);
          if (!tree || local !== repo.local || tree.id !== worktree || tree.state !== "ok") return "No matching registered checkout in the inventory.";
          if (protectedPaths.has(checkout) || tree.sessions?.length) return "The checkout is pinned or still in use.";
          if (tree.dirty !== false) return "The checkout has local changes or its cleanliness is unknown.";
          return undefined;
        });
        result.removed.push(...checked.removed);
        result.kept.push(...(checked.removed.length === 0 && checked.kept.length === 0
          ? [{ id, why: "No removable checkout matched the recorded merge." }] : checked.kept));
      }
      return result;
    }
    const trigger = input as MergeTrigger | undefined;
    const merged = PrMerged.schema.safeParse(trigger?.data);
    if (trigger?.type !== PrMerged.name || !merged.success || merged.data.head === undefined) return { removed: [], kept: [] };
    return cleanMerge({ id: trigger.id, repo: merged.data.pr.repo, number: merged.data.pr.number, head: merged.data.head }, "");
  },
);

async function cleanMerge(
  { id, repo: { host, path }, number, head }: { id: string; repo: { host: string; path: string }; number: number; head: string },
  key: string,
  preserve?: (id: string, checkout: string, local: string) => string | undefined,
) {
    const skipped = { removed: [], kept: [] };
    const repo = { host, path };

    // A caller may start this workflow with its own arguments. Require the observation that the forge wrote.
    const { records } = await api().read.records(PrMerged, {
      filter: { "pr.repo.host": host, "pr.repo.path": path, "pr.number": number, head },
    }, { label: `${key}merge` });
    const observed = records.find((row) => row.id === id && row.actor.kind === "host");
    if (observed === undefined) return skipped;

    const { binding } = (await api().call("pstack.pr.binding", { repo, number, head, before: observed.seq }, { label: `${key}binding` })) as { binding?: Binding };
    if (binding === undefined) return skipped;
    const { id: worktree, repo: local, path: checkout, branch } = binding.worktree;
  const why = preserve?.(worktree, checkout, local);
    if (why !== undefined) return { removed: [], kept: [{ id: worktree, why }] };
    try {
      const result = (await api().call("git.worktree.remove", {
        id: worktree,
        onlyIf: { repo: local, path: checkout, branch, head, project: repo },
      }, { label: `${key}remove` })) as { id: string; removed: boolean };
      return result.removed && result.id === worktree ? { removed: [worktree], kept: [] } : skipped;
    } catch (error) {
      if (!isRefusal(error)) throw error;
      return { removed: [], kept: [{ id: worktree, why: (error as Error).message }] };
    }
}
