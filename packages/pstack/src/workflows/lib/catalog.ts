/**
 * pstack's built-ins as the host registered them: the id and the versions of each, read through the workflow module.
 */

import { api } from "./script.ts";

/** One version of a workflow, as `workflow.get` lists it. */
interface ListedVersion {
  version: string;
  candidate?: boolean;
}

/** One built-in of pstack: its name, id, the version the host runs, and the newest candidate. */
export interface Registered {
  name: string;
  id: string;
  /** The version the host runs, when one was accepted. */
  accepted?: string;
  /** The newest version not accepted yet. */
  candidate?: string;
}

/** The built-ins of pstack, by name. */
export async function registered(key: string): Promise<Record<string, Registered>> {
  const listed = (await api().call("workflow.list", {}, { label: `${key}-list` })) as { items: Array<{ id: string; builtin?: { plugin: string; name: string } }> };
  const found: Record<string, Registered> = {};
  for (const item of listed.items) {
    if (item.builtin?.plugin !== "pstack") continue;
    const got = (await api().call("workflow.get", { id: item.id }, { label: `${key}-get-${item.builtin.name}` })) as { versions: ListedVersion[] };
    const accepted = got.versions.filter((one) => one.candidate !== true).at(-1)?.version;
    const candidate = got.versions.filter((one) => one.candidate === true).at(-1)?.version;
    found[item.builtin.name] = { name: item.builtin.name, id: item.id, ...(accepted === undefined ? {} : { accepted }), ...(candidate === undefined ? {} : { candidate }) };
  }
  return found;
}

/** How a run ended, as `workflow.run.finished` records it. */
type Outcome = { status: "done"; result: unknown } | { status: "failed"; error: { message: string } } | { status: "cancelled" };

/** The version of a built-in a run starts: the one `pins` names, else the one the host runs. */
function versionOf(found: Registered | undefined, name: string, pins: Readonly<Record<string, string>>): { id: string; version: string } {
  if (found === undefined) throw new Error(`pstack has no built-in "${name}"`);
  const version = pins[name] ?? found.accepted;
  if (version === undefined) throw new Error(`the built-in "${name}" has no accepted version yet: the suite promotes it first`);
  return { id: found.id, version };
}

/**
 * Run a built-in of pstack as a child of this run and answer its result: the version `pins` names, else the one the
 * host runs. The end of the child is read once it started and waited for from there, so an end written before the
 * wait began is not missed; a child that did not end with a result throws.
 */
export async function runBuiltin(key: string, name: string, args: unknown, pins: Readonly<Record<string, string>> = {}): Promise<unknown> {
  const all = await registered(key);
  const { id, version } = versionOf(all[name], name, pins);
  const { run } = (await api().call("workflow.start", { id, version, args }, { label: `${key}-start` })) as { run: string };
  const read = await api().read.records({ types: ["workflow.run.finished"], filter: { run } }, { label: `${key}-ended` });
  const ended = read.records[0]?.data ?? (await api().wait("workflow.run.finished", { filter: { run }, from: read.next, label: `${key}-end` })).data;
  const outcome = (ended as { outcome: Outcome }).outcome;
  if (outcome.status === "done") return outcome.result;
  throw new Error(`the playbook "${name}" (${run}) ended ${outcome.status}${outcome.status === "failed" ? `: ${outcome.error.message}` : ""}`);
}

/** How long the suite gives one scenario to end. */
export const SCENARIO_MS = 30 * 60_000;

/** Start a version of a built-in and wait for it to end, for at most `timeoutMs`: how it ended, or that it did not. */
export async function tryVersion(key: string, id: string, version: string, args: unknown, timeoutMs = SCENARIO_MS): Promise<{ ok: true; value: unknown } | { ok: false; error: { name: string; message: string } }> {
  let started: { run: string; state?: string; outcome?: Outcome; reason?: string };
  try {
    started = (await api().call("workflow.start", { id, version, args, wait: true, timeoutMs }, { label: `${key}-start` })) as typeof started;
  } catch (error) {
    return { ok: false, error: { name: (error as Error).name, message: (error as Error).message } };
  }
  if (started.state === "finished" && started.outcome?.status === "done") return { ok: true, value: started.outcome.result };
  if (started.state === "finished") return { ok: false, error: { name: "Ended", message: `the run ended ${started.outcome?.status ?? "with no outcome"}` } };
  await api().call("workflow.cancel", { run: started.run }, { label: `${key}-cancel` });
  return { ok: false, error: { name: "NotEnded", message: `the run was ${started.state ?? "running"}${started.reason === undefined ? "" : ` (${started.reason})`} and was cancelled` } };
}
