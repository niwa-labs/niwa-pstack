import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@niwa-labs/testing";
import { commitFile, gitIn } from "./support.ts";
import ts from "typescript";
import { z } from "zod";
import { declarationField, literalOf } from "@niwa-labs/script";

const globals = globalThis as Record<string, unknown>;
const names = ["z", "workflow", "phase", "call", "ask", "session", "parallel", "now", "record", "emit", "read", "race", "scope", "stream", "wait", "sleep", "random", "log"];
const sha = "a".repeat(40);
const roles = {
  lead: { harness: "lead" }, author: { harness: "author", box: true as const },
  reviewer: { harness: "reviewer" }, verifier: { harness: "verifier" }, judge: { harness: "judge" },
};
const fixture = { task: "Update the reader", repo: { host: "gitlab.example.com", path: "team/lib", local: "/repo" }, worktrees: "/trees", base: "main" };
const checkpoint = { blocking: "Run the parser gates", independent: "n/a: one reader", shared: "Separate registry and parser", decomposition: "One owner in parser/" };
const design = { shape: "A tagged reader", rationale: "One ownership boundary", scope: ["parser/reader.ts"], checks: ["Read a corrupt envelope"] };

afterEach(() => {
  for (const name of names) delete globals[name];
});

interface Turn {
  label: string;
  harness: string;
  prompt: string;
  visible?: string[];
  cwd?: string;
  box?: unknown;
}

function runtime(answers: Record<string, unknown>, actions: Record<string, unknown> = {}) {
  const turns: Turn[] = [];
  const calls: string[] = [];
  const answer = (options: Omit<Turn, "prompt"> & { schema: z.ZodType }, prompt: string) => {
    turns.push({ label: options.label, harness: options.harness, prompt, visible: options.visible, cwd: options.cwd, box: options.box });
    const value = answers[options.label] ?? (options.label === "architect" ? design
      : options.label === "approve-design" ? { kind: "proceed", design, resolution: "Use the single viable shape" } : undefined);
    return options.schema.parse(typeof value === "function" ? value(options, prompt) : value);
  };
  Object.assign(globals, {
    z,
    workflow: (definition: unknown, run: unknown) => ({ definition, run }),
    phase: () => undefined,
    record: (name: string, schema: z.ZodType) => ({ name, schema }),
    call: async (name: string, input: unknown) => {
      calls.push(name);
      if (Object.hasOwn(actions, name)) {
        const value = actions[name];
        return typeof value === "function" ? value(input) : value;
      }
      switch (name) {
        case "pstack.roles": return roles;
        case "git.worktree.create": return { id: "checkout", repo: "/repo", branch: "topic", path: "/trees/checkout" };
        case "pstack.author.options": return { harness: "author", cwd: "/trees/checkout", box: { allow: ["project"] } };
        case "proc.run": return { exit: 0, tail: sha, truncated: false };
        case "forge.pr.ensure": return { pr: { number: 7 }, head: sha };
        case "forge.pr.read": return { head: sha, base: "main", state: "open", autoMerge: false };
        case "pstack.pr.bind": return {};
        case "evidence.covers": return { covered: true, by: ["current-verdict"] };
        case "evidence.list": return { items: [{ id: "current-verdict", author: { kind: "session", harness: "verifier", id: "verifier-instance" } }] };
        case "forge.checks.read": return { head: sha, state: "green", pipeline: 1 };
        case "forge.pipeline.read": return { items: [{ pipeline: 1, kind: "head", pr: 7, sourceSha: sha, state: "success" }] };
        case "evidence.attest": return {};
        default: throw new Error("Unexpected action " + name);
      }
    },
    session: async (opts: { harness: string; visible?: string[] }) => ({
      address: { kind: "session", id: opts.harness + "-instance", harness: opts.harness },
      ask: (prompt: string, extra: { label: string; schema: z.ZodType }) => answer({ ...opts, ...extra }, prompt),
      end: async () => undefined,
    }),
    ask: answer,
    parallel: async (jobs: Record<string, () => unknown> | Array<() => unknown>) => Array.isArray(jobs)
      ? await Promise.all(jobs.map((run) => run()))
      : Object.fromEntries(await Promise.all(Object.entries(jobs).map(async ([key, run]) => [key, await run()]))),
    now: async () => 0,
    read: {},
    race: () => { throw new Error("Unexpected race"); },
    scope: (_name: string, _opts: unknown, run: () => unknown) => run(),
    stream: () => { throw new Error("Unexpected stream"); },
    wait: () => { throw new Error("Unexpected wait"); },
    sleep: () => { throw new Error("Unexpected sleep"); },
    random: () => 0,
  });
  return { turns, calls };
}

// The workflow factory is a VM global in a real script. This shim invokes the body the module registers.
function invoke(registered: unknown, input: unknown) {
  const script = z.object({ run: z.custom<(input: unknown) => Promise<unknown>>((value) => typeof value === "function") }).parse(registered);
  return script.run(input);
}

