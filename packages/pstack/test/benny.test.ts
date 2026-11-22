// Benny, when enabled: an agent for the agents module, and two gated automations. A report handed to him is triaged;
// a bug is reproduced and fixed in a draft pull request; nothing else is. Before the suite promoted them, a report
// starts nothing.

import { afterEach, expect, test } from "bun:test";

import { eventually } from "@niwa-labs/testing";

import { BENNY, UNGATED, gatedOf } from "../src/catalog.ts";
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
  await registeredAll(made.host, gatedOf(benny).length + UNGATED.length);
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
  // This report came with no source: the session is told so, and that no issue is filed for it.
  expect(report).toContain("This report has no source: file no issue for it");
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

test("a report with a source gets its verdict once, in its own thread, through the channel, and the session is shown the tracker, not the channel", async () => {
  const made = await served();
  await promote(made);
  made.ports.calls.length = 0;
  const before = (await runsOf(made, "benny-reproduce")).length;
  made.harnesses.answers["benny-triage:triage"] = async () => {
    const created = (await made.asOwner("benny.tracker.create", { title: "README names the wrong service", body: "Quoted.", source: "thread-9" })) as { id: string; url: string };
    return { verdict: "bug", owner: "the README", summary: "The README names the wrong service.", tracker: created };
  };
  await made.asOwner("benny.report", { report: "The README calls the service payroll.", from: "a customer", source: "thread-9" });
  await eventually(async () => (await runsOf(made, "benny-reproduce")).length === before + 1, 60_000, "the bug was not reproduced");

  const replies = made.ports.of("benny.channel.reply");
  expect(replies).toHaveLength(1);
  expect(replies[0]?.input).toEqual({ source: "thread-9", text: "bug: The README names the wrong service.\nhttps://tracker.example/issue/ISSUE-1" });
  const triage = made.harnesses.of("benny-triage:triage").at(-1);
  expect(triage?.visible).toEqual(["benny.tracker.find", "benny.tracker.create", "benny.tracker.comment"]);
  expect(triage?.prompt).toContain("The report's source: thread-9");
  expect(made.ports.issues.get("ISSUE-1")?.prs).toEqual([expect.stringMatching(/^gitlab\.example\.com\/acme\/billing\/pr\/\d+$/)]);
  expect(made.ports.of("benny.tracker.link-pr")).toHaveLength(1);
  expect(made.ports.of("benny.channel.notify")).toEqual([expect.objectContaining({ input: expect.objectContaining({ source: "thread-9" }) })]);
}, 240_000);

test("the reproduction session is shown the control actions of the product, and a report with no source posts nowhere", async () => {
  const made = await served();
  await promote(made);
  made.ports.calls.length = 0;
  const before = (await runsOf(made, "benny-reproduce")).length;
  await made.asOwner("benny.report", { report: "The README calls the service payroll." });
  await eventually(async () => (await runsOf(made, "benny-reproduce")).length === before + 1, 60_000, "the bug was not reproduced");

  const repro = made.harnesses.of("benny-reproduce:reproduce").at(-1);
  expect(repro?.visible).toEqual([
    "benny.control.capabilities",
    "benny.control.bring-up",
    "benny.control.drive",
    "benny.control.inspect",
    "benny.control.screenshot",
    "benny.control.record",
    "benny.control.cleanup",
  ]);
  expect(repro?.prompt).toContain("benny.control.capabilities");
  expect(made.ports.of("benny.channel.reply")).toEqual([]);
  expect(made.ports.of("benny.channel.notify")).toEqual([]);
  expect(made.ports.of("benny.tracker.link-pr")).toEqual([]);
}, 240_000);

test("a report whose bug is not reproduced is told to the channel once, and no pull request is linked", async () => {
  const made = await served();
  await promote(made);
  made.ports.calls.length = 0;
  made.harnesses.answers["benny-reproduce:reproduce"] = () => ({ kind: "not-reproduced", runs: ["The README says billing."] });
  const before = (await runsOf(made, "benny-reproduce")).length;
  await made.asOwner("benny.report", { report: "The README calls the service payroll.", source: "thread-3" });
  await eventually(async () => (await runsOf(made, "benny-reproduce")).length === before + 1, 60_000, "the bug was not reproduced");
  expect(made.ports.of("benny.channel.notify")).toEqual([expect.objectContaining({ input: { text: "Could not reproduce: The README names the wrong service.", source: "thread-3" } })]);
  expect(made.ports.of("benny.tracker.link-pr")).toEqual([]);
}, 240_000);
