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
  pins: Record<string, string>;
  /** A name that is new to each run of the suite, for the plans its scenarios write. */
  run: string;
}

/** What the scenarios hand on to the ones after them. */
export type Context = Record<string, unknown>;

/** How a run of a built-in ended. */
export type Ended = { ok: true; value: unknown } | { ok: false; error: { name: string; message: string } };

/** A scenario: the built-in it runs, its name, the input it gives, and why its outcome fails, or null when it passes. */
export interface Scenario {
  builtin: string;
  name: string;
  args(fixture: Fixture, context: Context): unknown | Promise<unknown>;
  check(ended: Ended, context: Context): string | null;
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
    args: (f) => ({ request: "Where does this repository describe itself?", repo: f.repo, worktrees: f.worktrees, base: f.base, pins: f.pins }),
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
    name: "carries a plan with the go to merged pull requests",
    args: async (f, context) => {
      await goOn("parallel", f, written(context, "parallel"));
      return { ...playbook(f, "Carry out the plan."), plan: written(context, "parallel").plan.of };
    },
    check: answered("done", (value) => {
      const nodes = value["nodes"] as Array<{ node: string; landed?: { outcome: string } }>;
      const unlanded = nodes.filter((one) => one.landed?.outcome !== "merged");
      return nodes.length > 0 && unlanded.length === 0 ? null : `not landed: ${JSON.stringify(unlanded).slice(0, 500)}`;
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
    name: "lands the bottom of a verified stack once it has the go",
    args: async (f, context) => {
      const plan = written(context, "stack");
      await goOn("stack", f, plan);
      const [bottom] = context["stacked"] as Array<{ node: string; pr: number; author: unknown }>;
      if (bottom === undefined) throw new Error("no stack was verified by an earlier scenario");
      return { ...playbook(f, "Land the bottom of the stack."), plan: plan.plan.of, prs: [{ number: bottom.pr, nodes: [bottom.node], author: bottom.author }] };
    },
    check: answered("landed"),
  },
];
