// How the suite starts a candidate: a start the host refuses is the scenario's failure, but a signal of the runtime
// (a step that failed pauses the run, a cancel ends it) is not caught: the suite's run pauses or ends as it should.

import { afterEach, expect, test } from "bun:test";

import { isRefusal, tryVersion } from "../src/workflows/lib/catalog.ts";

const globals = globalThis as Record<string, unknown>;
afterEach(() => {
  for (const name of ["call", "agent"]) delete globals[name];
});

/** An error of the name the script runtime gives it. */
const named = (name: string, message: string) => Object.assign(new Error(message), { name });

function startsWith(fail: Error | undefined, answer: unknown = {}): string[] {
  const calls: string[] = [];
  globals.agent = async () => ({});
  globals.call = async (name: string) => {
    calls.push(name);
    if (fail !== undefined) throw fail;
    return answer;
  };
  return calls;
}

test("a refused start is the scenario's failure", async () => {
  startsWith(named("RunRefusal", "the version is a candidate"));
  expect(await tryVersion("t", "wf-1", "v1", {})).toEqual({ ok: false, error: { name: "RunRefusal", message: "the version is a candidate" } });
});

test("a step that failed or a cancel is not caught", async () => {
  for (const signal of ["PauseSignal", "Cancelled"]) {
    startsWith(named(signal, "step failed"));
    await expect(tryVersion("t", "wf-1", "v1", {})).rejects.toThrow("step failed");
    expect(isRefusal(named(signal, "x"))).toBe(false);
  }
});

test("a run that did not end in time is cancelled, and one that ended with no result failed", async () => {
  const calls = startsWith(undefined, { run: "run-1", state: "paused", reason: "a step failed" });
  expect(await tryVersion("t", "wf-1", "v1", {})).toEqual({ ok: false, error: { name: "NotEnded", message: "the run was paused (a step failed) and was cancelled" } });
  expect(calls).toEqual(["workflow.start", "workflow.cancel"]);
  startsWith(undefined, { run: "run-2", state: "finished", outcome: { status: "cancelled" } });
  expect(await tryVersion("t", "wf-1", "v1", {})).toEqual({ ok: false, error: { name: "Ended", message: "the run ended cancelled" } });
  startsWith(undefined, { run: "run-3", state: "finished", outcome: { status: "done", result: 7 } });
  expect(await tryVersion("t", "wf-1", "v1", {})).toEqual({ ok: true, value: 7 });
});
