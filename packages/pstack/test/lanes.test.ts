// Lanes, the go and landing on a host with the promoted set: the author is boxed to its worktree, a verdict the
// author gives itself does not count, a merge result that is not green keeps a pull request from landing, and the
// owner's go is bound to the revision of the plan it was given on.

import { afterEach, expect, test } from "bun:test";

import { GATED } from "../src/catalog.ts";
import { goDigest, goSubject } from "../src/policy.ts";
import { builtins, claimAsked, defaultAnswers, pstackHost, recordsOf, registeredAll } from "./support.ts";
import type { Answers, PstackHost, PstackHostOptions } from "./support.ts";

const hosts: PstackHost[] = [];
afterEach(async () => {
  for (const one of hosts.splice(0)) await one.close();
}, 30_000);

/** A host whose set was tried and promoted by the suite, answering as `change` says from then on. */
async function promoted(options: PstackHostOptions = {}, change: (answers: Answers) => Answers = (answers) => answers): Promise<PstackHost> {
  const made = await pstackHost(options);
  hosts.push(made);
  made.harnesses.answers = defaultAnswers(made);
  await registeredAll(made.host, GATED.length + 1);
  const all = await builtins(made.host);
  const suite = (await made.host.call("workflow.start" as never, { id: all["suite"]?.id, args: made.fixture, wait: true, timeoutMs: 120_000 } as never)) as { outcome?: { result?: { status: string } } };
  if (suite.outcome?.result?.status !== "promoted") throw new Error(`the suite did not promote: ${JSON.stringify(suite).slice(0, 2000)}`);
  made.harnesses.answers = change(defaultAnswers(made));
  return made;
}

/** Run a promoted built-in to its end and answer its result. */
async function run(made: PstackHost, name: string, args: Record<string, unknown>): Promise<any> {
  const all = await builtins(made.host);
  const ended = (await made.host.call("workflow.start" as never, { id: all[name]?.id, args: { ...made.fixture, task: "Do it.", ...args }, wait: true, timeoutMs: 120_000 } as never)) as {
    state: string;
    outcome?: { status: string; result?: unknown };
    reason?: string;
  };
  if (ended.outcome?.status !== "done") throw new Error(`${name} did not finish: ${JSON.stringify(ended).slice(0, 2000)}`);
  return ended.outcome.result;
}

/** Plan two independent pull requests without asking, and give the go on them as the owner. */
async function plannedWithGo(made: PstackHost, of: string): Promise<{ plan: { of: string; rev: number }; nodes: Array<{ id: string }> }> {
  const planned = await run(made, "multi-phase-plan", { plan: of, ask: false });
  const change = `${made.fixture.repo.host}/${made.fixture.repo.path}`;
  for (const node of planned.nodes as Array<{ id: string }>) {
    await made.asOwner("evidence.attest", { subject: goSubject(planned.plan, node.id), claim: { kind: "verdict", name: "go", outcome: "pass", sha: goDigest(planned.plan, node.id, change) } });
  }
  return planned;
}

test("the author is started boxed to its own worktree and the forge, and a place elsewhere starts nothing", async () => {
  const made = await promoted();
  const authors = [...made.harnesses.sessions.values()].filter((one) => one.harness === "author");
  expect(authors.length).toBeGreaterThan(0);
  for (const one of authors) {
    expect(one.cwd?.startsWith(`${made.worktrees}/`)).toBe(true);
    expect(one.visible).toEqual([`write:${one.cwd}/*`, "net:gitlab.example.com"]);
  }
  const before = made.harnesses.sessions.size;
  await expect(made.host.call("pstack.author.start" as never, { place: made.repo } as never)).rejects.toThrow("is not one of niwa's worktrees");
  expect(made.harnesses.sessions.size).toBe(before);
}, 240_000);

