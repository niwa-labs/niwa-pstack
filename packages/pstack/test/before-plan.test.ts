import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { coveringRule, fillRule, grant, isRuleTemplate, principalOf } from "@niwa-labs/core";
import type { Action, ActionContext } from "@niwa-labs/core";
import { declarationField, literalOf } from "@niwa-labs/script";
import { connect, createNiwa, eventually, plugin, tempDir } from "@niwa-labs/testing";
import ts from "typescript";
import { z } from "zod";

import { codeResearch, pstackPlugin, scriptOf } from "../src/index.ts";
import { researchSettings } from "../src/extensions.ts";
import { registerResearch } from "../src/research-actions.ts";
import { ROLES, builtins, defaultAnswers, pstackHost, recordsOf, registeredAll } from "./support.ts";
import type { PstackHost } from "./support.ts";

const research = codeResearch({ harness: "ncode-flash", model: "configured-model", effort: "low" });
const task = "Explain how to add a billing section";
const first = "feature:before-plan-research-code-research";
const second = "feature:before-plan-research-audit";

function uses(name: string): string[] {
  const file = scriptOf(name);
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest);
  const field = declarationField(ts, source, "uses");
  const literals = field && "value" in field ? literalOf(ts, field.value)?.value : undefined;
  expect(Array.isArray(literals) && literals.every((item) => typeof item === "string")).toBe(true);
  return literals as string[];
}

test("codeResearch builds a stage descriptor and duplicate extension names are refused", () => {
  expect(research).toEqual({
    name: "code-research",
    feature: { beforePlan: { kind: "codeResearch", harness: "ncode-flash", model: "configured-model", effort: "low" } },
  });
  expect(() => pstackPlugin({ roles: ROLES, extensions: [research, research] })).toThrow('duplicate extension name "code-research"');
});

test("Niwa can read the same extra scoped grants on Feature and both callers", () => {
  for (const name of ["feature", "entry", "suite"]) {
    const base = uses(name);
    expect(base.some((rule) => rule.startsWith("pstack.feature.research.") || rule.startsWith("box.read@"))).toBe(false);
    expect(uses(`${name}-with-research`)).toEqual([
      ...base,
      "pstack.feature.research.settings",
      "pstack.feature.research.report@{repo.local}",
      "box.read@{repo.local}",
    ]);
  }
});

test("Feature reads back a durable report before framing, and an invalid answer blocks framing", async () => {
  const home = await tempDir("feature-report");
  const host = createNiwa({ home });
  const actions = new Map<string, Action<unknown, unknown>>();
  let readable = true;
  host.use(plugin("test-artifacts", (api) => {
    registerResearch({
      artifacts: {
        ...api.artifacts,
        read(ref) {
          if (!readable) throw new Error("research artifact is unavailable");
          return api.artifacts.read(ref);
        },
      },
      action: (action) => actions.set(action.name, action),
    }, researchSettings([research]));
  }));
  const repo = { host: "gitlab.example.com", path: "acme/billing", local: "/work/billing" };
  const report = "# Findings\nREADME.md:1 describes billing.";
  const trace: string[] = [];
  const stop = new Error("planner reached");
  let markdown = report;
  const globals = globalThis as Record<string, unknown>;
  const runtime = {
    z,
    workflow: (_declaration: unknown, run: unknown) => run,
    phase: (name: string) => trace.push(name),
    session: () => { throw new Error("unexpected session"); },
    call: async (name: string, input: unknown, { label }: { label: string }) => {
      trace.push(label);
      if (name === "pstack.roles") return ROLES;
      const action = actions.get(name)!;
      const value = action.input.parse(input);
      if (name === "pstack.feature.research.report") {
        const target = action.target?.(value);
        expect(target).toBe(repo.local);
        expect(coveringRule(grant([`${name}@${repo.local}`]), `${name}@${target}`)).toBeDefined();
        expect(coveringRule(grant([`${name}@/work/unrelated`]), `${name}@${target}`)).toBeUndefined();
      }
      return action.output.parse(await action.run(value, {} as ActionContext));
    },
    ask: async (options: { label: string; schema: z.ZodType }, prompt: string) => {
      trace.push(options.label);
      if (options.label === "frame") {
        const digest = /Niwa artifact sha256:([0-9a-f]{64})/.exec(prompt)?.[1] ?? "";
        expect(readFileSync(join(home, "artifacts", digest), "utf8")).toBe(report);
        expect(prompt).toContain(JSON.stringify(report));
        expect(prompt).toContain(`Task: ${task}`);
        throw stop;
      }
      expect(options).toMatchObject({ harness: "ncode-flash", mode: "ask", box: { only: [{ read: repo.local }] } });
      return options.schema.parse({ markdown });
    },
  };
  const original = Object.fromEntries(Object.keys(runtime).map((name) => [name, Object.getOwnPropertyDescriptor(globals, name)]));
  Object.assign(globals, runtime);
  try {
    const feature = (await import("../src/workflows/feature-with-research.ts")).default as unknown as
      (args: { task: string; repo: typeof repo; worktrees: string; base: string }) => Promise<unknown>;
    const args = { task, repo, worktrees: "/trees", base: "main" };
    await expect(feature(args)).rejects.toBe(stop);
    expect(trace).toEqual(["Research", "before-plan-settings", "before-plan-research-code-research", "before-plan-report-code-research", "roles", "Frame", "frame"]);
    trace.length = 0;
    markdown = " ";
    await expect(feature(args)).rejects.toThrow(/markdown/);
    expect(trace).toEqual(["Research", "before-plan-settings", "before-plan-research-code-research"]);
    trace.length = 0;
    readable = false;
    markdown = report;
    await expect(feature(args)).rejects.toThrow("research artifact is unavailable");
    expect(trace).toEqual(["Research", "before-plan-settings", "before-plan-research-code-research", "before-plan-report-code-research"]);
  } finally {
    for (const [name, descriptor] of Object.entries(original)) {
      if (descriptor === undefined) delete globals[name];
      else Object.defineProperty(globals, name, descriptor);
    }
    await host.close();
  }
});

