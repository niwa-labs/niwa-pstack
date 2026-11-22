// What the pstack tests share: a host laid out as an installation (the packages pstack runs with in a
// `node_modules` above the home, where a stored script finds them), a real git repository, a fake GitLab
// server behind the forge module, a `proc.run` that runs where it is asked, and fake harnesses that answer each
// step of a playbook as the test says.

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { z } from "zod";

import { action, actionRef, grant, principalOf } from "@niwa-labs/core";
import type { Caller } from "@niwa-labs/core";
import { evidence } from "@niwa-labs/evidence";
import { forge, secret } from "@niwa-labs/forge";
import { plan } from "@niwa-labs/plan";
import { AGENT, BUILTIN_WORKFLOW } from "@niwa-labs/plugin";
import type { AgentOffer, BuiltinWorkflow, CallerBinding, Plugin } from "@niwa-labs/plugin";
import { harnessList, sessionAsk, sessionEnd, sessionStart } from "@niwa-labs/sessions/records";
import { connect, connectAsOwner, createNiwa, eventually, git, historyRead, plugin, requests, timers, workflow } from "@niwa-labs/testing";
import type { Host } from "@niwa-labs/testing";

import { FakeGitLab, sha } from "../node_modules/@niwa-labs/forge/test/fake-gitlab.ts";
import type { FakeProject } from "../node_modules/@niwa-labs/forge/test/fake-gitlab.ts";
import { addressingOf } from "../src/binding.ts";
import type { Binding } from "../src/binding.ts";
import { pstackPlugin } from "../src/plugin.ts";
import type { RolesInput } from "../src/roles.ts";
import { fakePorts } from "./ports.ts";
import type { FakePorts } from "./ports.ts";

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

type VisibleActionRules = NonNullable<z.output<typeof sessionStart.input>["visible"]>["actions"];

/** What a fake harness is asked: by which harness, in which step, where, and what the session may call. */
export interface HarnessCall {
  harness: string;
  /** The step of the prompt's tag, `<playbook>:<step>`; empty without a tag. */
  step: string;
  prompt: string;
  cwd?: string;
  visible?: VisibleActionRules;
  box?: z.output<typeof sessionStart.input>["box"];
  mode?: string;
  model?: string;
  effort?: string;
  /** The reference of the conversation answering this turn. */
  ref?: string;
}

/** How the fakes answer a step: a value, or a function of the call. */
export type Answers = Record<string, (call: HarnessCall) => unknown>;

/** The step a prompt's tag names. */
const stepOf = (prompt: string): string => /\[pstack:([^\]]+)\]/.exec(prompt)?.[1] ?? "";

/** Fake calls and sessions seen through the workflow SDK. */
class Harnesses {
  readonly calls: HarnessCall[] = [];
  readonly sessions = new Map<string, {
    id: string;
    harness: string;
    ended: boolean;
    cwd?: string;
    visible?: VisibleActionRules;
    box: z.output<typeof sessionStart.input>["box"];
    caller: Caller;
  }>();
  answers: Answers = {};

  open(harness: string, caller: Caller, options: { cwd?: string; visible?: VisibleActionRules; box?: z.output<typeof sessionStart.input>["box"] }) {
    const number = this.sessions.size + 1;
    const id = `s-${String(number).padStart(6, "0")}`;
    const ref = `${harness} native-${String(number)}`;
    const { cwd, visible, box } = options;
    this.sessions.set(ref, { id, harness, ended: false, ...(cwd === undefined ? {} : { cwd }), ...(visible === undefined ? {} : { visible }), box, caller });
    return { session: id, ref, operation: `op-${String(number)}` };
  }

  lookup(id: string | { harness: string; native: string }) {
    const key = typeof id === "string" ? id : `${id.harness} ${id.native}`;
    const entry = [...this.sessions].find(([ref, session]) => ref === key || session.id === key);
    if (entry === undefined) throw new Error(`no fake session ${id}`);
    return entry;
  }

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
  /** The fake providers of Benny's ports, and what they were asked. */
  ports: FakePorts;
  /** The fixture a run of the suite or the entry is given. */
  fixture: { repo: { host: string; path: string; local: string }; worktrees: string; base: string };
  /** Call an action as the owner, from the owner's own client. */
  asOwner(name: string, input: unknown): Promise<unknown>;
  /** Answer the owner's next open question with these option ids. */
  answer(run: string, ids: string[]): Promise<void>;
  /** Attest as the session whose mark is `mark`, as its own client: what a verifier does with `evidence.attest`. */
  attestAs(mark: string, subject: string, claim: Record<string, unknown>): Promise<void>;
  close(): Promise<void>;
}

