/**
 * The scenarios the suite runs before it promotes a set of built-ins.
 *
 * The scenarios run in this order, each on the version of its built-in that the set under trial holds, and may hand
 * what one produced to the next: a plan written by one is carried out by the next. They work on the suite's fixture,
 * a repository the suite may change on a forge project it may merge into. Every gated built-in has a scenario: a
 * candidate with none is not promoted.
 */

import { GO, goDigest, goSubject } from "../policy.ts";
import { api } from "./lib/script.ts";

/** What the suite is started on: a repository it may work in, and the versions of the set it tries. */
export interface Fixture {
  repo: { host: string; path: string; local: string };
  worktrees: string;
  base: string;
  /** The version the suite tries of each built-in, by name. */
  /** A name that is new to each run of the suite, for the plans its scenarios write. */
  run: string;
}

/** What the scenarios hand on to the ones after them. */
export type Context = Record<string, unknown>;

/** How a run of a built-in ended. */
export type Ended = { ok: true; value: unknown } | { ok: false; error: { name: string; message: string } };

/** Built-ins a pstack plugin offers only when it is asked to: their scenarios are skipped when they are not registered. */
export const OPTIONAL = new Set(["benny-triage", "benny-reproduce"]);

/** A scenario: the built-in it runs, its name, the input it gives, and why its outcome fails, or null when it passes. */
export interface Scenario {
  builtin: string;
  name: string;
  args(fixture: Fixture, context: Context): unknown | Promise<unknown>;
  check(ended: Ended, context: Context): string | null;
  /** What the scenario seeded and no longer needs, removed once its outcome was checked. */
  after?(fixture: Fixture, context: Context): Promise<void>;
}

/** The value of a run that ended well, or why it did not. */
function valueOf(ended: Ended): { value: Record<string, any> } | { failed: string } {
  if (!ended.ok) return { failed: `the run failed: ${ended.error.name}: ${ended.error.message}` };
  if (typeof ended.value !== "object" || ended.value === null) return { failed: `the run answered ${JSON.stringify(ended.value)}` };
  return { value: ended.value as Record<string, any> };
}

/** A check that the run answered a status, and whatever else `more` wants of the value. */
function answered(status: string, more: (value: Record<string, any>, context: Context) => string | null = () => null): Scenario["check"] {
  return (ended, context) => {
    const got = valueOf(ended);
    if ("failed" in got) return got.failed;
    if (got.value["status"] !== status) return `the run answered status ${JSON.stringify(got.value["status"])}, not ${status}: ${JSON.stringify(got.value).slice(0, 500)}`;
    return more(got.value, context);
  };
}

const playbook = (f: Fixture, task: string) => ({ task, repo: f.repo, worktrees: f.worktrees, base: f.base });

/** A plan a scenario wrote: its revision and nodes. */
interface Written {
  plan: { of: string; rev: number };
  nodes: Array<{ id: string; after: string[] }>;
}

/**
 * Give the go on every node of a plan the suite's own scenario wrote, as a run may: the suite stands in for the owner
 * on the plans of its fixture, and on nothing else.
 */
async function goOn(key: string, f: Fixture, written: Written): Promise<void> {
  const change = `${f.repo.host}/${f.repo.path}`;
  for (const node of written.nodes) {
    await api().call(
      "evidence.attest",
      { subject: goSubject(written.plan, node.id), claim: { kind: "verdict", name: GO, outcome: "pass", sha: goDigest(written.plan, node.id, change) } },
      { label: `${key}-go-${node.id}` },
    );
  }
}

const written = (context: Context, key: string): Written => {
  const found = context[key] as Written | undefined;
  if (found === undefined) throw new Error(`no plan was written for ${key} by an earlier scenario`);
  return found;
};