async function featureGit() {
  const root = await tempDir("feature-freedom");
  const repo = join(root, "repo");
  const worktrees = join(root, "worktrees");
  mkdirSync(repo);
  mkdirSync(worktrees);
  gitIn(repo, "init", "-q", "-b", "main");
  const base = commitFile(repo, "a.txt", "baseline\n");
  let next = 0;
  let published: { sha: string; branch: string } | undefined;
  const gitActions = {
    "git.worktree.create": ({ base: ref }: { base: string }) => {
      const branch = "fixture-" + ++next;
      const path = join(worktrees, branch);
      const baseSha = gitIn(repo, "rev-parse", ref);
      gitIn(repo, "worktree", "add", "-q", "-b", branch, path, baseSha);
      return { id: branch, repo, branch, path, base: ref, baseSha };
    },
    "git.worktree.get": ({ id }: { id: string }) => {
      const path = join(worktrees, id);
      return { head: gitIn(path, "rev-parse", "HEAD"), dirty: gitIn(path, "status", "--porcelain") !== "" };
    },
    "pstack.author.options": ({ place }: { place: string }) => ({ harness: "author", cwd: place, box: { allow: ["project", { net: fixture.repo.host }] } }),
    "proc.run": ({ cmd, cwd }: { cmd: string[]; cwd: string }) => {
      const ran = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
      return { exit: ran.exitCode, tail: ran.stdout.toString(), truncated: false };
    },
    "forge.pr.ensure": ({ branch, base }: { branch: string; base: string }) => {
      expect(base).toBe("main");
      expect(branch).toBe(published?.branch ?? "");
      return { pr: { number: 7 }, head: published?.sha };
    },
    "forge.pr.read": () => ({ head: published?.sha }),
    "forge.pipeline.read": () => ({ items: [{ kind: "head", pr: 7, sourceSha: published?.sha, pipeline: 1, state: "success" }] }),
  };
  const publishedHead = (cwd: string) => {
    const sha = gitIn(cwd, "rev-parse", "HEAD");
    published = { sha, branch: gitIn(cwd, "branch", "--show-current") };
    return { sha };
  };
  const publish = ({ cwd }: { cwd: string }, prompt: string) => {
    const receipt = publishedHead(cwd);
    expect(prompt).toContain(receipt.sha);
    return receipt;
  };
  return { repo, base, gitActions, publish, publishedHead, input: { ...fixture, repo: { ...fixture.repo, local: repo }, worktrees } };
}

function commitArtifact(file: string, contents: string) {
  return ({ cwd }: { cwd: string }) => ({ sha: commitFile(cwd, file, contents + "\n"), observed: contents });
}
const alternativeAnswers = {
  frame: {
    kind: "alternatives", trace: "Input reaches the parser", question: "Who owns malformed input?",
    rubric: ["Is the malformed-envelope contract preserved?", "Does the caller remain simple?", "Is the test reproducible?"],
    checkpoint, contested: true,
  },
  "implementation-a-artifact": commitArtifact("a.txt", "tagged reader implementation"),
  "implementation-b-artifact": commitArtifact("a.txt", "reader registry implementation"),
};
const rubricScores = ["Contract", "Caller", "Test"].map((evidence) => ({ score: 4, evidence }));
const prBrief = { title: "fix(reader): update the reader", sections: [{ heading: "What changed", body: "Updated the reader." }] };

test("Feature compares distinct Git artifacts, integrates the winner, and verifies the published head", async () => {
  const git = await featureGit();
  const revised = { ...design, shape: "Tagged reader with stable error output" };
  let winner: string | undefined;
  const { turns, calls } = runtime({
    ...alternativeAnswers,
    judge: (_options: unknown, prompt: string) => {
      expect(prompt).toContain("+tagged reader implementation");
      expect(prompt).toContain("+reader registry implementation");
      return { pick: "second", why: "Fewer caller obligations", scores: { first: rubricScores, second: rubricScores } };
    },
    "adversary-1": ({ cwd }: { cwd: string }, prompt: string) => {
      expect(prompt).toContain("provided exact commits");
      if (existsSync(join(cwd, "b.txt"))) return { findings: [] };
      return { findings: [{
        candidate: "first", title: "Integration proof missing", cause: "Reader output contract has no integration note",
        cmd: ["sh", "-c", "if [ -f b.txt ]; then cat b.txt; else printf missing; exit 1; fi"],
        expected: { exit: 0, output: "integrated change" }, observed: { exit: 1, output: "missing" },
      }] };
    },
    "adversary-2": { findings: [] },
    "adversary-3": { findings: [] },
    "adversary-4": { findings: [] },
    resolve: { kind: "proceed", resolution: "Keep output stable", design: revised, pick: "first", scores: { first: rubricScores, second: rubricScores } },
    "integrate-artifact": ({ cwd }: { cwd: string }, prompt: string) => {
      winner = gitIn(cwd, "rev-parse", "HEAD");
      expect(prompt).toContain(revised.shape);
      expect(readFileSync(join(cwd, "a.txt"), "utf8")).toBe("tagged reader implementation\n");
      return commitArtifact("b.txt", "integrated change")({ cwd });
    },
    "change-write": prBrief,
    "publish-artifact": git.publish,
    "change-verify-gates": { outcome: "pass", evidence: "Tests passed" },
    "change-verify-live": { outcome: "fail", evidence: "Wrong surface" },
  }, git.gitActions);
  const feature = (await import("../src/workflows/feature.ts")).default;
  const result = await invoke(feature, git.input) as { head: string; framed: { artifacts: { sha: string; path: string }[] } };
  expect(result).toMatchObject({ status: "unverified", framed: { design: revised, challenge: "Keep output stable" }, verdicts: [{ covered: true }, { covered: false, why: "Wrong surface" }] });
  const [first, second] = result.framed.artifacts;
  expect(first!.sha).toBe(winner!);
  const lost = second!.sha;
  expect(first!.path).not.toBe(second!.path);
  expect(gitIn(git.repo, "merge-base", winner!, lost)).toBe(git.base);
  expect(gitIn(git.repo, "merge-base", winner!, result.head)).toBe(winner!);
  expect(gitIn(git.repo, "merge-base", lost, result.head)).toBe(git.base);
  expect(turns.map(({ label, harness }) => [label, harness])).toEqual([
    ["frame", "lead"], ["architect", "reviewer"],
    ["implementation-a-artifact", "author"], ["implementation-b-artifact", "verifier"], ["judge", "judge"],
    ["adversary-1", "reviewer"], ["adversary-2", "verifier"], ["adversary-3", "judge"], ["adversary-4", "author"],
    ["resolve", "lead"], ["integrate-artifact", "author"],
    ["adversary-1", "reviewer"], ["adversary-2", "verifier"], ["adversary-3", "judge"], ["adversary-4", "author"],
    ["change-write", "lead"], ["publish-artifact", "author"],
    ["change-verify-gates", "verifier"], ["change-verify-live", "verifier"],
  ]);
  expect(turns[2]?.box).toEqual({ only: ["project", "toolchains"] });
  expect(turns[2]?.visible).toEqual([]);
  expect(turns[2]?.prompt).not.toContain("Is the test reproducible?");
  expect(turns[3]?.prompt).not.toContain("tagged reader implementation");
  expect(turns.find(({ label }) => label === "resolve")?.prompt).toContain('"responded":[1,2,3,4]');
  expect(turns.find(({ label }) => label === "resolve")?.prompt).toContain("Reader output contract has no integration note");
  expect(turns.find(({ label }) => label === "change-write")?.prompt).toContain("+integrated change");
  expect(turns.find(({ label }) => label === "change-verify-live")?.prompt).toContain("Read a corrupt envelope");
  expect(calls.filter((call) => call === "evidence.covers")).toHaveLength(1);
}, 20_000);

