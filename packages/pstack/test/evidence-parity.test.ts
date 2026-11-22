import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { z } from "zod";

type Turn = { label: string; harness: string; cwd: string; box?: unknown };
type Answer = object | ((opts: Turn, prompt: string) => object);
const globals = globalThis as Record<string, unknown>;
const roots: string[] = [];
const saved = new Map<string, unknown>();
const roles = {
  lead: { harness: "lead", vendor: "leader" }, author: { harness: "author", vendor: "worker", box: true },
  reviewer: { harness: "reviewer", vendor: "review" }, verifier: { harness: "verifier", vendor: "verify" },
  judge: { harness: "judge", vendor: "neutral" },
};

afterEach(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete globals[key];
    else globals[key] = value;
  }
  saved.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]) {
  const run = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (run.exitCode !== 0) throw Error(run.stderr.toString());
  return run.stdout.toString().trim();
}

function commit(cwd: string, file: string, value: string) {
  writeFileSync(join(cwd, file), value);
  git(cwd, "add", "--", file);
  git(cwd, "commit", "-qm", `Update ${file}`);
  return git(cwd, "rev-parse", "HEAD");
}

function fixture(answers: Record<string, Answer>, options: { historyUnavailable?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "product-"));
  roots.push(root);
  const repo = join(root, "source");
  const worktrees = join(root, "projects");
  mkdirSync(repo);
  mkdirSync(worktrees);
  git(repo, "init", "-qb", "main");
  git(repo, "config", "user.email", "fixture@example.invalid");
  git(repo, "config", "user.name", "Fixture");
  commit(repo, ".gitignore", ".proof/\n");
  const input = { task: "Improve the local reader", repo: { local: repo, host: "forge.example.invalid", path: "team/product" }, worktrees, base: "main" };
  const turns: (Turn & { prompt: string })[] = [];
  const operations: { name: string; input: any; label?: string }[] = [];
  const published = new Map<string, string>();
  const prs = new Map<number, string>();
  let allocated = 0;
  const answer = (opts: Turn & { schema?: z.ZodType }, prompt: string) => {
    turns.push({ ...opts, prompt });
    if (opts.label.endsWith("-publish")) {
      expect(prompt).toContain(git(opts.cwd, "rev-parse", "HEAD"));
      published.set(git(opts.cwd, "branch", "--show-current"), git(opts.cwd, "rev-parse", "HEAD"));
      return opts.schema?.parse({ published: true });
    }
    const source = answers[opts.label] ?? (opts.label.endsWith("-gates") || opts.label.endsWith("-live") ?
      { outcome: "pass", evidence: "Deterministic fixture" } : undefined);
    if (!source) throw Error("Unexpected turn " + opts.label);
    const result = typeof source === "function" ? source(opts, prompt) : source;
    return opts.schema ? opts.schema.parse(result) : result;
  };
  const api = {
    z, workflow: (definition: unknown, run: unknown) => ({ definition, run }),
    phase: () => undefined, record: () => undefined, now: async () => 0, random: async () => 0.1,
    read: { records: async (input: unknown) => { operations.push({ name: "read.records", input }); return { next: 8 }; } },
    stream: () => { throw Error("Unexpected stream"); },
    race: () => { throw Error("Unexpected race"); },
    wait: async (name: string, input: unknown) => { operations.push({ name, input }); return null; },
    sleep: async (input: unknown) => { operations.push({ name: "sleep", input }); },
    scope: (_name: string, _opts: unknown, run: (scope: object) => unknown) => {
      const pending = new Map<string, Promise<{ key: string; result: object }>>();
      return run({
        start: (key: string, task: () => unknown) => {
          const value = Promise.resolve().then(task);
          pending.set(key, value.then(
            (value) => ({ key, result: { ok: true, value } }),
            (error: Error) => ({ key, result: { ok: false, error: { name: error.name, message: error.message } } }),
          ));
          return { value: () => value };
        },
        next: async () => {
          if (!pending.size) return null;
          const result = await Promise.race(pending.values());
          pending.delete(result.key);
          return result;
        },
      });
    },
    parallel: async (jobs: Record<string, () => unknown> | Array<() => unknown>) => Array.isArray(jobs) ?
      Promise.all(jobs.map((run) => run())) :
      Object.fromEntries(await Promise.all(Object.entries(jobs).map(async ([key, run]) => [key, await run()]))),
    ask: async (opts: Turn, prompt: string) => answer(opts, prompt),
    session: async (opts: Turn) => ({
      address: { kind: "session", harness: opts.harness, id: opts.harness + "-based" },
      ask: async (prompt: string, next?: { label: string; schema: z.ZodType }) => answer({ ...opts, ...next }, prompt),
      end: async () => undefined,
    }),
    call: async (name: string, args: any, opts?: { label: string }) => {
      operations.push({ name, input: args, label: opts?.label });
      switch (name) {
        case "pstack.roles": return roles;
        case "pstack.author.options": return { harness: "author", cwd: args.place, box: { only: ["project"] } };
        case "git.worktree.create": {
          const id = "space-" + ++allocated;
          const path = join(worktrees, id);
          const baseSha = git(repo, "rev-parse", args.base);
          git(repo, "worktree", "add", "-qb", id, path, baseSha);
          return { id, path, repo, branch: id, base: args.base, baseSha };
        }
        case "git.worktree.remove": return git(repo, "worktree", "remove", join(worktrees, args.id));
        case "git.worktree.get": {
          const path = join(worktrees, args.id);
          return { head: git(path, "rev-parse", "HEAD"), dirty: git(path, "status", "--porcelain") !== "" };
        }
        case "proc.run": {
          const scratch = mkdtempSync(join(root, "scratch-"));
          try {
            const ran = Bun.spawnSync(args.cmd, { cwd: args.cwd, env: { ...process.env, TMPDIR: scratch }, stdout: "pipe", stderr: "pipe" });
            const tail = ran.stdout.toString() + ran.stderr.toString();
            return { exit: ran.exitCode, tail, truncated: false, outputCut: false, output: {
              digest: createHash("sha256").update(tail).digest("hex"), size: Buffer.byteLength(tail), type: "text/plain",
            } };
          } finally {
            rmSync(scratch, { recursive: true, force: true });
          }
        }
        case "history.read": return options.historyUnavailable ?
          { coverage: { status: "unavailable", reason: "No saved tool calls" }, records: [] } : { coverage: { status: "not-scanned" }, records: [
          { kind: "assistant", text: "I opened missing.md" },
          { kind: "tool-call", category: "read", callId: "a", paths: ["guide.md"] },
          { kind: "tool-result", callId: "a", ok: true },
          { kind: "tool-call", category: "read", callId: "b", paths: ["missing.md"] },
          { kind: "tool-result", callId: "b", ok: false },
        ] };
        case "forge.pr.ensure": {
          const head = published.get(args.branch) ?? git(repo, "rev-parse", args.branch);
          const number = prs.size + 1;
          prs.set(number, head);
          return { pr: { number }, head };
        }
        case "forge.pr.read": return { head: prs.get(args.number), state: "open" };
        case "forge.pipeline.read": return { items: [...prs].map(([pr, sourceSha]) => ({
          pr, sourceSha, pipeline: pr, kind: "head", state: "success",
        })).filter((one) => one.sourceSha === args.sha) };
        case "pstack.pr.bind":
        case "evidence.attest": return {};
        case "evidence.covers": return { covered: true, by: ["receipt"] };
        case "evidence.list": return { items: [{ id: "receipt", author: { kind: "session", harness: "verifier", id: "verifier-based" } }] };
        default: throw Error("Unexpected action " + name);
      }
    },
  };
  for (const [key, value] of Object.entries(api)) {
    if (!saved.has(key)) saved.set(key, globals[key]);
    globals[key] = value;
  }
  return { repo, input, turns, operations };
}

