import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";

import { z } from "zod";

const roots: string[] = [];
const globals = globalThis as Record<string, unknown>;
const names = ["z", "workflow", "phase", "call", "ask", "session", "parallel", "scope", "read", "stream", "wait", "sleep", "now", "random"];
const roles = {
  lead: { harness: "lead", vendor: "lead-vendor" },
  author: { harness: "author", box: true },
  reviewer: { harness: "reviewer", vendor: "reviewer-vendor" },
  verifier: { harness: "verifier", vendor: "verifier-vendor" },
  judge: { harness: "judge", vendor: "judge-vendor" },
};
type Options = { cwd: string; label: string; harness: string; schema: z.ZodType };
type Answer = (options: Options, prompt: string) => unknown;
type Handler = (input: Record<string, unknown>, label: string) => unknown;
const empty = () => Promise.resolve();

afterEach(() => {
  for (const name of names) delete globals[name];
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, ...argv: string[]): string {
  const ran = Bun.spawnSync(["git", ...argv], { cwd, stdout: "pipe", stderr: "pipe" });
  if (ran.exitCode !== 0) throw new Error(ran.stderr.toString());
  return ran.stdout.toString().trim();
}

function commit(cwd: string, value: string, file = "contract.txt") {
  writeFileSync(join(cwd, file), value + "\n");
  git(cwd, "add", "--", file);
  git(cwd, "commit", "-qm", value);
  return git(cwd, "rev-parse", "HEAD");
}

function setup(answers: Record<string, unknown>, actions: Record<string, Handler> = {}, owner: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), "pstack-decisions-"));
  roots.push(root);
  const local = join(root, "repo");
  const worktrees = join(root, "trees");
  mkdirSync(local);
  mkdirSync(worktrees);
  git(local, "init", "-qb", "main");
  git(local, "config", "user.name", "Decision Fixture");
  git(local, "config", "user.email", "fixture@example.invalid");
  const initial = commit(local, "baseline");
  const repo = { local, host: "forge.example.invalid", path: "org/repo" };
  let serial = 0;
  let published: { sha: string; branch: string } | undefined;
  const turns: Array<Options & { prompt: string }> = [];
  const calls: Array<{ name: string; input: Record<string, unknown>; label: string }> = [];
  const requests: string[] = [];
  const scopes: string[] = [];
  const childResults: Record<string, unknown> = {};
  const ask = async (opts: Options, prompt: string) => {
    turns.push({ ...opts, prompt });
    const value = answers[opts.label];
    if (value === undefined) throw new Error("Unexpected turn " + opts.label);
    return opts.schema.parse(typeof value === "function" ? await (value as Answer)(opts, prompt) : value);
  };
  const respond = async (_prompt: string, opts: { label: string }) => {
    requests.push(opts.label);
    if (!Object.hasOwn(owner, opts.label)) throw new Error("Unexpected owner request " + opts.label);
    return owner[opts.label];
  };
  Object.assign(globals, {
    z, workflow: (definition: unknown, run: unknown) => ({ definition, run }), phase: () => {},
    stream: empty, wait: empty, sleep: empty, now: async () => 0, random: () => 0,
    ask: Object.assign(ask, { confirm: respond, choice: respond, text: respond }),
    scope: async (key: string, _: unknown, work: () => unknown) => { scopes.push(key); return work(); },
    parallel: async (work: Record<string, () => unknown> | Array<() => unknown>) => Array.isArray(work)
      ? Promise.all(work.map((one) => one()))
      : Object.fromEntries(await Promise.all(Object.entries(work).map(async ([id, run]) => [id, await run()]))),
    read: {
      records: async ({ filter }: { filter: { run: string } }) => ({
        records: [{ data: { outcome: { status: "done", result: childResults[filter.run] } } }],
      }),
    },
    session: async (opts: Options) => ({
      address: { kind: "session", id: opts.harness + "-id", harness: opts.harness },
      ask: (prompt: string, extra: Partial<Options>) => ask({ ...opts, ...extra }, prompt),
      end: empty,
    }),
    call: async (name: string, input: Record<string, unknown>, { label = name }: { label?: string } = {}) => {
      calls.push({ name, input, label });
      if (actions[name]) return actions[name](input, label);
      switch (name) {
        case "pstack.roles": return roles;
        case "pstack.author.options": return { harness: "author", cwd: input.place };
        case "git.worktree.create": {
          const branch = "local-" + ++serial;
          const path = join(worktrees, branch);
          const baseSha = git(local, "rev-parse", String(input.base));
          git(local, "worktree", "add", "-qb", branch, path, baseSha);
          return { id: branch, repo: local, path, branch, base: input.base, baseSha };
        }
        case "git.worktree.get": return { head: git(join(worktrees, String(input.id)), "rev-parse", "HEAD"), dirty: false };
        case "git.worktree.remove":
          git(local, "worktree", "remove", "--force", join(worktrees, String(input.id)));
          return {};
        case "proc.run": {
          const ran = Bun.spawnSync(input.cmd as string[], { cwd: input.cwd as string, stdout: "pipe", stderr: "pipe" });
          return { exit: ran.exitCode, tail: ran.stdout.toString() + ran.stderr.toString(), truncated: false };
        }
        case "forge.pr.ensure":
          expect(input.draft).toBe(false);
          expect(input.branch).toBe(published?.branch);
          return { pr: { number: 7 }, head: published?.sha };
        case "forge.pr.read": return { head: published?.sha, branch: published?.branch, base: "main" };
        case "pstack.pr.bind": return {};
        case "evidence.attest": return {};
        case "evidence.covers": return { covered: true, by: ["verdict"] };
        case "evidence.list": return { items: [{ id: "verdict", author: { kind: "session", id: "verifier-id", harness: "verifier" } }] };
        case "forge.pipeline.read":
          return { items: [{ kind: "head", pr: 7, sourceSha: published?.sha, pipeline: 1, state: "success" }] };
        default: throw new Error("Unexpected action " + name);
      }
    },
  });
  return {
    initial, local, calls, turns, requests, scopes, childResults,
    input: { task: "Preserve the reader", repo, worktrees, base: "main" },
    publish: ({ cwd }: Options) => {
      published = { branch: git(cwd, "branch", "--show-current"), sha: git(cwd, "rev-parse", "HEAD") };
      return { sha: published.sha };
    },
  };
}