/** A `proc.run` that runs the command in its cwd, with no box: its target is the cwd, as the real action's is. */
function fakeProc(root: string): Plugin {
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
          const scratch = mkdtempSync(join(root, "proc-"));
          const ran = (() => {
            try {
              return Bun.spawnSync(cmd, { cwd, env: { ...process.env, TMPDIR: scratch, TMP: scratch, TEMP: scratch }, stdout: "pipe", stderr: "pipe" });
            } finally {
              rmSync(scratch, { recursive: true, force: true });
            }
          })();
          const bytes = Buffer.concat([ran.stdout, ran.stderr]);
          const tail = bytes.subarray(-4096).toString();
          return {
            outcome: "exited",
            exit: ran.exitCode,
            durationMs: 1,
            tail,
            truncated: bytes.length > 4096,
            output: { digest: `sha256:${"0".repeat(64)}`, size: bytes.length, type: "text/plain" },
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
function fakeSessions(harnesses: Harnesses): Binding {
  const made_ = plugin("sessions", (api) => {
    api.action(action(harnessList, {
      recovery: "repeat",
      effect: "read",
      world: "niwa",
      run: () => ({ items: [] }),
    }));
    api.action(
      action("session.start", {
        description: "Start a fake session.",
        input: sessionStart.input,
        output: z.any(),
        recovery: "repeat",
        effect: "write",
        world: "local",
        run: (input, { caller }) => {
          const { cwd, box } = input;
          const visible = input.visible?.actions;
          return harnesses.open(input.harness, caller, {
            ...(cwd === undefined ? {} : { cwd }),
            ...(visible === undefined ? {} : { visible }),
            ...(box === undefined ? {} : { box }),
          });
        },
      }),
    );
    api.action(action(sessionAsk, {
      recovery: "repeat",
      effect: "write",
      world: "local",
      async run(input) {
        const [ref, session] = harnesses.lookup(input.session);
        if (session.ended) throw new Error(`fake session ${ref} already ended`);
        const prompt = input.prompt.sections.map((section) => section.text).join("\n");
        const value = await harnesses.answer({ harness: session.harness, step: stepOf(prompt), prompt, ref, ...(session.cwd === undefined ? {} : { cwd: session.cwd }), ...(session.visible === undefined ? {} : { visible: session.visible }) });
        return { value };
      },
    }));
    api.action(action(sessionEnd, {
      recovery: "repeat",
      effect: "write",
      world: "local",
      run: ({ session: id }) => {
        const [, session] = harnesses.lookup(id);
        const ended = !session.ended;
        session.ended = true;
        return { ended };
      },
    }));
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

/** The workflow SDK action of each role's harness. */
function fakeAgents(harnesses: Harnesses) {
  const names = ["lead", "author", "reviewer", "verifier", "judge", "ncode-flash"];
  return Object.fromEntries(
    names.map((harness) => [
      harness,
      action(`session.start.${harness}`, {
        description: "Open a fake workflow session or answer a one-shot question.",
        input: z.looseObject({
          prompt: z.string().optional(), cwd: z.string().optional(), visible: z.array(z.string()).optional(),
          box: z.custom<z.output<typeof sessionStart.input>["box"]>().optional(),
          mode: z.string().optional(), model: z.string().optional(), effort: z.string().optional(),
        }),
        output: z.any(),
        recovery: "repeat",
        effect: "write",
        world: "local",
        async run({ prompt, cwd, visible, box, mode, model, effort }, { caller }) {
          const options = { ...(cwd === undefined ? {} : { cwd }), ...(visible === undefined ? {} : { visible }) };
          if (prompt === undefined) return harnesses.open(harness, caller, { ...options, ...(box === undefined ? {} : { box }) });
          return await harnesses.answer({
            harness, step: stepOf(prompt), prompt, ...options,
            ...(box === undefined ? {} : { box }),
            ...(mode === undefined ? {} : { mode }),
            ...(model === undefined ? {} : { model }),
            ...(effort === undefined ? {} : { effort }),
          });
        },
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
      const mr = (await answered.clone().json()) as { iid: number; sha: string; target_branch: string };
      const target = gitIn(repo, "rev-parse", mr.target_branch);
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
  /** Install only these real built-ins ungated, for isolated playbook tests. */
  readonly onlyBuiltins?: readonly string[];
  /** The binding evidence binds its callers with. Default: pstack's, over the fake sessions. */
  readonly bind?: CallerBinding;
  /** Benny: on unless `false`. */
  readonly benny?: false;
  /** The role seats, when a test needs specific harnesses or vendors. */
  readonly roles?: RolesInput;
  /** The providers of Benny's ports that are left out, as a host that lacks them would be. */
  readonly withoutPorts?: ReadonlyArray<"tracker" | "channel" | "control">;
  /** How the pipelines a new pull request gets end: its head's and its merge result's. Default: both succeed. */
  readonly ci?: { readonly head?: string; readonly mergeResult?: string };
  /** More plugins, installed before the workflow module. */
  readonly plugins?: readonly Plugin[];
}

/**
 * A host with pstack: requests, timers, git, a fake `proc.run`, fake sessions, the forge module over a fake GitLab
 * with the project acme/billing (42), evidence, plan, pstack, and the workflow module with a fake harness action per role.
 */
export async function pstackHost(options: PstackHostOptions = {}): Promise<PstackHost> {
  // Eval sees the absolute checkout path. Keep the generic niwa-test-* marker out of this fixture.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pstack-fixture-")));
  try {
    const made = await pstackHostAt(root, options);
    return { ...made, close: async () => {
      try {
        await made.close();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    } };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

async function pstackHostAt(root: string, options: PstackHostOptions): Promise<PstackHost> {
  // As in an installation, the packages pstack runs with are in a node_modules above the home.
  symlinkSync(realpathSync(join(import.meta.dir, "..", "node_modules")), join(root, "node_modules"), "dir");
  const home = join(root, "home");
  mkdirSync(join(home, "secrets"), { recursive: true });
  const repo = join(root, "repo");
  mkdirSync(repo);
  gitIn(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "README.md"), "The billing service.\n");
  writeFileSync(join(repo, ".gitignore"), "/.captures/\n");
  writeFileSync(join(repo, "tone"), "black\n");
  writeFileSync(join(repo, "metric"), "10\n");
  writeFileSync(join(repo, "draw.sh"), [
    "mkdir -p .captures",
    "magick -size 2x2 xc:white .captures/reference.png",
    'magick -size 2x2 "xc:$(cat tone)" .captures/surface.png',
  ].join("\n") + "\n");
  gitIn(repo, "add", ".");
  gitIn(repo, "commit", "-q", "-m", "start");

  const gitlab = new FakeGitLab();
  const project = gitlab.project(42, PROJECT);
  project.branches.set("main", gitIn(repo, "rev-parse", "main"));
  const token = join(home, "secrets", "GITLAB_TOKEN");
  writeFileSync(token, `${gitlab.token}\n`);
  chmodSync(token, 0o600);

  const harnesses = new Harnesses();
  const agents = fakeAgents(harnesses);
  const sessions = fakeSessions(harnesses);
  const offeredAgents: AgentOffer[] = [];
  const ports = fakePorts(options.withoutPorts ?? []);
  const ci = { head: options.ci?.head ?? "success", mergeResult: options.ci?.mergeResult ?? "success" };
  const host = createNiwa({ home });
  const pstack = pstackPlugin({ roles: options.roles ?? ROLES, forges: [FORGE_HOST], ...(options.benny === false ? {} : { benny: { repo: { host: FORGE_HOST, path: PROJECT, local: repo } } }) });
  if (options.onlyBuiltins) {
    const setup = pstack.setup;
    pstack.setup = api => setup({ ...api, offer(key, value) {
      if (key.name !== BUILTIN_WORKFLOW.name) return api.offer(key, value);
      const builtin = value as BuiltinWorkflow;
      if (options.onlyBuiltins?.includes(builtin.name)) api.offer(BUILTIN_WORKFLOW, { ...builtin, gated: false });
    } });
  }
  host.use(
    requests(),
    timers([]),
    git({ cleanup: false }),
    fakeProc(root),
    plugin("box", (api) => {
      for (const rule of ["box.net", "box.read"]) api.action(action(rule, {
        description: "A sandbox permission rule.",
        input: z.strictObject({ place: z.string().min(1) }),
        output: z.strictObject({ held: z.literal(true) }),
        recovery: "repeat",
        effect: "read",
        world: "local",
        target: (input) => input.place,
        run: () => ({ held: true as const }),
      }));
    }),
    sessions,
    plugin("history", (api) => {
      api.action(action("history.list", {
        description: "List fixture sessions scoped to a checkout.",
        input: z.object({ cwd: z.string().optional(), limit: z.number().optional() }),
        output: z.object({
          sessions: z.array(z.object({ session: z.object({ harness: z.string(), native: z.string() }), cwd: z.string().optional() })),
          more: z.boolean(),
          unreadable: z.array(z.object({ harness: z.string(), reason: z.string() })),
        }),
        recovery: "repeat", effect: "read", world: "niwa",
        run: () => ({ sessions: [], more: false, unreadable: [] }),
      }));
      api.action(action(historyRead, {
        recovery: "repeat", effect: "read", world: "niwa",
        run: ({ session }) => {
          try {
            harnesses.lookup(`${session.harness} ${session.native}`);
            return { records: [], coverage: { status: "empty" as const } };
          } catch {
            return { records: [], coverage: { status: "unavailable" as const, reason: "Unknown fixture session" } };
          }
        },
      }));
    }),
    plugin("fake-agents", (api) => {
      for (const one of Object.values(agents)) api.action(one);
    }),
    forge({ servers: [{ host: FORGE_HOST, url: gitlab.url, token: secret("GITLAB_TOKEN") }], fetch: withCi(gitlab, project, repo, ci), env: {}, poll: false }),
    evidence({ bind: options.bind ?? addressingOf([sessions]) }),
    plan(),
    ...(options.plugins ?? []),
    ...(options.benny === false ? [] : ports.plugins),
    pstack,
    // The agents module reads the agents a plugin offers; this one only keeps them.
    plugin("agents", (api) => {
      offeredAgents.push(...api.offers(AGENT).map((one) => one.value));
    }),
    workflow({ agents }),
  );
  await host.serve();
  const owner = await connectAsOwner(home).catch(async (error: unknown) => {
    await host.close().catch(() => {});
    throw error;
  });
  const worktrees = join(home, "worktrees");
  return {
    host,
    home,
    repo,
    worktrees,
    gitlab,
    project,
    harnesses,
    ports,
    agents: offeredAgents,
    ci,
    fixture: { repo: { host: FORGE_HOST, path: PROJECT, local: repo }, worktrees, base: "main" },
    answer: async (run, ids) => {
      let id: string | undefined;
      try {
        await eventually(async () => {
          const open = (await owner.call("request.open" as never, { to: { kind: "owner" } } as never)) as {
            requests: Array<{ id?: string; from?: { kind: string; id?: string } }>;
          };
          id = open.requests.find(({ from }) => from?.kind === "client" && from.id === `run:${run}`)?.id;
          return id !== undefined;
        }, 20_000, "the owner was not asked");
      } catch (error) {
        const inspection = await host.call("workflow.inspect" as never, { run } as never)
          .then((result) => (result as { status: unknown }).status, (failure) => String(failure));
        throw new Error(`Owner request for ${run}: ${String(error)}. Run state: ${JSON.stringify(inspection).slice(0, 2000)}`, { cause: error });
      }
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
  const featureDesign = { shape: "A section of the README.", rationale: "One file", scope: ["README.md"], checks: ["Read the section"] };
  const bench = 'printf \'{"metric":%s,"errors":0,"work":100,"surface":"CLI","driver":"fixture"}\\n\'';
  const profilePath = ".captures/profile.json";
  const profile = (symbol: string, duration: string) =>
    `mkdir -p .captures && printf '{"nodes":[{"id":1,"callFrame":{"functionName":"${symbol}","url":"README.md","lineNumber":0}}],"samples":[1],"timeDeltas":[%s]}\\n' ${duration} > "${profilePath}"`;
  const publish = (cwd: string) => {
    const sha = gitIn(cwd, "rev-parse", "HEAD");
    made.project.branches.set(gitIn(cwd, "branch", "--show-current"), sha);
    return sha;
  };
  return {
    "entry:route": () => ({ kind: "run", playbook: "investigation", task: "Where does this repository describe itself?", more: {} }),
    "investigation:trace": () => ({ summary: "The README says what the service is.", sources: [{ file: "README.md", line: 1 }] }),
    "investigation:unslop": ({ prompt }) => JSON.parse(prompt.split("\n").find((line) => line.startsWith('{"summary":'))!),
    "multi-phase-plan:plan": (call) => {
      const task = call.prompt.slice(call.prompt.lastIndexOf("Task:"));
      const nodes = /stack|building on|builds on/i.test(task) ? STACK : PARALLEL;
      return {
        kind: "plan",
        goal: "Deliver the task",
        nodes: nodes.map((node) => ({
          ...node,
          verification: {
            unit: `Check the syntax of ${node.files.join(", ")}.`,
            live: { scenario: node.text, pass: "Open the changed document and verify its expected content." },
            perf: {
              metric: "Documentation build time",
              probe: "Time a clean documentation build.",
              trunk: "Measure a clean build on main first.",
              fail: "Build time increases by more than 10%.",
            },
          },
        })),
      };
    },
    "*:build": (call) => ({ sha: commit(call), summary: `Added change ${String(changes)}.` }),
    "*:verify-gates": verify("the gates passed"),
    "*:verify-live": verify("the page renders"),
    "*:gate-review": () => ({ kind: "unchanged", proof: "The committed patch changes documentation only." }),
    "trace-forensics:investigate": hypotheses,
    "runtime-forensics:capture-plan": () => ({
      kind: "capture", target: "README reader", surface: "CLI", driver: "fixture",
      signal: profile("read", "10"), path: profilePath,
      setup: "touch .captures/active", observe: "test -f .captures/active && echo active",
      control: "test -f README.md && echo quiet", cleanup: "rm .captures/active", expected: "active", controlExpected: "quiet",
    }),
    "runtime-forensics:investigate": () => ({
      cause: "The fixture reader is active.",
      hypotheses: [{ claim: "The fixture reader is active.", status: "confirmed", evidence: "The capture and repeated observation identify the reader." }],
      source: { file: "README.md", symbol: "read", line: 1 }, route: "bug-fix",
    }),
    "feature:frame": () => ({ kind: "direct", trace: "README", design: featureDesign, whyOnlyOne: "No code or data model changes", contested: false, checkpoint: { blocking: "n/a: one file", independent: "n/a: one file", shared: "n/a: none", decomposition: "one worker: one file" } }),
    "feature:architect": () => featureDesign,
    "feature:approve-design": () => ({ kind: "proceed", design: featureDesign, resolution: "Keep the existing README structure." }),
    "feature:integrate": ({ cwd }) => ({
      sha: commitFile(cwd!, "README.md", "The billing service.\n\nThis guide explains billing.\n"),
      observed: "Added the billing guide introduction",
    }),
    "bug-fix:frame": () => ({
      kind: "confirmed", crossesBoundary: false, repro: "read README.md", cause: "a typo", evidence: "README.md:1",
      history: "The initial fixture commit introduced the wording", surface: "README.md", driver: "grep",
      replay: { command: "if grep -q 'The billing service' README.md; then echo wording; exit 1; fi", failingSignal: "wording" },
      regression: { kind: "skip", reason: "The fixture has no regression test runner" },
    }),
    "bug-fix:fix": ({ cwd }) => {
      if (cwd === undefined) throw new Error("the bug fix author has no checkout");
      commitFile(cwd, "README.md", "A billing service.\n");
      return { summary: "Fix wording" };
    },
    "*:publish": ({ cwd }) => ({ sha: publish(cwd!) }),
    "refactoring:frame": () => ({ kind: "reshape", crossesBoundary: false, contract: "The README reads the same.", pin: "test -f README.md", target: "One section per topic." }),
    "refactoring:characterize": () => ({
      predicate: "The README is unchanged", probe: ["cat", "README.md"],
      phases: [{ hypothesis: "Separate the implementation from its contract", change: "Add the implementation note" }],
    }),
    "refactoring:reshape": ({ cwd }) => {
      if (cwd === undefined) throw new Error("the refactoring author has no checkout");
      return { sha: commitFile(cwd, "implementation.txt", "The reader implementation.\n"), observed: "Moved the implementation" };
    },
    "refactoring:reader-load": () => ({ keep: true, why: "The implementation has one place to look" }),
    "authoring-a-skill:frame": () => ({ skill: "readme-style", decisions: ["short"], validation: "frontmatter has a name" }),
    "authoring-a-skill:create-skill": () => ({
      path: "SKILL.md", guidance: "Keep README changes short and grounded in the existing page.",
      cases: { kind: "structural", commands: [["grep", "-q", "name: readme-style", "SKILL.md"]] },
    }),
    "authoring-a-skill:author-skill": ({ cwd }) => ({
      sha: commitFile(cwd!, "SKILL.md", "---\nname: readme-style\ndescription: Update the billing README.\n---\nRead the [guide](README.md).\n"),
      observed: "Added the README editing skill",
    }),
    "visual-parity:frame": () => ({
      kind: "ready", reference: "White surface", surface: "Synthetic image capture", baseline: "draw.sh", differences: ["The background"],
      command: "sh -e draw.sh", protectedPaths: ["draw.sh"], shared: null,
      components: [{ id: "background", paths: ["tone"], states: [{ name: "default", reference: ".captures/reference.png", actual: ".captures/surface.png" }] }],
    }),
    "visual-parity:component": ({ cwd }) => ({ summary: commitFile(cwd!, "tone", "white\n") }),
    "perf-issue:frame": () => ({
      measure: bench + ' "$(cat metric)"', direction: "lower", target: 6, crossesBoundary: false,
      workload: {
        surface: "CLI", driver: "fixture", unit: "steps", workload: "100 records", limiter: "Extra steps",
        comparability: "Same input and counters", easier: bench + " 2", profile: profile("measure", '"$(cat metric)"'), profilePath,
        gate: "test -s metric", harnessPaths: [],
      },
    }),
    "perf-issue:performance-plan": () => ({
      attempts: [{ mantra: "remove", hypothesis: "Remove the repeated stages", crossesBoundary: false }],
      skipped: "Other categories leave the same repeated stages",
    }),
    "perf-issue:attempt": ({ cwd }) => ({ summary: commitFile(cwd!, "metric", "5\n") }),
    "autonomous-run:attempt": (call) => ({ change: `committed ${commit(call)}` }),
    "hillclimb:attempt": (call) => ({ hypothesis: `one more note: ${commit(call)}` }),
    "prototype:scope": () => ({ kind: "decide", decision: "What the README leads with", variants: [{ name: "usage", idea: "Usage first" }, { name: "architecture", idea: "Architecture first" }] }),
    "prototype:build": (call) => ({ observed: `built in ${call.cwd ?? ""}` }),
    "prototype:recommend": () => ({ kind: "pick", recommend: "usage", why: "A reader wants to run it first." }),
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
    "": ({ prompt, cwd }) => {
      if (prompt.startsWith("Publish the existing commit")) {
        publish(cwd!);
        return { published: true };
      }
      if (!prompt.startsWith("Grade all labeled outputs")) return { answer: "It is the billing service." };
      const rows = JSON.parse(prompt.split("\n\n").at(-1)!) as Array<{ label: string }>;
      return { grades: rows.map(({ label }) => ({ label, scores: { right: 1, short: 1, plain: 1 }, rationale: "Matches the fixture README" })) };
    },
    "eval:synthesis": () => ({ recommendation: null, rationale: "Both answers match the fixture README" }),
    "opening-a-pr:write": () => ({
      title: "docs(readme): add the page",
      sections: [
        { heading: "Why", body: "The page needs it." },
        { heading: "What changed", body: "Updated the page." },
        { heading: "Verification", body: "Read it." },
      ],
    }),
    "pause-safely:checkpoint": () => {
      return { intent: "Add the page", state: "half done", verified: [], next: "finish the page", files: ["page.md"], gotchas: [] };
    },
    "benny-triage:triage": () => ({ verdict: "bug", owner: "the README", summary: "The README names the wrong service." }),
    "benny-reproduce:reproduce": () => ({ kind: "reproduced", runs: ["The README says payroll.", "It still says payroll."] }),
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
