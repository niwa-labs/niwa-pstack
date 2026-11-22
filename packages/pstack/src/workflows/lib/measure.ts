/**
 * Commands a playbook runs in a worktree to decide something: a measurement whose last number is the metric, or a
 * predicate whose exit says whether it holds. They run through `proc.run`, boxed to the worktree.
 */

import { api } from "./script.ts";

/** What a command answered: its exit and the end of its output. */
export interface Ran {
  exit: number | null;
  out: string;
}

/** Run a shell command in a worktree. */
export async function shell(key: string, cwd: string, command: string, timeout = 600_000): Promise<Ran> {
  const ran = (await api().call("proc.run", { cmd: ["sh", "-c", command], cwd, timeout }, { label: key })) as { exit: number | null; tail: string };
  return { exit: ran.exit, out: ran.tail };
}

/** The metric a measurement printed: the last number of its output, or null when it printed none or failed. */
export function metricOf(ran: Ran): number | null {
  if (ran.exit !== 0) return null;
  const numbers = ran.out.match(/-?\d+(?:\.\d+)?(?:e[-+]?\d+)?/gi);
  const last = numbers?.at(-1);
  const value = Number(last);
  return Number.isFinite(value) ? value : null;
}

/** Run a measurement in a worktree: its metric. */
export async function measure(key: string, cwd: string, command: string): Promise<number | null> {
  return metricOf(await shell(key, cwd, command));
}

/** Whether `after` is better than `before` in the direction that counts. */
export const better = (after: number, before: number, direction: "lower" | "higher"): boolean => (direction === "lower" ? after < before : after > before);