test("Feature leaves both local artifacts available when the lead blocks publication", async () => {
  const git = await featureGit();
  const { calls, turns } = runtime({
    ...alternativeAnswers,
    judge: { pick: "first", why: "Simpler", scores: { first: rubricScores, second: rubricScores } },
    resolve: { kind: "blocked", why: "Need a decision" },
  }, git.gitActions);
  const feature = (await import("../src/workflows/feature.ts")).default;
  await expect(invoke(feature, git.input)).rejects.toThrow("Need a decision");
  expect(turns.filter(({ label }) => label.endsWith("-artifact"))).toHaveLength(2);
  expect(calls).not.toContain("forge.pr.ensure");
}, 20_000);

test("Feature records an arena dropout and integrates the only completed artifact", async () => {
  const git = await featureGit();
  const { turns } = runtime({
    ...alternativeAnswers,
    frame: { ...alternativeAnswers.frame, contested: false },
    "implementation-b-artifact": () => { throw new Error("Runner could not produce code"); },
    judge: (_options: unknown, prompt: string) => {
      expect(prompt).toContain("Runner could not produce code");
      return { pick: "first", why: "Only complete artifact", scores: { first: rubricScores } };
    },
    resolve: { kind: "proceed", resolution: "Keep the surviving implementation", design, scores: { first: rubricScores } },
    "integrate-artifact": ({ cwd }: { cwd: string }) => ({
      sha: gitIn(cwd, "rev-parse", "HEAD"),
      observed: readFileSync(join(cwd, "a.txt"), "utf8"),
    }),
    "change-write": prBrief,
    "publish-artifact": git.publish,
    "change-verify-gates": { outcome: "pass", evidence: "Tests passed" },
    "change-verify-live": { outcome: "pass", evidence: "Surface passed" },
  }, git.gitActions);
  const feature = (await import("../src/workflows/feature.ts")).default;
  const result = await invoke(feature, git.input) as { head: string; framed: { artifacts: { sha: string }[] } };
  expect(result).toMatchObject({ status: "verified", framed: { dropouts: [{ candidate: "second", why: "Runner could not produce code" }] } });
  expect(result.framed.artifacts.map(({ sha }) => sha)).toEqual([result.head]);
  expect(turns.some(({ label }) => label.startsWith("adversary-"))).toBe(false);
}, 20_000);

test("Feature validates a partition before serially integrating independent slice commits", async () => {
  const git = await featureGit();
  const frame = { kind: "direct", trace: "Independent reporters", design, checkpoint, whyOnlyOne: "Existing extension points", contested: false };
  const partition = {
    gates: [["git", "diff", "--quiet", "HEAD"]],
    lanes: [{ assignment: "Implement A", files: ["a.txt"] }, { assignment: "Implement B", files: ["b.txt"] }],
  };
  const answers = {
    frame: { ...frame, partition },
    "slice-1-artifact": commitArtifact("a.txt", "new A"),
    "slice-2-artifact": commitArtifact("b.txt", "new B"),
    "integrate-artifact": ({ cwd }: { cwd: string }) => {
      expect(gitIn(cwd, "rev-parse", "HEAD")).toBe(git.base);
      gitIn(cwd, "merge", "--no-ff", "--no-edit", "fixture-2");
      gitIn(cwd, "merge", "--no-ff", "--no-edit", "fixture-3");
      return { sha: gitIn(cwd, "rev-parse", "HEAD"), observed: "Both slices integrated" };
    },
    "change-write": prBrief,
    "publish-artifact": git.publish,
    "change-verify-gates": { outcome: "fail", evidence: "Gate missing" },
    "change-verify-live": { outcome: "fail", evidence: "Surface missing" },
  };
  const feature = (await import("../src/workflows/feature.ts")).default;
  const { turns } = runtime(answers, git.gitActions);
  await expect(invoke(feature, git.input)).resolves.toMatchObject({ status: "unverified" });
  expect(turns[2]?.prompt).toContain("delegated architect");
  expect(turns.find(({ label }) => label === "slice-1-artifact")?.prompt).toContain('["a.txt"]');
  const integrated = turns.find(({ label }) => label === "integrate-artifact")?.cwd ?? "";
  expect(readFileSync(join(integrated, "a.txt"), "utf8")).toBe("new A\n");
  expect(readFileSync(join(integrated, "b.txt"), "utf8")).toBe("new B\n");

  const refused = runtime({ ...answers, "slice-1-artifact": commitArtifact("unassigned.txt", "wrong scope") }, git.gitActions);
  await expect(invoke(feature, git.input)).rejects.toThrow("outside its assigned scope");
  expect(refused.turns.some(({ label }) => label === "publish-artifact")).toBe(false);

  const ungated = runtime({
    ...answers, frame: { ...frame, partition: { ...partition, gates: [["git", "rev-parse", "--verify", "missing-revision"]] } },
  }, git.gitActions);
  await expect(invoke(feature, git.input)).rejects.toThrow("Partition gate 1 failed");
  expect(ungated.turns.map(({ label }) => label)).toEqual(["frame", "architect", "approve-design"]);
}, 20_000);

test("Feature replans after architect review without starting abandoned delivery", async () => {
  const { calls, turns } = runtime({
    frame: { kind: "direct", trace: "One reader", design, checkpoint, whyOnlyOne: "Existing contract", contested: false },
    "approve-design": (_options: unknown, prompt: string) => prompt.includes("Reassess source")
      ? { kind: "blocked", why: "Missing source" }
      : { kind: "replan", why: "Reassess source" },
  });
  const feature = (await import("../src/workflows/feature.ts")).default;
  await expect(invoke(feature, fixture)).rejects.toThrow("Missing source");
  expect(turns.filter(({ label }) => label === "architect")).toHaveLength(2);
  expect(calls).toEqual(["pstack.roles", "pstack.roles"]);
});

