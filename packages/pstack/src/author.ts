/**
 * The author's box keeps its project writes in a worktree of niwa. The plugin checks the place and starts the
 * session with the forge hosts its caller's grant covers.
 */

import { existsSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";

import { CatchableError } from "@niwa-labs/core";

import type { Roles } from "./roles.ts";

/** Why the author was not started. */
export type AuthorRefusalCode = "no-box" | "no-place" | "not-a-worktree";

/** The author was not started: a refusal the run may catch. */
export class AuthorRefusal extends CatchableError {
  override name = "AuthorRefusal";
  override readonly code: AuthorRefusalCode;

  constructor(code: AuthorRefusalCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** The folder niwa's git module keeps its worktrees in. */
export const worktreesOf = (home: string): string => join(realpathSync(home), "worktrees");

/**
 * The real path of a place a role works in, checked before anything is read or written there: it exists and is one of
 * niwa's worktrees under `worktrees` (its real path, so a link cannot lead out). `who` names the role in the refusal.
 */
export function worktreePlace(who: string, place: string, worktrees: string): string {
  if (place.trim() === "" || !existsSync(place)) throw new AuthorRefusal("no-place", `${who} has no place to work in: ${JSON.stringify(place)} is not there`);
  const real = realpathSync(place);
  const root = existsSync(worktrees) ? realpathSync(worktrees) : worktrees;
  if (!real.startsWith(root + sep) || real.slice(root.length + 1).includes(sep)) {
    throw new AuthorRefusal("not-a-worktree", `${who}'s place ${real} is not one of niwa's worktrees under ${root}`);
  }
  return real;
}

/**
 * The launch of the author's session: its project is the worktree and its box also reaches the given forges.
 * Refused when the role carries no box or the place is outside `worktrees`.
 */
export function authorLaunch(
  author: Roles["author"],
  place: string,
  worktrees: string,
  forges: readonly string[],
): { place: string; box: { allow: Array<"project" | { net: string }> } } {
  if ((author as { box?: unknown }).box !== true) throw new AuthorRefusal("no-box", "the author role carries no box, and an author writes only in a box");
  const real = worktreePlace("the author", place, worktrees);
  return { place: real, box: { allow: ["project", ...forges.map((net) => ({ net }))] } };
}
