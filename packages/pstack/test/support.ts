// What the pstack tests share: a host laid out as an installation (the packages pstack runs with in a
// `node_modules` above the home, where a stored script finds them), a real git repository, a fake GitLab
// server behind the forge module, a `proc.run` that runs where it is asked, and fake harnesses that answer each
// step of a playbook as the test says.

import { chmodSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import { evidence } from "@niwa-labs/evidence";
import { forge, secret } from "@niwa-labs/forge";
import { plan } from "@niwa-labs/plan";
import type { CallerBinding, Plugin } from "@niwa-labs/plugin";
import { connectAsOwner, createNiwa, eventually, git, plugin, requests, stubAction, tempDir, timers, workflow } from "@niwa-labs/testing";
import type { Host } from "@niwa-labs/testing";

import { FakeGitLab } from "../node_modules/@niwa-labs/forge/test/fake-gitlab.ts";
import type { FakeProject } from "../node_modules/@niwa-labs/forge/test/fake-gitlab.ts";
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

  answer(call: HarnessCall): unknown {
    this.calls.push(call);
    const reply = this.answers[call.step];
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
  /** The fixture a run of the suite or the entry is given. */
  fixture: { repo: { host: string; path: string; local: string }; worktrees: string; base: string };
  /** Answer the owner's next open question with these option ids. */
  answer(ids: string[]): Promise<void>;
  close(): Promise<void>;
}

/** A `proc.run` that runs the command in its cwd, with no box. */
function fakeProc(home: string): Plugin {
  return plugin("fake-proc", (api) =>
    api.action(
      stubAction("proc.run", {
        home,
        input: z.looseObject({ cmd: z.array(z.string()).min(1), cwd: z.string().min(1) }),
        output: z.any(),
        recovery: "repeat",
        result: ({ cmd, cwd }) => {
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

/** Sessions started and asked through `session.start` and `session.ask`, answered by the fakes. */
function fakeSessions(home: string, harnesses: Harnesses): Plugin {
  let made = 0;
  return plugin("fake-sessions", (api) => {
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
        result: (input) => {
          const session = harnesses.sessions.get(input.session);
          if (session === undefined) throw new Error(`no fake session ${input.session}`);
          const value = harnesses.answer({ harness: session.harness, step: stepOf(input.prompt), prompt: input.prompt, ref: input.session, ...(session.cwd === undefined ? {} : { cwd: session.cwd }), ...(session.visible === undefined ? {} : { visible: session.visible }) });
          return { value };
        },
      }),
    );
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
        result: (input) =>
          harnesses.answer({ harness, step: stepOf(input.prompt), prompt: input.prompt, ...(input.cwd === undefined ? {} : { cwd: input.cwd }), ...(input.visible === undefined ? {} : { visible: input.visible }) }),
      }),
    ]),
  );
}

/** What a test host is made with. */
export interface PstackHostOptions {
  /** The binding evidence binds its callers with. Default: the evidence module's own. */
  readonly bind?: CallerBinding;
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
  const host = createNiwa({ home });
  host.use(
    requests(),
    timers([]),
    git({ cleanup: false }),
    fakeProc(home),
    fakeSessions(home, harnesses),
    plugin("fake-agents", (api) => {
      for (const one of Object.values(agents)) api.action(one);
    }),
    forge({ servers: [{ host: FORGE_HOST, url: gitlab.url, token: secret("GITLAB_TOKEN") }], fetch: gitlab.fetch, env: {}, poll: false }),
    evidence(options.bind === undefined ? {} : { bind: options.bind }),
    plan(),
    ...(options.plugins ?? []),
    pstackPlugin({ roles: ROLES }),
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