async function run(registered: unknown, args: unknown) {
  const script = registered as { definition: { input: z.ZodType; output: z.ZodType }; run: (input: unknown) => Promise<unknown> };
  return script.definition.output.parse(await script.run(script.definition.input.parse(args))) as any;
}

const repro = 'if grep -qx broken reader; then echo "bad reader"; exit 1; fi; cat reader';
const bugFrame = {
  kind: "confirmed", repro: "Read the fixture", cause: "Wrong literal", evidence: "The same read returns broken",
  history: "Initial literal", surface: "CLI", driver: "sh", crossesBoundary: false,
  replay: { command: repro, failingSignal: "bad reader" },
  regression: { kind: "test", command: "sh regression.sh", failingSignal: "bad reader", paths: ["regression.sh"] },
};

test("Bug fix publishes only after the original replay and the exact same test go red to green", async () => {
  const f = fixture({
    frame: { ...bugFrame, hypotheses: [
      { id: "literal", claim: "Wrong literal" }, { id: "permissions", claim: "Reader permission denied" },
    ] },
    "diagnose-1": { kind: "probe", command: "cat reader", outcomes: [
      { exit: 0, signal: "broken", rulesOut: ["permissions"] },
      { exit: 1, signal: "Permission denied", rulesOut: ["literal"] },
    ] },
    red: ({ cwd }) => ({ summary: commit(cwd, "regression.sh", 'echo wrong-failure; exit 1\n') }),
    "red-decision": { kind: "revise", instruction: "Assert what the reader actually returns" },
    "red-2": ({ cwd }) => {
      writeFileSync(join(cwd, "regression.sh"), repro + "\n");
      git(cwd, "add", "--", "regression.sh");
      git(cwd, "commit", "--amend", "--no-edit", "-q");
      return { summary: "Reproduce the original reader failure" };
    },
    fix: ({ cwd }) => ({ summary: commit(cwd, "reader", "healthy\n") }),
  });
  const base = commit(f.repo, "reader", "broken\n");
  const workflow = (await import("../src/workflows/bug-fix.ts")).default;
  const result = await run(workflow, f.input);
  expect(result).toMatchObject({ status: "verified", proof: {
    baseHead: base, surface: "CLI", before: { exit: 1, tail: "bad reader\n" }, red: { exit: 1, tail: "bad reader\n" },
    after: { exit: 0, tail: "healthy\n" }, green: { exit: 0, tail: "healthy\n" },
    rejectedRed: [{ exit: 1, tail: "wrong-failure\n" }],
  } });
  expect(git(result.worktree, "rev-parse", "HEAD^")).toBe(result.proof.redHead);
  expect(git(result.worktree, "rev-parse", "HEAD^^")).toBe(base);
  expect(f.turns.map(({ label }) => label).slice(0, 7))
    .toEqual(["frame", "diagnose-1", "red", "red-decision", "red-2", "fix", "bug-publish"]);

  const invalid = fixture({ frame: bugFrame, red: ({ cwd }) => ({ summary: commit(cwd, "reader", "healthy\n") }) });
  commit(invalid.repo, "reader", "broken\n");
  expect(await run(workflow, invalid.input)).toMatchObject({ status: "blocked" });
  expect(invalid.turns.map(({ label }) => label)).toEqual(["frame", "red"]);
  expect(invalid.operations.some(({ name }) => name === "forge.pr.ensure")).toBe(false);
});

