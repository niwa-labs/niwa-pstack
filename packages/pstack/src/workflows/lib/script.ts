/**
 * The globals of the script a helper runs in, read when the helper is called: the helpers import nothing of the
 * script runtime, only its types, so a stored copy of a script finds them as the script itself does.
 */

import type { AgentCallOptions, ScriptApi } from "@niwa-labs/script";

/** The globals of the script that calls a helper. */
export function api(): ScriptApi {
  const globals = globalThis as unknown as Partial<ScriptApi>;
  if (typeof globals.call !== "function" || typeof globals.agent !== "function") {
    throw new Error("pstack's helpers run inside a workflow script: call and agent are not globals here");
  }
  return globals as ScriptApi;
}

/** A repository as pstack's scripts are given it: where the forge serves it, and the local clone. */
export interface Repo {
  /** The host of the forge: `gitlab.example.com`. */
  host: string;
  /** The path of the project on it: `acme/billing`. */
  path: string;
  /** The real path of the local clone. */
  local: string;
}

/** The repository as forge's actions name it. */
export const forgeRepo = (repo: Repo): { host: string; path: string } => ({ host: repo.host, path: repo.path });

/** The subject of a pull request, as evidence names it: `gitlab.example.com/acme/billing/pr/7`. */
export const prSubject = (repo: Repo | { host: string; path: string }, number: number): string => `${repo.host}/${repo.path}/pr/${String(number)}`;

/** A seat of a role, as the options of an `agent()` call. */
export interface Seat {
  harness: string;
  vendor?: string;
  model?: string;
  effort?: string;
}

/** The roles, as `pstack.roles` answers them. */
export interface Roles {
  lead: Seat;
  author: Seat & { box: true };
  reviewer: Seat;
  verifier: Seat;
  judge?: Seat;
}

/** The roles the owner gave pstack. */
export async function roles(): Promise<Roles> {
  return (await api().call("pstack.roles", {}, { label: "roles" })) as Roles;
}

/** The options of an `agent()` call on a seat. */
export function seatOptions(seat: Seat): AgentCallOptions {
  return {
    harness: seat.harness,
    ...(seat.model === undefined ? {} : { model: seat.model }),
    ...(seat.effort === undefined ? {} : { effort: seat.effort }),
  };
}

/** The tag a prompt opens with: which step of which playbook it is, so a transcript shows where it came from. */
export const stepTag = (playbook: string, step: string): string => `[pstack:${playbook}:${step}]`;