export const SCENARIOS: readonly Scenario[] = [
  {
    builtin: "entry",
    name: "routes a question to the investigation",
    args: (f) => ({ request: "Where does this repository describe itself?", repo: f.repo, worktrees: f.worktrees, base: f.base }),
    check: answered("ran", (value) => (value["playbook"] === "investigation" ? null : `the entry ran ${JSON.stringify(value["playbook"])}, not the investigation`)),
  },
  {
    builtin: "investigation",
    name: "answers with sources",
    args: (f) => playbook(f, "Where does this repository describe itself?"),
    check: answered("answered", (value) => ((value["answer"]?.sources ?? []).length > 0 ? null : "the answer cites no source")),
  },
  {
    builtin: "multi-phase-plan",
    name: "writes a plan of two independent pull requests",
    args: (f) => ({ ...playbook(f, "Add a changelog and a contributing guide, each in its own pull request."), plan: `suite/${f.run}/parallel`, ask: false }),
    check: answered("planned", (value, context) => {
      if ((value["nodes"] ?? []).length < 2) return "the plan has fewer than two nodes";
      context["parallel"] = value;
      return null;
    }),
  },
  {
    builtin: "autopilot-full",
    name: "checks the landing precondition for every verified plan node",
    args: async (f, context) => {
      await goOn("parallel", f, written(context, "parallel"));
      return { ...playbook(f, "Carry out the plan."), plan: written(context, "parallel").plan.of };
    },
    check: answered("done", (value, context) => {
      const nodes = value["nodes"] as Array<{ node: string; pr: number; head: string; verified: boolean; go: boolean; landed?: { outcome: string; missing?: Array<{ name: string; why: string }> } }>;
      context["landed"] = nodes.filter(one => one.landed?.outcome === "merged");
      context["verifiedForCleanup"] = nodes.filter(one => one.verified && one.go);
      return nodes.length > 0 && nodes.every(one => one.verified && one.go && gatedLanding(one.landed)) ? null : "an unverified pair reached landing, or a verified pair failed for an unexpected reason";
    }),
  },
  {
    builtin: "multi-phase-plan",
    name: "writes a stack of two pull requests",
    args: (f) => ({ ...playbook(f, "Add a settings module, then a page that uses it, the page building on the module."), plan: `suite/${f.run}/stack`, ask: false }),
    check: answered("planned", (value, context) => {
      const nodes = value["nodes"] as Array<{ after: string[] }>;
      if (!nodes.some((one) => one.after.length > 0)) return "the plan stacks no node on another";
      context["stack"] = value;
      return null;
    }),
  },
  {
    builtin: "autopilot-stack",
    name: "stacks and verifies without merging",
    args: (f, context) => ({ ...playbook(f, "Carry out the plan."), plan: written(context, "stack").plan.of }),
    check: answered("verified", (value, context) => {
      const nodes = value["nodes"] as Array<{ node: string; pr: number; base: string; verified: boolean; author: unknown }>;
      if (nodes.length < 2 || !nodes.every((one) => one.verified)) return `not every node verified: ${JSON.stringify(nodes).slice(0, 500)}`;
      if (!nodes.slice(1).some((one) => one.base !== "main")) return "no pull request was stacked on another";
      context["stacked"] = nodes;
      return null;
    }),
  },
  {
    builtin: "shipping",
    name: "stops before landing a stack on a forge without a target precondition",
    args: async (f, context) => {
      const plan = written(context, "stack");
      await goOn("stack", f, plan);
      const [bottom] = context["stacked"] as Array<{ node: string; pr: number; author: unknown }>;
      if (bottom === undefined) throw new Error("no stack was verified by an earlier scenario");
      return { ...playbook(f, "Land the bottom of the stack."), plan: plan.plan.of, prs: [{ number: bottom.pr, nodes: [bottom.node], author: bottom.author }] };
    },
    check: answered("stopped", value => gatedLanding(value["prs"]?.[0]) ? null : "expected refusal of an unconditioned merge"),
  },
  {
    builtin: "worktree-cleanup",
    name: "keeps a registered checkout until the forge has recorded its merge",
    args: async (f, context) => {
      const candidate = (context["verifiedForCleanup"] as Array<{ pr: number; head: string }> | undefined)?.[0]
        ?? (context["landed"] as Array<{ pr: number; head: string }> | undefined)?.[0];
      if (candidate === undefined) throw new Error("no pull request was verified by an earlier scenario");
      const { host, path } = f.repo;
      const { binding } = await api().call("pstack.pr.binding", { repo: { host, path }, number: candidate.pr, head: candidate.head }, { label: "cleanup-fixture" }) as {
        binding?: { worktree: { id: string } };
      };
      if (binding === undefined) throw new Error("no checkout was recorded for the fixture pull request");
      context["cleanupCheckout"] = { id: binding.worktree.id, head: candidate.head };
      return {
        id: "suite-unobserved",
        type: "forge.pr.merged",
        data: {
          pr: { repo: { host, path, projectId: 1 }, number: candidate.pr },
          base: f.base,
          head: candidate.head,
          source: { kind: "observed", version: 1 },
        },
      };
    },
    check: (ended) => {
      const got = valueOf(ended);
      if ("failed" in got) return got.failed;
      if (!Array.isArray(got.value["removed"]) || got.value["removed"].length !== 0) {
        return `removed a checkout without a forge observation: ${JSON.stringify(got.value)}`;
      }
      return null;
    },
    after: async (_f, context) => {
      const expected = context["cleanupCheckout"] as { id: string; head: string };
      const result = await api().call("git.worktree.get", { id: expected.id }, { label: "cleanup-checkout-kept" }) as { head?: string };
      if (result.head !== expected.head) throw new Error(`the fixture checkout ${expected.id} was changed or removed`);
    },
  },
  {
    builtin: "opening-a-pr",
    name: "makes the top of the stack ready for review",
    args: (f, context) => ({ ...playbook(f, "Open the page's pull request."), branch: top(context).branch, number: top(context).pr }),
    check: answered("opened", (value, context) => (value["pr"] === top(context).pr ? null : `opened ${JSON.stringify(value["pr"])}, not the branch's own pull request`)),
  },
  {
    builtin: "babysit",
    name: "checks the top of the stack and finds it ready",
    args: (f, context) => ({ ...playbook(f, "Watch the page's pull request."), pr: top(context).pr, mode: "check" }),
    check: answered("merge-ready"),
  },
  {
    builtin: "pause-safely",
    name: "checkpoints the top of the stack's worktree",
    args: (f, context) => ({ ...playbook(f, "Pause the page's work."), worktree: top(context).worktree }),
    check: answered("paused", (value) => (value["clean"] === true ? null : "the worktree was left with uncommitted work")),
  },
  {
    builtin: "session-pickup",
    name: "picks the first plan up from its trail",
    args: (f) => ({ ...playbook(f, "Where does the work stand?"), plan: `suite/${f.run}/parallel` }),
    check: answered("picked-up"),
  },
  ...(["trace-forensics", "runtime-forensics"] as const).map(
    (builtin): Scenario => ({
      builtin,
      name: "holds hypotheses against evidence",
      args: (f) => ({ ...playbook(f, "The README describes the service wrongly: why?"), ...(builtin === "trace-forensics" ? { trace: "README.md" } : {}) }),
      check: (ended) => {
        const got = valueOf(ended);
        if ("failed" in got) return got.failed;
        return (got.value["hypotheses"] ?? []).length > 0 ? null : "no hypothesis was held";
      },
    }),
  ),
  ...(["bug-fix", "feature", "refactoring", "authoring-a-skill", "visual-parity", "perf-issue"] as const).map(
    (builtin): Scenario => ({
      builtin,
      name: "carries a change to a verified pull request",
      args: (f) => playbook(f, `A small ${builtin} on the README of the fixture.`),
      check: answered("verified", (value) => (builtin === "perf-issue" && value["after"] === null ? "the fix was not measured" : null)),
    }),
  ),
  {
    builtin: "autonomous-run",
    name: "drives a change until its predicate holds",
    args: (f) => ({ ...playbook(f, "Add a change note."), predicate: "ls change-*.md >/dev/null 2>&1", max: 3 }),
    check: answered("met"),
  },
  {
    builtin: "hillclimb",
    name: "keeps changes that move the metric",
    args: (f) => ({ ...playbook(f, "Add change notes."), metric: "ls change-*.md 2>/dev/null | wc -l", direction: "higher", target: 2, min: 2, max: 4 }),
    check: answered("reached"),
  },
  {
    builtin: "prototype",
    name: "settles a decision with variants",
    args: (f) => playbook(f, "Should the README lead with usage or with the architecture?"),
    check: answered("decided", (value) => ((value["variants"] ?? []).length >= 2 ? null : "fewer than two variants were built")),
  },
  {
    builtin: "eval",
    name: "grades two variants blind",
    args: async (f) => {
      const seats = (await api().call("pstack.roles", {}, { label: "eval-roles" })) as { lead: { harness: string }; reviewer: { harness: string } };
      return { ...playbook(f, "Which seat explains the README better?"), variants: { lead: seats.lead.harness, reviewer: seats.reviewer.harness } };
    },
    check: answered("judged", (value) => (Object.keys(value["table"] ?? {}).length === 2 ? null : "not every variant was graded")),
  },
  {
    builtin: "upstream-sync",
    name: "carries the map of a reworded upstream to its new snapshot",
    args: (f, context) => seedSync(f, context),
    check: answered("synced", (value) => {
      if (value["summary"]?.touched !== 0 || value["summary"]?.textProblems !== 0) return `the map was not settled: ${JSON.stringify(value["summary"])}`;
      return (value["changed"] ?? []).some((file: string) => file.endsWith("texts/worker.json")) ? null : "the texts were not assembled from the map";
    }),
    after: async (_f, context) => {
      const seeded = context["sync"] as { up: string; pkg: string } | undefined;
      if (seeded === undefined) return;
      for (const id of [seeded.pkg, seeded.up]) await api().call("git.worktree.remove", { id, force: true }, { label: `sync-clean-${id}` });
    },
  },
  {
    builtin: "benny-triage",
    name: "triages a bug report as a bug",
    args: (f) => ({ id: "suite", type: "benny.reported", data: { report: REPORT, repo: f.repo, worktrees: f.worktrees, base: f.base } }),
    check: (ended, context) => {
      const got = valueOf(ended);
      if ("failed" in got) return got.failed;
      if (got.value["verdict"] !== "bug") return `the report was triaged as ${JSON.stringify(got.value["verdict"])}`;
      context["triaged"] = got.value;
      return null;
    },
  },
  {
    builtin: "benny-reproduce",
    name: "reproduces a triaged bug and fixes it in a draft",
    args: (f, context) => {
      const triaged = context["triaged"] as Record<string, unknown> | undefined;
      if (triaged === undefined) throw new Error("no report was triaged by an earlier scenario");
      return { id: "suite", type: "wf.pstack-benny-triage.triaged", data: { report: REPORT, ...triaged, repo: f.repo, worktrees: f.worktrees, base: f.base } };
    },
    check: answered("verified"),
  },
];

