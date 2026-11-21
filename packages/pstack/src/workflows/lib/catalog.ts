/**
 * pstack's built-ins as the host registered them: the id and the versions of each, read through the workflow module.
 */

import { api } from "./script.ts";

/** How a run ended, as `workflow.run.finished` records it. */
type Outcome = { status: "done"; result: unknown } | { status: "failed"; error: { message: string } } | { status: "cancelled" };

/** Run the host-selected version of a built-in as a child. The journal read and cursor cover a child that already ended. */
export async function runBuiltin(key: string, name: string, args: unknown): Promise<unknown> {
  const listed = (await api().call("workflow.list", {}, { label: `${key}-list` })) as { items: Array<{ id: string; builtin?: { plugin: string; name: string } }> };
  const builtin = listed.items.find((item) => item.builtin?.plugin === "pstack" && item.builtin.name === name);
  if (builtin === undefined) throw new Error(`pstack has no built-in "${name}"`);
  const { run } = (await api().call("workflow.start", { id: builtin.id, args }, { label: `${key}-start` })) as { run: string };
  const read = await api().read.records({ types: ["workflow.run.finished"], filter: { run } }, { label: `${key}-ended` });
  const ended = read.records[0]?.data ?? (await api().wait("workflow.run.finished", { filter: { run }, from: read.next, label: `${key}-end` })).data;
  const outcome = (ended as { outcome: Outcome }).outcome;
  if (outcome.status === "done") return outcome.result;
  throw new Error(`the playbook "${name}" (${run}) ended ${outcome.status}${outcome.status === "failed" ? `: ${outcome.error.message}` : ""}`);
}

/** Whether an error is a refusal a script may catch, not a signal of the runtime that pauses or cancels the run. */
export function isRefusal(error: unknown): boolean {
  return error instanceof Error && error.name !== "PauseSignal" && error.name !== "Cancelled";
}

/** How long the suite gives one scenario to end. */
export const SCENARIO_MS = 30 * 60_000;

/** Start a version of a built-in and wait for it to end, for at most `timeoutMs`: how it ended, or that it did not. */
export async function tryVersion(key: string, id: string, version: string, args: unknown, timeoutMs = SCENARIO_MS): Promise<{ ok: true; value: unknown } | { ok: false; error: { name: string; message: string } }> {
  let started: { run: string; state?: string; outcome?: Outcome; reason?: string };
  try {
    started = (await api().call("workflow.start", { id, version, args, wait: true, timeoutMs }, { label: `${key}-start` })) as typeof started;
  } catch (error) {
    // A refusal of the start is the scenario's failure; a step that failed pauses this run, as it should.
    if (!isRefusal(error)) throw error;
    return { ok: false, error: { name: (error as Error).name, message: (error as Error).message } };
  }
  if (started.state === "finished" && started.outcome?.status === "done") return { ok: true, value: started.outcome.result };
  if (started.state === "finished") return { ok: false, error: { name: "Ended", message: `the run ended ${started.outcome?.status ?? "with no outcome"}` } };
  await api().call("workflow.cancel", { run: started.run }, { label: `${key}-cancel` });
  return { ok: false, error: { name: "NotEnded", message: `the run was ${started.state ?? "running"}${started.reason === undefined ? "" : ` (${started.reason})`} and was cancelled` } };
}
