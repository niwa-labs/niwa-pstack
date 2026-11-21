import { expect, test } from "bun:test";
import { existsSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { action, actionName, record } from "@niwa-labs/core";
import { PrMerged } from "@niwa-labs/forge/records";
import { BUILTIN_WORKFLOW, SCRIPT_PACKAGE, plugin } from "@niwa-labs/plugin";
import { createNiwa, eventually, git, tempHome, workflow } from "@niwa-labs/testing";
import { z } from "zod";

import { commitFile, gitIn } from "./support.ts";

const project = { host: "example.invalid", path: "team/repo" };
const forgeRoot = realpathSync(join(dirname(fileURLToPath(import.meta.resolve("@niwa-labs/forge/records"))), ".."));
const source = fileURLToPath(new URL("../src/workflows/worktree-cleanup.ts", import.meta.url));

const Worktree = z.object({ id: z.string(), path: z.string(), repo: z.string(), branch: z.string(), baseSha: z.string() });
const BindingQuery = z.object({ repo: z.object({ host: z.string(), path: z.string() }), number: z.number(), head: z.string(), before: z.number().optional() });
const Binding = record("fixture.binding", BindingQuery.omit({ before: true }).extend({ worktree: Worktree }));

test("an observed merge removes only its bound unchanged checkout", async () => {
  const temp = await tempHome();
  const home = join(temp.path, "home");
  const repo = join(realpathSync(temp.path), "repo");
  const host = createNiwa({ home });
  const lookup: Array<z.infer<typeof BindingQuery>> = [];
  try {
    symlinkSync(realpathSync(join(import.meta.dir, "..", "node_modules")), join(temp.path, "node_modules"), "dir");
    mkdirSync(repo);
    gitIn(repo, "init", "-q", "-b", "main");
    commitFile(repo, "README.md", "test\n");
    gitIn(repo, "remote", "add", "origin", `https://${project.host}/${project.path}.git`);
    host.use(git({ cleanup: false }), plugin("cleanup-fixture", (api) => {
      api.declare(PrMerged, Binding);
      api.offer(SCRIPT_PACKAGE, { name: "@niwa-labs/forge", root: forgeRoot });
      api.offer(BUILTIN_WORKFLOW, { name: "cleanup", description: "Clean the checkout for a merge", file: source, triggers: [PrMerged] });
      api.action(action("pstack.pr.binding", {
        description: "Find the fixture checkout bound to a merge.",
        input: BindingQuery,
        output: z.object({ binding: Binding.schema.optional() }),
        recovery: "repeat",
        effect: "read",
        world: "niwa",
        run(query) {
          lookup.push(query);
          const rows = api.journal?.()?.find({ type: Binding.name, field: "number", equals: query.number }) ?? [];
          const match = rows.find((row) => {
            const data = Binding.schema.parse(row.data);
            return row.seq < (query.before ?? Infinity) && data.head === query.head && data.repo.host === query.repo.host && data.repo.path === query.repo.path;
          });
          return { binding: match === undefined ? undefined : Binding.schema.parse(match.data) };
        },
      }));
    }), workflow());
    await host.serve();

    let workflowId: string | undefined;
    await eventually(async () => {
      const response = await host.call(actionName("workflow.installation.list"), {}) as { items: Array<{ workflow: string }> };
      workflowId = response.items[0]?.workflow;
      return workflowId !== undefined;
    }, 8_000, "cleanup should install on the merge event");
    const make = async (description: string, local = repo) => Worktree.parse(await host.call(actionName("git.worktree.create"), { repo: local, description }));
    const target = await make("selected checkout");
    const twin = await make("different checkout with the same HEAD");
    const clone = join(realpathSync(temp.path), "clone");
    gitIn(repo, "clone", "-q", repo, clone);
    const otherRepo = await make("different repository with the same HEAD", clone);
    expect([twin.baseSha, otherRepo.baseSha]).toEqual([target.baseSha, target.baseSha]);
    const binding = await host.emit(Binding, { repo: project, number: 4, head: target.baseSha, worktree: target });
    const merged = { pr: { repo: { ...project, projectId: 42 }, number: 4 }, base: "main", head: target.baseSha, source: { kind: "observed" as const, version: 1 } };
    const manual = await host.call(actionName("workflow.start"), {
      id: workflowId, args: { id: "fabricated", type: PrMerged.name, data: merged }, wait: true, timeoutMs: 8_000,
    }) as { outcome?: unknown };
    expect(manual.outcome).toMatchObject({ status: "done", result: { removed: [], kept: [] } });
    expect(lookup).toEqual([]);
    expect(existsSync(target.path)).toBe(true);

    const recorded = await host.emit(PrMerged, merged);
    expect(recorded.seq).toBeGreaterThan(binding.seq);
    await eventually(async () => (await host.records.read()).some((row) =>
      row.type === "workflow.run.finished" && JSON.stringify(row.data).includes(`"removed":["${target.id}"]`)), 8_000, "the observed merge should remove the selected checkout");
    expect(lookup).toEqual([{ repo: project, number: 4, head: target.baseSha, before: recorded.seq }]);
    expect(existsSync(target.path)).toBe(false);
    expect(existsSync(twin.path)).toBe(true);
    expect(existsSync(otherRepo.path)).toBe(true);
    expect(gitIn(repo, "rev-parse", target.branch)).toBe(target.baseSha);
    const removes = (await host.records.read()).filter((row) => row.type === "git.worktree.removed");
    expect(removes.map((row) => row.data)).toEqual([{ id: target.id, forced: false, branchKept: true }]);

    const unbound = await host.emit(PrMerged, { ...merged, pr: { ...merged.pr, number: 5 } });
    await eventually(() => lookup.some((query) => query.before === unbound.seq), 8_000, "the unbound merge should query its own receipt");
    expect(existsSync(twin.path)).toBe(true);

    await host.emit(Binding, { repo: project, number: 6, head: twin.baseSha, worktree: twin });
    writeFileSync(join(twin.path, "uncommitted.txt"), "keep this\n");
    await host.emit(PrMerged, { ...merged, pr: { ...merged.pr, number: 6 } });
    await eventually(async () => (await host.records.read()).some((row) =>
      row.type === "workflow.run.finished" && JSON.stringify(row.data).includes(`"kept":[{"id":"${twin.id}"`)), 8_000, "the modified checkout should be reported as kept");
    expect(existsSync(join(twin.path, "uncommitted.txt"))).toBe(true);
    expect((await host.records.read()).filter((row) => row.type === "git.worktree.removed")).toHaveLength(1);
  } finally {
    await host.close();
    await temp.cleanup();
  }
}, 30_000);
