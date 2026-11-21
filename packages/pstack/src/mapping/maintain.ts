/**
 * Bookkeeping on the mapping that follows from a measurement and decides nothing: re-recording entries at the
 * positions their ranges were carried to. Which entries to re-record is the caller's call.
 */

import type { EntryMove, Report } from "./analyze.ts";
import { WORKTREE } from "./sources.ts";
import type { Entry, Mapping } from "./schema.ts";

/** An entry as the measurement carried it to the current commits; throws when a side of it is gone. */
function recorded(entry: Entry, move: EntryMove): Entry {
  const upstream = move.upstream.to;
  const ours = move.ours.map((one) => one.to);
  if (upstream === undefined || ours.some((one) => one === undefined)) throw new Error(`${entry.id} has a range that is gone: link it again by hand, or drop it`);
  return { ...entry, upstream, ours: ours as NonNullable<(typeof ours)[number]>[] };
}

function current(report: Report): void {
  if (report.ours.head === WORKTREE) throw new Error("the ranges of ours are measured against the working tree: commit, and measure against the commit, before recording them");
}

/** Record every entry that is unchanged at the current commits, at the positions its ranges were carried to. */
export function advance(mapping: Mapping, report: Report): Mapping {
  current(report);
  const unchanged = new Map(report.entries.filter((one) => one.status === "unchanged").map((one) => [one.id, one]));
  return { entries: mapping.entries.map((entry) => (unchanged.has(entry.id) ? recorded(entry, unchanged.get(entry.id) as EntryMove) : entry)) };
}

/** Record the named entries, touched or not, at the positions their ranges were carried to. */
export function accept(mapping: Mapping, report: Report, ids: readonly string[]): Mapping {
  current(report);
  const moves = new Map(report.entries.map((one) => [one.id, one]));
  for (const id of ids) if (!moves.has(id)) throw new Error(`${id} is not an entry of the mapping, or the mapping is not valid for it`);
  const wanted = new Set(ids);
  return { entries: mapping.entries.map((entry) => (wanted.has(entry.id) ? recorded(entry, moves.get(entry.id) as EntryMove) : entry)) };
}
