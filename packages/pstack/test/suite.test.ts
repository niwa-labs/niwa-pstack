// pstack's entry and playbooks come in as candidates: shown, not installed, not run. The suite runs its scenarios
// on the candidates, each started by its version, and promotes the tried set in one action; a set whose scenario
// fails is not promoted.

import { afterEach, expect, test } from "bun:test";

import { eventually } from "@niwa-labs/testing";

import { builtins, pstackHost, recordsOf } from "./support.ts";
import type { Answers, PstackHost } from "./support.ts";

const hosts: PstackHost[] = [];
afterEach(async () => {
  for (const one of hosts.splice(0)) await one.close();
}, 30_000);

const ANSWERS: Answers = {
  "entry:route": () => ({ kind: "run", playbook: "investigation", task: "Where does this repository describe itself?" }),
  "investigation:trace": () => ({ summary: "The README says what the service is.", sources: [{ file: "README.md", line: 1 }] }),
};

async function served(answers: Answers = ANSWERS): Promise<PstackHost> {
  const made = await pstackHost();
  made.harnesses.answers = answers;
  hosts.push(made);
  await eventually(async () => Object.keys(await builtins(made.host)).length >= 3, 30_000, "pstack's built-ins were not registered");
  return made;
}

const versionsOf = async (made: PstackHost, id: string) =>
  ((await made.host.call("workflow.get" as never, { id } as never)) as { versions: Array<{ version: string; candidate?: boolean }> }).versions;

const startSuite = async (made: PstackHost) => {
  const suite = (await builtins(made.host))["suite"];
  return (await made.host.call("workflow.start" as never, { id: suite?.id, args: made.fixture, wait: true, timeoutMs: 60_000 } as never)) as {
    run: string;
    outcome?: { status: string; result?: any };
  };
};

test("a first install shows the entry and the playbooks as candidates and runs none of them", async () => {
  const made = await served();
  const all = await builtins(made.host);
  for (const name of ["entry", "investigation"]) {
    expect((await versionsOf(made, all[name]?.id ?? "")).map((one) => one.candidate)).toEqual([true]);
    await expect(made.host.call("workflow.start" as never, { id: all[name]?.id, args: {} } as never)).rejects.toThrow("candidate");
  }
  expect((await versionsOf(made, all["suite"]?.id ?? "")).map((one) => one.candidate)).toEqual([undefined]);
}, 60_000);

test("the suite tries the candidates by their versions and promotes the set in one action", async () => {
  const made = await served();
  const all = await builtins(made.host);
  const ran = await startSuite(made);
  expect(ran.outcome?.status).toBe("done");
  expect(ran.outcome?.result.status).toBe("promoted");
  expect(ran.outcome?.result.rows.every((one: { passed: boolean }) => one.passed)).toBe(true);

  const promoted = await recordsOf(made.host, "workflow.builtin.promoted");
  expect(promoted).toHaveLength(1);
  const data = promoted[0]?.data as { run: string; versions: Array<{ workflow: string; version: string }> };
  expect(data.run).toBe(ran.run);
  expect(data.versions.map((one) => one.workflow).sort()).toEqual([all["entry"]?.id ?? "", all["investigation"]?.id ?? ""].sort());

  // The entry the suite tried started the investigation candidate it was pinned to.
  expect(made.harnesses.of("investigation:trace").length).toBe(2);

  // Promoted: the entry starts by its id, and runs the accepted investigation.
  const entry = (await made.host.call("workflow.start" as never, {
    id: all["entry"]?.id,
    args: { request: "Where is the description?", repo: made.fixture.repo, worktrees: made.fixture.worktrees },
    wait: true,
    timeoutMs: 60_000,
  } as never)) as { outcome?: { status: string; result?: any } };
  expect(entry.outcome).toMatchObject({ status: "done", result: { status: "ran", playbook: "investigation", result: { status: "answered" } } });
}, 120_000);

test("a set with a failing scenario is not promoted, and the candidates stay candidates", async () => {
  const made = await served({ ...ANSWERS, "investigation:trace": () => ({ summary: "No idea.", sources: [] }) });
  const all = await builtins(made.host);
  const ran = await startSuite(made);
  expect(ran.outcome?.result.status).toBe("failed");
  const failed = (ran.outcome?.result.rows as Array<{ builtin: string; passed: boolean; why?: string }>).filter((one) => !one.passed);
  expect(failed.map((one) => one.builtin).sort()).toEqual(["investigation"]);
  expect(failed[0]?.why).toContain("no source");
  expect(await recordsOf(made.host, "workflow.builtin.promoted")).toEqual([]);
  expect((await versionsOf(made, all["entry"]?.id ?? "")).map((one) => one.candidate)).toEqual([true]);
}, 120_000);

test("the entry holds its rights over the repository as the four target templates", async () => {
  const made = await served();
  const all = await builtins(made.host);
  const registered = (await recordsOf(made.host, "workflow.registered")).map((one) => one.data as { workflow: string; uses: string[] });
  const uses = registered.find((one) => one.workflow === all["entry"]?.id)?.uses ?? [];
  expect(uses.filter((one) => one.includes("{"))).toEqual(
    expect.arrayContaining(["forge.pr.merge@{repo.host}/{repo.path}/pr/*", "forge.pr.ensure@{repo.host}/{repo.path}/pr/*", "proc.run@{worktrees}/*", "git.*@{repo.local}"]),
  );
  expect(uses.filter((one) => one.startsWith("forge.pr.merge") || one.startsWith("forge.pr.ensure") || one.startsWith("proc.run") || one.startsWith("git.*"))).toEqual([
    "forge.pr.merge@{repo.host}/{repo.path}/pr/*",
    "forge.pr.ensure@{repo.host}/{repo.path}/pr/*",
    "proc.run@{worktrees}/*",
    "git.*@{repo.local}",
  ]);
}, 60_000);
