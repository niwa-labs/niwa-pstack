/**
 * What the mapping says now, measured and not judged: whether it is consistent, how much of the upstream text it
 * covers, and what became of each entry's ranges since the commits they were recorded at.
 *
 * Every range is followed from its recorded commit to the current one, on each side: the upstream side from the
 * commit it was recorded at to the commit of the snapshot, our side from the commit it was recorded at to the head
 * of this repository. The carried upstream ranges are what coverage counts. Nothing here concludes anything: a
 * touched range comes with its old and new text, and what it means is for the reader to say.
 */

import { carry, diffText } from "./diff.ts";
import type { Segment, Span } from "./diff.ts";
import type { Entry, Mapping, Ref } from "./schema.ts";
import type { Texts, UpstreamTexts } from "./sources.ts";

/** Something the mapping gets wrong about itself. */
export interface Problem {
  readonly entry?: string;
  readonly message: string;
}

/** What became of one range. */
export interface Moved {
  readonly status: "unchanged" | "touched" | "gone";
  readonly from: Ref;
  /** Where the range is now; absent when it is gone. */
  readonly to?: Ref;
  /** The text of a touched range as it was recorded, and as it reads now. */
  readonly old?: string;
  readonly new?: string;
}

/** What became of one entry: the worst of its sides. */
export interface EntryMove {
  readonly id: string;
  readonly kind: Entry["kind"];
  readonly status: "unchanged" | "touched" | "gone";
  readonly upstream: Moved;
  readonly ours: readonly Moved[];
  readonly note?: string;
}

/** A run of upstream characters no entry covers. */
export interface Uncovered {
  readonly start: number;
  readonly end: number;
  readonly text: string;
  /** Whether the text is not in upstream at the oldest commit the mapping was recorded at. */
  readonly added: boolean;
}

/** How much of one upstream file the entries cover. */
export interface FileCoverage {
  readonly file: string;
  readonly size: number;
  readonly covered: number;
  readonly percent: number;
  readonly uncovered: readonly Uncovered[];
}

/** The measurement. */
export interface Report {
  readonly upstream: { readonly commit: string };
  readonly ours: { readonly head: string };
  readonly problems: readonly Problem[];
  /** What is wrong with the texts the scripts import, held to the map: measured apart, for they follow the map and lag it. */
  readonly texts: readonly Problem[];
  readonly coverage: { readonly size: number; readonly covered: number; readonly percent: number; readonly files: readonly FileCoverage[] };
  readonly entries: readonly EntryMove[];
  /** The entries that are not unchanged. */
  readonly unresolved: number;
}

const percentOf = (part: number, whole: number): number => (whole === 0 ? 100 : (part / whole) * 100);

/** The problems of the mapping in itself: its entries, and its ranges at the commits they were recorded at. */
function validate(mapping: Mapping, upstream: UpstreamTexts, ours: Texts): { problems: Problem[]; sound: Set<string> } {
  const problems: Problem[] = [];
  const bad = new Set<string>();
  const complain = (entry: Entry, message: string): void => {
    problems.push({ entry: entry.id, message });
    bad.add(entry.id);
  };
  const seen = new Set<string>();
  const inside = (entry: Entry, side: string, ref: Ref, texts: Texts): void => {
    const text = texts.at(ref.commit, ref.file);
    if (text === undefined) complain(entry, `${side} file ${ref.file} does not exist at ${ref.commit}`);
    else if (ref.range[1] > text.length) complain(entry, `${side} range [${ref.range.join(", ")}) is outside ${ref.file} at ${ref.commit}, which has ${String(text.length)} characters`);
  };
  const scope = new Set(upstream.files());
  for (const entry of mapping.entries) {
    if (seen.has(entry.id)) complain(entry, "the id is used by another entry");
    seen.add(entry.id);
    if (entry.kind === "dropped") {
      if (entry.note === undefined) complain(entry, "a dropped entry says why in its note");
      if (entry.ours.length > 0) complain(entry, "a dropped entry has no range of ours");
    } else if (entry.ours.length === 0) complain(entry, `a ${entry.kind} entry links to the ranges of ours that carry it`);
    if (upstream.same(entry.upstream.commit, upstream.current) && !scope.has(entry.upstream.file)) complain(entry, `${entry.upstream.file} is not an upstream file of the snapshot`);
    else inside(entry, "upstream", entry.upstream, upstream);
    for (const link of entry.ours) inside(entry, "our", link, ours);
  }
  // Upstream ranges recorded at one commit of one file must not overlap: a character belongs to one entry.
  const groups = new Map<string, Array<{ entry: Entry; range: Span }>>();
  for (const entry of mapping.entries) {
    if (bad.has(entry.id)) continue;
    const key = `${upstream.same(entry.upstream.commit, upstream.current) ? upstream.current : entry.upstream.commit}\0${entry.upstream.file}`;
    groups.set(key, [...(groups.get(key) ?? []), { entry, range: entry.upstream.range }]);
  }
  for (const group of groups.values()) {
    const sorted = [...group].sort((a, b) => a.range[0] - b.range[0] || a.range[1] - b.range[1]);
    let reach = sorted[0];
    for (const next of sorted.slice(1)) {
      if (reach !== undefined && next.range[0] < reach.range[1]) {
        problems.push({ entry: next.entry.id, message: `the upstream range overlaps the one of ${reach.entry.id}` });
        bad.add(next.entry.id);
      }
      if (reach === undefined || next.range[1] > reach.range[1]) reach = next;
    }
  }
  return { problems, sound: new Set(mapping.entries.map((one) => one.id).filter((id) => !bad.has(id))) };
}