test("Bug fix sends contested architecture to independent comparison and honors the lead's block", async () => {
  const design = (shape: string) => ({ shape, tradeoffs: "One state owner", checks: ["Read the same fixture"] });
  const picks = ["shape-1", "shape-2", "shape-3"];
  const assessment = { pick: "shape-2", why: "Closest to the current ownership",
    scores: Object.fromEntries(picks.map((name) => [name, Array.from({ length: 3 }, () => ({ score: 3, evidence: "Caller analysis" }))])),
  };
  const f = fixture({
    frame: { ...bugFrame, crossesBoundary: true, contested: true, challenge: true },
    "adversary-1": { findings: [{
      candidate: "mechanism", title: "The empty caller also receives the literal", cause: "Literal exposed",
      cmd: ["cat", "reader"], expected: { exit: 0, output: "healthy\n" }, observed: { exit: 0, output: "broken\n" },
    }] },
    "adversary-2": { findings: [] },
    "adversary-3": { findings: [] },
    "challenge-decision": { kind: "retain", evidence: "The alternate caller sees the same literal" },
    "architecture-rubric": ["One owner", "Preserve caller scope", "Replay remains unchanged"],
    "shape-1": design("Place ownership in the reader"),
    "shape-2": design("Keep ownership in the adapter"),
    "shape-3": design("Keep ownership in the caller"),
    "architecture-judge-1": assessment,
    "architecture-synthesize": { assessment, advice: design("Keep ownership in the adapter") },
    architect: { shape: "Prefer the narrower adapter change" },
    "approve-shape": { kind: "blocked", why: "Adapter change leaves another caller unverified" },
  });
  commit(f.repo, "reader", "broken\n");
  const workflow = (await import("../src/workflows/bug-fix.ts")).default;
  expect(await run(workflow, f.input)).toMatchObject({ status: "blocked", why: "Adapter change leaves another caller unverified",
    challenge: { confirmed: [{ proofs: [{ by: [1] }] }] } });
  expect(f.turns.filter(({ label }) => picks.includes(label)).map(({ harness }) => harness).sort())
    .toEqual(["author", "reviewer", "verifier"]);
  expect(f.turns.find(({ label }) => label === "architecture-judge-1")?.harness).toBe("judge");
  expect(f.turns.some(({ label }) => label === "red" || label === "fix")).toBe(false);
});

