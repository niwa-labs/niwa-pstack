import { action, actionRef, record, runIdOfPrincipal } from "@niwa-labs/core";
import type { JournalReader } from "@niwa-labs/core";
import type { PluginApi } from "@niwa-labs/plugin";
import { BuiltinsWanted, RunRequested, RunStarted, WorkflowRegistered, storedEntry } from "@niwa-labs/workflow/records";
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
const Bound = record("pstack.pr.bound", Provenance.extend({ run: z.string().min(1) }), { providerOnly: "pstack" });
export const pstackPrBind = actionRef("pstack.pr.bind", {
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

function trustedLane(journal: JournalReader, home: string, run: string, invocation: string, execution?: string): boolean {
  const started = journal.find({ type: RunStarted.name, field: "run", equals: run })
    .find(row => row.actor.kind === "handler" && row.actor.invocation === invocation);
  if (!started?.cause) return false;
  const cause = journal.get(started.cause);
  if (cause?.type !== RunRequested.name) return false;
  const request = RunRequested.schema.parse(cause.data);
  if (request.run !== run || (execution !== undefined && (request.execution ?? run) !== execution)) return false;
  const { workflow, version, file } = RunStarted.schema.parse(started.data);
  if (!workflow || !version || request.workflow !== workflow || request.version !== version || request.file !== file) return false;
  if (storedEntry(home, workflow, version) !== file) return false;
  return journal.find({ type: WorkflowRegistered.name, field: "workflow", equals: workflow }).some(row => {
    if (row.actor.kind !== "handler" || !row.cause) return false;
    const proposal = journal.get(row.cause);
    if (proposal?.type !== BuiltinsWanted.name || proposal.actor.kind !== "host") return false;
    const registered = WorkflowRegistered.schema.parse(row.data);
    const builtin = registered.builtin;
    if (registered.version !== version || builtin?.plugin !== "pstack" || !lanes.has(builtin.name)) return false;
    return BuiltinsWanted.schema.parse(proposal.data).items.some(item =>
      item.plugin === builtin.plugin && item.name === builtin.name && item.file === registered.file && item.version === version);
  });
}

export function registerPrBindings(api: PluginApi): void {
  api.declare(Bound);
  api.action(action(pstackPrBind, {
    recovery: "repeat", effect: "record", world: "niwa",
    async run(input, ctx) {
      const journal = api.journal?.();
      const principal = ctx.caller.kind === "client" ? ctx.caller.principal : undefined;
      const execution = principal?.kind === "run" ? principal.id : undefined;
      const run = execution && runIdOfPrincipal(execution);
      if (!journal || !execution || !run || !ctx.invocation || !trustedLane(journal, api.home(), run, ctx.invocation, execution)) {
        throw new Error("only a registered pstack authoring lane can bind a pull request");
      }
      const row = await ctx.emit(Bound, { ...input, run });
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
        if (row.actor.kind !== "handler" || !trustedLane(journal, api.home(), receipt.run, row.actor.invocation)) continue;
        if (binding && (JSON.stringify(binding.author) !== JSON.stringify(receipt.author) || JSON.stringify(binding.worktree) !== JSON.stringify(receipt.worktree))) return {};
        binding = receipt;
      }
      return binding ? { binding } : {};
    },
  }));
}
