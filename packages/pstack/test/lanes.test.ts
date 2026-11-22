// Lanes, the go and landing on a host with the promoted set: the author is boxed to its worktree, a verdict the
// author gives itself does not count, a merge result that is not green keeps a pull request from landing, and the
// owner's go is bound to the revision of the plan it was given on.

import { afterEach, expect, test } from "bun:test";

import { deny, grant, principalOf } from "@niwa-labs/core";
import { sessionStart } from "@niwa-labs/sessions/records";
import { connect, plugin } from "@niwa-labs/testing";

import { UNGATED, gatedOf, scriptOf } from "../src/catalog.ts";
import { goDigest, goSubject } from "../src/policy.ts";
import { pstackPrBind } from "../src/pr-binding.ts";
import { pstackAuthorOptions } from "../src/records.ts";
import { FORGE_HOST, builtins, claimAsked, defaultAnswers, pstackHost, recordsOf, registeredAll } from "./support.ts";
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
  await registeredAll(made.host, gatedOf(true).length + UNGATED.length);
  const all = await builtins(made.host);
  const suite = (await made.host.call("workflow.start" as never, { id: all["suite"]?.id, args: made.fixture, wait: true, timeoutMs: 120_000 } as never)) as { outcome?: { result?: { status: string } } };
  if (suite.outcome?.result?.status !== "promoted") throw new Error(`the suite did not promote: ${JSON.stringify(suite).slice(0, 2000)}`);
  made.harnesses.answers = change(defaultAnswers(made));
  return made;
}

/** Run a registered built-in to its end and return its result. */
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
  expect(authors.map((one) => one.box)).toContainEqual({ allow: ["project", { net: FORGE_HOST }] });
  const tools = ["harness.list", "session.start@author", "session.ask", "session.end"];
  for (const one of authors) {
    expect(one.cwd?.startsWith(`${made.worktrees}/`)).toBe(true);
    if (one.box && typeof one.box === "object" && "only" in one.box) {
      expect(one.box).toEqual({ only: ["project", "toolchains"] });
      const usesHelpers = made.harnesses.of("autonomous-run:attempt").some(call => call.ref === made.harnesses.lookup(one.id)[0]);
      expect(one.visible).toEqual(usesHelpers ? tools : []);
    } else {
      expect(one.box).toMatchObject({ allow: expect.arrayContaining(["project"]) });
    }
    expect(one.ended).toBe(true);
    if (one.visible?.length) expect(one.visible).toEqual(tools);
    expect(one.caller).toMatchObject({ kind: "client", principal: { kind: "run" } });
  }
  const attempts = made.harnesses.of("hillclimb:attempt");
  expect(attempts).toHaveLength(2);
  const ref = attempts[0]?.ref;
  expect(ref).toBeDefined();
  expect(attempts.map((call) => call.ref)).toEqual([ref, ref]);
  expect(made.harnesses.lookup(ref ?? "")[1]).toMatchObject({ ended: true, visible: tools });

  const before = made.harnesses.sessions.size;
  await expect(made.host.call(pstackAuthorOptions, { place: made.repo })).rejects.toThrow("is not one of niwa's worktrees");
  expect(made.harnesses.sessions.size).toBe(before);
}, 240_000);

test("checked author settings add only the forge network the caller can grant", async () => {
  const made = await pstackHost({ benny: false });
  hosts.push(made);
  const { path } = await made.host.call("git.worktree.create" as never, { repo: made.repo, description: "author grant" } as never) as { path: string };
  for (const [label, rule, allow] of [
    ["local", [], ["project"]],
    ["publish", [`box.net@${FORGE_HOST}`], ["project", { net: FORGE_HOST }]],
  ] as const) {
    const token = made.host.issueToken(principalOf("client", label), { grant: grant([pstackAuthorOptions.name, ...rule]) });
    const client = await connect({ home: made.home, id: label, token });
    try {
      expect(await client.call(pstackAuthorOptions, { place: path })).toEqual({ harness: "author", cwd: path, box: { allow: [...allow] } });
      expect(made.harnesses.sessions.size).toBe(0);
    } finally {
      await client.close();
    }
  }
}, 30_000);

test("the fake session preserves mixed visible action rules", async () => {
  const made = await pstackHost({ benny: false });
  hosts.push(made);
  const actions = ["harness.list", { do: "session.ask", ask: true as const }];
  const { ref } = await made.host.call(sessionStart, { harness: "author", prompt: "", visible: { actions } });
  expect(made.harnesses.lookup(ref)[1].visible).toEqual(actions);
}, 30_000);

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