const trace = (symbol: string, ns = 20) => JSON.stringify({
  nodes: [{ id: 1, callFrame: { functionName: symbol, url: "reader.js", lineNumber: 0 } }], samples: [1], timeDeltas: [ns],
});
const location = { symbol: "read", file: "reader.js", line: 1 };
const finding = { cause: "Reader loops", hypotheses: [{ claim: "Reader loops", status: "confirmed", evidence: "Stack holds read" }], source: location, route: "perf-issue" };

test("Trace resolves a paired frame even when it disappeared, and leaves a single capture open", async () => {
  const f = fixture({ investigate: { ...finding, observed: "Reader disappears after disabling the redundant path" } });
  writeFileSync(join(f.repo, "before.json.gz"), gzipSync(trace("read")));
  writeFileSync(join(f.repo, "after.json"), trace("idle"));
  const workflow = (await import("../src/workflows/trace-forensics.ts")).default;
  const args = { ...f.input, trace: "before.json.gz" };
  expect(await run(workflow, args)).toMatchObject({ status: "open", handoff: null });
  const paired = { path: "after.json", surface: "local script", driver: "inspector", condition: "omit repeated read" };
  expect(await run(workflow, { ...args, paired })).toMatchObject({
    status: "found", handoff: { playbook: "perf-issue" }, evidence: { pairConfirmed: true, source: location, query: { reduced: { focus: 0 } } },
  });
  writeFileSync(join(f.repo, "after.json"), trace("read", 5));
  expect(await run(workflow, { ...args, paired })).toMatchObject({ status: "open", evidence: { pairConfirmed: false } });
});

test("Runtime forensics requires a fresh capture, two mechanism observations and teardown", async () => {
  const plan = {
    kind: "capture", target: "reader", surface: "CLI", driver: "local process",
    signal: `mkdir -p .proof; printf '%s' '${trace("read")}' > .proof/run.json`, path: ".proof/run.json",
    setup: "touch .proof/active", observe: "test -f .proof/active && echo observed",
    control: "echo blocked", cleanup: "rm .proof/active", expected: "observed", controlExpected: "blocked",
  };
  const f = fixture({ "capture-plan": plan, investigate: finding });
  commit(f.repo, "reader.js", "function read() {}\n");
  const workflow = (await import("../src/workflows/runtime-forensics.ts")).default;
  const found = await run(workflow, f.input);
  expect(found).toMatchObject({ status: "found", handoff: { playbook: "perf-issue" }, evidence: { trace: { reduced: { count: 1 } } } });
  expect(found.evidence.probe.tail).toContain("CLEANUP=0");
  expect(await Bun.file(join(found.evidence.worktree, ".proof/active")).exists()).toBe(false);
  const invalid = fixture({ "capture-plan": { ...plan, observe: "echo absent" } });
  expect(await run(workflow, invalid.input)).toMatchObject({ status: "open", handoff: null });
  expect(invalid.turns).toHaveLength(1);
});