test("Refactoring delegates boundary design and honors the lead's handoff before edits", async () => {
  const { calls, turns } = runtime({
    frame: { kind: "reshape", crossesBoundary: true, contract: "Stable output", pin: "Replay fixture", target: "Move reader" },
    architect: { target: "The caller contract changes" },
    "approve-shape": { kind: "handoff", route: "feature", why: "New behavior" },
  });
  const refactoring = (await import("../src/workflows/refactoring.ts")).default;
  await expect(invoke(refactoring, fixture)).resolves.toEqual({
    status: "handoff", route: "feature", why: "New behavior",
    next: { playbook: "feature", args: { ...fixture, task: fixture.task + "\n\nRefactoring discovered: New behavior" } },
  });
  expect(turns.map(({ label, harness }) => [label, harness])).toEqual([["frame", "lead"], ["architect", "reviewer"], ["approve-shape", "lead"]]);
  expect(turns[2]?.prompt).toContain("The caller contract changes");
  expect(calls).toEqual(["pstack.roles"]);

  const redirected = runtime({ frame: { kind: "handoff", route: "figure-it-out", why: "Several linked subsystems" } });
  await expect(invoke(refactoring, fixture)).resolves.toMatchObject({ status: "handoff", route: "figure-it-out" });
  expect(redirected.calls).toEqual(["pstack.roles"]);
});

test("a focused Refactoring delivers a commit with the lead-approved boundary shape and retained pin", async () => {
  const git = await featureGit();
  const { turns } = runtime({
    frame: { kind: "reshape", crossesBoundary: true, contract: "Stable output", pin: "Read a.txt", target: "Move reader" },
    architect: { target: "Move only the implementation" },
    "approve-shape": { kind: "reshape", target: "Move reader behind stable interface" },
    characterize: {
      predicate: "The observed reader output is unchanged", probe: ["cat", "a.txt"],
      phases: [{ hypothesis: "One fewer delegation", change: "Move the implementation" }],
    },
    "reshape-artifact": ({ cwd }: { cwd: string }, prompt: string) => {
      expect(prompt).toContain("Move reader behind stable interface");
      expect(prompt).toContain('["cat","a.txt"]');
      return { sha: commitFile(cwd, "implementation.txt", "isolated reader\n"), observed: "Moved reader" };
    },
    "reader-load": { keep: true, why: "One fewer delegation" },
    "publish-artifact": git.publish,
    "change-write": {
      title: "refactor(reader): move implementation",
      sections: [
        { heading: "Why", body: "Make the reader simpler." },
        { heading: "What changed", body: "Moved the implementation." },
        { heading: "Verification", body: "Replayed the characterization command on both commits." },
      ],
    },
    "change-verify-gates": { outcome: "pass", evidence: "Tests passed" },
    "change-verify-live": { outcome: "pass", evidence: "The output matches" },
  }, git.gitActions);
  const refactoring = (await import("../src/workflows/refactoring.ts")).default;
  await expect(invoke(refactoring, git.input)).resolves.toMatchObject({ status: "verified", framed: { target: "Move reader behind stable interface" } });
  expect(turns.at(-1)?.prompt).toContain("Independently prove equivalence on the real artifact. Pin: Read a.txt");
}, 20_000);

test("an ambiguous forensic result stays open even when the model asserts a cause", async () => {
  const { turns } = runtime({
    investigate: { cause: "unrelated", hypotheses: [
      { claim: "One mechanism", status: "confirmed", evidence: "trace row 1" },
      { claim: "Another mechanism", status: "confirmed", evidence: "trace row 2" },
    ] },
  });
  const trace = (await import("../src/workflows/trace-forensics.ts")).default;
  await expect(invoke(trace, { ...fixture, trace: "capture.json" })).resolves.toMatchObject({ status: "open", cause: null });
  expect(turns[0]?.prompt).toContain("The trace: capture.json");
});

test("Benny's blocked and existing-fix decisions never start an owner lane", async () => {
  runtime({});
  const repro = (await import("../src/workflows/benny-reproduce.ts")).default;
  for (const [decision, status] of [
    [{ kind: "blocked", why: "Missing test harness" }, "blocked"],
    [{ kind: "existing-fix", evidence: "Patched build passes; baseline fails" }, "existing-fix"],
  ]) {
    const { calls, turns } = runtime({ reproduce: decision }, { "benny.channel.notify": {} });
    await expect(invoke(repro, { data: { ...fixture, report: "A regression", owner: "parser", source: "thread", summary: "Reader fails" } })).resolves.toMatchObject({ status });
    expect(calls).toEqual(["pstack.roles", "benny.channel.notify"]);
    expect(turns[0]?.visible).toContain("benny.control.cleanup");
    expect(turns[0]?.visible).not.toContain("benny.channel.notify");
  }
});

test("routing rejects missing variant data and cannot send unrelated fields to a child", async () => {
  runtime({ route: { kind: "run", playbook: "shipping", task: "Ship", more: { plan: "rollout" } } });
  const entry = (await import("../src/workflows/entry.ts")).default;
  await expect(invoke(entry, { ...fixture, request: "Ship the rollout" })).rejects.toThrow("Invalid fields for shipping");

  const variants = { current: "reviewer", pinned: { harness: "author", model: "reader", effort: "low", ref: "topic" } };
  runtime({ route: { kind: "run", playbook: "eval", task: "Compare reader guides", more: { variants } } }, {
    "workflow.list": { items: [{ id: "workflow-eval", builtin: { plugin: "pstack", name: "eval" } }] },
    "workflow.start": (input: unknown) => {
      expect(input).toEqual({ id: "workflow-eval", args: { ...fixture, task: "Compare reader guides", variants } });
      return { run: "run-eval" };
    },
  });
  globals.read = { records: () => ({ records: [{ data: { outcome: { status: "done", result: { status: "judged" } } } }] }) };
  await expect(invoke(entry, { ...fixture, request: "Compare the guides" })).resolves.toMatchObject({ status: "ran", playbook: "eval" });
});

