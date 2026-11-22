import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { GO, goDigest } from "../src/policy.ts";

const globals = globalThis as Record<string, unknown>;
const head = "a".repeat(40);
const next = "b".repeat(40);
const repo = { host: "forge.example", path: "team/project", local: "/checkout" };
const project = { host: repo.host, path: repo.path };
const input = { repo, worktrees: "/trees", base: "main", task: "Prove continuation" };
const tree = { id: "wt-111111", repo: repo.local, path: "/trees/wt-111111", branch: "topic", baseSha: head };
const pr = { state: "open", head, base: "main", branch: tree.branch, autoMerge: false };
const roles = { lead: { harness: "lead" }, reviewer: { harness: "reviewer" }, author: { harness: "author", box: true as const }, verifier: { harness: "verifier" } };
const names = new Set<string>();

function install(values: Record<string, unknown>) {
  for (const [name, value] of Object.entries(values)) {
    names.add(name);
    globals[name] = value;
  }
}

afterEach(() => {
  for (const name of names) delete globals[name];
  names.clear();
});

type Input = Record<string, any>;
type Handler = (input: Input, label: string) => unknown;
type Script = { definition: { input?: z.ZodType; output: z.ZodType }; run: (args: unknown) => Promise<unknown> };

function runtime(actions: Record<string, Handler> = {}, answers: Record<string, unknown> = {}) {
  const calls: Array<{ name: string; input: Input; label: string }> = [];
  const emitted: Array<{ name: string; data: unknown }> = [];
  const turns: string[] = [];
  const box: unknown[] = [];
  const answer = (opts: { label: string; schema: z.ZodType }, prompt: string) => {
    turns.push(prompt);
    return opts.schema.parse(answers[opts.label]);
  };
  install({
    z, workflow: (definition: unknown, run: unknown) => ({ definition, run }), phase: () => undefined,
    record: (name: string, schema: z.ZodType) => ({ name, schema }),
    emit: async (record: { name: string; schema: z.ZodType }, data: unknown) => { emitted.push({ name: record.name, data: record.schema.parse(data) }); },
    ask: Object.assign(answer, { choice: async (_: string, __: unknown, opts: { label: string }) => answers[opts.label] }),
    session: async (opts: { box: unknown }) => {
      box.push(opts.box);
      return { address: { kind: "session", id: "author-1", harness: "author" }, ask: async (prompt: string, opts: Parameters<typeof answer>[0]) => answer(opts, prompt), end: async () => undefined };
    },
    call: async (name: string, input: Input, { label = name }: { label?: string } = {}) => {
      calls.push({ name, input, label });
      if (actions[name]) return actions[name](input, label);
      if (name === "pstack.roles") return roles;
      if (name === "pstack.author.options") return { harness: "author", box: { allow: ["project"] } };
      if (name === "git.worktree.create") return tree;
      if (name === "git.worktree.list") return { items: [] };
      if (name === "forge.pr.list") return { items: [] };
      if (name === "history.list") return { sessions: [], more: false, unreadable: [] };
      if (name === "forge.pr.read") return pr;
      if (name === "proc.run") return { exit: 0, tail: "", truncated: false };
      throw new Error(`Unexpected ${name} (${label})`);
    },
    scope: async (_name: string, _options: unknown, run: () => Promise<unknown>) => run(),
    parallel: async (branches: Record<string, () => Promise<unknown>>) =>
      Object.fromEntries(await Promise.all(Object.entries(branches).map(async ([key, fn]) => [key, await fn()]))),
    stream: () => { throw new Error("Unexpected stream"); },
    race: () => { throw new Error("Unexpected race"); },
    wait: () => { throw new Error("Unexpected wait"); },
    sleep: () => { throw new Error("Unexpected sleep"); },
    random: () => { throw new Error("Unexpected random"); },
    read: { records: () => { throw new Error("Unexpected records read"); } },
    log: () => undefined,
    moveOnAfter: async (_name: string, _limit: unknown, attempt: () => Promise<unknown>) => attempt(),
    now: async () => 0,
  });
  return { calls, emitted, turns, box };
}

