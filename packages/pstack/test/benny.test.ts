// Benny, when enabled: an agent for the agents module, and two gated automations. A report handed to him is triaged;
// a bug is reproduced and fixed in a draft pull request; nothing else is. Before the suite promoted them, a report
// starts nothing.

import { afterEach, expect, test } from "bun:test";

import { eventually } from "@niwa-labs/testing";

import { BENNY, gatedOf } from "../src/catalog.ts";
import { builtins, defaultAnswers, pstackHost, recordsOf, registeredAll } from "./support.ts";
import type { PstackHost } from "./support.ts";

const hosts: PstackHost[] = [];
afterEach(async () => {
  for (const one of hosts.splice(0)) await one.close();
}, 30_000);

async function served(benny = true): Promise<PstackHost> {
  const made = await pstackHost(benny ? {} : { benny: false });
  hosts.push(made);
  made.harnesses.answers = defaultAnswers(made);
  await registeredAll(made.host, gatedOf(benny).length + 1);
  return made;
}

async function promote(made: PstackHost): Promise<void> {
  const suite = (await builtins(made.host))["suite"];
  const ran = (await made.host.call("workflow.start" as never, { id: suite?.id, args: made.fixture, wait: true, timeoutMs: 120_000 } as never)) as { outcome?: { result?: { status: string } } };
  expect(ran.outcome?.result?.status).toBe("promoted");
}

const runsOf = async (made: PstackHost, name: string) => {
  const id = (await builtins(made.host))[name]?.id;
  const requested = new Set((await recordsOf(made.host, "workflow.run.requested")).filter((one) => (one.data as { workflow?: string }).workflow === id).map((one) => (one.data as { run: string }).run));
  return (await recordsOf(made.host, "workflow.run.finished")).filter((one) => requested.has((one.data as { run: string }).run)).map((one) => (one.data as { outcome: { result?: any } }).outcome.result);
};

test("a report starts nothing before the suite promoted Benny, and is triaged and fixed in a draft after", async () => {
  const made = await served();
  expect(made.agents.map((one) => one.name)).toEqual(["benny"]);
  await made.asOwner("benny.report", { report: "The README calls the service payroll." });
  await Bun.sleep(1000);
  expect(await recordsOf(made.host, "workflow.run.requested")).toEqual([]);

  await promote(made);
  // The suite's own scenarios ran each automation once.
  const before = { mrs: made.project.mrs.size, triaged: (await runsOf(made, "benny-triage")).length, fixed: (await runsOf(made, "benny-reproduce")).length };
  await made.asOwner("benny.report", { report: "The README calls the service payroll.", from: "a customer" });
  await eventually(async () => (await runsOf(made, "benny-reproduce")).length === before.fixed + 1, 60_000, "the bug was not reproduced");
  const triaged = (await runsOf(made, "benny-triage")).slice(before.triaged);
  expect(triaged).toEqual([expect.objectContaining({ verdict: "bug" })]);
  const fixed = (await runsOf(made, "benny-reproduce")).at(-1);
  expect(fixed).toMatchObject({ status: "verified", runs: ["The README says payroll.", "It still says payroll."] });
  expect(made.project.mrs.size).toBe(before.mrs + 1);
  const report = made.harnesses.of("benny-triage:triage").at(-1)?.prompt ?? "";
  expect(report).toContain("<report>\nThe README calls the service payroll.\n</report>");
}, 240_000);

test("a report that is not a bug is triaged and goes no further", async () => {
  const made = await served();
  await promote(made);
  made.harnesses.answers["benny-triage:triage"] = () => ({ verdict: "other", owner: "nobody", summary: "A question." });
  const reproduced = (await runsOf(made, "benny-reproduce")).length;
  await made.asOwner("benny.report", { report: "How do I read the README?" });
  await eventually(async () => (await runsOf(made, "benny-triage")).some((one) => one?.verdict === "other"), 60_000, "the report was not triaged");
  await Bun.sleep(1000);
  expect((await runsOf(made, "benny-reproduce")).length).toBe(reproduced);
}, 240_000);

test("without Benny there is no agent, no report action and none of his automations, and the suite still promotes", async () => {
  const made = await served(false);
  expect(made.agents).toEqual([]);
  const all = await builtins(made.host);
  for (const { name } of BENNY) expect(all[name]).toBeUndefined();
  await expect(made.asOwner("benny.report", { report: "x" })).rejects.toThrow();
  await promote(made);
}, 240_000);
