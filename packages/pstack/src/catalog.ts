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
  { name: "investigation", description: "Answer a question about the code with cited sources" },
];

/** The built-ins that come in as candidates: the entry and the playbooks. */
export const GATED: readonly Builtin[] = [{ name: ENTRY, description: "Pick the playbook a request needs and run it" }, ...PLAYBOOKS];

/** The suite: it is what promotes, so it is not gated. */
export const SUITE_BUILTIN: Builtin = { name: SUITE, description: "Run the scenarios on candidate playbooks and promote them" };