async function run(script: unknown, args: unknown) {
  const { definition, run } = script as Script;
  return definition.output.parse(await run(definition.input ? definition.input.parse(args) : args));
}

async function check(script: unknown, args: unknown, outcome: unknown) {
  expect(await run(script, args)).toMatchObject(outcome as object);
}

test.each([["checks", "forge.checks"], ["head", "forge.pr.head"], ["merged", "forge.pr.merged"]] as const)(
  "Autonomous run checkpoints the attempt and tests the same predicate after a scoped %s wake", async (event, record) => {
  const { calls, emitted, turns, box } = runtime({
    "proc.run": ({ cmd }, label) => cmd[0] === "sh" ? { exit: label === "wake-check-2" ? 0 : 1, tail: "predicate evidence" }
      : { exit: 0, tail: cmd.includes("rev-parse") ? head : "", truncated: false },
  }, { "attempt-1": { change: "Discarded a failed alternative" } });
  const filter = { "pr.repo.host": repo.host, "pr.repo.path": repo.path, "pr.number": 17 };
  let waited = 0;
  install({
    read: { records: async (query: unknown) => { expect(query).toMatchObject({ types: [record], filter }); return { next: 19 }; } },
    wait: async (type: string, options: unknown) => {
      expect(type).toBe(record);
      expect(options).toMatchObject({ filter, from: 19, timeout: 30 });
      expect(emitted).toHaveLength(1);
      waited++;
      return { at: 20 };
    },
  });
  const { default: script } = await import("../src/workflows/autonomous-run.ts");
  await check(script, { ...input, predicate: "test -f done", wake: { heartbeatMs: 30, pr: 17, event } }, { status: "met", head, rows: [{ iteration: 1, held: false }] });
  expect(waited).toBe(1);
  expect(turns).toHaveLength(1);
  expect(box).toEqual([{ only: ["project", "toolchains"] }]);
  expect(calls.filter(one => one.input.cmd?.[0] === "sh").map(one => one.input.cmd[2])).toEqual(Array(3).fill("test -f done"));
});

test("Autonomous run uses a fixed heartbeat and asks for a pivot after a plateau", async () => {
  const { emitted, turns } = runtime({
    "proc.run": ({ cmd }, label) => cmd[0] === "sh" ? { exit: label === "check-2" ? 0 : 1, tail: "same diagnostic" }
      : { exit: 0, tail: cmd.includes("rev-parse") ? head : "", truncated: false },
  }, { "attempt-1": { change: "Ruled out the first hypothesis" }, "attempt-2": { change: "The alternative satisfies the predicate" } });
  const heartbeats: number[] = [];
  install({ sleep: async (ms: number) => { heartbeats.push(ms); expect(emitted).toHaveLength(1); } });
  const { default: script } = await import("../src/workflows/autonomous-run.ts");
  await check(script, { ...input, predicate: "test -f done", wake: { heartbeatMs: 25 }, max: 2 }, {
    status: "met", rows: [{ iteration: 1, held: false }, { iteration: 2, held: true }],
  });
  expect(heartbeats).toEqual([25]);
  expect(turns[1]).toContain("Change the hypothesis or probe.");
});

test("Autonomous run records a timed-out attempt and keeps its recovery checkout", async () => {
  const { calls, emitted, turns } = runtime({
    "proc.run": ({ cmd }) => ({ exit: cmd[0] === "sh" ? 1 : 0, tail: cmd.includes("rev-parse") ? next : "", truncated: false }),
  });
  install({ moveOnAfter: async () => undefined });
  const { default: script } = await import("../src/workflows/autonomous-run.ts");
  await expect(run(script, { ...input, predicate: "false", attemptTimeoutMs: 10 })).resolves.toMatchObject({ status: "not-met", worktree: tree.path, reason: expect.stringContaining("timed out"), head: next });
  expect(emitted[0]).toMatchObject({ name: "attempt", data: { exit: null, held: false, head: next } });
  expect(turns).toHaveLength(0);
  expect(calls.some(one => one.name === "git.worktree.remove")).toBe(false);
});