test("planning rejects a forward dependency before persisting or asking for go", async () => {
  const { calls } = runtime({ plan: { kind: "plan", goal: "Read safely", nodes: [
    { id: "reader", text: "Add a reader", after: ["parser"] }, { id: "parser", text: "Add a parser" },
  ] } });
  const plan = (await import("../src/workflows/multi-phase-plan.ts")).default;
  await expect(invoke(plan, { ...fixture, plan: "reader", ask: true })).rejects.toThrow("which the plan does not hold before it");
  expect(calls).toEqual(["pstack.roles"]);
});

test("an already satisfied autonomous predicate never starts an author", async () => {
  const git = await featureGit();
  const { calls, turns } = runtime({}, git.gitActions);
  const autonomous = (await import("../src/workflows/autonomous-run.ts")).default;
  await expect(invoke(autonomous, { ...git.input, predicate: "true", max: 1 })).resolves.toMatchObject({ status: "met", rows: [] });
  expect(calls).not.toContain("pstack.author.options");
  expect(turns).toEqual([]);
});

test("Babysit check reports from a single PR-scoped check read and leaves review untouched", async () => {
  const { calls, turns } = runtime({
    threads: { threads: [{ discussion: "discussion", verdict: "noise", why: "The guard is already present" }] },
  }, {
    "forge.pr.read": { state: "open", branch: "topic", base: "main", head: sha },
    "forge.comment.read": { items: [{ discussion: "discussion", author: "Bot", body: "Check the guard", resolvable: true, resolved: false, system: false }] },
    "forge.checks.read": { head: sha, state: "pending" },
    "proc.run": { exit: 0, tail: "", truncated: false },
  });
  const babysit = (await import("../src/workflows/babysit.ts")).default;
  await expect(invoke(babysit, { ...fixture, pr: 7, mode: "check", rounds: 3 })).resolves.toMatchObject({ status: "reported", ci: "pending" });
  expect(turns[0]?.prompt).toContain("The Bugbot triage reference");
  expect(turns[0]?.prompt).toContain("Check the guard");
  expect(calls.filter((call) => call === "forge.checks.read")).toHaveLength(1);
  expect(calls).not.toContain("forge.comment.reply");
  expect(calls).not.toContain("forge.pipeline.read");
});

test("Babysit retries a proven flake once on the matching PR pipeline", async () => {
  let retries = 0;
  const { calls, turns } = runtime({ "fix-1": { kind: "flake", why: "Identical head passed locally" } }, {
    "forge.pr.read": { state: "open", branch: "topic", base: "main", head: sha },
    "forge.comment.read": { items: [] },
    "proc.run": { exit: 0, tail: "", truncated: false },
    "forge.pipeline.read": () => ({ items: [{ pipeline: 1, ref: "topic", sourceSha: sha, pr: 7, state: retries === 0 ? "failed" : "success" }] }),
    "forge.pipeline.retry": () => { retries++; return { pipeline: 1, state: "pending" }; },
  });
  const babysit = (await import("../src/workflows/babysit.ts")).default;
  await expect(invoke(babysit, { ...fixture, pr: 7, mode: "drive", rounds: 2 })).resolves.toMatchObject({ status: "merge-ready", ci: "green" });
  expect(retries).toBe(1);
  expect(calls.filter((call) => call === "forge.pipeline.retry")).toHaveLength(1);
  expect(turns[0]?.prompt).toContain("leave the branch unchanged");
});

test("Bug fix and Visual parity stop before edits when their prerequisite evidence is missing", async () => {
  const { calls } = runtime({ frame: { kind: "blocked", why: "No usable evidence" } });
  const bug = (await import("../src/workflows/bug-fix.ts")).default;
  const visual = (await import("../src/workflows/visual-parity.ts")).default;
  for (const playbook of [bug, visual]) {
    await expect(invoke(playbook, fixture)).resolves.toMatchObject({ status: "blocked", why: "No usable evidence" });
  }
  expect(calls).toEqual(["pstack.roles", "pstack.roles"]);
});

test("a boundary-crossing Bug fix gets lead-approved architecture before changing the real checkout", async () => {
  const git = await featureGit();
  const answers = {
    frame: {
      kind: "confirmed", crossesBoundary: true, repro: "Read a.txt", cause: "Wrong reader", evidence: "a.txt contains baseline",
      history: "The wrong default was introduced with a.txt", surface: "reader output", driver: "sh",
      replay: { command: "if grep -qx baseline a.txt; then echo wrong-reader; exit 1; fi", failingSignal: "wrong-reader" },
      regression: { kind: "skip", reason: "The repo has no test harness" },
    },
    architect: { shape: "Move the contract across the parser boundary" },
    fix: ({ cwd }: { cwd: string }, prompt: string) => {
      expect(prompt).toContain("Patch the caller");
      commitFile(cwd, "a.txt", "fixed reader\n");
      return { summary: "Reader corrected" };
    },
    "bug-publish": ({ cwd }: { cwd: string }) => {
      git.publishedHead(cwd);
      return { published: true };
    },
    "change-verify-gates": { outcome: "pass", evidence: "Tests passed" },
    "change-verify-live": { outcome: "pass", evidence: "Reader ran" },
  };
  const bug = (await import("../src/workflows/bug-fix.ts")).default;
  const stopped = runtime({ ...answers, "approve-shape": { kind: "blocked", why: "Evidence missing" } }, git.gitActions);
  await expect(invoke(bug, git.input)).resolves.toMatchObject({ status: "blocked", why: "Evidence missing" });
  expect(stopped.calls).not.toContain("forge.pr.ensure");
  expect(stopped.turns.map(({ label }) => label)).toEqual(["frame", "architect", "approve-shape"]);
  const built = runtime({ ...answers, "approve-shape": { kind: "proceed", shape: "Patch the caller" } }, git.gitActions);
  await expect(invoke(bug, git.input)).resolves.toMatchObject({ status: "verified" });
  expect(built.turns.slice(0, 4).map(({ label, harness }) => [label, harness])).toEqual([
    ["frame", "lead"], ["architect", "reviewer"], ["approve-shape", "lead"], ["fix", "author"],
  ]);
}, 20_000);

