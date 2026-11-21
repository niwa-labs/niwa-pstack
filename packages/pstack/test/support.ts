// What the pstack tests share: a host laid out as an installation (the packages pstack runs with in a
// `node_modules` above the home, where a stored script finds them), a real git repository, a fake GitLab
// server behind the forge module, a `proc.run` that runs where it is asked, and fake harnesses that answer each
// step of a playbook as the test says.

import { chmodSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import { action, actionRef, grant, principalOf } from "@niwa-labs/core";
import { evidence } from "@niwa-labs/evidence";
import { forge, secret } from "@niwa-labs/forge";
import { plan } from "@niwa-labs/plan";
import { AGENT } from "@niwa-labs/plugin";
import type { AgentOffer, CallerBinding, Plugin } from "@niwa-labs/plugin";
import { connect, connectAsOwner, createNiwa, eventually, git, plugin, requests, stubAction, tempDir, timers, workflow } from "@niwa-labs/testing";
import type { Host } from "@niwa-labs/testing";

import { FakeGitLab, sha } from "../node_modules/@niwa-labs/forge/test/fake-gitlab.ts";
import type { FakeProject } from "../node_modules/@niwa-labs/forge/test/fake-gitlab.ts";
import { addressingOf } from "../src/binding.ts";
import type { Binding } from "../src/binding.ts";
import { pstackPlugin } from "../src/plugin.ts";
import type { RolesInput } from "../src/roles.ts";

process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_AUTHOR_NAME = "pstack test";
process.env.GIT_AUTHOR_EMAIL = "test@pstack.invalid";
process.env.GIT_COMMITTER_NAME = "pstack test";
process.env.GIT_COMMITTER_EMAIL = "test@pstack.invalid";

export const FORGE_HOST = "gitlab.example.com";
export const PROJECT = "acme/billing";

/** The roles of the tests: one fake harness each. */
export const ROLES: RolesInput = {
  lead: { harness: "lead" },
  author: { harness: "author", box: true },
  reviewer: { harness: "reviewer" },
  verifier: { harness: "verifier", vendor: "other" },
  judge: { harness: "judge", vendor: "third" },
};

/** Run git in a directory; its output, trimmed. */
export function gitIn(dir: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

/** Write a file in a checkout and commit it: the new commit. */
export function commitFile(dir: string, file: string, text: string): string {
  writeFileSync(join(dir, file), text);
  gitIn(dir, "add", file);
  gitIn(dir, "commit", "-q", "-m", `change ${file}`);
  return gitIn(dir, "rev-parse", "HEAD");
}

/** What a fake harness is asked: by which harness, in which step, where, and what the session may call. */
export interface HarnessCall {
  harness: string;
  /** The step of the prompt's tag, `<playbook>:<step>`; empty without a tag. */
  step: string;
  prompt: string;
  cwd?: string;
  visible?: string[];
  /** The session's reference, for a session started with `session.start`. */
  ref?: string;
}

/** How the fakes answer a step: a value, or a function of the call. */
export type Answers = Record<string, (call: HarnessCall) => unknown>;

/** The step a prompt's tag names. */
const stepOf = (prompt: string): string => /\[pstack:([^\]]+)\]/.exec(prompt)?.[1] ?? "";

/** The harnesses of the tests, behind `agent()` and behind `session.start` and `session.ask`. */
class Harnesses {
  readonly calls: HarnessCall[] = [];
  readonly sessions = new Map<string, { harness: string; cwd?: string; visible?: string[] }>();
  answers: Answers = {};

  answer(call: HarnessCall): unknown | Promise<unknown> {
    this.calls.push(call);
    const reply = this.answers[call.step] ?? (call.step === "" ? undefined : this.answers[`*:${call.step.slice(call.step.indexOf(":") + 1)}`]);
    if (reply === undefined) throw new Error(`no fake answer for the step "${call.step}" (${call.harness})`);
    return reply(call);
  }

  /** The calls of a step. */
  of(step: string): HarnessCall[] {
    return this.calls.filter((one) => one.step === step);
  }
}

export interface PstackHost {
  host: Host;
  home: string;
  repo: string;
  worktrees: string;
  gitlab: FakeGitLab;
  project: FakeProject;
  harnesses: Harnesses;
  /** The agents the plugins offered to the agents module, as a stand-in for it read them. */
  agents: AgentOffer[];
  /** How the pipelines of the next pull requests end; a test may change it as it goes. */
  ci: { head: string; mergeResult: string };
  /** The fixture a run of the suite or the entry is given. */
  fixture: { repo: { host: string; path: string; local: string }; worktrees: string; base: string };
  /** Call an action as the owner, from the owner's own client. */
  asOwner(name: string, input: unknown): Promise<unknown>;
  /** Answer the owner's next open question with these option ids. */
  answer(ids: string[]): Promise<void>;
  /** Attest as the session whose mark is `mark`, as its own client: what a verifier does with `evidence.attest`. */
  attestAs(mark: string, subject: string, claim: Record<string, unknown>): Promise<void>;
  close(): Promise<void>;
}

/** A `proc.run` that runs the command in its cwd, with no box: its target is the cwd, as the real action's is. */
function fakeProc(): Plugin {
  const ref = actionRef("proc.run", {
    description: "Run a command in its cwd.",
    input: z.looseObject({ cmd: z.array(z.string()).min(1), cwd: z.string().min(1) }),
    output: z.any(),
    target: (input) => input.cwd,
  });
  return plugin("fake-proc", (api) =>
    api.action(
      action(ref, {
        recovery: "repeat",
        effect: "write",
        world: "local",
        run: ({ cmd, cwd }) => {
          const ran = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
          const tail = (ran.stdout.toString() + ran.stderr.toString()).slice(-4096);
          return {
            outcome: "exited",
            exit: ran.exitCode,
            durationMs: 1,
            tail,
            truncated: false,
            output: { digest: `sha256:${"0".repeat(64)}`, size: tail.length, type: "text/plain" },
            box: { sandbox: "none", write: [cwd], net: [] },
          };
        },
      }),
    ),
  );
}

/**
 * Sessions started and asked through `session.start` and `session.ask`, answered by the fakes. Like the sessions
 * module, it says which session a token's mark names, so a session that attests is bound to its address; the mark
 * of a fake session is its native id.
 */
function fakeSessions(home: string, harnesses: Harnesses): Binding {
  let made = 0;
  const made_ = plugin("sessions", (api) => {
    api.action(
      stubAction("session.start", {
        home,
        input: z.looseObject({ harness: z.string(), prompt: z.any(), cwd: z.string().optional(), visible: z.any().optional() }),
        output: z.any(),
        recovery: "repeat",
        result: (input) => {
          made += 1;
          const native = `native-${String(made)}`;
          const visible = Array.isArray(input.visible) ? (input.visible as string[]) : (input.visible as { actions?: string[] } | undefined)?.actions;
          harnesses.sessions.set(`${input.harness} ${native}`, { harness: input.harness, ...(input.cwd === undefined ? {} : { cwd: input.cwd }), ...(visible === undefined ? {} : { visible }) });
          return { session: `s-${String(made).padStart(6, "0")}`, ref: `${input.harness} ${native}`, operation: `op-${String(made)}` };
        },
      }),
    );
    api.action(
      stubAction("session.ask", {
        home,
        input: z.looseObject({ session: z.string(), prompt: z.string() }),
        output: z.any(),
        recovery: "repeat",
        result: async (input) => {
          const session = harnesses.sessions.get(input.session);
          if (session === undefined) throw new Error(`no fake session ${input.session}`);
          const value = await harnesses.answer({ harness: session.harness, step: stepOf(input.prompt), prompt: input.prompt, ref: input.session, ...(session.cwd === undefined ? {} : { cwd: session.cwd }), ...(session.visible === undefined ? {} : { visible: session.visible }) });
          return { value };
        },
      }),
    );
  });
  return Object.assign(made_, {
    bind: (fallback?: CallerBinding): CallerBinding => (caller) => {
      const principal = caller.kind === "client" ? caller.principal : undefined;
      const found = principal?.kind === "session" ? [...harnesses.sessions.entries()].find(([ref]) => ref.endsWith(` ${principal.id}`)) : undefined;
      if (found === undefined || principal === undefined) return fallback?.(caller);
      return { kind: "session", harness: found[1].harness, id: principal.id };
    },
  });
}

/** The agent action of each role's harness, answered by the fakes. */
function fakeAgents(home: string, harnesses: Harnesses) {
  const names = ["lead", "author", "reviewer", "verifier", "judge"];
  return Object.fromEntries(
    names.map((harness) => [
      harness,
      stubAction(`session.start.${harness}`, {
        home,
        input: z.looseObject({ prompt: z.string(), cwd: z.string().optional(), visible: z.array(z.string()).optional() }),
        output: z.any(),
        recovery: "repeat",
        result: async (input) =>
          await harnesses.answer({ harness, step: stepOf(input.prompt), prompt: input.prompt, ...(input.cwd === undefined ? {} : { cwd: input.cwd }), ...(input.visible === undefined ? {} : { visible: input.visible }) }),
      }),
    ]),
  );
}

/**
 * The fake server's fetch, with a CI: a pull request opened gets a pipeline of its head and one of its merge result,
 * the merge of its head into the local trunk's tip, ending as `ci` says.
 */
function withCi(gitlab: FakeGitLab, project: FakeProject, repo: string, ci: { head: string; mergeResult: string }): FakeGitLab["fetch"] {
  return async (url, init) => {
    const answered = await gitlab.fetch(url, init);
    if (init.method === "POST" && /\/merge_requests$/.test(new URL(url).pathname) && answered.status === 201) {
      const mr = (await answered.clone().json()) as { iid: number; sha: string };
      const target = gitIn(repo, "rev-parse", "main");
      const merge = sha(`merge-result-${String(mr.iid)}-${mr.sha}`);
      project.commits.set(merge, [target, mr.sha]);
      gitlab.pipeline(project, { sha: mr.sha, ref: `refs/merge-requests/${String(mr.iid)}/head`, status: ci.head, source: "merge_request_event" });
      gitlab.pipeline(project, { sha: merge, ref: `refs/merge-requests/${String(mr.iid)}/merge`, status: ci.mergeResult, source: "merge_request_event" });
    }
    return answered;
  };
}

/** What a test host is made with. */
export interface PstackHostOptions {
  /** The binding evidence binds its callers with. Default: pstack's, over the fake sessions. */
  readonly bind?: CallerBinding;
  /** Benny: on unless `false`. */
  readonly benny?: false;
  /** How the pipelines a new pull request gets end: its head's and its merge result's. Default: both succeed. */
  readonly ci?: { readonly head?: string; readonly mergeResult?: string };
  /** More plugins, installed before the workflow module. */
  readonly plugins?: readonly Plugin[];
}

/**
 * A host with pstack: requests, timers, git, a fake `proc.run`, fake sessions, the forge module over a fake GitLab
 * with the project acme/billing (42), evidence, plan, pstack, and the workflow module with an agent per role.
 */
export async function pstackHost(options: PstackHostOptions = {}): Promise<PstackHost> {
  const root = realpathSync(await tempDir("pstack"));
  // As in an installation, the packages pstack runs with are in a node_modules above the home.
  symlinkSync(realpathSync(join(import.meta.dir, "..", "node_modules")), join(root, "node_modules"), "dir");
  const home = join(root, "home");
  mkdirSync(join(home, "secrets"), { recursive: true });
  const repo = join(root, "repo");
  mkdirSync(repo);
  gitIn(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "README.md"), "The billing service.\n");
  gitIn(repo, "add", ".");
  gitIn(repo, "commit", "-q", "-m", "start");

  const gitlab = new FakeGitLab();
  const project = gitlab.project(42, PROJECT);
  const token = join(home, "secrets", "GITLAB_TOKEN");
  writeFileSync(token, `${gitlab.token}\n`);
  chmodSync(token, 0o600);

  const harnesses = new Harnesses();
  const agents = fakeAgents(home, harnesses);
  const sessions = fakeSessions(home, harnesses);
  const offeredAgents: AgentOffer[] = [];
  const ci = { head: options.ci?.head ?? "success", mergeResult: options.ci?.mergeResult ?? "success" };
  const host = createNiwa({ home });
  host.use(
    requests(),
    timers([]),
    git({ cleanup: false }),
    fakeProc(),
    sessions,
    plugin("fake-agents", (api) => {
      for (const one of Object.values(agents)) api.action(one);
    }),
    forge({ servers: [{ host: FORGE_HOST, url: gitlab.url, token: secret("GITLAB_TOKEN") }], fetch: withCi(gitlab, project, repo, ci), env: {}, poll: false }),
    evidence({ bind: options.bind ?? addressingOf([sessions]) }),
    plan(),
    ...(options.plugins ?? []),
    pstackPlugin({ roles: ROLES, forges: [FORGE_HOST], ...(options.benny === false ? {} : { benny: { repo: { host: FORGE_HOST, path: PROJECT, local: repo } } }) }),
    // The agents module reads the agents a plugin offers; this one only keeps them.
    plugin("agents", (api) => {
      offeredAgents.push(...api.offers(AGENT).map((one) => one.value));
    }),
    workflow({ agents }),
  );
  await host.serve();
  const owner = await connectAsOwner(home);
  const worktrees = join(home, "worktrees");
  return {
    host,
    home,
    repo,
    worktrees,
    gitlab,
    project,
    harnesses,
    agents: offeredAgents,
    ci,
    fixture: { repo: { host: FORGE_HOST, path: PROJECT, local: repo }, worktrees, base: "main" },
    answer: async (ids) => {
      let id: string | undefined;
      await eventually(async () => {
        const open = (await owner.call("request.open" as never, {} as never)) as { items?: Array<{ id: string }>; requests?: Array<{ id: string }> };
        id = (open.items ?? open.requests ?? [])[0]?.id;
        return id !== undefined;
      }, 20_000, "the owner was not asked");
      await owner.call("request.answer" as never, { id, answer: { ids } } as never);
    },
    asOwner: async (name, input) => await owner.call(name as never, input as never),
    attestAs: async (mark, subject, claim) => {
      const token = host.issueToken(principalOf("session", mark), { grant: grant(["evidence.attest"]) });
      const client = await connect({ home, id: `session:${mark}`, token });
      try {
        await client.call("evidence.attest" as never, { subject, claim } as never);
      } finally {
        await client.close().catch(() => {});
      }
    },
    close: async () => {
      await owner.close().catch(() => {});
      await host.close().catch(() => {});
    },
  };
}