const finding = { comment: 1, discussion: "d-1", author: "bot", body: "Check owner's data policy", resolvable: true, resolved: false, system: false };

test("Babysit asks the owner before touching an escalated discussion and honors hold", async () => {
  const { calls } = runtime({ "forge.comment.read": () => ({ items: [finding] }) }, {
    threads: { threads: [{ discussion: finding.discussion, verdict: "escalate", why: "Data decision" }] },
    "escalated-findings": "hold",
  });
  const { default: script } = await import("../src/workflows/babysit.ts");
  await expect(run(script, { ...input, pr: 17, mode: "drive" })).resolves.toMatchObject({ status: "blocked", ci: "unread", why: expect.stringContaining("owner") });
  expect(calls.map(one => one.name)).not.toContain("forge.comment.reply");
  expect(calls.map(one => one.name)).not.toContain("forge.pipeline.read");
});

test("Babysit can continue with proven noise while leaving the escalated finding open", async () => {
  const noise = { ...finding, comment: 2, discussion: "d-2", body: "Unused wrapper" };
  let resolved = false;
  const { calls } = runtime({
    "forge.comment.read": () => ({ items: resolved ? [finding] : [finding, noise] }),
    "forge.comment.reply": () => ({ comment: 3 }),
    "forge.comment.resolve": () => { resolved = true; return {}; },
    "forge.pipeline.read": () => ({ items: [{ pipeline: 3, pr: 17, sourceSha: head, state: "success" }] }),
  }, {
    threads: { threads: [
      { discussion: finding.discussion, verdict: "escalate", why: "Data decision" },
      { discussion: noise.discussion, verdict: "noise", why: "The upper stack calls the wrapper" },
    ] },
    "escalated-findings": "continue",
  });
  const { default: script } = await import("../src/workflows/babysit.ts");
  await check(script, { ...input, pr: 17, mode: "drive" }, { status: "blocked", ci: "green", why: "Open discussions: d-1" });
  expect(calls.filter(one => ["forge.comment.reply", "forge.comment.resolve"].includes(one.name)).map(one => one.input.discussion))
    .toEqual([noise.discussion, noise.discussion]);
});

test("Babysit revisits discussion intake after CI and ignores a green pipeline belonging to another PR", async () => {
  let intake = 0;
  let replied = false;
  let seenWait = false;
  const { calls } = runtime({
    "forge.comment.read": () => ({ items: ++intake === 1 || replied ? [] : [finding] }),
    "forge.comment.reply": () => ({}),
    "forge.comment.resolve": () => { replied = true; return {}; },
    "forge.pipeline.read": () => ({ items: [
      { pipeline: 99, pr: 24, sourceSha: head, state: "success" },
      { pipeline: 3, pr: 17, sourceSha: head, state: seenWait ? "success" : "running" },
    ] }),
  }, { threads: { threads: [{ discussion: finding.discussion, verdict: "noise", why: "Current guard covers it" }] } });
  install({ wait: async () => { seenWait = true; return { timedOut: true }; } });
  const { default: script } = await import("../src/workflows/babysit.ts");
  await expect(run(script, { ...input, pr: 17, mode: "drive" })).resolves.toMatchObject({ status: "merge-ready", head });
  expect(seenWait).toBe(true);
  expect(calls.filter(one => one.name === "forge.comment.reply").map(one => one.input)).toEqual([{ repo: project, number: 17, discussion: finding.discussion, body: "Current guard covers it" }]);
});