test("Perf measures real checkouts, routes boundary design and refuses an out-of-target result", async () => {
  const git = await featureGit();
  commitFile(git.repo, "bench.txt", "10\n");
  let measurements = 0;
  const { turns } = runtime({
    frame: { measure: "cat bench.txt", direction: "lower", target: 5, crossesBoundary: true },
    architect: { shape: "Keep workload and shrink parser boundary" },
    "approve-shape": { kind: "proceed", shape: "Shrink the parser boundary" },
    "change-build-build": ({ cwd }: { cwd: string }, prompt: string) => {
      expect(measurements).toBe(1);
      expect(prompt).toContain("Approved architecture: Shrink the parser boundary");
      commitFile(cwd, "bench.txt", "7\n");
      return { ...git.publishedHead(cwd), summary: "Speed up the reader" };
    },
    "change-verify-gates": { outcome: "pass", evidence: "Tests passed" },
    "change-verify-live": { outcome: "pass", evidence: "Reader ran" },
  }, {
    ...git.gitActions, "git.worktree.remove": {},
    "proc.run": (input: { cmd: string[]; cwd: string }) => {
      if (input.cmd[0] === "sh") measurements++;
      return git.gitActions["proc.run"](input);
    },
    "forge.pr.ensure": (input: { branch: string; base: string }) => {
      expect(measurements).toBe(2);
      expect(input).toMatchObject({ description: expect.stringContaining("After 7; delta -3") });
      return git.gitActions["forge.pr.ensure"](input);
    },
  });
  const perf = (await import("../src/workflows/perf-issue.ts")).default;
  await expect(invoke(perf, git.input)).resolves.toMatchObject({ status: "unverified", baseline: 10, after: 7, met: false });
  expect(turns[1]).toMatchObject({ label: "architect", harness: "reviewer", prompt: expect.stringContaining("Baseline 10") });
  expect(turns.at(-1)?.prompt).toContain("frozen measurement");
}, 20_000);

test("an independent delivery verdict still needs green CI for this PR and HEAD", async () => {
  const git = await featureGit();
  const { calls } = runtime({
    frame: { kind: "direct", trace: "One reader", design, checkpoint, whyOnlyOne: "Single supported extension point", contested: false },
    architect: design,
    "approve-design": { kind: "proceed", resolution: "One supported extension point", design },
    "integrate-artifact": commitArtifact("a.txt", "Updated the reader"),
    "change-write": prBrief,
    "publish-artifact": git.publish,
    "change-verify-gates": { outcome: "pass", evidence: "Tests passed" },
    "change-verify-live": { outcome: "pass", evidence: "Observed the reader" },
  }, { ...git.gitActions, "forge.pr.read": { head: "b".repeat(40) } });
  const feature = (await import("../src/workflows/feature.ts")).default;
  await expect(invoke(feature, git.input)).resolves.toMatchObject({ status: "unverified", ci: "timed-out" });
  expect(calls).not.toContain("evidence.attest");
});

test("lane CI selects the latest head pipeline for the exact PR and commit", async () => {
  const { headCi } = await import("../src/workflows/lib/lane.ts");
  const opts = { repo: fixture.repo, number: 7, subject: "project/pr/7", sha };
  const head = { kind: "head", pr: 7, sourceSha: sha, pipeline: 2, state: "success" };
  for (const state of ["success", "failed"] as const) {
    const { calls } = runtime({}, {
      "forge.pipeline.read": { items: [
        { ...head, pipeline: 6, kind: "merge-result", state: "failed" },
        { ...head, pipeline: 5, pr: 8 },
        { ...head, pipeline: 4, sourceSha: "b".repeat(40) },
        { ...head, pipeline: 3, state },
        head,
      ] },
    });
    expect(await headCi("fixture-ci", opts)).toEqual({ outcome: state === "success" ? "green" : "red", pipeline: 3 });
    expect(calls.includes("evidence.attest")).toBe(state === "success");
  }
});

test("prototype revision builds fresh isolated scratch artifacts and selects from the new round", async () => {
  const git = await featureGit();
  const variants = [{ name: "first", idea: "First variant idea" }, { name: "second", idea: "Second variant idea" }];
  const scratchVariant = (description: string) => ({ cwd }: { cwd: string }) => {
    commitFile(cwd, "scratch.txt", description + "\n");
    return { observed: description };
  };
  let round = 0;
  const { turns, calls } = runtime({
    scope: { kind: "decide", decision: "Where is the reader?", variants },
    "build-first": scratchVariant("The first variant starts immediately"),
    "build-second": scratchVariant("The second variant waits"),
    recommend: (_options: unknown, prompt: string) => {
      expect(prompt).toContain("The second variant waits");
      return ++round === 1
        ? { kind: "revise", variants, why: "Compare in another condition" }
        : { kind: "pick", recommend: "first", why: "Lower latency" };
    },
  }, git.gitActions);
  const prototype = (await import("../src/workflows/prototype.ts")).default;
  await expect(invoke(prototype, git.input)).resolves.toMatchObject({ status: "decided", recommend: "first" });
  expect(turns[1]?.prompt).toContain("First variant idea");
  expect(turns[1]?.prompt).not.toContain("Second variant idea");
  const scratch = turns.filter(({ label }) => label.startsWith("build-"));
  expect(new Set(scratch.map(({ cwd }) => cwd)).size).toBe(4);
  expect(scratch.map(({ cwd }) => readFileSync(join(cwd ?? "", "scratch.txt"), "utf8").trim())).toEqual([
    "The first variant starts immediately", "The second variant waits", "The first variant starts immediately", "The second variant waits",
  ]);
  expect(calls).not.toContain("forge.pr.ensure");
}, 20_000);