/** A tiny upstream pstack, as a checkout holds it, and the same one reworded: what the sync scenario carries the map across. */
const SYNC_UPSTREAM: Record<string, string> = {
  LICENSE: "MIT License\n",
  "skills/poteto-mode/SKILL.md": "# Mode\n\nAlpha block.\n",
  "skills/poteto-mode/worker.md": "Work for the operator.\n",
  "skills/poteto-mode/playbooks/bug-fix.md": "### Bug fix\n\nReproduce it.\n\nFix the cause.\n",
};
const SYNC_REWORDED = { "skills/poteto-mode/worker.md": "Work for the operator, always.\n" };

/** The files of the snapshot the checkout above gives, by their paths in it, and what the sync's map does with each. */
const SYNC_SNAPSHOT: Array<{ file: string; from: string; kind: "dropped" | "prompt" }> = [
  { file: "poteto-mode/SKILL.md", from: "skills/poteto-mode/SKILL.md", kind: "dropped" },
  { file: "poteto-mode/worker.md", from: "skills/poteto-mode/worker.md", kind: "prompt" },
  { file: "poteto-mode/playbooks/bug-fix.md", from: "skills/poteto-mode/playbooks/bug-fix.md", kind: "prompt" },
];

/** A worktree of the fixture's repository, for the scenario to seed. */
async function seedWorktree(key: string, f: Fixture, what: string): Promise<{ id: string; path: string; branch: string }> {
  return (await api().call("git.worktree.create", { repo: f.repo.local, base: f.base, description: what }, { label: key })) as { id: string; path: string; branch: string };
}