/** pstack's built-ins as the host lists them, by name. */
export async function builtins(host: Host): Promise<Record<string, { id: string; version: string }>> {
  const listed = (await host.call("workflow.list" as never, {} as never)) as { items: Array<{ id: string; version: string; builtin?: { plugin: string; name: string } }> };
  return Object.fromEntries(listed.items.filter((one) => one.builtin?.plugin === "pstack").map((one) => [one.builtin?.name ?? "", { id: one.id, version: one.version }]));
}

/** The records of a type. */
export async function recordsOf(host: Host, type: string): Promise<Array<{ data: unknown; seq: number }>> {
  return (await host.records.read({ types: [type] })).map((row) => ({ data: row.data, seq: row.seq }));
}

/** The node ids a fake lead plans: two independent pull requests, or a stack of two when the task asks for one. */
const PARALLEL = [
  { id: "changelog", text: "Add a changelog", after: [], files: ["CHANGELOG.md"] },
  { id: "contributing", text: "Add a contributing guide", after: [], files: ["CONTRIBUTING.md"] },
];
const STACK = [
  { id: "settings", text: "Add a settings module", after: [], files: ["settings.md"] },
  { id: "page", text: "Add a page that uses the settings", after: ["settings"], files: ["page.md"] },
];

/** The claim a lane asks a verifier to attest, as its prompt names it. */
export function claimAsked(prompt: string): { subject: string; name: string; sha: string } {
  const found = /subject "([^"]+)", claim \{ kind: "verdict", name: "([^"]+)", outcome: "pass" or "fail", sha: "([0-9a-f]+)" \}/.exec(prompt);
  if (found === null) throw new Error("the verifier was not told what to attest");
  return { subject: found[1] as string, name: found[2] as string, sha: found[3] as string };
}

