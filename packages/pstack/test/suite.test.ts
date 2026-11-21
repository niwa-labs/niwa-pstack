// pstack's entry and playbooks come in as candidates: shown, not installed, not run. The suite runs its scenarios
// on the set under trial, each built-in started by its version, and promotes the candidates in one action; a set
// whose scenario fails is not promoted.

import { afterEach, expect, test } from "bun:test";

import { PrMerged } from "@niwa-labs/forge/records";
import { eventually } from "@niwa-labs/testing";

import { GATED } from "../src/catalog.ts";
import { builtins, defaultAnswers, pstackHost, recordsOf, registeredAll, syncErrors } from "./support.ts";
import type { Answers, PstackHost } from "./support.ts";

const hosts: PstackHost[] = [];
afterEach(async () => {
  for (const one of hosts.splice(0)) await one.close();
}, 30_000);

async function served(change: (answers: Answers) => Answers = (answers) => answers): Promise<PstackHost> {
  const made = await pstackHost();
  made.harnesses.answers = change(defaultAnswers(made));
  hosts.push(made);
  await registeredAll(made.host, GATED.length + 1);
  return made;
}

/** A merge on the forge, as the forge module records one. */
const merge = (made: PstackHost, number: number, version: number) =>
  made.host.emit(PrMerged, {
    pr: { repo: { host: made.fixture.repo.host, path: made.fixture.repo.path, projectId: 42 }, number },
    base: "main",
    head: "a".repeat(40),
    source: { kind: "observed", version },
  });

/** The runs of a built-in that were asked for. */
const runsOf = async (made: PstackHost, name: string) => {
  const id = (await builtins(made.host))[name]?.id;
  return (await recordsOf(made.host, "workflow.run.requested")).filter((one) => (one.data as { workflow?: string }).workflow === id);
};

const versionsOf = async (made: PstackHost, id: string) =>
  ((await made.host.call("workflow.get" as never, { id } as never)) as { versions: Array<{ version: string; candidate?: boolean }> }).versions;

const startSuite = async (made: PstackHost) => {
  const suite = (await builtins(made.host))["suite"];
  return (await made.host.call("workflow.start" as never, { id: suite?.id, args: made.fixture, wait: true, timeoutMs: 120_000 } as never)) as {
    run: string;
    outcome?: { status: string; result?: any };
  };
};

test("a first install shows the entry and the playbooks as candidates and runs none of them", async () => {
  const made = await served();
  const all = await builtins(made.host);
  for (const { name } of GATED) {
    expect((await versionsOf(made, all[name]?.id ?? "")).map((one) => one.candidate)).toEqual([true]);
    await expect(made.host.call("workflow.start" as never, { id: all[name]?.id, args: {} } as never)).rejects.toThrow("candidate");
  }
  expect((await versionsOf(made, all["suite"]?.id ?? "")).map((one) => one.candidate)).toEqual([undefined]);
  expect((await made.host.call("workflow.installation.list" as never, {} as never)) as { items: unknown[] }).toEqual({ items: [] });

  // A merge on the forge starts no cleanup before a version of it was accepted.
  await merge(made, 99, 1);
  await Bun.sleep(1000);
  expect(await runsOf(made, "worktree-cleanup")).toEqual([]);
}, 60_000);

test("the suite tries the set by its versions and promotes the candidates in one action", async () => {
  const made = await served();
  const all = await builtins(made.host);
  const ran = await startSuite(made);
  if (ran.outcome?.status !== "done") console.log(JSON.stringify(ran), (await syncErrors(made.host, "")).join("\n"));
  expect(ran.outcome?.status).toBe("done");
  const failed = (ran.outcome?.result.rows as Array<{ passed: boolean }>).filter((one) => !one.passed);
  if (failed.length > 0) console.log((await syncErrors(made.host, "")).join("\n"));
  expect(failed).toEqual([]);
  expect(ran.outcome?.result.status).toBe("promoted");

  const promoted = await recordsOf(made.host, "workflow.builtin.promoted");
  expect(promoted).toHaveLength(1);
  const data = promoted[0]?.data as { run: string; versions: Array<{ workflow: string; version: string }> };
  expect(data.run).toBe(ran.run);
  expect(data.versions.map((one) => one.workflow).sort()).toEqual(GATED.map(({ name }) => all[name]?.id ?? "").sort());

  // The plan with the go landed both its pull requests on the forge and the stack's bottom landed; the stack's top
  // and the six changes the other playbooks carried stay open, for nothing but shipping merges.
  const merged = [...made.project.mrs.values()].filter((mr) => mr.state === "merged").map((mr) => mr.iid);
  const open = [...made.project.mrs.values()].filter((mr) => mr.state === "opened").map((mr) => mr.iid);
  expect(merged).toHaveLength(3);
  expect(open).toHaveLength(7);
  expect(made.project.mrs.get(4)?.description).toStartWith("## Why");

  // Promoted: a merge on the forge starts the cleanup.
  await merge(made, 99, 1);
  await eventually(async () => (await runsOf(made, "worktree-cleanup")).length === 1, 20_000, "the cleanup did not start on the merge");

  // Promoted: the entry starts by its id, and runs the accepted investigation.
  const entry = (await made.host.call("workflow.start" as never, {
    id: all["entry"]?.id,
    args: { request: "Where is the description?", repo: made.fixture.repo, worktrees: made.fixture.worktrees },
    wait: true,
    timeoutMs: 60_000,
  } as never)) as { outcome?: { status: string; result?: any } };
  expect(entry.outcome).toMatchObject({ status: "done", result: { status: "ran", playbook: "investigation", result: { status: "answered" } } });
}, 240_000);

test("a set with a failing scenario is not promoted, and the candidates stay candidates", async () => {
  const made = await served((answers) => ({ ...answers, "investigation:trace": () => ({ summary: "No idea.", sources: [] }) }));
  const all = await builtins(made.host);
  const ran = await startSuite(made);
  expect(ran.outcome?.result.status).toBe("failed");
  const failed = (ran.outcome?.result.rows as Array<{ builtin: string; passed: boolean; why?: string }>).filter((one) => !one.passed);
  expect(failed.map((one) => one.builtin)).toEqual(["investigation"]);
  expect(failed[0]?.why).toContain("no source");
  expect(await recordsOf(made.host, "workflow.builtin.promoted")).toEqual([]);
  expect((await versionsOf(made, all["entry"]?.id ?? "")).map((one) => one.candidate)).toEqual([true]);
}, 240_000);

test("the entry holds its rights over the repository as the four target templates", async () => {
  const made = await served();
  const all = await builtins(made.host);
  const registered = (await recordsOf(made.host, "workflow.registered")).map((one) => one.data as { workflow: string; uses: string[] });
  const uses = registered.find((one) => one.workflow === all["entry"]?.id)?.uses ?? [];
  expect(uses.filter((one) => one.startsWith("forge.pr.merge") || one.startsWith("forge.pr.ensure") || one.startsWith("proc.run") || one.startsWith("git.*"))).toEqual([
    "forge.pr.merge@{repo.host}/{repo.path}/pr/*",
    "forge.pr.ensure@{repo.host}/{repo.path}/pr/*",
    "proc.run@{worktrees}/*",
    "git.*@{repo.local}",
  ]);
}, 60_000);