async function invoke(registered: unknown, input: unknown) {
  const program = registered as { definition: { input: z.ZodType; output: z.ZodType }; run: (args: unknown) => Promise<unknown> };
  return program.definition.output.parse(await program.run(program.definition.input.parse(input)));
}

const prNote = { title: "refactor(reader): simplify read", sections: [
  { heading: "Verification", body: "Replayed the checked behavior." },
  { heading: "What changed", body: "Simplified the reader." },
] };
const verification = {
  unit: "Run reader tests", live: { scenario: "Open the reader", pass: "The original value is shown" },
  perf: { metric: "reader time", probe: "Measure the first read", trunk: "Measure with the same input", fail: "More than 20 ms" },
};
const probe = ["cat", "contract.txt"];

test("Investigation binds history to its PR, edits prose, and returns a runnable owner handoff", async () => {
  const answers: Record<string, unknown> = {};
  const fixture = setup(answers, {
    "forge.pr.read": (_input, label) => label === "why-pr-0" ? { head: fixture.initial } : { head: "b".repeat(40) },
    "forge.comment.read": () => ({ items: [{ body: "Author: the reader must tolerate legacy input." }] }),
  });
  const later = commit(fixture.local, "later");
  const traced = { summary: "The reader kept its original contract.", sources: [{ file: "contract.txt", line: 1 }], handoff: "bug-fix" };
  answers.trace = { ...traced, history: [{ sha: fixture.initial, pr: 7 }, { sha: later, pr: 8 }] };
  answers.why = (_opts: Options, prompt: string) => {
    expect(prompt).toContain("the reader must tolerate legacy input");
    expect(prompt).toContain("origin/main");
    return traced;
  };
  answers.unslop = (_opts: Options, prompt: string) => {
    expect(prompt).toContain(traced.summary);
    return { ...traced, summary: "The reader accepts legacy input.", sources: [], changeTask: "Keep accepting legacy input in contract.txt" };
  };
  const result = await invoke((await import("../src/workflows/investigation.ts")).default, fixture.input);
  expect(result).toMatchObject({
    answer: { summary: "The reader accepts legacy input.", sources: traced.sources },
    next: { playbook: "bug-fix", args: { ...fixture.input, task: "Keep accepting legacy input in contract.txt" } },
  });
  expect(fixture.calls.filter(({ name }) => name === "forge.comment.read")).toHaveLength(1);
  expect(fixture.calls.some(({ name }) => name === "workflow.start" || name === "forge.pr.ensure")).toBe(false);
});