async function redMergeResultHost(): Promise<PstackHost> {
  const made = await pstackHost({ onlyBuiltins: ["multi-phase-plan", "autopilot-full"], ci: { mergeResult: "failed" } });
  hosts.push(made);
  made.harnesses.answers = defaultAnswers(made);
  await registeredAll(made.host, 2);
  return made;
}

test("a merge result that is not green keeps a verified pull request with the go from landing", async () => {
  const made = await redMergeResultHost();
  const planned = await plannedWithGo(made, "red-merge-result");
  const done = await run(made, "autopilot-full", { plan: planned.plan.of });
  expect(done.nodes.map((node: { node: string }) => node.node)).toEqual(planned.nodes.map(({ id }) => id));
  for (const node of done.nodes as Array<{ verified: boolean; go: boolean; landed: { outcome: string; missing: Array<{ name: string }> } }>) {
    expect(node).toMatchObject({ verified: true, go: true, gate: { decision: "unchanged" }, landed: { outcome: "refused" } });
    expect(node.landed.missing.map((one) => one.name)).toEqual(["merge-result"]);
  }
  const prs = new Set((done.nodes as Array<{ pr: number }>).map((one) => one.pr));
  expect([...made.project.mrs.values()].filter((mr) => prs.has(mr.iid)).map((mr) => mr.state)).toEqual(["opened", "opened"]);
  expect(made.gitlab.seen("PUT", /\/merge$/)).toHaveLength(0);
}, 90_000);

test("the owner's go is asked once, attested per node, and does not cover a revised plan", async () => {
  const made = await pstackHost({ onlyBuiltins: ["multi-phase-plan", "autopilot-full"] });
  hosts.push(made);
  made.harnesses.answers = defaultAnswers(made);
  await registeredAll(made.host, 2);
  const all = await builtins(made.host);
  const { run: started } = (await made.host.call("workflow.start" as never, { id: all["multi-phase-plan"]?.id, args: { ...made.fixture, task: "Do it.", plan: "with-go" } } as never)) as { run: string };
  await made.answer(started, ["yes"]);
  const ended = (await made.host.call("workflow.wait" as never, { run: started, timeoutMs: 60_000 } as never)) as { outcome?: { result?: any } };
  const planned = ended.outcome?.result as { go: boolean; plan: { of: string; rev: number }; nodes: Array<{ id: string }> };
  expect(planned.go).toBe(true);
  const requests = (await recordsOf(made.host, "request.created"))
    .map(({ data }) => data as { id: string; from?: { kind: string; id?: string }; to: { kind: string } })
    .filter(({ from }) => from?.kind === "client" && from.id === `run:${started}`);
  expect(requests).toHaveLength(1);
  expect(requests[0]?.to).toEqual({ kind: "owner" });
  const answers = (await recordsOf(made.host, "request.answered")).map(({ data }) => data);
  expect(answers).toContainEqual(expect.objectContaining({ id: requests[0]?.id, by: { kind: "owner" }, answer: { ids: ["yes"] } }));
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
}, 90_000);

/** A merge-result claim of a pull request's selected merge result, as the fake forge has it. */
function mergeResultClaim(made: PstackHost, number: number, sha: string) {
  const pipeline = [...made.project.pipelines].reverse().find((one) => one.ref === `refs/merge-requests/${String(number)}/merge`);
  const parents = pipeline === undefined ? undefined : made.project.commits.get(pipeline.sha);
  if (pipeline === undefined || parents?.[0] === undefined) throw new Error(`no merge result of ${String(number)}`);
  return { kind: "ci", at: "merge-result", sourceSha: sha, targetSha: parents[0], mergeSha: pipeline.sha, pipeline: pipeline.id, pipelineKind: "merge-result" };
}