/** Follows ranges from the commits they were recorded at to the current one, side by side. */
class Mover {
  private readonly moves = new Map<string, Map<string, string | null>>();
  private readonly segments = new Map<string, Segment[]>();

  constructor(private readonly texts: Texts) {}

  /** The segments from a file at a commit to its current path, or null when the file is gone. */
  diff(commit: string, file: string): { file: string; segments: Segment[] } | null {
    if (!this.moves.has(commit)) this.moves.set(commit, this.texts.moved(commit));
    const moved = this.moves.get(commit) as Map<string, string | null>;
    const now = moved.has(file) ? (moved.get(file) as string | null) : file;
    if (now === null) return null;
    const key = `${commit}\0${file}\0${now}`;
    if (!this.segments.has(key)) {
      const before = this.texts.at(commit, file);
      const after = this.texts.at(this.texts.current, now);
      if (before === undefined || after === undefined) return null;
      this.segments.set(key, diffText(before, after));
    }
    return { file: now, segments: this.segments.get(key) as Segment[] };
  }

  /** What became of one range. */
  move(ref: Ref): Moved {
    if (this.texts.same(ref.commit, this.texts.current)) return { status: "unchanged", from: ref, to: ref };
    const found = this.diff(ref.commit, ref.file);
    if (found === null) return { status: "gone", from: ref };
    const carried = carry(found.segments, ref.range);
    if (carried.status === "gone") return { status: "gone", from: ref };
    const to: Ref = { commit: this.texts.current, file: found.file, range: [carried.range[0], carried.range[1]] };
    if (carried.status === "unchanged") return { status: "unchanged", from: ref, to };
    const before = this.texts.at(ref.commit, ref.file) as string;
    const after = this.texts.at(this.texts.current, found.file) as string;
    return { status: "touched", from: ref, to, old: before.slice(...ref.range), new: after.slice(...carried.range) };
  }
}

/** The worst status of a set of sides. */
function worst(upstream: Moved, ours: readonly Moved[]): EntryMove["status"] {
  if (upstream.status === "gone" || (ours.length > 0 && ours.every((one) => one.status === "gone"))) return "gone";
  return upstream.status === "unchanged" && ours.every((one) => one.status === "unchanged") ? "unchanged" : "touched";
}

/** The runs of characters of a text outside a set of ranges. */
function gaps(size: number, ranges: readonly Span[]): Span[] {
  const found: Span[] = [];
  let at = 0;
  for (const [start, end] of [...ranges].sort((a, b) => a[0] - b[0])) {
    if (start > at) found.push([at, start]);
    at = Math.max(at, end);
  }
  if (at < size) found.push([at, size]);
  return found;
}

/** Measure the mapping against the snapshot and this repository. */
export function analyze(mapping: Mapping, upstream: UpstreamTexts, ours: Texts): Report {
  const { problems, sound } = validate(mapping, upstream, ours);
  const upstreamMover = new Mover(upstream);
  const oursMover = new Mover(ours);
  const entries: EntryMove[] = [];
  for (const entry of mapping.entries) {
    if (!sound.has(entry.id)) continue;
    const up = upstreamMover.move(entry.upstream);
    const ourSides = entry.ours.map((link) => oursMover.move(link));
    entries.push({ id: entry.id, kind: entry.kind, status: worst(up, ourSides), upstream: up, ours: ourSides, ...(entry.note === undefined ? {} : { note: entry.note }) });
  }

  // The commits older than the snapshot that the mapping was recorded at: text not in them is new.
  const older = [...new Set(mapping.entries.map((one) => one.upstream.commit))].filter((commit) => !upstream.same(commit, upstream.current));
  const files: FileCoverage[] = [];
  for (const file of upstream.files()) {
    const text = upstream.at(upstream.current, file) as string;
    const ranges = entries.flatMap((one) => (one.upstream.to?.file === file ? [one.upstream.to.range] : []));
    const runs = gaps(text.length, ranges);
    const uncovered = runs.map(([start, end]): Uncovered => {
      const added =
        older.length > 0 &&
        older.every((commit) => {
          if (upstream.at(commit, file) === undefined) return true;
          const found = upstreamMover.diff(commit, file);
          return found === null || !found.segments.some((one) => one.same && one.newStart < end && start < one.newEnd);
        });
      return { start, end, text: text.slice(start, end), added };
    });
    const missing = uncovered.reduce((sum, one) => sum + (one.end - one.start), 0);
    files.push({ file, size: text.length, covered: text.length - missing, percent: percentOf(text.length - missing, text.length), uncovered });
  }
  const size = files.reduce((sum, one) => sum + one.size, 0);
  const covered = files.reduce((sum, one) => sum + one.covered, 0);
  return {
    upstream: { commit: upstream.current },
    ours: { head: ours.current },
    problems,
    texts: [],
    coverage: { size, covered, percent: percentOf(covered, size), files },
    entries,
    unresolved: entries.filter((one) => one.status !== "unchanged").length,
  };
}