test("Plan runs a Prototype, records a preference, and only attests the owner-approved revision", async () => {
  let revision = 0;
  const fixture = setup({
    plan: (_opts: Options, prompt: string) => {
      if (!prompt.includes("observed 12 ms")) return { kind: "prototype", question: "How slow is the reader?" };
      if (!prompt.includes("Keep the cancel action")) return { kind: "preference", question: "Which action should remain?" };
      const changed = prompt.includes("Name the action in the plan");
      return { kind: "plan", goal: "Preserve the reader", nodes: [
        { id: "reader", text: changed ? "Keep the cancel action" : "Keep one action", files: ["reader.ts"],
          interaction: changed ? "Cancel stays visible" : "Action stays visible", verification },
      ] };
    },
  }, {
    "workflow.list": () => ({ items: [{ id: "prototype-id", builtin: { plugin: "pstack", name: "prototype" } }] }),
    "workflow.start": (args) => {
      expect(args).toMatchObject({ id: "prototype-id", args: { handoff: false } });
      return { run: "prototype-run" };
    },
    "plan.set": (args) => ({ of: args.of, rev: ++revision }),
  }, { preference: "Keep the cancel action", "interaction-reader": "edit", "edit-reader": "Name the action in the plan", "go-ask": true });
  fixture.childResults["prototype-run"] = { status: "decided", observed: "observed 12 ms" };
  let interaction = 0;
  const confirm = globals.ask as { choice: (prompt: string, items: unknown, opts: { label: string }) => unknown };
  confirm.choice = () => ++interaction === 1 ? "edit" : "accept";
  const args = {
    ...fixture.input, plan: "reader", reviewInteractions: true,
  };
  const plan = (await import("../src/workflows/multi-phase-plan.ts")).default;
  const stored = new Map<string, unknown>();
  let paused = false;
  const scope = globals.scope as (key: string, params: unknown, work: () => unknown) => Promise<unknown>;
  globals.scope = async (key: string, params: unknown, work: () => unknown) => {
    if (stored.has(key)) return stored.get(key);
    if (key === "plan-revision-4" && !paused) {
      paused = true;
      throw new Error("Pause before final revision");
    }
    const outcome = await scope(key, params, work);
    stored.set(key, outcome);
    return outcome;
  };
  await expect(invoke(plan, args)).rejects.toThrow("Pause before final revision");
  const result = await invoke(plan, args);
  expect(result).toMatchObject({ status: "planned", plan: { of: "reader", rev: 2 }, go: true });
  expect(fixture.scopes).toEqual(["plan-revision-1", "plan-revision-2", "plan-revision-3", "plan-revision-4"]);
  const attests = fixture.calls.filter(({ name }) => name === "evidence.attest");
  const { goDigest, goSubject } = await import("../src/policy.ts");
  expect(attests).toHaveLength(1);
  expect(attests[0]?.input).toMatchObject({
    subject: goSubject({ of: "reader", rev: 2 }, "reader"),
    claim: { sha: goDigest({ of: "reader", rev: 2 }, "reader", "forge.example.invalid/org/repo") },
  });
  expect(fixture.calls.filter(({ name }) => name === "workflow.start")).toHaveLength(1);
});

test("Prototype replays a single empirical variant and respects declined continuation", async () => {
  const fixture = setup({
    scope: { kind: "decide", surface: "timing", decision: "How does the reader respond?", variants: [{ name: "current", idea: "Use the reader" }] },
    "build-current": { observed: "Printed baseline", command: probe },
    recommend: (_opts: Options, prompt: string) => {
      expect(prompt).toContain('"replay":"baseline\\n"');
      return { kind: "pick", recommend: "current", why: "The output establishes the baseline", route: "feature" };
    },
  }, {}, { continue: false });
  const result = await invoke((await import("../src/workflows/prototype.ts")).default, fixture.input);
  expect(result).toMatchObject({ status: "decided", variants: [{ name: "current", replay: "baseline\n" }] });
  expect(fixture.requests).toEqual(["continue"]);
  expect(fixture.calls.some(({ name }) => name === "workflow.start")).toBe(false);
});