test("an open Prototype follows the owner's direction before creating any scratch worktree", async () => {
  const git = await featureGit();
  const answers = {
    scope: { kind: "explore", decision: "How should the demo show both modes?" },
    references: {
      references: [{ source: "a.txt", observation: "The current reader has one mode." }],
      directions: [
        { label: "Tabs", rationale: "Familiar switcher", variants: [{ name: "top", idea: "Top tabs" }, { name: "side", idea: "Side tabs" }] },
        { label: "Panels", rationale: "Easier to compare", variants: [{ name: "split", idea: "Split panels" }, { name: "stack", idea: "Stacked panels" }] },
      ],
    },
    "build-split": ({ cwd }: { cwd: string }) => { commitFile(cwd, "demo.txt", "split\n"); return { observed: "Split panels" }; },
    "build-stack": ({ cwd }: { cwd: string }) => { commitFile(cwd, "demo.txt", "stack\n"); return { observed: "Stacked panels" }; },
    recommend: { kind: "pick", recommend: "split", why: "Visible at once" },
  };
  const prototype = (await import("../src/workflows/prototype.ts")).default;
  for (const direction of ["stop", "direction-1"]) {
    const { calls } = runtime(answers, git.gitActions);
    Object.assign(globals.ask as object, {
      choice: async (prompt: string) => {
        expect(prompt).toContain("a.txt");
        expect(calls).not.toContain("git.worktree.create");
        return direction;
      },
    });
    const result = await invoke(prototype, git.input);
    if (direction === "stop") {
      expect(result).toMatchObject({ status: "no-decision" });
      expect(calls).not.toContain("git.worktree.create");
    } else {
      expect(result).toMatchObject({ status: "decided", recommend: "split", variants: [{ name: "split" }, { name: "stack" }] });
    }
  }
}, 20_000);

test("a pickup renders only this repository's attested data and its explicit handoff", async () => {
  const dirs: string[] = [];
  const read: string[] = [];
  const { turns } = runtime({
    resume: { where: "At the verification step", verified: ["invented verified result"], next: "Resume investigation" },
  }, {
    "git.worktree.list": { items: [
      { state: "ok", repo: "/repo", path: "/trees/local" },
      { state: "ok", repo: "/other", path: "/trees/private" },
    ] },
    "history.list": ({ cwd }: { cwd: string }) => {
      dirs.push(cwd);
      return { sessions: [
        { session: { harness: "lead", native: "same project" }, cwd: "/trees/local" },
        { session: { harness: "lead", native: "different project" }, cwd: "/trees/private" },
      ], more: false, unreadable: [] };
    },
    "history.read": ({ session }: { session: { native: string } }) => {
      read.push(session.native);
      return { records: [session.native], coverage: {} };
    },
    "forge.pr.list": { items: [{ pr: { repo: fixture.repo, number: 7 } }] },
    "forge.pr.read": { state: "open", head: sha, branch: "topic", base: "main" },
    "pstack.pr.binding": { binding: { author: { kind: "session", harness: "author", id: "original" } } },
  });
  const pickup = (await import("../src/workflows/session-pickup.ts")).default;
  const result = await invoke(pickup, { ...fixture, trail: "Handoff: the parser still fails." });
  expect(result).toMatchObject({ status: "picked-up", pickup: { verified: [expect.stringContaining("forge head CI green")] } });
  expect(JSON.stringify(result)).not.toContain("invented verified result");
  expect(dirs).toEqual(["/repo", "/trees/local"]);
  expect(read).toEqual(["same project"]);
  expect(turns[0]?.prompt).toContain("the parser still fails");
  expect(turns[0]?.prompt).toContain("same project");
  expect(turns[0]?.prompt).not.toContain("different project");
});

test("pickup drops all receipts when a PR changes during the evidence read", async () => {
  let reads = 0;
  runtime({ resume: { where: "The PR moved", verified: ["old receipt"], next: "Check the new head" } }, {
    "git.worktree.list": { items: [] },
    "history.list": { sessions: [], more: false, unreadable: [] },
    "forge.pr.list": { items: [{ pr: { repo: fixture.repo, number: 7 } }] },
    "forge.pr.read": () => ({ state: "open", head: reads++ === 0 ? sha : "b".repeat(40), base: "main" }),
    "pstack.pr.binding": { binding: { author: { kind: "session", harness: "author", id: "original" } } },
  });
  const pickup = (await import("../src/workflows/session-pickup.ts")).default;
  expect(await invoke(pickup, fixture)).toMatchObject({ pickup: { verified: [] } });
});

test("go after pagination uses the latest authorized verdict", async () => {
  const { goDigest } = await import("../src/policy.ts");
  const plan = { of: "rollout", rev: 3, items: [{ id: "node", text: "Ship", state: "open" }] };
  const change = "gitlab.example.com/team/lib";
  const digest = goDigest(plan, "node", change);
  const instance = (id: string, outcome: string) => ({ id, author: { kind: "owner" }, claim: { kind: "verdict", name: "go", sha: digest, outcome } });
  runtime({}, { "evidence.list": ({ after }: { after?: number }) =>
    after === undefined ? { items: [instance("before", "pass")], next: 42 } : { items: [instance("after", "fail")] },
  });
  const { goFound } = await import("../src/workflows/lib/go.ts");
  expect(await goFound("go", { plan, change, nodes: ["node"] })).toEqual([{ name: "go:node", covered: false, why: "withdrawn" }]);
});

test("Niwa can statically read the history grants of pickup and its two callers", () => {
  for (const builtin of ["session-pickup", "entry", "suite"]) {
    const file = new URL(`../src/workflows/${builtin}.ts`, import.meta.url);
    const source = ts.createSourceFile(file.pathname, readFileSync(file, "utf8"), ts.ScriptTarget.Latest);
    const uses = declarationField(ts, source, "uses");
    const literal = uses && "value" in uses ? literalOf(ts, uses.value)?.value : undefined;
    expect(literal).toEqual(expect.arrayContaining(["history.list", "history.read", "forge.pr.list"]));
  }
});

