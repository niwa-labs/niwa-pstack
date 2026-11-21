/**
 * The built-in workflows pstack ships: the entry, one script per upstream playbook, and the suite that tries a new
 * set of them before the host runs it.
 *
 * Every script but the suite is gated: a new version of it comes in as a candidate, and the host runs it only once
 * the suite has run its scenarios on the candidates and promoted the set. The suite itself is not gated, for it is
 * what promotes.
 */

import { fileURLToPath } from "node:url";

/** One built-in, as pstack offers it to the workflow module. */
export interface Builtin {
  /** Its name among pstack's built-ins: the playbook's name for a playbook. */
  readonly name: string;
  /** A few words on one line: what it is registered under. */
  readonly description: string;
  /** The record types its `on` names, other than script records. */
  readonly triggers?: readonly string[];
}

/** The folder of the scripts. */
const WORKFLOWS = new URL("./workflows/", import.meta.url);

/** The script of a built-in. */
export const scriptOf = (name: string): string => fileURLToPath(new URL(`${name}.ts`, WORKFLOWS));

/** The name of the entry. */
export const ENTRY = "entry";

/** The name of the suite. */
export const SUITE = "suite";

/** The playbooks, by the name of their upstream file. */
export const PLAYBOOKS: readonly Builtin[] = [
  { name: "authoring-a-skill", description: "Write or change a skill and carry it to a pull request" },
  { name: "autonomous-run", description: "Drive a change until its done predicate holds" },
  { name: "autopilot-full", description: "Carry a plan with the go to merged pull requests" },
  { name: "autopilot-stack", description: "Carry a plan to verified, stacked pull requests" },
  { name: "babysit", description: "Clear one pull request's conflicts, threads and CI" },
  { name: "bug-fix", description: "Find a bug's cause and carry its fix to a pull request" },
  { name: "eval", description: "Compare variants blind on a rubric they never see" },
  { name: "feature", description: "Design a feature and carry it to a verified pull request" },
  { name: "hillclimb", description: "Improve one metric an attempt at a time" },
  { name: "investigation", description: "Answer a question about the code with cited sources" },
  { name: "multi-phase-plan", description: "Write a plan of pull requests and ask the owner's go" },
  { name: "opening-a-pr", description: "Open a ready pull request for a published branch" },
  { name: "pause-safely", description: "Stop cleanly with a checkpoint to resume from" },
  { name: "perf-issue", description: "Measure a slow path, fix it, and measure the fix" },
  { name: "prototype", description: "Settle a design decision with throwaway variants" },
  { name: "refactoring", description: "Reshape code behind a pinned contract" },
  { name: "runtime-forensics", description: "Find the cause of a symptom from the program running" },
  { name: "session-pickup", description: "Pick up work from the trail niwa keeps of it" },
  { name: "shipping", description: "Land a verified stack bottom up under the merge policy" },
  { name: "trace-forensics", description: "Read a trace for the cause of a symptom" },
  { name: "visual-parity", description: "Match a surface to its reference and verify it live" },
  { name: "worktree-cleanup", description: "Remove the worktrees a merged pull request was built in", triggers: ["forge.pr.merged"] },
];

/** Benny's two automations, offered when Benny is enabled: triage every report, reproduce and fix a confirmed bug. */
export const BENNY: readonly Builtin[] = [
  { name: "benny-triage", description: "Triage an issue report handed to Benny", triggers: ["benny.reported"] },
  { name: "benny-reproduce", description: "Reproduce a confirmed bug and fix it in a draft request" },
];

/** The built-ins that come in as candidates: the entry and the playbooks. */
export const GATED: readonly Builtin[] = [{ name: ENTRY, description: "Pick the playbook a request needs and run it" }, ...PLAYBOOKS];

/** The suite: it is what promotes, so it is not gated. */
export const SUITE_BUILTIN: Builtin = { name: SUITE, description: "Run the scenarios on candidate playbooks and promote them" };

/** The gated built-ins a pstack plugin offers: Benny's too when he is enabled. */
export const gatedOf = (benny: boolean): readonly Builtin[] => (benny ? [...GATED, ...BENNY] : GATED);