test("Runtime reduces a CPU profile captured by the matching local Node CLI", async () => {
  const f = fixture({
    "capture-plan": {
      kind: "capture", target: "Node reader", surface: "CLI", driver: "Node inspector",
      signal: "mkdir -p .proof; node reader.cjs profile .proof/runtime.json", path: ".proof/runtime.json",
      setup: 'node reader.cjs watch > .proof/live.log 2>&1 & echo "$!" > .proof/pid',
      observe: "for i in 1 2 3 4 5; do grep -q active .proof/live.log && { echo active; exit 0; }; sleep 0.1; done; exit 1",
      control: 'touch .proof/control; for i in 1 2 3 4 5; do grep -q quiet .proof/live.log && { echo quiet; exit 0; }; sleep 0.1; done; exit 1',
      cleanup: 'kill "$(cat .proof/pid)"; rm .proof/pid .proof/control',
      expected: "active", controlExpected: "quiet",
    },
    investigate: { ...finding, source: { ...location, file: "reader.cjs" } },
  });
  commit(f.repo, "reader.cjs", [
    "function read() { const until = Date.now() + 30; while (Date.now() < until) {} }",
    "const fs = require('node:fs');",
    "if (process.argv[2] === 'watch') {",
    "  setInterval(() => { if (fs.existsSync('.proof/control')) console.log('quiet'); else { read(); console.log('active'); } }, 20);",
    "} else {",
    "  const session = new (require('node:inspector').Session)(); session.connect();",
    "  session.post('Profiler.enable', () => session.post('Profiler.start', () => {",
    "    read(); session.post('Profiler.stop', (error, result) => {",
    "      if (error) throw error; fs.writeFileSync(process.argv[3], JSON.stringify(result.profile)); session.disconnect();",
    "    });",
    "  }));",
    "}",
  ].join("\n") + "\n");
  const workflow = (await import("../src/workflows/runtime-forensics.ts")).default;
  const result = await run(workflow, f.input);
  expect(result).toMatchObject({ status: "found", evidence: { trace: { reduced: { format: "cpuprofile" } } } });
  expect(result.evidence.trace.reduced.count).toBeGreaterThan(0);
  expect(await Bun.file(join(result.evidence.worktree, ".proof/pid")).exists()).toBe(false);
}, 15_000);

test("Eval pins variants, blinds a common judge and reads only the two candidate transcripts", async () => {
  const organic = "Describe the reader and improve its guide.";
  const rubric = ["precision", "clarity", "completeness"].map((id) => ({ id, text: "Show " + id }));
  const workAnswer = ({ cwd, harness }: Turn, prompt: string) => {
    expect(prompt).toBe(organic);
    const content = readFileSync(join(cwd, "guide.md"), "utf8").trim();
    writeFileSync(join(cwd, "notes.md"), `New notes from ${content}\n`);
    return { answer: `From ${harness}: Guide for ${content}` };
  };
  const f = fixture({
    frame: { success: "Readable guide", rubric, cases: [{ id: "guide", prompt: organic, opened: ["guide.md", "missing.md"] }] },
    "work-A": workAnswer,
    "work-B": workAnswer,
    "blind-grade": ({ harness }, prompt) => {
      expect(harness).toBe("judge");
      expect(prompt).not.toContain("alpha-runner");
      expect(prompt).not.toContain("updated-seat");
      const rows = JSON.parse(prompt.split("\n\n").at(-1)!) as Array<{ label: string; output: string; changes: string; chain: unknown }>;
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row.changes).toContain("+New notes from");
        expect(row.chain).toEqual({ opened: ["guide.md"], missing: ["missing.md"] });
      }
      return { grades: rows.map((row) => ({
        label: row.label, scores: Object.fromEntries(rubric.map(({ id }) => [id, row.output.endsWith("current") ? 1 : 0.5])), rationale: "Guide quality",
      })) };
    },
    synthesis: { recommendation: "updated-seat", rationale: "Read both guides and agreed with the independent scores" },
  });
  const old = commit(f.repo, "guide.md", "previous\n");
  const current = commit(f.repo, "guide.md", "current\n");
  const workflow = (await import("../src/workflows/eval.ts")).default;
  const result = await run(workflow, { ...f.input, variants: {
    baseline: { harness: "alpha-runner", vendor: "alpha", ref: old },
    "updated-seat": { harness: "beta-runner", vendor: "beta", ref: current },
  } });
  expect(result).toMatchObject({ recommend: "updated-seat", decision: "recommend", table: { baseline: { guide: 0.5 }, "updated-seat": { guide: 1 } } });
  const work = f.turns.filter(({ label }) => label?.startsWith("work-"));
  expect(new Set(work.map(({ cwd }) => cwd)).size).toBe(2);
  expect(new Set(work.map(({ label }) => label)).size).toBe(2);
  expect(f.operations.filter(({ name }) => name === "history.read").map(({ input }) => input.session.native).sort())
    .toEqual(["alpha-runner-based", "beta-runner-based"]);

  const incomplete = fixture({
    frame: { success: "Readable guide", rubric, cases: [{ id: "guide", prompt: organic }] },
    "work-A": { answer: "Guide" },
    "work-B": { answer: "Guide" },
  }, { historyUnavailable: true });
  expect(await run(workflow, { ...incomplete.input, variants: { baseline: "alpha-runner", current: "beta-runner" } }))
    .toMatchObject({ decision: "incomplete", recommend: null, grades: [] });
  expect(incomplete.turns.map(({ label }) => label)).not.toContain("blind-grade");
});