test("a contested Prototype architecture handoff runs a read-only arena only after owner approval", async () => {
  const shape = { shape: "One reader", tradeoffs: "One owner", checks: ["Read the baseline"] };
  const score = ["owners", "callers", "proof"].map((evidence) => ({ score: 4, evidence }));
  const scores = { "shape-1": score, "shape-2": score };
  const fixture = setup({
    scope: { kind: "decide", surface: "behavior", decision: "Where should the value live?", variants: [{ name: "current", idea: "Read current value" }] },
    "build-current": { observed: "Printed baseline", command: probe },
    recommend: { kind: "pick", recommend: "current", why: "Baseline observed", route: "architect" },
    architect: { ...shape, contested: true },
    "architecture-rubric": ["owners", "callers", "proof"],
    "shape-1": shape,
    "shape-2": { ...shape, shape: "Different owner" },
    "shape-3": () => { throw new Error("Unavailable test seat"); },
    "architecture-judge-1": { pick: "shape-2", why: "Fewer callers", scores },
    "architecture-synthesize": (_opts: Options, prompt: string) => {
      expect(prompt).toContain("Unavailable test seat");
      return { assessment: { pick: "shape-1", why: "Keep owner", scores }, advice: shape };
    },
  }, {}, { continue: true });
  const result = await invoke((await import("../src/workflows/prototype.ts")).default, fixture.input);
  expect(result).toMatchObject({ status: "decided", continuation: { route: "architect", advice: shape,
    evidence: { assessment: { pick: "shape-1" }, judge: { pick: "shape-2" } },
  } });
  expect(fixture.requests).toEqual(["continue"]);
  expect(fixture.turns.filter(({ label }) => label.startsWith("shape-")).every(({ prompt }) => !prompt.includes("Freeze three"))).toBe(true);
  expect(fixture.calls.some(({ name }) => name === "forge.pr.ensure")).toBe(false);
});

test("the visual switcher switches the rendered document and preserves sandbox isolation", async () => {
  const fixture = setup({});
  const { buildSwitcher } = await import("../src/workflows/lib/prototype-evidence.ts");
  const first = "<p>One</p>";
  const second = "<button>Two</button><script>1</script>";
  const path = await buildSwitcher(fixture.local, [{ name: "one", html: first }, { name: "two", html: second }]);
  const rendered = readFileSync(path, "utf8");
  expect(rendered).toContain('sandbox="allow-scripts"');
  const script = /<script>([\s\S]*)<\/script>/.exec(rendered)?.[1] ?? "";
  class Button {
    pressed = "";
    click = () => {};
    setAttribute(_name: string, value: string) { this.pressed = value; }
    addEventListener(_name: string, click: () => void) { this.click = click; }
  }
  const buttons = [new Button(), new Button()];
  const iframe = { srcdoc: "" };
  runInNewContext(script, { document: { querySelectorAll: () => buttons, querySelector: () => iframe } });
  expect(iframe.srcdoc).toBe(first);
  buttons[1]!.click();
  expect(iframe.srcdoc).toBe(second);
  expect(buttons.map(({ pressed }) => pressed)).toEqual(["false", "true"]);
});

test("Prototype reads a replay-created image and refuses a stale capture", async () => {
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP1sAAAAASUVORK5CYII=";
  let stale = false;
  const fixture = setup({
    scope: { kind: "decide", surface: "visual", decision: "Can the control be reached?", variants: [{ name: "control", idea: "Use a button" }] },
    "build-control": ({ cwd }: Options) => {
      writeFileSync(join(cwd, "index.html"), "<button>Reader</button>");
      if (stale) writeFileSync(join(cwd, "capture.png"), Buffer.from(png, "base64"));
      const cmd = 'await Bun.write("capture.png", Buffer.from(Bun.argv[1], "base64")); console.log("Fixture control changed");';
      return { observed: "Fixture capture", entry: "index.html", screenshot: "capture.png", interaction: "Click callback",
        command: stale ? ["bun", "-e", 'console.log("Ignored capture")'] : ["bun", "-e", cmd, png],
      };
    },
    recommend: { kind: "pick", recommend: "control", why: "The fixture capture was read" },
  });
  const prototype = (await import("../src/workflows/prototype.ts")).default;
  const first = await invoke(prototype, fixture.input);
  expect(first).toMatchObject({ variants: [{ replay: "Fixture control changed\n", screenshotDigest: expect.stringMatching(/^[0-9a-f]{64}$/) }] });
  stale = true;
  await expect(invoke(prototype, fixture.input)).rejects.toThrow("Visual replay did not refresh its screenshot");
});