/**
 * Answers that carry every playbook through on the fakes: the lead routes to the investigation and plans, the author
 * commits in its worktree and publishes the branch to the fake server, and a verifier attests a pass as itself.
 */
export function defaultAnswers(made: PstackHost): Answers {
  let changes = 0;
  /** What an author does: commit a change in its worktree, and publish the branch to the fake server. */
  const commit = (call: HarnessCall): string => {
    if (call.cwd === undefined) throw new Error("the author was started in no directory");
    changes += 1;
    const sha = commitFile(call.cwd, `change-${String(changes)}.md`, `change ${String(changes)}\n`);
    made.project.branches.set(gitIn(call.cwd, "rev-parse", "--abbrev-ref", "HEAD"), sha);
    return sha;
  };
  const verify = (evidence: string) => async (call: HarnessCall) => {
    const asked = claimAsked(call.prompt);
    await made.attestAs(call.ref?.split(" ")[1] ?? "", asked.subject, { kind: "verdict", name: asked.name, outcome: "pass", sha: asked.sha });
    return { outcome: "pass", evidence };
  };
  const hypotheses = () => ({ cause: "The README was not updated.", hypotheses: [{ claim: "The README was not updated", status: "confirmed", evidence: "README.md:1" }] });
  return {
    "entry:route": () => ({ kind: "run", playbook: "investigation", task: "Where does this repository describe itself?", more: {} }),
    "investigation:trace": () => ({ summary: "The README says what the service is.", sources: [{ file: "README.md", line: 1 }] }),
    "multi-phase-plan:plan": (call) => ({ kind: "plan", goal: "Deliver the task", nodes: /stack|building on|builds on/i.test(call.prompt.slice(call.prompt.lastIndexOf("Task:"))) ? STACK : PARALLEL }),
    "*:build": (call) => ({ sha: commit(call), summary: `Added change ${String(changes)}.` }),
    "*:verify-gates": verify("the gates passed"),
    "*:verify-live": verify("the page renders"),
    "trace-forensics:investigate": hypotheses,
    "runtime-forensics:investigate": hypotheses,
    "feature:frame": () => ({ shape: "A section of the README.", checkpoint: { blocking: "n/a: one file", independent: "n/a: one file", shared: "n/a: none", decomposition: "one worker: one file" } }),
    "bug-fix:frame": () => ({ repro: "read README.md", cause: "a typo", evidence: "README.md:1" }),
    "refactoring:frame": () => ({ contract: "The README reads the same.", pin: "test -f README.md", target: "One section per topic." }),
    "authoring-a-skill:frame": () => ({ skill: "readme-style", decisions: ["short"], validation: "frontmatter has a name" }),
    "visual-parity:frame": () => ({ reference: "the design", surface: "the README", differences: ["the heading"] }),
    "perf-issue:frame": () => ({ measure: "ls | wc -l", direction: "higher", target: 1 }),
    "autonomous-run:attempt": (call) => ({ change: `committed ${commit(call)}` }),
    "hillclimb:attempt": (call) => ({ hypothesis: `one more note: ${commit(call)}` }),
    "prototype:scope": () => ({ kind: "decide", decision: "What the README leads with", variants: [{ name: "usage", idea: "Usage first" }, { name: "architecture", idea: "Architecture first" }] }),
    "prototype:build": (call) => ({ observed: `built in ${call.cwd ?? ""}` }),
    "prototype:recommend": () => ({ recommend: "usage", why: "A reader wants to run it first." }),
    "eval:frame": () => ({
      success: "The explanation is right and short.",
      rubric: [
        { id: "right", text: "It is right." },
        { id: "short", text: "It is short." },
        { id: "plain", text: "It is plain." },
      ],
      cases: [{ id: "readme", prompt: "What is this repository for?" }],
    }),
    // Prompts with no tag: an eval's candidates, which must not see they are graded, and its grader.
    "": (call) => {
      if (!call.prompt.startsWith("Grade the subject")) return { answer: "It is the billing service." };
      const ids = [...call.prompt.matchAll(/^- ([a-z][a-z0-9-]*): /gm)].map((found) => found[1] as string);
      return { scores: Object.fromEntries(ids.map((id) => [id, 1])) };
    },
    "opening-a-pr:write": () => ({ title: "docs(readme): add the page", sections: [{ heading: "Why", body: "The page needs it." }, { heading: "Verification", body: "Read it." }] }),
    "pause-safely:checkpoint": (call) => {
      commit(call);
      return { intent: "Add the page", state: "half done", verified: [], next: "finish the page", files: ["page.md"], gotchas: [] };
    },
    "benny-triage:triage": () => ({ verdict: "bug", owner: "the README", summary: "The README names the wrong service." }),
    "benny-reproduce:reproduce": () => ({ reproduced: true, runs: ["The README says payroll.", "It still says payroll."] }),
    // What a boxed author does for the sync: it reads the report in its worktree and settles the touched entries as carried.
    "upstream-sync:round": (call) => {
      const report = JSON.parse(readFileSync(join(call.cwd as string, ".upstream-map-report.json"), "utf8")) as { entries: Array<{ id: string; status: string }> };
      return { summary: "settled the touched entries", decisions: [], accept: report.entries.filter((one) => one.status === "touched").map((one) => one.id) };
    },
    "session-pickup:resume": () => ({ where: "Both pull requests merged.", verified: ["changelog", "contributing"], next: "Nothing is left." }),
  };
}

/** The steps that failed, by the prefix of their key: the workflow module's sync by default. */
export async function syncErrors(host: Host, prefix = "sync:"): Promise<string[]> {
  return (await host.records.read({ types: ["niwa.step.outcome"] }))
    .map((row) => row.data as { key: string; outcome: { status: string; error?: string } })
    .filter((one) => one.key.startsWith(prefix) && one.outcome.status === "failed")
    .map((one) => `${one.key}: ${one.outcome.error ?? ""}`);
}

/** Wait until every built-in of pstack is registered, or fail with why the sync refused one. */
export async function registeredAll(host: Host, count: number): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Object.keys(await builtins(host)).length < count) {
    const errors = await syncErrors(host);
    if (errors.length > 0) throw new Error(`pstack's built-ins were not registered:\n${errors.join("\n")}`);
    if (Date.now() > deadline) throw new Error("pstack's built-ins were not registered in time");
    await Bun.sleep(100);
  }
}