const metric = 'printf \'{"metric":%s,"errors":0,"work":100,"surface":"CLI","driver":"reader"}\\n\' "$(cat metric)"';
const workload = {
  surface: "CLI", driver: "reader", unit: "steps", workload: "100 records", limiter: "One loop per record",
  comparability: "Same records and driver", easier: metric.replace('"$(cat metric)"', "2"),
  profile: `mkdir -p .proof; printf '%s' '${trace("read")}' > .proof/profile.json`,
  profilePath: ".proof/profile.json", gate: "test ! -e broken", harnessPaths: ["bench.sh"], samples: 5,
};

test("Hillclimb isolates competing commits, rejects a faster broken build and keeps a neutral simplification", async () => {
  const f = fixture({
    "hypotheses-1": { kind: "attempts", hypotheses: [
      { hypothesis: "Reuse the already decoded value", simplification: false },
      { hypothesis: "Skip the validity check", simplification: false },
    ] },
    "climb-1": ({ cwd }) => ({ summary: commit(cwd, "metric", "6\n") }),
    "climb-2": ({ cwd }) => {
      writeFileSync(join(cwd, "metric"), "3\n");
      writeFileSync(join(cwd, "broken"), "invalid\n");
      git(cwd, "add", "--", "metric", "broken");
      git(cwd, "commit", "-qm", "Skip check");
      return { summary: "Faster but changes behavior" };
    },
    "hypotheses-3": { kind: "attempts", hypotheses: [{ hypothesis: "Remove the unnecessary wrapper", simplification: true }] },
    "climb-3": ({ cwd }) => ({ summary: commit(cwd, "wrapper", "direct\n") }),
  });
  const initial = commit(f.repo, "metric", "10\n");
  const workflow = (await import("../src/workflows/hillclimb.ts")).default;
  const result = await run(workflow, { ...f.input, metric, workload, direction: "lower", target: 6, min: 3, max: 5,
    wake: { heartbeatMs: 10_000, pr: 19 } });
  expect(result).toMatchObject({ status: "reached", baseline: 10, final: 6, rows: [
    { verdict: "kept", after: 6 }, { verdict: "reverted", after: 3 }, { verdict: "kept", after: 6 },
  ], proof: { delivery: { verified: true }, percentDelta: -40 } });
  expect(new Set(result.rows.map((row: { worktree: string }) => row.worktree)).size).toBe(3);
  expect(git(result.rows[1].worktree, "rev-parse", "HEAD^")).toBe(initial);
  expect(git(result.worktree, "rev-parse", "HEAD^")).toBe(result.rows[0].change);
  const ledger = readFileSync(result.proof.ledgerPath, "utf8");
  expect(ledger.trim().split("\n")).toHaveLength(4);
  const earlier = f.operations.find(({ label }) => label === "decision-0")!;
  const replay = globals.call as (name: string, input: unknown) => Promise<{ exit: number; tail: string }>;
  expect(await replay(earlier.name, earlier.input)).toMatchObject({ exit: 0, tail: ledger.split("\n")[0] + "\n" });
  expect(readFileSync(result.proof.ledgerPath, "utf8")).toBe(ledger);
  expect(f.operations.filter(({ name }) => name === "forge.checks")).toEqual([{
    name: "forge.checks", input: {
      filter: { "pr.repo.host": f.input.repo.host, "pr.repo.path": f.input.repo.path, "pr.number": 19 },
      from: 8, timeout: 10_000, label: "climb-wake-3",
    },
  }]);
});