test("Figure-it-out replays rejected work from the same accepted commit and preserves the trail", async () => {
  let attempts = 0;
  const fixture = setup({
    frame: { kind: "handoff", route: "figure-it-out", why: "Cross-cutting migration", offer: true },
    "figure-it-out": { contract: "Keep output", pin: "Read value", target: "Inline reader", oneWayDesign: false },
    characterize: { predicate: "identical output", probe, phases: [{ hypothesis: "Inline", change: "Try inline" }] },
    "reshape-artifact": ({ cwd }: Options) => {
      expect(git(cwd, "rev-parse", "HEAD")).toBe(fixture.initial);
      return { sha: ++attempts === 1 ? commit(cwd, "changed contract") : commit(cwd, "read consistently", "implementation.txt"), observed: "Tried inline" };
    },
    "revise-phases": (_opts: Options, prompt: string) => {
      expect(prompt).toContain("changed contract");
      return { kind: "retry", why: "Keep output", phases: [{ hypothesis: "Inline only internals", change: "Keep contract fixture" }] };
    },
    "reader-load": { keep: true, why: "Removed wrapper" },
    "publish-artifact": (opts: Options) => fixture.publish(opts),
    "change-write": prNote,
    "change-verify-gates": { outcome: "pass", evidence: "Pin replayed" },
    "change-verify-live": { outcome: "pass", evidence: "Same reader output" },
  }, {}, { "handoff-figure-it-out": true, "approve-phases": true });
  const result = await invoke((await import("../src/workflows/refactoring.ts")).default, fixture.input);
  expect(result).toMatchObject({ status: "verified" });
  expect(JSON.stringify(result)).toContain("changed contract");
  expect(fixture.scopes).toEqual(["reshape-1", "replan-1", "reshape-2"]);
});

test("skill authoring validates actual links and structural cases before the shared PR writer", async () => {
  const fixture = setup({
    frame: { skill: "read", decisions: ["Read in order"], validation: "Cross-skill link and case" },
    "create-skill": { path: "skills/read/SKILL.md", guidance: "Read based on the existing contract", cases: { kind: "structural", commands: [probe] } },
    "author-skill-artifact": ({ cwd }: Options) => {
      mkdirSync(join(cwd, "skills/read"), { recursive: true });
      mkdirSync(join(cwd, "skills/base"), { recursive: true });
      commit(cwd, "---\nname: base\ndescription: Use the baseline\n---", "skills/base/SKILL.md");
      return { sha: commit(cwd, "---\nname: read\ndescription: Read legacy input\n---\nUse [base](../base/SKILL.md).", "skills/read/SKILL.md"), observed: "Authored the skill" };
    },
    "publish-artifact": (opts: Options) => fixture.publish(opts),
    "change-write": (_opts: Options, prompt: string) => {
      expect(prompt).toContain("Case passed");
      expect(prompt).toContain("skills/read/SKILL.md");
      return prNote;
    },
    "change-verify-gates": { outcome: "pass", evidence: "Validated structure" },
    "change-verify-live": { outcome: "pass", evidence: "Case ran" },
  });
  const result = await invoke((await import("../src/workflows/authoring-a-skill.ts")).default, fixture.input);
  expect(result).toMatchObject({ status: "verified" });
  expect(JSON.stringify(result)).toContain("base/SKILL.md");
  expect(fixture.calls.find(({ name }) => name === "forge.pr.ensure")?.input.description)
    .toBe("## What changed\n\nSimplified the reader.\n\n## Verification\n\nReplayed the checked behavior.");
});

