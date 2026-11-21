/**
 * The scenarios the suite runs on candidate built-ins before it promotes them.
 *
 * A scenario starts one built-in with input made from the suite's fixture (a repository the suite may change, on a
 * forge project it may merge into) and says what the outcome must show. Every gated built-in has at least one: a
 * candidate with none is not promoted.
 */

/** What the suite is started on: a repository it may work in, and the versions of the set it tries. */
export interface Fixture {
  repo: { host: string; path: string; local: string };
  worktrees: string;
  base: string;
  /** The version the suite tries of each built-in, by name. */
  pins: Record<string, string>;
}

/** How a run of a built-in ended, as a branch of a scope answers it. */
export type Ended = { ok: true; value: unknown } | { ok: false; error: { name: string; message: string } };

/** A scenario: the built-in it runs, its name, the input it gives, and why its outcome fails, or null when it passes. */
export interface Scenario {
  builtin: string;
  name: string;
  args(fixture: Fixture): unknown;
  check(ended: Ended): string | null;
}

/** The value of a run that ended well, or why it did not. */
function valueOf(ended: Ended): { value: Record<string, unknown> } | { failed: string } {
  if (!ended.ok) return { failed: `the run failed: ${ended.error.name}: ${ended.error.message}` };
  if (typeof ended.value !== "object" || ended.value === null) return { failed: `the run answered ${JSON.stringify(ended.value)}` };
  return { value: ended.value as Record<string, unknown> };
}

/** A check that the run answered a status, and whatever else `more` wants of the value. */
function answered(status: string, more: (value: Record<string, unknown>) => string | null = () => null): Scenario["check"] {
  return (ended) => {
    const got = valueOf(ended);
    if ("failed" in got) return got.failed;
    if (got.value["status"] !== status) return `the run answered status ${JSON.stringify(got.value["status"])}, not ${status}`;
    return more(got.value);
  };
}

const base = (f: Fixture, task: string) => ({ task, repo: f.repo, worktrees: f.worktrees, base: f.base });

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
    args: (f) => base(f, "Where does this repository describe itself?"),
    check: answered("answered", (value) => {
      const sources = (value["answer"] as { sources?: unknown[] } | undefined)?.sources ?? [];
      return sources.length > 0 ? null : "the answer cites no source";
    }),
  },
];
