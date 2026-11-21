/**
 * Git read in a checkout through `proc.run`: the command runs in the checkout, boxed to it, with no network. What
 * pstack reads of a repository it reads this way, so a run needs no right but `proc.run` on its worktrees.
 */

import { api } from "./script.ts";

/** What a git command answered: its exit and the end of its output. */
export interface GitRan {
  exit: number | null;
  out: string;
  truncated: boolean;
}

/** Run git in a checkout. */
export async function gitRun(key: string, cwd: string, args: readonly string[]): Promise<GitRan> {
  const ran = (await api().call("proc.run", { cmd: ["git", ...args], cwd, timeout: 60_000 }, { label: key })) as { exit: number | null; tail: string; truncated: boolean };
  return { exit: ran.exit, out: ran.tail, truncated: ran.truncated };
}

/** Run git in a checkout and answer its output, trimmed; a command that fails throws. */
export async function gitOut(key: string, cwd: string, args: readonly string[]): Promise<string> {
  const ran = await gitRun(key, cwd, args);
  if (ran.exit !== 0) throw new Error(`git ${args.join(" ")} failed (${String(ran.exit)}): ${ran.out.trim().slice(-500)}`);
  if (ran.truncated) throw new Error(`git ${args.join(" ")} answered more than a read keeps`);
  return ran.out.trim();
}

/** The lines of an output, without empty ones. */
export const linesOf = (text: string): string[] => text.split("\n").map((line) => line.trim()).filter((line) => line !== "");
