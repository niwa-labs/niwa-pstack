// Worktree cleanup, on a merge: a pull request merged on the forge leaves the worktrees its head was built in with
// nothing to do. Those of them that are clean and run no session are removed; one with uncommitted work or a live
// session is left and named.

import type { ScriptApi } from "@niwa-labs/script";

import { api } from "./lib/script.ts";

declare const workflow: ScriptApi["workflow"];
declare const z: ScriptApi["z"];

/** The merge, as much of `forge.pr.merged` as the cleanup reads. */
interface Merged {
  pr: { repo: { host: string; path: string }; number: number };
  head?: string;
}

/** A worktree as `git.worktree.list` shows it. */
interface Listed {
  id: string;
  state: string;
  path: string;
  head?: string;
  dirty?: boolean;
  sessions?: string[];
}

export default workflow(
  {
    name: "pstack-worktree-cleanup",
    description: "Remove the worktrees a merged pull request was built in",
    on: ["forge.pr.merged"],
    output: z.strictObject({ removed: z.array(z.string()), kept: z.array(z.strictObject({ id: z.string(), why: z.string() })) }),
    uses: ["git.worktree.list", "git.worktree.remove"],
  },
  async ({ data }: { data: Merged }) => {
    if (data.head === undefined) return { removed: [], kept: [] };
    const listed = (await api().call("git.worktree.list", {}, { label: "list" })) as { items: Listed[] };
    const built = listed.items.filter((one) => one.state === "ok" && one.head === data.head);
    const removed: string[] = [];
    const kept: Array<{ id: string; why: string }> = [];
    for (const one of built) {
      if (one.dirty === true) kept.push({ id: one.id, why: "it has uncommitted work" });
      else if ((one.sessions ?? []).length > 0) kept.push({ id: one.id, why: "a session runs in it" });
      else {
        // Its commits are the head the forge merged: what its base lacks here is on the forge's trunk.
        await api().call("git.worktree.remove", { id: one.id, force: true }, { label: `remove-${one.id}` });
        removed.push(one.id);
      }
    }
    return { removed, kept };
  },
);