test("Pickup journals a head-bound handoff and dispatches only Babysit's read-only check", async () => {
  const { calls, emitted } = runtime({ "workflow.list": () => ({ items: [{ id: "workflow-babysit", builtin: { plugin: "pstack", name: "babysit" } }] }) }, {
    resume: { where: "Awaiting CI", next: "Read checks at the bound head" },
  });
  let launches = 0;
  install({ scope: async (_: string, fn: (scope: unknown) => Promise<unknown>) => fn({
    run: (key: string, child: { id: string; args: Input }) => {
      launches++;
      expect(key).toBe("babysit");
      expect(child).toMatchObject({ id: "workflow-babysit", args: { mode: "check", pr: 17, expected: { head, base: "main" } } });
      expect(emitted).toHaveLength(1);
      return { settled: async () => ({ ok: true, value: { status: "reported", head, ci: "pending" } }) };
    },
  }) });
  const { default: script } = await import("../src/workflows/session-pickup.ts");
  await expect(run(script, { ...input, check: { pr: 17, head, base: "main" } })).resolves.toMatchObject({ continuation: { status: "checked", detail: { ci: "pending" } } });
  await expect(run(script, { ...input, check: { pr: 17, head: next, base: "main" } })).resolves.toMatchObject({ continuation: { status: "refused" } });
  expect(launches).toBe(1);
  expect(calls.map(one => one.name)).not.toContain("forge.pr.merge");
});

test("Cleanup inventory keeps a pinned checkout even with a matching host merge record", async () => {
  const { calls } = runtime({
    "git.worktree.list": () => ({ items: [{ ...tree, state: "ok", remote: project, dirty: false, sessions: [] }] }),
    "pstack.pr.binding": () => ({ binding: { worktree: tree } }),
    "git.worktree.remove": () => ({ id: tree.id, removed: true }),
  });
  install({ read: { records: async () => ({ records: [{ id: "merge-1", seq: 4, actor: { kind: "host" } }] }) } });
  const { default: script } = await import("../src/workflows/worktree-cleanup.ts");
  const merges = [{ id: "merge-1", pr: 17, head }];
  await expect(run(script, { kind: "inventory", repo, prune: { merges, protectedPaths: [tree.path] } })).resolves.toMatchObject({ removed: [], kept: [{ id: tree.id, why: expect.stringContaining("pinned") }] });
  await expect(run(script, { kind: "inventory", repo, prune: { merges, protectedPaths: [] } })).resolves.toMatchObject({ removed: [tree.id], kept: [] });
  expect(calls.filter(one => one.name === "git.worktree.remove").map(one => one.input)).toEqual([{ id: tree.id, onlyIf: { repo: repo.local, branch: tree.branch, path: tree.path, head, project } }]);
});

test("Pause safely waits for the target run's boundary and emits an off-context checkpoint when reached", async () => {
  let ready = false;
  const { calls, emitted, box } = runtime({
    "workflow.pause": () => ({ state: ready ? "paused" : "running", manualPause: { state: ready ? "paused" : "requested" } }),
    "proc.run": ({ cmd }) => ({ exit: 0, tail: cmd.includes("rev-parse") ? head : "", truncated: false }),
  }, { checkpoint: { intent: "resume prior task", state: "clean", verified: ["checks"], next: "Read the prior result", files: ["README.md"], gotchas: [] } });
  const { default: script } = await import("../src/workflows/pause-safely.ts");
  const args = { ...input, worktree: tree.path, run: "run-old" };
  await expect(run(script, args)).resolves.toMatchObject({ status: "pending" });
  expect(calls.map(one => one.name)).toEqual(["workflow.pause"]);
  ready = true;
  await expect(run(script, args)).resolves.toMatchObject({ status: "paused", head, clean: true });
  expect(emitted).toEqual([{ name: "checkpoint", data: expect.objectContaining({ worktree: tree.path, run: "run-old", head }) }]);
  expect(box).toEqual([]);
});

test("Pause safely keeps the checkout untouched when the target run belongs to a different principal", async () => {
  const { calls, turns, emitted } = runtime({
    "workflow.pause": () => { throw Object.assign(new Error("only the owner or whoever made it may pause"), { name: "Denied" }); },
  });
  const { default: script } = await import("../src/workflows/pause-safely.ts");
  await check(script, { ...input, worktree: tree.path, run: "run-owner" }, { status: "pending", why: expect.stringContaining("starter") });
  expect(calls.map(one => one.name)).toEqual(["workflow.pause"]);
  expect(turns).toHaveLength(0);
  expect(emitted).toHaveLength(0);
});