test("a merge result a verifier attests does not stand in for the red one the forge reports", async () => {
  const made = await redMergeResultHost();
  const planned = await plannedWithGo(made, "forged-merge-result");
  // The verifiers, who are not the authors, also attest a green merge result of the pair the forge selected.
  const verify = made.harnesses.answers["*:verify-gates"];
  const claims = new Map<number, ReturnType<typeof mergeResultClaim>>();
  made.harnesses.answers["*:verify-gates"] = async (call) => {
    const asked = claimAsked(call.prompt);
    const number = Number(asked.subject.slice(asked.subject.lastIndexOf("/") + 1));
    const claim = mergeResultClaim(made, number, asked.sha);
    await made.attestAs(call.ref?.split(" ")[1] ?? "", asked.subject, claim);
    claims.set(number, claim);
    return await verify?.(call);
  };
  const done = await run(made, "autopilot-full", { plan: planned.plan.of });
  expect(done.nodes.map((node: { node: string }) => node.node)).toEqual(planned.nodes.map(({ id }) => id));
  for (const node of done.nodes as Array<{ pr: number; head: string; landed: { outcome: string; missing: Array<{ name: string }> } }>) {
    expect(node).toMatchObject({ verified: true, go: true, gate: { decision: "unchanged" }, landed: { outcome: "refused" } });
    expect(claims.get(node.pr)).toMatchObject({ sourceSha: node.head });
    expect(node.landed.missing.map((one) => one.name)).toEqual(["merge-result"]);
    expect(made.project.mrs.get(node.pr)?.state).toBe("opened");
  }
  expect(made.gitlab.seen("PUT", /\/merge$/)).toHaveLength(0);
}, 90_000);

test("a head the forge reports red after it was verified green does not land", async () => {
  const made = await promoted();
  const planned = await run(made, "multi-phase-plan", { plan: "red-later", ask: false });
  const stacked = await run(made, "autopilot-stack", { plan: planned.plan.of });
  const change = `${made.fixture.repo.host}/${made.fixture.repo.path}`;
  for (const node of planned.nodes as Array<{ id: string }>) {
    await made.asOwner("evidence.attest", { subject: goSubject(planned.plan, node.id), claim: { kind: "verdict", name: "go", outcome: "pass", sha: goDigest(planned.plan, node.id, change) } });
  }
  const [bottom] = stacked.nodes as Array<{ node: string; pr: number; head: string; author: unknown }>;
  if (bottom === undefined) throw new Error("nothing was stacked");
  // The head's pipeline runs again, and fails: the green one attested when it was verified is not the latest.
  made.gitlab.pipeline(made.project, { sha: bottom.head, ref: `refs/merge-requests/${String(bottom.pr)}/head`, status: "failed", source: "merge_request_event" });
  const shipped = await run(made, "shipping", { plan: planned.plan.of, prs: [{ number: bottom.pr, nodes: [bottom.node], author: bottom.author }] });
  expect(shipped.status).toBe("stopped");
  expect(shipped.prs[0].missing.map((one: { name: string }) => one.name)).toEqual(["head-ci"]);
  expect(made.project.mrs.get(bottom.pr)?.state).toBe("opened");
}, 240_000);

test("standalone shipping binds the author, MR and live target and refuses before merge", async () => {
  const made = await pstackHost({ onlyBuiltins: ["multi-phase-plan", "autopilot-stack", "shipping"] });
  hosts.push(made);
  made.harnesses.answers = defaultAnswers(made);
  await registeredAll(made.host, 3);
  const planned = await plannedWithGo(made, "standalone");
  const stacked = await run(made, "autopilot-stack", { plan: planned.plan.of });
  const [bottom] = stacked.nodes as Array<{ node: string; pr: number; head: string; author: { kind: "session"; id: string; harness: string } }>;
  if (!bottom) throw new Error("no PR built");
  const repo = { host: made.fixture.repo.host, path: made.fixture.repo.path };
  const key = { repo, number: bottom.pr, head: bottom.head };
  const receipt = await made.host.call("pstack.pr.binding" as never, key as never) as { binding?: { author: unknown; run: string } };
  expect(receipt.binding?.author).toEqual(bottom.author);
  const rows = await recordsOf(made.host, "pstack.pr.bound");
  expect(await made.host.call("pstack.pr.binding" as never, { ...key, before: rows[0]?.seq } as never)).toEqual({});
  const bound = rows[0]!.data as { run: string; worktree: object };
  await expect(made.host.call("pstack.pr.bind" as never, { ...key, author: bottom.author, worktree: bound.worktree } as never))
    .rejects.toThrow("only a registered pstack authoring lane");

  const ship = async (author?: typeof bottom.author) => {
    const shipped = await run(made, "shipping", { plan: planned.plan.of, prs: [{ number: bottom.pr, nodes: [bottom.node], author }] });
    expect(shipped.status).toBe("stopped");
    return shipped.prs[0].missing.map((one: { name: string }) => one.name);
  };
  const subject = `${repo.host}/${repo.path}/pr/${bottom.pr}`;
  for (const name of ["gates", "live"]) {
    await made.attestAs(bottom.author.id, subject, { kind: "verdict", name, outcome: "pass", sha: bottom.head });
  }
  expect(await ship({ ...bottom.author, id: "another-session" })).toEqual(["author"]);
  expect(await ship()).toEqual(["land"]);

  const previous = made.project.branches.get("main")!;
  made.project.branches.set("main", bottom.head);
  expect(await ship()).toEqual(["merge-result"]);
  made.project.branches.set("main", previous);
  const own = made.project.pipelines.find(one => one.ref === `refs/merge-requests/${bottom.pr}/merge`)!;
  own.status = "failed";
  made.gitlab.mr(made.project, { iid: 987, source_branch: "other", sha: bottom.head });
  made.gitlab.pipeline(made.project, { ref: "refs/merge-requests/987/merge", sha: own.sha, status: "success", source: "merge_request_event" });
  expect(await ship()).toEqual(["merge-result"]);
  const mr = made.project.mrs.get(bottom.pr)!;
  mr.sha = previous;
  expect(await ship()).toEqual(["author"]);
  expect(made.gitlab.seen("PUT", /\/merge$/)).toHaveLength(0);
}, 150_000);