test("subjective skill skips cases but still rejects a broken structural reference before publication", async () => {
  const fixture = setup({
    frame: { skill: "voice", decisions: ["Be concise"], validation: "Links and subjective judgment" },
    "create-skill": { path: "SKILL.md", guidance: "Use direct prose", cases: { kind: "subjective", why: "Voice needs judgment" } },
    "author-skill-artifact": ({ cwd }: Options) => ({
      sha: commit(cwd, "---\nname: voice\ndescription: Edit prose\n---\nSee `skills/missing/SKILL.md`.", "SKILL.md"),
      observed: "Authored voice",
    }),
  });
  await expect(invoke((await import("../src/workflows/authoring-a-skill.ts")).default, fixture.input))
    .rejects.toThrow("Skill validation failed");
  expect(fixture.calls.some(({ label }) => label.startsWith("skill-case-"))).toBe(false);
  expect(fixture.turns.some(({ label }) => label === "publish-artifact" || label === "change-write")).toBe(false);
});

test("Opening a PR stops before writing when an existing binding moved", async () => {
  let head: string;
  let base = "main";
  const fixture = setup({
    write: (_opts: Options, prompt: string) => {
      expect(prompt).toContain("+changed reader");
      return prNote;
    },
  }, { "forge.pr.read": () => ({ head, branch: "reader", base }) });
  head = fixture.initial;
  git(fixture.local, "switch", "-qc", "reader");
  const briefed = commit(fixture.local, "changed reader");
  git(fixture.local, "switch", "-q", "main");
  const workflow = (await import("../src/workflows/opening-a-pr.ts")).default;
  const args = { ...fixture.input, branch: "reader", number: 7 };
  await expect(invoke(workflow, args)).rejects.toThrow("existing PR no longer matches");
  head = briefed;
  base = "other-target";
  await expect(invoke(workflow, args)).rejects.toThrow("existing PR no longer matches");
  expect(fixture.calls.some(({ name }) => name === "forge.pr.ensure")).toBe(false);
});

test("Opening a PR briefs a sealed stack diff and opens it ready without launching a babysit", async () => {
  const fixture = setup({
    write: (_opts: Options, prompt: string) => {
      expect(prompt).toContain("+new reader");
      expect(prompt).not.toContain("+stack parent");
      return prNote;
    },
  }, {
    "forge.pr.ensure": (params) => {
      expect(params).toMatchObject({ branch: "reader", base: "parent", draft: false });
      return { pr: { number: 9 }, head: git(fixture.local, "rev-parse", "reader") };
    },
  });
  git(fixture.local, "switch", "-qc", "parent");
  commit(fixture.local, "stack parent", "parent.txt");
  git(fixture.local, "switch", "-qc", "reader");
  const head = commit(fixture.local, "new reader");
  git(fixture.local, "switch", "-q", "main");
  const result = await invoke((await import("../src/workflows/opening-a-pr.ts")).default, {
    ...fixture.input, base: "parent", branch: "reader",
  });
  expect(result).toMatchObject({ status: "opened", pr: 9, head });
  expect(fixture.calls.some(({ name }) => name === "workflow.start")).toBe(false);
});