test("Autonomous run refuses a successful predicate that leaves local changes", async () => {
  const { turns } = runtime({ "proc.run": ({ cmd }) => ({
    exit: 0, tail: cmd.includes("rev-parse") ? head : cmd.includes("status") ? "?? generated" : "",
  }) });
  const { default: script } = await import("../src/workflows/autonomous-run.ts");
  await check(script, { ...input, predicate: "touch generated" }, { status: "not-met", reason: expect.stringContaining("changed the checkout") });
  expect(turns).toHaveLength(0);
});

test("Babysit reclassifies a discussion that changed after the review before trying to resolve it", async () => {
  let intake = 0;
  const { calls } = runtime({
    "forge.comment.read": () => ({ items: [{ ...finding, body: ++intake === 1 ? finding.body : "New finding on the same discussion" }] }),
    "forge.pipeline.read": () => ({ items: [{ pipeline: 3, pr: 17, sourceSha: head, state: "success" }] }),
  }, {
    threads: { threads: [{ discussion: finding.discussion, verdict: "noise", why: "Only the original body was reviewed" }] },
  });
  const ask = globals.ask as ((opts: { label: string; schema: z.ZodType }, prompt: string) => unknown);
  install({ ask: Object.assign((opts: { label: string; schema: z.ZodType }, prompt: string) =>
    intake > 3 && opts.label === "threads" ? { threads: [{ discussion: finding.discussion, verdict: "escalate", why: "New decision" }] }
      : ask(opts, prompt), { choice: async () => "hold" }) });
  const { default: script } = await import("../src/workflows/babysit.ts");
  await check(script, { ...input, pr: 17, mode: "drive" }, { status: "blocked", threads: [{ verdict: "escalate" }] });
  expect(calls.some(one => one.name.startsWith("forge.comment.") && one.name !== "forge.comment.read")).toBe(false);
});

test("Pickup reads the named recent and earlier trail only from its registered project directory", async () => {
  const transcript = { cwd: tree.path, harness: "author", native: "known" };
  const session = { harness: transcript.harness, native: transcript.native };
  const { calls, turns } = runtime({
    "git.worktree.list": () => ({ items: [{ ...tree, state: "ok", remote: project }] }),
    "history.list": () => ({ sessions: [{ session, cwd: tree.path }], unreadable: [], more: false }),
    "history.read": (_, label) => label.endsWith("-tail")
      ? { coverage: "complete", records: ["recent stop"], page: { hasEarlier: true } }
      : { coverage: "complete", digest: "earlier decision" },
  }, { resume: { where: "Stopped", next: "Inspect original result" } });
  const { default: script } = await import("../src/workflows/session-pickup.ts");
  await check(script, { ...input, transcript }, { status: "picked-up" });
  expect(turns[0]).toContain("recent stop");
  expect(turns[0]).toContain("earlier decision");
  expect(calls.filter(one => one.name === "history.read").map(one => one.input.session)).toEqual([session, session]);
  const before = calls.length;
  await check(script, { ...input, transcript: { ...transcript, cwd: "/unrelated" }, check: { pr: 17, head, base: "main" } },
    { continuation: { status: "refused", detail: expect.stringContaining("outside") } });
  expect(calls.slice(before).some(one => one.name === "history.list" || one.name === "history.read" || one.name === "workflow.start")).toBe(false);
});

function settleOwnerScope() {
  install({
    sleep: async () => new Promise(() => {}),
    scope: async (_key: string, _options: unknown, body: (scope: unknown) => Promise<unknown>) => {
      const outcomes: Array<Promise<{ key: string; result: unknown }>> = [];
      return body({
        next: () => Promise.race(outcomes),
        start(key: string, work: () => Promise<unknown>) {
          const settled = work().then(value => ({ ok: true, value }), (error: Error) => ({ ok: false, error }));
          outcomes.push(settled.then(result => ({ key, result })));
          return { settled: () => settled };
        },
      });
    },
  });
}