async function start(made: PstackHost, name: string, args: object) {
  const listed = await builtins(made.host);
  return await made.asOwner("workflow.start", {
    id: listed[name]!.id, args: { ...made.fixture, ...args }, wait: true, timeoutMs: 30_000,
  }) as { run: string; state: string; reason?: string; outcome?: { status: string; result?: unknown } };
}

test("routed and direct Feature preserve the original path without extensions", async () => {
  const made = await pstackHost({ onlyBuiltins: ["entry", "feature"], benny: false });
  try {
    await registeredAll(made.host, 2);
    made.harnesses.answers = {
      ...defaultAnswers(made),
      "entry:route": () => ({ kind: "run", playbook: "feature", task, more: {} }),
    };
    expect((await start(made, "entry", { request: task })).outcome).toMatchObject({
      status: "done", result: { status: "ran", playbook: "feature", result: { status: "verified" } },
    });
    expect((await start(made, "feature", { task })).outcome).toMatchObject({ status: "done", result: { status: "verified" } });
    expect(made.harnesses.of("feature:frame")).toHaveLength(2);
    expect(made.harnesses.calls.some(({ step, prompt }) => step.includes("before-plan") || prompt.includes("Niwa artifact"))).toBe(false);
    expect(await recordsOf(made.host, "niwa.step.outcome")).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ data: expect.objectContaining({ key: expect.stringContaining("before-plan") }) }),
    ]));
  } finally {
    await made.close();
  }
}, 50_000);

test("Feature runs ordered research after routing and hands verified on-disk reports to its planner", async () => {
  const audit = codeResearch({ name: "audit", harness: "verifier" });
  const made = await pstackHost({ onlyBuiltins: ["entry", "feature", "investigation"], benny: false, extensions: [research, audit] });
  try {
    await registeredAll(made.host, 3);
    const normal = defaultAnswers(made);
    const findings = () => `# Research\nREADME.md:1 — ${readFileSync(join(made.repo, "README.md"), "utf8").trim()}`;
    const refs: string[] = [];
    made.harnesses.answers = {
      ...normal,
      "entry:route": () => ({ kind: "run", playbook: "feature", task, more: {} }),
      [first]: (call) => {
        expect(call).toMatchObject({
          harness: "ncode-flash", cwd: made.repo, mode: "ask", model: "configured-model", effort: "low",
          box: { only: [{ read: made.repo }] },
        });
        expect(call.visible ?? []).toEqual([]);
        expect(call.prompt).toContain(`Task: ${task}`);
        return { markdown: findings() };
      },
      [second]: (call) => {
        expect(call.harness).toBe("verifier");
        return { markdown: "# Audit\nREADME.md:1 identifies the service." };
      },
      "feature:frame": (call) => {
        const expected = [findings(), "# Audit\nREADME.md:1 identifies the service."];
        const digests = [...call.prompt.matchAll(/Niwa artifact sha256:([0-9a-f]{64})/g)].map((match) => match[1]!);
        expect(call.prompt).toContain(`Task: ${task}`);
        expect(digests.map((digest) => readFileSync(join(made.home, "artifacts", digest), "utf8"))).toEqual(expected);
        for (const report of expected) expect(call.prompt).toContain(JSON.stringify(report));
        refs.push(...digests);
        return normal["feature:frame"]!(call);
      },
    };
    expect((await start(made, "entry", { request: task })).outcome).toMatchObject({
      status: "done", result: { status: "ran", playbook: "feature", result: { status: "verified" } },
    });
    expect(made.harnesses.calls.slice(0, 4).map((call) => call.step)).toEqual(["entry:route", first, second, "feature:frame"]);
    const direct = await start(made, "feature", { task });
    expect(direct.outcome).toMatchObject({ status: "done", result: { status: "verified" } });
    expect(refs.slice(2)).toEqual(refs.slice(0, 2));

    await made.asOwner("workflow.resume", { run: direct.run });
    const results = async () => (await recordsOf(made.host, "workflow.run.finished"))
      .map(({ data }) => data as { run: string; outcome: unknown }).filter(({ run }) => run === direct.run);
    await eventually(async () => (await results()).length === 2, 10_000, "Feature did not replay to completion");
    expect((await results()).map(({ outcome }) => outcome)).toEqual([direct.outcome, direct.outcome]);
    expect(made.harnesses.of(first)).toHaveLength(2);
    expect(made.harnesses.of(second)).toHaveLength(2);
    expect(made.harnesses.of("feature:frame")).toHaveLength(2);
    const reused = (await recordsOf(made.host, "workflow.step.reused"))
      .map(({ data }) => data as { run: string; key: string }).filter(({ run }) => run === direct.run);
    expect(reused.map(({ key }) => key)).toEqual(expect.arrayContaining([
      "label:before-plan-settings", "label:before-plan-research-code-research", "label:before-plan-report-code-research",
      "label:before-plan-research-audit", "label:before-plan-report-audit",
    ]));

    made.harnesses.answers["entry:route"] = normal["entry:route"]!;
    expect((await start(made, "entry", { request: "Where is the service described?" })).outcome)
      .toMatchObject({ status: "done", result: { playbook: "investigation" } });
    expect(made.harnesses.of(first)).toHaveLength(2);
  } finally {
    await made.close();
  }
}, 60_000);