test("Performance tries the cheaper mantra first and publishes only the comparable calibrated fix", async () => {
  const f = fixture({
    frame: { measure: "sh bench.sh", direction: "lower", target: 6, crossesBoundary: false, workload },
    "performance-plan": { attempts: [
      { mantra: "reuse", hypothesis: "Reuse the reader result", crossesBoundary: false },
      { mantra: "remove", hypothesis: "Remove an operation that appeared unused", crossesBoundary: false },
      { mantra: "cheapen", hypothesis: "Inline the reader", crossesBoundary: false },
    ], skipped: "Other categories lack a relevant mechanism" },
    "perf-remove": ({ cwd }) => ({ summary: commit(cwd, "metric", "8\n") }),
    "perf-reuse": ({ cwd }) => ({ summary: commit(cwd, "metric", "5\n") }),
  });
  commit(f.repo, "metric", "10\n");
  commit(f.repo, "bench.sh", metric + "\n");
  const workflow = (await import("../src/workflows/perf-issue.ts")).default;
  expect(await run(workflow, f.input)).toMatchObject({ status: "verified", baseline: 10, after: 5, met: true });
  const turns = f.turns.map(({ label }) => label);
  expect(turns.slice(0, 5)).toEqual(["frame", "performance-plan", "perf-remove", "perf-reuse", "perf-reuse-publish"]);
  expect(turns).not.toContain("perf-cheapen");
  expect(f.operations.filter(({ name }) => name === "forge.pr.ensure")).toHaveLength(1);
});

test("Visual verifies a primitive before separate component lanes and requires exact zero on both states", async () => {
  const states = (id: string) => ["normal", "focus"].map((name) => ({ name, reference: ".proof/ref.png", actual: `.proof/${id}-${name}.png` }));
  const component = (id: string) => ({ id, paths: [id], states: states(id) });
  const frame = {
    kind: "ready", reference: "white", surface: "PNG fixture", baseline: "draw.sh", differences: [],
    protectedPaths: ["draw.sh"], command: "sh draw.sh", shared: component("tone"), components: [component("header"), component("footer")], rounds: 1,
  };
  const f = fixture({
    frame,
    "pixels-1": ({ cwd }, prompt) => {
      const [, id] = /Component (\w+), scope/.exec(prompt)!;
      return { summary: commit(cwd, id!, id === "header" ? "gray\n" : "white\n") };
    },
    "header-1-retry": { kind: "continue", next: "The gray state still differs. Compare against the white background." },
    "pixels-2": ({ cwd }) => ({ summary: commit(cwd, "header", "white\n") }),
  });
  for (const id of ["tone", "header", "footer"]) commit(f.repo, id, "black\n");
  commit(f.repo, "draw.sh", [
    "set -e", "mkdir -p .proof", "magick -size 1x1 xc:white .proof/ref.png",
    'for part in tone header footer; do for s in normal focus; do magick -size 1x1 "xc:$(cat "$part")" ".proof/$part-$s.png"; done; done',
  ].join("\n") + "\n");
  const workflow = (await import("../src/workflows/visual-parity.ts")).default;
  const result = await run(workflow, f.input);
  expect(result).toMatchObject({ status: "verified", components: [
    { id: "tone", status: "verified" }, { id: "header", status: "verified" }, { id: "footer", status: "verified" },
  ] });
  expect(result.components[1].runs.map((one: { states: { count: number }[] }) => one.states.map(({ count }) => count)))
    .toEqual([[1, 1], [1, 1], [1, 1], [0, 0]]);
  const prs = f.operations.filter(({ name }) => name === "forge.pr.ensure");
  expect(prs[0]?.input.base).toBe("main");
  expect(prs.slice(1).map(({ input }) => input.base)).toEqual([prs[0]?.input.branch, prs[0]?.input.branch]);
});