test("Autopilot Full replans undispatched work without reusing a prior node's go or dispatching its replacement twice", async () => {
  const { calls } = runtime({
    "plan.get": (_, label) => label === "plan"
      ? { of: "rollout", rev: 1, items: [{ id: "a", text: "Original", state: "open" }, { id: "b", text: "Dependent", state: "open", note: "after a" }] }
      : { of: "rollout", rev: 2, items: [{ id: "a", text: "Still blocked", state: "open" }, { id: "b", text: "Independent now", state: "open" }] },
    "evidence.list": ({ subject }) => ({ items: [
      { id: "old", author: { kind: "owner" }, claim: { kind: "verdict", name: GO, outcome: "pass",
        sha: goDigest({ of: "rollout", rev: 1 }, subject.endsWith("/a") ? "a" : "b", `${repo.host}/${repo.path}`) } },
    ] }),
    "git.worktree.create": () => { throw Error("No writer admitted by fixture"); },
  });
  settleOwnerScope();
  const { default: script } = await import("../src/workflows/autopilot-full.ts");
  await check(script, { ...input, plan: "rollout" }, { status: "done", nodes: [
    { node: "a", go: true, verified: false, blocked: "No writer admitted by fixture" },
    { node: "b", go: false, verified: false, blocked: "No writer admitted by fixture" },
  ] });
  expect(calls.filter(one => one.name === "git.worktree.create")).toHaveLength(2);
  expect(calls.filter(one => one.name === "evidence.list").map(one => one.input.subject)).toContain("plan/rollout/rev-2/b");
  expect(calls.filter(one => one.name === "forge.pr.merge")).toEqual([]);
});

test("Autopilot Stack stops dispatching when the stack plan changes", async () => {
  const { calls } = runtime({
    "plan.get": (_, label) => ({ of: "rollout", rev: label === "plan" ? 1 : 2, items: [{ id: "a", text: "Changed", state: "open" }] }),
  });
  const { default: script } = await import("../src/workflows/autopilot-stack.ts");
  await check(script, { ...input, plan: "rollout" }, { status: "unverified", nodes: [{ node: "a", blocked: expect.stringContaining("changed") }] });
  expect(calls.some(one => one.name === "git.worktree.create")).toBe(false);
});

test("Autopilot replaces a timed-out verifier on the exact published head without reopening or rebuilding", async () => {
  const original = { kind: "session", harness: "author", id: "author-source" };
  let latestVerifier: { kind: string; harness: string; id: string };
  const timedOut = Promise.withResolvers<void>();
  let seq = 0;
  const { calls } = runtime({
    "proc.run": ({ cmd }) => ({ exit: 0, tail: cmd.includes("rev-parse") ? head : "", truncated: false }),
    "forge.pr.ensure": () => ({ pr: { number: 17 }, head }),
    "pstack.pr.bind": () => ({}),
    "pstack.pr.binding": () => ({ binding: { author: original, worktree: tree } }),
    "forge.pipeline.read": () => ({ items: [{ pipeline: 3, pr: 17, kind: "head", sourceSha: head, state: "success" }] }),
    "evidence.attest": () => ({}),
    "evidence.covers": () => ({ covered: true, by: ["fresh"] }),
    "evidence.list": () => ({ items: [{ id: "fresh", author: latestVerifier }] }),
  });
  install({
    sleep: async () => new Promise(() => {}),
    scope: async (_key: string, options: { onDeadline: string; onExit: string }, body: (scope: unknown) => Promise<unknown>) => {
      expect(options).toMatchObject({ onDeadline: "skip", onExit: "cancel" });
      void body({ start: (_key: string, run: () => Promise<unknown>) => { void run(); }, next: () => new Promise(() => {}) });
      await timedOut.promise;
      return undefined;
    },
    session: async ({ harness }: { harness: string }) => {
    const address = harness === "author" ? original : { kind: "session", harness, id: `verifier-${++seq}` };
    return { address, end: async () => undefined, ask: async () => {
      if (harness === "author") return { sha: head, summary: "Original changes" };
      if (seq === 1) {
        timedOut.resolve();
        return new Promise(() => {});
      }
      latestVerifier = address;
      return { outcome: "pass", evidence: "Observed the requested surface at the bound head" };
    } };
  } });
  const { supervisedDelivery } = await import("../src/workflows/lib/autopilot.ts");
  const { default: playbook } = await import("../src/workflows/texts/autopilot-full.json");
  const result = await supervisedDelivery("lost", { ...input, roles, playbook, title: "Change" });
  expect(result).toMatchObject({ delivered: { verified: true, pr: { head }, built: { author: original } } });
  expect(seq).toBe(3);
  expect(calls.filter(one => ["git.worktree.create", "forge.pr.ensure", "pstack.pr.bind"].includes(one.name)).map(one => one.name))
    .toEqual(["git.worktree.create", "forge.pr.ensure", "pstack.pr.bind"]);
});