/** Both verification seats report the author's own evidence in this fixture. */
function attestAsAuthor(made: PstackHost): void {
  for (const name of ["gates", "live"]) {
    made.harnesses.answers[`*:verify-${name}`] = async call => {
      const asked = claimAsked(call.prompt);
      const author = [...made.harnesses.sessions.entries()].find(([, one]) => one.harness === "author" && one.cwd === call.cwd);
      if (!author) throw new Error("no author for this checkout");
      await made.attestAs(author[0].split(" ")[1]!, asked.subject, { kind: "verdict", name, outcome: "pass", sha: asked.sha });
      return { outcome: "pass", evidence: "only the author's verdict" };
    };
  }
}

test("the author's own verdicts on a bound head cannot satisfy standalone shipping", async () => {
  const made = await pstackHost({ onlyBuiltins: ["multi-phase-plan", "autopilot-stack", "shipping"] });
  hosts.push(made);
  made.harnesses.answers = defaultAnswers(made);
  attestAsAuthor(made);
  await registeredAll(made.host, 3);
  const planned = await plannedWithGo(made, "self-verdict");
  const stacked = await run(made, "autopilot-stack", { plan: planned.plan.of });
  const [bottom] = stacked.nodes;
  expect(bottom.verified).toBe(false);
  const prs = [{ number: bottom.pr, nodes: [bottom.node] }];
  const shipped = await run(made, "shipping", { plan: planned.plan.of, prs });
  expect(shipped.prs[0].missing.map((one: { name: string }) => one.name)).toEqual(["gates", "live"]);
  const forged = await run(made, "shipping", { plan: planned.plan.of, prs: [{ ...prs[0], author: { ...bottom.author, id: "another-session" } }] });
  expect(forged.prs[0].missing.map((one: { name: string }) => one.name)).toEqual(["author"]);
  expect(made.gitlab.seen("PUT", /\/merge$/)).toHaveLength(0);
}, 150_000);