test("research fails before planning on an invalid report, and grants stay scoped to the target repo", async () => {
  const made = await pstackHost({ onlyBuiltins: ["feature"], benny: false, extensions: [research] });
  try {
    await registeredAll(made.host, 1);
    const normal = defaultAnswers(made);
    made.harnesses.answers = { ...normal, [first]: () => ({ markdown: " " }) };
    const listed = await builtins(made.host);
    const report = "pstack.feature.research.report";
    const args = { ...made.fixture, task };
    const base = uses("feature").map((rule) => isRuleTemplate(rule) ? fillRule(rule, args) : rule);
    const scopedCaller = (id: string, read: string) => {
      const token = made.host.issueToken(principalOf("session", id), {
        grant: grant(["workflow.start", ...base, "pstack.feature.research.settings", `${report}@${made.repo}`, `box.read@${read}`]),
      });
      return connect({ home: made.home, id: `session:${id}`, token });
    };
    const input = { id: listed["feature"]!.id, args, wait: true, timeoutMs: 30_000 };
    const limited = await scopedCaller("other-repo-research", made.worktrees);
    try {
      await expect(limited.call(report as never, { repo: made.worktrees, markdown: "foreign" } as never))
        .rejects.toMatchObject({
          code: "Denied",
          denied: { grant: expect.any(String), missing: `call:${report}@${made.worktrees}` },
        });
      await expect(limited.call(report as never, { repo: made.repo, markdown: "in scope" } as never))
        .resolves.toMatchObject({ markdown: "in scope" });
      await expect(limited.call("workflow.start" as never, input as never)).rejects.toMatchObject({
        code: "UsesRefused",
        message: `a script cannot have more than whoever starts it: box.read@${made.repo} is not held`,
      });
    } finally {
      await limited.close();
    }
    expect(made.harnesses.calls).toHaveLength(0);

    const allowed = await scopedCaller("target-repo-research", made.repo);
    try {
      const started = await allowed.call("workflow.start" as never, input as never) as { run: string };
      expect(started).toMatchObject({ state: "paused", reason: expect.stringContaining("markdown") });
      expect((await recordsOf(made.host, "workflow.run.paused")).map(({ data }) => data))
        .toContainEqual(expect.objectContaining({ run: started.run, reason: expect.stringContaining("markdown") }));
      expect(made.harnesses.calls.map((call) => call.step)).toEqual([first]);

      made.harnesses.answers[first] = () => ({ markdown: "# Research\nREADME.md:1 describes the service." });
      await expect(allowed.call("workflow.start" as never, input as never)).resolves.toMatchObject({
        state: "finished", outcome: { status: "done", result: { status: "verified" } },
      });
      expect(made.harnesses.of(first)).toHaveLength(2);
      expect(made.harnesses.of("feature:frame")).toHaveLength(1);
    } finally {
      await allowed.close();
    }
  } finally {
    await made.close();
  }
}, 90_000);