test("Autopilot only countersigns a proved relaxation after asking the owner", async () => {
  const { countersign } = await import("../src/workflows/lib/autopilot.ts");
  const { default: playbook } = await import("../src/workflows/texts/autopilot-full.json");
  const wt = { id: "checkout", repo: "/repo", path: "/trees/checkout", branch: "topic", base: "main", baseSha: sha, description: "Reader" };
  const built = { wt, author: { kind: "session" as const, harness: "author", id: "original" }, sha, summary: "updated" };
  const delivered = { built, pr: { number: 7, head: sha, subject: "gitlab.example.com/team/lib/pr/7" }, verdicts: [], ci: { outcome: "green" as const }, verified: true };
  for (const [kind, answer, decision] of [
    ["unchanged", false, "unchanged"], ["disabled", true, "blocked"], ["unproved", true, "blocked"],
    ["relaxed", false, "declined"], ["relaxed", true, "approved"],
  ] as const) {
    const { turns } = runtime({ "gate-review": { kind, proof: "Measured the relevant gate" } }, {
      "proc.run": ({ cmd }: { cmd: string[] }) => ({ exit: 0, tail: cmd[1] === "status" ? "" : sha, truncated: false }),
      "forge.pr.read": { head: sha, base: "main", state: "open", autoMerge: false },
    });
    const decisions: string[] = [];
    Object.assign(globals.ask as object, { confirm: async (prompt: string) => { decisions.push(prompt); return answer; } });
    expect(await countersign("gate", { ...fixture, playbook, roles, title: "Reader" }, delivered)).toMatchObject({ decision });
    expect(decisions).toHaveLength(kind === "relaxed" ? 1 : 0);
    expect(turns[0]?.harness).toBe("reviewer");
    if (kind === "relaxed") expect(decisions[0]).toContain(sha);
  }
  runtime({ "gate-review": { kind: "relaxed", proof: "Measured the relevant gate" } }, {
    "proc.run": ({ cmd }: { cmd: string[] }) => ({ exit: 0, tail: cmd[1] === "status" ? "" : sha, truncated: false }),
    "forge.pr.read": { head: "b".repeat(40), base: "main", state: "open", autoMerge: false },
  });
  Object.assign(globals.ask as object, { confirm: async () => true });
  expect(await countersign("gate", { ...fixture, playbook, roles, title: "Reader" }, delivered)).toMatchObject({ decision: "blocked" });
});

test("landing refuses a head that changed after the gate review before any merge step", async () => {
  const { calls } = runtime({}, { "forge.pr.read": { state: "open", base: "main", head: "b".repeat(40) } });
  const { ship } = await import("../src/workflows/lib/ship.ts");
  expect(await ship("land", { repo: fixture.repo, number: 7, trunk: "main", cwd: "/trees/checkout", plan: "rollout", nodes: ["a"], expectHead: sha }))
    .toMatchObject({ outcome: "refused", missing: [{ name: "pr", why: "head changed after independent gate review" }] });
  expect(calls).toEqual(["forge.pr.read"]);
});

test.each(["owner", "audit"] as const)("Autopilot audits a live owner and surfaces a failure from %s", async (failure) => {
  const { supervisedDelivery } = await import("../src/workflows/lib/autopilot.ts");
  const { default: playbook } = await import("../src/workflows/texts/autopilot-full.json");
  runtime({}, {
    "proc.run": { exit: failure === "audit" ? 9 : 0, tail: failure === "audit" ? "fixture audit read failed" : sha, truncated: false },
  });
  const asleep = Promise.withResolvers<void>();
  const authorStarted = Promise.withResolvers<void>();
  const authorAnswer = Promise.withResolvers<never>();
  const observed = Promise.withResolvers<string>();
  const waits: unknown[] = [];
  globals.session = async () => ({
    address: { kind: "session", harness: "author", id: "author-fixture" },
    ask: () => { authorStarted.resolve(); return authorAnswer.promise; },
  });
  globals.log = (line: string) => observed.resolve(line);
  globals.sleep = (duration: unknown) => {
    waits.push(duration);
    return waits.length === 1 ? asleep.promise : new Promise(() => {});
  };
  const exits: string[] = [];
  globals.scope = async (key: string, options: { onExit: string }, body: (scope: unknown) => Promise<unknown>) => {
    const outcomes: Array<Promise<{ key: string; result: unknown }>> = [];
    try {
      return await body({ next: () => Promise.race(outcomes), start: (key: string, run: () => Promise<unknown>) => {
        const settled = run().then(value => ({ ok: true, value }), (error: Error) => ({ ok: false, error }));
        outcomes.push(settled.then(result => ({ key, result })));
        return { settled: () => settled };
      } });
    } finally {
      exits.push(`${key}:${options.onExit}`);
    }
  };
  const loading = supervisedDelivery("node-fixture", { ...fixture, playbook, roles, title: "Reader" });
  await authorStarted.promise;
  asleep.resolve();
  if (failure === "audit") {
    await expect(loading).rejects.toThrow("git rev-parse HEAD failed (9): fixture audit read failed");
  } else {
    expect(await observed.promise).toContain(`author in /trees/checkout at ${sha}`);
    authorAnswer.reject(new Error("fixture author failed"));
    expect(await loading).toEqual({ reason: "fixture author failed Worktree: /trees/checkout." });
  }
  expect(waits[0]).toBe("1h");
  expect(exits).toEqual(["node-fixture:cancel"]);
});

test("an old passing attestation cannot stand in for the verifier dispatched now", async () => {
  const git = await featureGit();
  const { calls } = runtime({
    frame: { kind: "direct", trace: "One reader", design, checkpoint, whyOnlyOne: "Single supported extension point", contested: false },
    architect: design,
    "approve-design": { kind: "proceed", resolution: "One supported extension point", design },
    "integrate-artifact": commitArtifact("a.txt", "Updated the reader"),
    "change-write": prBrief,
    "publish-artifact": git.publish,
    "change-verify-gates": { outcome: "pass", evidence: "Tests passed" },
    "change-verify-live": { outcome: "pass", evidence: "Observed the reader" },
  }, { ...git.gitActions, "evidence.list": { items: [{ id: "current-verdict", author: { kind: "session", harness: "verifier", id: "previous-instance" } }] } });
  const feature = (await import("../src/workflows/feature.ts")).default;
  await expect(invoke(feature, git.input)).resolves.toMatchObject({
    status: "unverified",
    verdicts: [{ covered: false, why: "No current verifier receipt" }, { covered: false, why: "No current verifier receipt" }],
  });
  expect(calls.filter((call) => call === "evidence.list")).toHaveLength(2);
});
