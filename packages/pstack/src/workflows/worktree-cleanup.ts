// Clean up the registered checkout of the pull request named by an observed merge.
import { PrMerged } from "@niwa-labs/forge/records";
import type { ScriptApi } from "@niwa-labs/script";

import { isRefusal } from "./lib/catalog.ts";
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

export default workflow(
  {
    name: "pstack-worktree-cleanup",
    description: "Remove the registered checkout of a merged pull request",
    on: ["forge.pr.merged"],
    output: z.strictObject({ removed: z.array(z.string()), kept: z.array(z.strictObject({ id: z.string(), why: z.string() })) }),
    uses: ["niwa.records.read", "pstack.pr.binding", "git.worktree.remove"],
  },
  async ({ id, type, data }: MergeTrigger) => {
    const skipped = { removed: [], kept: [] };
    const merged = PrMerged.schema.safeParse(data);
    if (type !== PrMerged.name || !merged.success || merged.data.head === undefined) return skipped;
    const { head, pr: { repo: { host, path }, number } } = merged.data;
    const repo = { host, path };

    // A caller may start this workflow with its own arguments. Require the observation that the forge wrote.
    const { records } = await api().read.records(PrMerged, {
      filter: { "pr.repo.host": host, "pr.repo.path": path, "pr.number": number, head },
    }, { label: "merge" });
    const observed = records.find((row) => row.id === id && row.actor.kind === "host");
    if (observed === undefined) return skipped;

    const { binding } = (await api().call("pstack.pr.binding", { repo, number, head, before: observed.seq }, { label: "binding" })) as { binding?: Binding };
    if (binding === undefined) return skipped;
    const { id: worktree, repo: local, path: checkout, branch } = binding.worktree;
    try {
      const result = (await api().call("git.worktree.remove", {
        id: worktree,
        onlyIf: { repo: local, path: checkout, branch, head, project: repo },
      }, { label: "remove" })) as { id: string; removed: boolean };
      return result.removed && result.id === worktree ? { removed: [worktree], kept: [] } : skipped;
    } catch (error) {
      if (!isRefusal(error)) throw error;
      return { removed: [], kept: [{ id: worktree, why: (error as Error).message }] };
    }
  },
);
