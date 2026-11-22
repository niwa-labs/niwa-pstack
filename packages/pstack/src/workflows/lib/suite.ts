// The suite: before the host runs a new version of pstack's entry or playbooks, it runs the scenarios on the
// candidates, each started by its version, and promotes the whole set in one action when every scenario passes.
// The playbooks the entry starts are pinned to the set under trial, so the set is tried as it will run.

import type { ScriptApi } from "@niwa-labs/script";
import type { z as Z } from "zod";

import { OPTIONAL, SCENARIOS } from "../scenarios.ts";
import type { Context, Ended, Fixture } from "../scenarios.ts";
import { isRefusal, tryVersion } from "./catalog.ts";
import { repoSchema } from "./inputs.ts";
import { api } from "./script.ts";

declare const z: ScriptApi["z"];
declare function phase(title: string): void;

const row = z.strictObject({ builtin: z.string(), scenario: z.string(), passed: z.boolean(), why: z.string().optional() });

export const input = z.strictObject({
  repo: repoSchema().describe("A repository the scenarios may change, on a forge project they may merge into"),
  worktrees: z.string().min(1).describe("The real path of the folder niwa keeps its worktrees in, <home>/worktrees"),
  base: z.string().min(1).default("main"),
});
export const output = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("nothing"), why: z.string() }),
  z.strictObject({ status: z.literal("promoted"), versions: z.array(z.strictObject({ builtin: z.string(), version: z.string() })), rows: z.array(row) }),
  z.strictObject({ status: z.enum(["failed", "stale"]), rows: z.array(row) }),
]);

export async function run({ repo, worktrees, base }: Z.output<typeof input>) {
  phase("Find");
  const { entries } = (await api().call("workflow.builtin.trial", {}, { label: "pin" })) as {
    entries: Array<{ name: string; workflow: string; version: string; candidate?: true }>;
  };
  const all = new Map(entries.map((entry) => [entry.name, entry]));
  const candidates = entries.filter((entry) => entry.candidate === true);
  if (candidates.length === 0) return { status: "nothing" as const, why: "no built-in of pstack has a candidate version" };
  const fixture: Fixture = { repo, worktrees, base, run: String(await api().random({ label: "run" })).slice(2, 10) };

  phase("Try");
  const rows: Array<{ builtin: string; scenario: string; passed: boolean; why?: string }> = [];
  for (const one of candidates) {
    if (!SCENARIOS.some((scenario) => scenario.builtin === one.name)) rows.push({ builtin: one.name, scenario: "-", passed: false, why: "the built-in has no scenario" });
  }
  // Every scenario runs, on the version of the set under trial, in order: one hands its plan to the next.
  const context: Context = {};
  for (const [index, scenario] of SCENARIOS.entries()) {
    const found = all.get(scenario.builtin);
    if (found === undefined && OPTIONAL.has(scenario.builtin)) continue;
    if (found === undefined) {
      rows.push({ builtin: scenario.builtin, scenario: scenario.name, passed: false, why: "the built-in is not registered" });
      continue;
    }
    const key = `try-${String(index)}`;
    let ended: Ended;
    try {
      ended = await tryVersion(key, found.workflow, found.version, await scenario.args(fixture, context));
    } catch (error) {
      if (!isRefusal(error)) throw error;
      ended = { ok: false, error: { name: (error as Error).name, message: (error as Error).message } };
    }
    const why = scenario.check(ended, context);
    if (scenario.after !== undefined) await scenario.after(fixture, context);
    rows.push({ builtin: scenario.builtin, scenario: scenario.name, passed: why === null, ...(why === null ? {} : { why }) });
  }
  if (rows.some((one) => !one.passed)) return { status: "failed" as const, rows };

  phase("Promote");
  const { status } = (await api().call("workflow.builtin.promote", {}, { label: "promote" })) as { status: "promoted" | "stale" };
  if (status === "stale") return { status, rows };
  return { status, versions: candidates.map((entry) => ({ builtin: entry.name, version: entry.version })), rows };
}
