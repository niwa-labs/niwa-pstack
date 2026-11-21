import { action, actionRef, record } from "@niwa-labs/core";
import type { JournalReader } from "@niwa-labs/core";
import type { PluginApi } from "@niwa-labs/plugin";
import { RunStarted, WorkflowRegistered } from "@niwa-labs/workflow/records";
import { z } from "zod";

import { SessionAddress } from "./records.ts";

const Key = z.strictObject({
  repo: z.strictObject({ host: z.string().min(1), path: z.string().min(1) }),
  number: z.number().int().positive(),
  head: z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/),
});
const Provenance = Key.extend({
  author: SessionAddress,
  worktree: z.strictObject({ id: z.string().min(1), path: z.string().min(1), branch: z.string().min(1), repo: z.string().min(1) }),
});
const Bound = record("pstack.pr.bound", Provenance.extend({ run: z.string().min(1) }));
const bind = actionRef("pstack.pr.bind", {
  description: "Record the author and worktree a built-in authoring lane used to make this pull request head.",
  input: Provenance,
  output: z.strictObject({ id: z.string() }),
});
const lookup = actionRef("pstack.pr.binding", {
  description: "Read the unambiguous authoring receipt for this exact repository, pull request and head.",
  input: Key.extend({ before: z.number().int().positive().optional() }),
  output: z.strictObject({ binding: Bound.schema.optional() }),
});

const lanes = new Set(["authoring-a-skill", "autopilot-full", "autopilot-stack", "benny-reproduce", "bug-fix", "feature", "perf-issue", "refactoring", "visual-parity"]);

function trustedLane(journal: JournalReader, run: string, invocation: string): boolean {
  const started = journal.find({ type: RunStarted.name, field: "run", equals: run })
    .find(row => row.actor.kind === "handler" && row.actor.invocation === invocation);
  if (!started) return false;
  const { workflow, version } = RunStarted.schema.parse(started.data);
  if (!workflow || !version) return false;
  return journal.find({ type: WorkflowRegistered.name, field: "workflow", equals: workflow }).some(row => {
    const registered = WorkflowRegistered.schema.parse(row.data);
    return registered.version === version && registered.builtin?.plugin === "pstack" && lanes.has(registered.builtin.name);
  });
}

export function registerPrBindings(api: PluginApi): void {
  api.declare(Bound);
  api.action(action(bind, {
    recovery: "repeat", effect: "record", world: "niwa",
    async run(input, ctx) {
      const journal = api.journal?.();
      const principal = ctx.caller.kind === "client" ? ctx.caller.principal : undefined;
      if (!journal || principal?.kind !== "run" || !ctx.invocation || !trustedLane(journal, principal.id, ctx.invocation)) {
        throw new Error("only a registered pstack authoring lane can bind a pull request");
      }
      const row = await ctx.emit(Bound, { ...input, run: principal.id });
      return { id: row.id };
    },
  }));
  api.action(action(lookup, {
    recovery: "repeat", effect: "read", world: "niwa",
    run(input) {
      const journal = api.journal?.();
      if (!journal) throw new Error("pstack needs its journal to read pull request bindings");
      let binding: z.infer<typeof Bound.schema> | undefined;
      for (const row of journal.find({ type: Bound.name, field: "head", equals: input.head })) {
        if (input.before !== undefined && row.seq >= input.before) continue;
        const receipt = Bound.schema.parse(row.data);
        if (receipt.number !== input.number || receipt.repo.host !== input.repo.host || receipt.repo.path !== input.repo.path) continue;
        if (row.actor.kind !== "handler" || !trustedLane(journal, receipt.run, row.actor.invocation)) continue;
        if (binding && (JSON.stringify(binding.author) !== JSON.stringify(receipt.author) || JSON.stringify(binding.worktree) !== JSON.stringify(receipt.worktree))) return {};
        binding = receipt;
      }
      return binding ? { binding } : {};
    },
  }));
}