test.each(["automatic", "manual", "moved", "unconditioned", "conflict", "queued", "review-accepted", "review-declined", "review-superseded", "review-go-withdrawn"] as const)("Shipping handles the %s landing frontier", async (branch) => {
  const cwd = mkdtempSync(join(process.env.PSTACK_TEST_TMP ?? import.meta.dir, "operations-"));
  const exec = (cmd: string[]) => {
    const result = Bun.spawnSync(cmd, { cwd });
    return { exit: result.exitCode, tail: (result.exitCode === 0 ? result.stdout : result.stderr).toString(), truncated: false };
  };
  const git = (...args: string[]) => {
    const ran = exec(["git", ...args]);
    if (ran.exit !== 0) throw new Error(ran.tail);
    return ran.tail.trim();
  };
  try {
    git("init", "-q", "-b", "main");
    git("config", "user.name", "Operations fixture");
    git("config", "user.email", "operations@example.test");
    const commit = (file: string) => {
      writeFileSync(join(cwd, file), file + "\n");
      git("add", file);
      git("commit", "-qm", file);
      return git("rev-parse", "HEAD");
    };
    const root = commit("base");
    git("checkout", "-qb", "low");
    const lower = commit("lower");
    git("checkout", "-qb", "high");
    const upper = commit("upper");
    git("checkout", "-q", "main");
    const author = { kind: "session", harness: "author", id: "test-author" };
    const merged = new Map<number, string>();
    const interaction = branch.startsWith("review-");
    let reviewed = false;
    const { calls } = runtime({
      "git.worktree.create": () => ({ ...tree, path: cwd }),
      "git.worktree.remove": () => ({ id: tree.id, removed: true }),
      "proc.run": ({ cmd }) => exec(cmd),
      "plan.get": () => ({ of: "rollout", rev: 1, items: [
        { id: "a", text: interaction ? "Lower\n- [ ] Operator review before merge: Use the changed reader." : "Lower", state: "open" },
        { id: "b", text: "Upper", state: "open" },
      ] }),
      "evidence.list": ({ subject }) => ({ items: [{
        id: "owner-go", author: { kind: "owner" }, claim: { kind: "verdict", name: GO, outcome: reviewed && branch === "review-go-withdrawn" ? "fail" : "pass",
          sha: goDigest({ of: "rollout", rev: 1 }, subject.slice(-1), `${repo.host}/${repo.path}`) },
      }] }),
      "evidence.attest": () => ({}),
      "evidence.covers": () => ({ covered: true }),
      "pstack.pr.binding": ({ number }) => ({ binding: { author, worktree: { branch: number === 17 ? "low" : "high", repo: repo.local } } }),
      "forge.pr.read": ({ number, landing }) => {
        const sha = number === 17 ? lower : merged.has(17) && branch === "moved" ? next : upper;
        const targetSha = git("rev-parse", "main");
        const base = number === 17 || merged.has(17) && branch !== "manual" && branch !== "conflict" ? "main" : "low";
        return { state: merged.has(number) ? "merged" : "open", head: sha, base, branch: number === 17 ? "low" : "high",
          autoMerge: branch === "queued",
          ...(merged.has(number) ? { mergeSha: merged.get(number) } : {}), ...(landing ? { landing: { targetSha, conditionalMerge: branch !== "unconditioned", pipelines: [
            { pr: number, pipeline: 2, kind: "head", state: "success", sourceSha: sha },
            { pr: number, pipeline: 3, kind: "merge-result", state: reviewed && branch === "review-superseded" ? "failed" : "success", sourceSha: sha, targetSha, mergeSha: sha },
          ] } } : {}) };
      },
      "forge.pr.merge": ({ number, expectHead }) => {
        git("merge", "-q", "--ff-only", expectHead);
        if (branch === "conflict" && number === 17) {
          writeFileSync(join(cwd, "upper"), "Changed by the merge result\n");
          git("add", "upper");
          git("commit", "-qm", "Create the committed merge result for this fixture");
        }
        const sha = git("rev-parse", "HEAD");
        merged.set(number, sha);
        return { outcome: "merged", sha, externalId: String(number) };
      },
    });
    const prompts: string[] = [];
    Object.assign(globals.ask as object, { confirm: async (prompt: string, { label }: { label: string }) => {
      expect(interaction).toBe(true);
      expect(label).toContain(`-interaction-1-${lower}-${root}`);
      expect(prompt).toContain("Use the changed reader.");
      expect(prompt).toContain(`at ${lower} into main at ${root}`);
      expect(calls.some((one) => one.name === "forge.pr.merge")).toBe(false);
      prompts.push(prompt);
      reviewed = true;
      return branch !== "review-declined";
    } });
    const { default: script } = await import("../src/workflows/shipping.ts");
    const args = { ...input, plan: "rollout", prs: [{ number: 17, nodes: ["a"] }, { number: 18, nodes: ["b"] }] };
    const result = await run(script, args);
    if (branch === "automatic" || branch === "review-accepted") {
      expect(result).toMatchObject({ status: "landed", prs: [{ outcome: "merged", sha: lower }, { outcome: "merged", sha: upper }] });
    } else if (branch === "manual") {
      expect(result).toMatchObject({ status: "stopped", handoff: { pr: 18, expectedHead: upper, expectedBase: "low", targetBase: "main",
        patchKept: true, localRef: `refs/pstack/restack/${tree.id}/18` } });
      const ref = `refs/pstack/restack/${tree.id}/18`;
      const { pinPreparedHead } = await import("../src/workflows/lib/operations-restack.ts");
      expect(await pinPreparedHead("same-pin", { ...tree, path: cwd }, 18, upper)).toBe(ref);
      await expect(pinPreparedHead("different-pin", { ...tree, path: cwd }, 18, lower)).rejects.toThrow("already points");
      expect(git("rev-parse", ref)).toBe(upper);
    } else if (branch === "moved") {
      expect(result).toMatchObject({ status: "stopped", handoff: { pr: 18, reason: expect.stringContaining("moved") } });
    } else if (branch === "conflict") {
      expect(result).toMatchObject({ status: "stopped", prs: [{ outcome: "merged", pr: 17, sha: merged.get(17) }],
        handoff: { pr: 18, worktree: cwd, expectedHead: upper, reason: expect.stringContaining("does not rebase") } });
      expect(git("rev-parse", "high")).toBe(upper);
      expect(git("status", "--porcelain")).toBe("");
    } else if (branch === "queued") {
      expect(result).toMatchObject({ status: "stopped", prs: [], handoff: { pr: 17, reason: expect.stringContaining("queued") } });
    } else if (interaction) {
      expect(result).toMatchObject({ status: "stopped", prs: [{ outcome: "refused", missing: [{
        name: branch === "review-go-withdrawn" ? "go:a" : "interaction-review",
      }] }] });
    } else {
      expect(result).toMatchObject({ status: "stopped", prs: [{ outcome: "refused", missing: [{ name: "land", why: expect.stringContaining("target commit") }] }] });
    }
    const expected = branch === "automatic" || branch === "review-accepted" ? [[lower, root], [upper, lower]]
      : branch === "unconditioned" || branch === "queued" || interaction ? [] : [[lower, root]];
    expect(calls.filter(one => one.name === "forge.pr.merge").map(one => [one.input.expectHead, one.input.expectTarget])).toEqual(expected);
    expect(prompts).toHaveLength(interaction ? 1 : 0);
    expect(calls.some(one => one.name === "forge.pr.retarget" || one.input.cmd?.includes("push"))).toBe(false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
