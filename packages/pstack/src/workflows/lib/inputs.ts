/**
 * The input every playbook takes, as a zod schema made with the script's own `z`: a schema is read before the
 * script runs, by a process that has `z` and nothing else of the script runtime.
 */

import type { ScriptApi } from "@niwa-labs/script";

/** The zod of the script. */
export function zod(): ScriptApi["z"] {
  const found = (globalThis as unknown as { z?: ScriptApi["z"] }).z;
  if (found === undefined) throw new Error("pstack's scripts run inside a workflow script: z is not a global here");
  return found;
}

/** A repository: where the forge serves it, and the real path of the local clone. */
export function repoSchema() {
  const z = zod();
  return z.strictObject({
    host: z.string().min(1).describe("The host of the forge, gitlab.example.com"),
    path: z.string().min(1).describe("The path of the project on the forge, acme/billing"),
    local: z.string().min(1).describe("The real path of the local clone"),
  });
}

/** What a playbook is started with: the task, the repository, where niwa keeps its worktrees, and the trunk. */
export function playbookInput() {
  const z = zod();
  return z.strictObject({
    task: z.string().min(1).max(4000),
    repo: repoSchema(),
    worktrees: z.string().min(1).describe("The real path of the folder niwa keeps its worktrees in, <home>/worktrees"),
    base: z.string().min(1).default("main").describe("The trunk the changes land on"),
  });
}

export function evalId() {
  return zod().string().regex(/^[a-z][a-z0-9-]{0,30}$/);
}

/** Variant settings shared by the direct and routed Eval entry points. */
export function evalVariants() {
  const z = zod();
  const name = z.string().min(1);
  return z.record(evalId(), z.union([name, z.strictObject({
    harness: name, vendor: name.optional(), model: name.optional(), effort: name.optional(), ref: name.optional(),
  })]));
}