test("a verdict the author attests itself does not verify its pull request", async () => {
  const made = await promoted({}, (answers) => ({
    ...answers,
    // The verifier finds nothing to attest; the author attests the live verdict as itself.
    "*:verify-live": () => ({ outcome: "pass", evidence: "looked" }),
    "*:build": async (call) => {
      const built = (await answers["*:build"]?.(call)) as { sha: string; summary: string };
      return built;
    },
  }));
  const planned = await run(made, "multi-phase-plan", { plan: "own-verdict", ask: false });
  // The author's session attests a live pass on whatever it is asked to verify once its pull request exists.
  made.harnesses.answers["*:verify-gates"] = async (call) => {
    const asked = claimAsked(call.prompt);
    const author = [...made.harnesses.sessions.entries()].find(([, one]) => one.harness === "author" && one.cwd === call.cwd)?.[0];
    await made.attestAs(author?.split(" ")[1] ?? "", asked.subject, { kind: "verdict", name: "live", outcome: "pass", sha: asked.sha });
    await made.attestAs(call.ref?.split(" ")[1] ?? "", asked.subject, { kind: "verdict", name: "gates", outcome: "pass", sha: asked.sha });
    return { outcome: "pass", evidence: "the gates passed" };
  };
  const stacked = await run(made, "autopilot-stack", { plan: planned.plan.of });
  expect(stacked.nodes.map((one: { verified: boolean }) => one.verified)).toEqual([false, false]);
  const attested = (await recordsOf(made.host, "evidence.attested")).map((one) => one.data as { claim: { name?: string }; author: { harness?: string } });
  expect(attested.some((one) => one.claim.name === "live" && one.author.harness === "author")).toBe(true);
}, 240_000);

test("a merge result that is not green keeps a verified pull request with the go from landing", async () => {
  const made = await promoted();
  made.ci.mergeResult = "failed";
  const planned = await plannedWithGo(made, "red-merge-result");
  const done = await run(made, "autopilot-full", { plan: planned.plan.of });
  for (const node of done.nodes as Array<{ verified: boolean; go: boolean; landed: { outcome: string; missing: Array<{ name: string }> } }>) {
    expect(node).toMatchObject({ verified: true, go: true, landed: { outcome: "refused" } });
    expect(node.landed.missing.map((one) => one.name)).toEqual(["merge-result"]);
  }
  const prs = new Set((done.nodes as Array<{ pr: number }>).map((one) => one.pr));
  expect([...made.project.mrs.values()].filter((mr) => prs.has(mr.iid)).map((mr) => mr.state)).toEqual(["opened", "opened"]);
}, 240_000);

test("the owner's go is asked once, attested per node, and does not cover a revised plan", async () => {
  const made = await promoted();
  const all = await builtins(made.host);
  const { run: started } = (await made.host.call("workflow.start" as never, { id: all["multi-phase-plan"]?.id, args: { ...made.fixture, task: "Do it.", plan: "with-go" } } as never)) as { run: string };
  await made.answer(["yes"]);
  const ended = (await made.host.call("workflow.wait" as never, { run: started, timeoutMs: 60_000 } as never)) as { outcome?: { result?: any } };
  const planned = ended.outcome?.result as { go: boolean; plan: { of: string; rev: number }; nodes: Array<{ id: string }> };
  expect(planned.go).toBe(true);
  const goes = (await recordsOf(made.host, "evidence.attested")).map((one) => one.data as { subject: string; claim: { name: string; sha: string } }).filter((one) => one.claim.name === "go" && one.subject.includes("with-go"));
  const change = `${made.fixture.repo.host}/${made.fixture.repo.path}`;
  expect(goes.map((one) => [one.subject, one.claim.sha])).toEqual(planned.nodes.map((node) => [goSubject(planned.plan, node.id), goDigest(planned.plan, node.id, change)]));

  // A revision of the plan: the go of revision 1 covers nothing of it, and nothing lands.
  await made.host.call("plan.set" as never, { of: "with-go", goal: "Deliver the task, revised", items: planned.nodes.map((node) => ({ id: node.id, text: `${node.id}, revised`, state: "open" })) } as never);
  const done = await run(made, "autopilot-full", { plan: "with-go" });
  expect(done.nodes.map((one: { go: boolean; landed?: unknown }) => [one.go, one.landed])).toEqual([
    [false, undefined],
    [false, undefined],
  ]);
}, 240_000);