test("a resumed registered lane binds the open PR and its next head under the stable run", async () => {
  let interrupt = true;
  const made = await pstackHost({
    onlyBuiltins: ["multi-phase-plan", "autopilot-stack", "shipping"],
    plugins: [plugin("interrupt-receipt", api => api.guard(pstackPrBind, () => interrupt ? deny("fixture interruption after PR opened") : undefined))],
  });
  hosts.push(made);
  made.harnesses.answers = defaultAnswers(made);
  attestAsAuthor(made);
  await registeredAll(made.host, 3);
  const planned = await plannedWithGo(made, "resume-receipt");
  const flows = await builtins(made.host);
  const args = { ...made.fixture, task: "Do it.", plan: planned.plan.of };
  const timeoutMs = 30_000;
  const started = await made.host.call("workflow.start" as never, { id: flows["autopilot-stack"]!.id, args, wait: true, timeoutMs } as never) as { run: string };
  expect(started).toMatchObject({ state: "paused" });
  const lane = `node-${planned.nodes[0]!.id}`;
  const from = `@${lane}.owner.label:${lane}-pr-bind`;
  expect(started).toMatchObject({ reason: expect.stringContaining(from) });
  expect(started).not.toHaveProperty("waiting");
  expect((await recordsOf(made.host, "niwa.step.outcome")).map(row => row.data)).toContainEqual(expect.objectContaining({
    key: from,
    outcome: { status: "denied", reason: "fixture interruption after PR opened" },
  }));
  expect(made.project.mrs.size).toBe(1);
  const opened = [...made.project.mrs.values()][0]!;
  expect(await recordsOf(made.host, "pstack.pr.bound")).toHaveLength(0);
  interrupt = false;
  await made.asOwner("workflow.resume", { run: started.run, from });
  const result = await made.host.call("workflow.wait" as never, { run: started.run, timeoutMs } as never) as { state: string; outcome?: { status: string; result: { nodes: Array<{ node: string; pr: number; head: string; author: unknown }> } } };
  expect(result.state).toBe("finished");
  expect(result.outcome?.status).toBe("done");
  const nodes = result.outcome!.result.nodes;
  expect(nodes.map(one => one.node)).toEqual(planned.nodes.map(one => one.id));
  expect(nodes.map(one => one.pr)).toEqual([opened.iid, opened.iid + 1]);
  expect(nodes[0]!.head).toBe(opened.sha);
  expect(nodes[1]!.head).not.toBe(opened.sha);
  expect(made.gitlab.seen("POST", /\/merge_requests$/)).toHaveLength(2);
  const settled = (await recordsOf(made.host, "workflow.scope.settled")).map(row => row.data);
  for (const node of nodes) {
    const scope = `@node-${node.node}`;
    expect(settled).toContainEqual(expect.objectContaining({ run: started.run, scope, key: "owner", outcome: "done" }));
    expect(settled).toContainEqual(expect.objectContaining({ run: started.run, scope, key: "audit", outcome: "cancelled" }));
  }
  const { host, path } = made.fixture.repo;
  for (const node of nodes) {
    expect(await made.host.call("pstack.pr.binding" as never, { repo: { host, path }, number: node.pr, head: node.head } as never))
      .toMatchObject({ binding: { run: started.run, author: node.author } });
  }
  const last = nodes[1]!;
  const shipped = await run(made, "shipping", { plan: planned.plan.of, prs: [{ number: last.pr, nodes: [last.node] }] });
  expect(shipped.prs[0].missing.map((one: { name: string }) => one.name)).toEqual(["gates", "live"]);

  // The unarchived source has the same code, name and grants. Its inherited origin must not authorize it.
  const beforeRevision = (await recordsOf(made.host, "niwa.step.outcome")).at(-1)?.seq ?? 0;
  await made.asOwner("workflow.revise", { run: started.run, file: scriptOf("autopilot-stack"), from });
  const revised = await made.host.call("workflow.wait" as never, { run: started.run, timeoutMs } as never) as { outcome?: { status: string }; reason?: string };
  expect(revised).toMatchObject({ state: "paused" });
  const failures = await recordsOf(made.host, "niwa.step.outcome");
  expect(failures.filter(row => row.seq > beforeRevision).map(row => row.data)).toContainEqual(expect.objectContaining({
    key: from,
    outcome: expect.objectContaining({ status: "failed", error: expect.stringContaining("only a registered pstack authoring lane can bind a pull request") }),
  }));
  expect(await recordsOf(made.host, "pstack.pr.bound")).toHaveLength(2);
  expect(made.gitlab.seen("POST", /\/merge_requests$/)).toHaveLength(2);
}, 120_000);

test("a registered lane surfaces an unrelated owner refusal while the audit sleeps", async () => {
  const made = await pstackHost({
    onlyBuiltins: ["multi-phase-plan", "autopilot-stack"],
    plugins: [plugin("interrupt-author", api => api.guard(pstackAuthorOptions, () => deny("fixture author grant refused")))],
  });
  hosts.push(made);
  made.harnesses.answers = defaultAnswers(made);
  await registeredAll(made.host, 2);
  const planned = await plannedWithGo(made, "author-refused");
  const flows = await builtins(made.host);
  const timeoutMs = 30_000;
  const started = await made.host.call("workflow.start" as never, {
    id: flows["autopilot-stack"]!.id, args: { ...made.fixture, task: "Do it.", plan: planned.plan.of }, wait: true, timeoutMs,
  } as never);
  const lane = `node-${planned.nodes[0]!.id}`;
  const key = `@${lane}.owner.label:${lane}-build-author-options`;
  expect(started).toMatchObject({ state: "paused", reason: expect.stringContaining(key) });
  expect(started).not.toHaveProperty("waiting");
  expect((await recordsOf(made.host, "timer.sleep.requested")).map(row => row.data)).toContainEqual(expect.objectContaining({
    key: expect.stringContaining(`@${lane}.audit.label:${lane}-audit-sleep-1`),
  }));
  expect((await recordsOf(made.host, "niwa.step.outcome")).map(row => row.data)).toContainEqual(expect.objectContaining({
    key,
    outcome: { status: "denied", reason: "fixture author grant refused" },
  }));
  expect(made.project.mrs.size).toBe(0);
}, 60_000);