test("Feature scores three artifacts, retries a judge, and grafts only after an exact-head finding replays", async () => {
  const design = { shape: "One owner", rationale: "One caller", scope: ["contract.txt"], checks: ["Read existing input"] };
  const scores = ["contract", "owner", "checks"].map((evidence) => ({ score: 4, evidence }));
  const change = (value: string) => ({ cwd }: Options) => ({ sha: commit(cwd, value), observed: value });
  let repaired = false;
  const defect = (candidate: string) => ({
    candidate, title: "Contract changed", cause: "Reader owns the wrong value", cmd: probe,
    expected: { exit: 0, output: "baseline" }, observed: { exit: 0, output: "bad output" },
  });
  const fixture = setup({
    frame: {
      kind: "alternatives", trace: "Read contract.txt", question: "Who owns the value?",
      rubric: ["Contract", "Ownership", "Observable checks"], contested: true,
      checkpoint: { blocking: "baseline", independent: "candidates", shared: "no shared writes", decomposition: "one checkout per candidate" },
      arena: { artifact: "Readable contract implementation", runners: ["author", "verifier", "reviewer"],
        judges: ["judge", "reviewer"], adversaries: ["reviewer", "verifier"] },
    },
    architect: design,
    "implementation-a-artifact": change("bad output"),
    "implementation-b-artifact": change("alternative"),
    "implementation-c-artifact": change("baseline from another owner"),
    judge: () => { throw new Error("First judge unavailable"); },
    "judge-2": { pick: "first", why: "The base has one owner", scores: { first: scores, second: scores, "candidate-3": scores } },
    "adversary-1": (_opts: Options, prompt: string) => ({
      findings: repaired ? [] : [defect(prompt.includes('"candidate":"synthesis"') ? "synthesis" : "first")],
    }),
    "adversary-2": (_opts: Options, prompt: string) => {
      if (repaired) return { findings: [] };
      const candidate = prompt.includes('"candidate":"synthesis"') ? "synthesis" : "first";
      return { findings: [defect(candidate), { ...defect(candidate), title: "Nonreproducing output", observed: { exit: 0, output: "fiction" } }] };
    },
    resolve: (_opts: Options, prompt: string) => {
      expect(prompt).toContain("First judge unavailable");
      expect(prompt).toContain('"by":[1,2]');
      expect(prompt).toContain("Nonreproducing output");
      return { kind: "proceed", resolution: "Keep one owner and replay the contract", design, probes: [probe],
        scores: { first: scores, second: scores, "candidate-3": scores } };
    },
    "integrate-artifact": ({ cwd }: Options) => ({ sha: git(cwd, "rev-parse", "HEAD"), observed: "Selected the proposed base" }),
    "recover-synthesis": (_opts: Options, prompt: string) => {
      expect(prompt).toContain('"candidate":"synthesis"');
      expect(prompt).toContain('"by":[1,2]');
      return { kind: "graft", instructions: "Take the contract behavior from the third candidate", source: "candidate-3" };
    },
    "graft-artifact": ({ cwd }: Options, prompt: string) => {
      expect(prompt).toMatch(/Graft from [0-9a-f]{40} at /);
      repaired = true;
      commit(cwd, "baseline");
      return { sha: commit(cwd, "one owner implementation", "reader.txt"), observed: "Grafted the contract" };
    },
    "publish-artifact": (opts: Options) => fixture.publish(opts),
    "change-write": prNote,
    "change-verify-gates": { outcome: "pass", evidence: "Probe replayed" },
    "change-verify-live": { outcome: "pass", evidence: "Expected value" },
  });
  const result = await invoke((await import("../src/workflows/feature.ts")).default, fixture.input);
  expect(result).toMatchObject({ status: "verified", framed: { synthesis: { selected: "first" } } });
  expect(JSON.stringify(result)).toContain("First judge unavailable");
  expect(fixture.scopes).toEqual(["synthesis-1", "synthesis-2"]);
  expect(fixture.turns.filter(({ label }) => label === "publish-artifact")).toHaveLength(1);
});

test("direct Feature opens from a sealed commit but an advanced forge head cannot pass verification", async () => {
  const design = { shape: "One reader", rationale: "Known ownership", scope: ["contract.txt"], checks: ["Read new input"] };
  const fixture = setup({
    frame: { kind: "direct", trace: "Read contract", design, whyOnlyOne: "Use the existing owner", contested: false,
      checkpoint: { blocking: "n/a: no setup", independent: "n/a: coupled edit", shared: "one file", decomposition: "one author" } },
    architect: design,
    "approve-design": { kind: "proceed", resolution: "Use the existing owner", design },
    "integrate-artifact": ({ cwd }: Options) => ({ sha: commit(cwd, "new reader"), observed: "Reader changed" }),
    "change-write": (_opts: Options, prompt: string) => {
      expect(prompt).toContain("+new reader");
      expect(fixture.turns.some(({ label }) => label === "publish-artifact")).toBe(false);
      return prNote;
    },
    "publish-artifact": (opts: Options) => fixture.publish(opts),
    "change-verify-gates": { outcome: "pass", evidence: "Pin replayed" },
    "change-verify-live": { outcome: "pass", evidence: "Reader showed input" },
  }, { "forge.pr.read": () => ({ head: "a".repeat(40) }) });
  const result = await invoke((await import("../src/workflows/feature.ts")).default, fixture.input);
  expect(result).toMatchObject({ status: "unverified", ci: "timed-out", verdicts: [{ covered: true }, { covered: true }] });
  expect(fixture.calls.some(({ label }) => label === "change-ci-attest")).toBe(false);
});