/** Write a file in a worktree and answer nothing: a command in a box that writes only there. */
async function seedFile(key: string, cwd: string, file: string, text: string): Promise<void> {
  const ran = (await api().call("proc.run", { cmd: ["sh", "-c", 'mkdir -p "$(dirname "$1")" && printf %s "$2" > "$1"', "sh", file, text], cwd, timeout: 60_000 }, { label: key })) as { exit: number | null; tail: string };
  if (ran.exit !== 0) throw new Error(`${file} was not written in ${cwd}: ${ran.tail.slice(-300)}`);
}

/** Commit what is under `paths` in a seeded worktree, on the host (the plugin's own step): the commit. */
async function seedCommit(key: string, place: string, message: string, paths: string[]): Promise<string> {
  return ((await api().call("pstack.upstream.commit", { place, message, paths }, { label: key })) as { head: string }).head;
}

/**
 * What the sync scenario seeds: an upstream checkout of one worktree, and a branch of the fixture's repository whose
 * package folder holds the snapshot of it and a map that covers the snapshot. Upstream is then reworded, so the sync has
 * a real round of work: the entry that holds the reworded block is touched.
 */
async function seedSync(f: Fixture, context: Context): Promise<unknown> {
  const up = await seedWorktree("sync-up", f, "A tiny upstream pstack for the sync");
  for (const [index, [file, text]] of Object.entries(SYNC_UPSTREAM).entries()) await seedFile(`sync-up-${String(index)}`, up.path, file, text);
  const first = await seedCommit("sync-up-commit", up.path, "Upstream pstack", ["LICENSE", "skills"]);
  const pkg = await seedWorktree("sync-pkg", f, "A tiny pstack package for the sync");
  const oursCommit = ((await api().call("pstack.upstream.state", { place: pkg.path }, { label: "sync-pkg-head" })) as { head: string }).head;
  await api().call("pstack.upstream.refresh", { place: pkg.path, checkout: up.path, commit: first, package: "packages/pstack" }, { label: "sync-pkg-snapshot" });
  const entries = SYNC_SNAPSHOT.map((one, index) => {
    const text = SYNC_UPSTREAM[one.from] as string;
    const upstream = { commit: first, file: one.file, range: [0, text.length] };
    return one.kind === "dropped"
      ? { id: `skill:${String(index)}`, upstream, ours: [], kind: "dropped", note: "Not taken: a skill of Cursor's." }
      : { id: `${one.file.split("/").at(-1)?.replace(/\.md$/, "") ?? one.file}:01`, upstream, ours: [{ commit: oursCommit, file: "README.md", range: [0, 1] }], kind: "prompt" };
  });
  await seedFile("sync-pkg-map", pkg.path, "packages/pstack/upstream/mapping.json", `${JSON.stringify({ entries }, null, 2)}\n`);
  await seedCommit("sync-pkg-commit", pkg.path, "Snapshot and map", ["packages"]);
  for (const [index, [file, text]] of Object.entries(SYNC_REWORDED).entries()) await seedFile(`sync-reword-${String(index)}`, up.path, file, text);
  await seedCommit("sync-up-reword", up.path, "Reword upstream", ["skills"]);
  context["sync"] = { up: up.id, pkg: pkg.id };
  return { repo: { local: f.repo.local }, worktrees: f.worktrees, base: pkg.branch, upstream: { checkout: up.path } };
}

/** What Benny is handed in the scenarios: a report of a bug in the fixture. */
const REPORT = "The README calls the service payroll; it is the billing service.";

/** The top of the stack an earlier scenario verified. */
function top(context: Context): { pr: number; branch: string; worktree: string } {
  const stacked = context["stacked"] as Array<{ pr: number; branch: string; worktree: string }> | undefined;
  const found = stacked?.at(-1);
  if (found === undefined) throw new Error("no stack was verified by an earlier scenario");
  return found;
}

function gatedLanding(result?: { outcome: string; missing?: Array<{ name: string; why: string }> }): boolean {
  return result?.outcome === "refused" && result.missing?.length === 1 && result.missing[0]?.name === "land"
    && result.missing[0].why === "forge cannot condition a merge on the target commit";
}
