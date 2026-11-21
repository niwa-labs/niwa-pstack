/**
 * What happened to a range of characters when a text changed.
 *
 * The two texts are compared by lines, and inside each block of lines that differs by the characters the old and the
 * new block share at their start and at their end. What is left between is the change. A range that lies wholly in
 * the text the two share is unchanged: it only shifted. A range with a change inside it, or at its edge, is touched,
 * and it follows the change to the new text. A range whose characters are all removed is gone. Offsets are positions
 * in the string, UTF-16 code units, as `String.prototype.slice` counts them.
 */

/** A start and an end offset: the characters from start up to, not including, end. */
export type Span = readonly [start: number, end: number];

/** One stretch of the old text and the stretch of the new text that stands for it. */
export interface Segment {
  readonly oldStart: number;
  readonly oldEnd: number;
  readonly newStart: number;
  readonly newEnd: number;
  /** Whether both stretches are the same text. */
  readonly same: boolean;
}

/** What happened to a range. */
export type Carried = { readonly status: "unchanged"; readonly range: Span } | { readonly status: "touched"; readonly range: Span } | { readonly status: "gone" };

/** Beyond this many line pairs the lines are not compared one by one: the whole text counts as changed. */
const MAX_PAIRS = 16_000_000;

/** The lines of a text, each with its newline, and the offset each starts at. */
function linesOf(text: string): { lines: string[]; starts: number[] } {
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const starts: number[] = [];
  let at = 0;
  for (const line of lines) {
    starts.push(at);
    at += line.length;
  }
  starts.push(at);
  return { lines, starts };
}

/** The pairs of equal lines of a longest common subsequence of two line lists, as indexes. */
function commonLines(a: readonly string[], b: readonly string[]): Array<[number, number]> {
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail += 1;
  const pairs: Array<[number, number]> = [];
  for (let i = 0; i < head; i += 1) pairs.push([i, i]);
  const n = a.length - head - tail;
  const m = b.length - head - tail;
  if (n > 0 && m > 0 && n * m <= MAX_PAIRS) {
    // table[i][j]: the length of the longest common subsequence of the middle of a from i and of b from j.
    const width = m + 1;
    const table = new Uint32Array((n + 1) * width);
    for (let i = n - 1; i >= 0; i -= 1) {
      for (let j = m - 1; j >= 0; j -= 1) {
        table[i * width + j] = a[head + i] === b[head + j] ? (table[(i + 1) * width + j + 1] as number) + 1 : Math.max(table[(i + 1) * width + j] as number, table[i * width + j + 1] as number);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (a[head + i] === b[head + j]) {
        pairs.push([head + i, head + j]);
        i += 1;
        j += 1;
      } else if ((table[(i + 1) * width + j] as number) >= (table[i * width + j + 1] as number)) i += 1;
      else j += 1;
    }
  }
  for (let i = 0; i < tail; i += 1) pairs.push([a.length - tail + i, b.length - tail + i]);
  return pairs;
}

/** Add a segment, joining it to the one before when both are the same text. */
function push(into: Segment[], next: Segment): void {
  if (next.oldStart === next.oldEnd && next.newStart === next.newEnd) return;
  const last = into.at(-1);
  if (last !== undefined && last.same && next.same) into[into.length - 1] = { ...last, oldEnd: next.oldEnd, newEnd: next.newEnd };
  else into.push(next);
}

/** Compare two texts: segments that cover both, in order, the same text and the changed text between. */
export function diffText(before: string, after: string): Segment[] {
  const segments: Segment[] = [];
  if (before === after) {
    push(segments, { oldStart: 0, oldEnd: before.length, newStart: 0, newEnd: after.length, same: true });
    return segments;
  }
  const a = linesOf(before);
  const b = linesOf(after);
  const pairs = commonLines(a.lines, b.lines);
  // Changed blocks of lines sit between the pairs of equal ones.
  let oldAt = 0;
  let newAt = 0;
  const changed = (oldTo: number, newTo: number): void => {
    const oldStart = a.starts[oldAt] as number;
    const oldEnd = a.starts[oldTo] as number;
    const newStart = b.starts[newAt] as number;
    const newEnd = b.starts[newTo] as number;
    if (oldStart === oldEnd && newStart === newEnd) return;
    const from = before.slice(oldStart, oldEnd);
    const to = after.slice(newStart, newEnd);
    let head = 0;
    while (head < from.length && head < to.length && from[head] === to[head]) head += 1;
    let tail = 0;
    while (tail < from.length - head && tail < to.length - head && from[from.length - 1 - tail] === to[to.length - 1 - tail]) tail += 1;
    push(segments, { oldStart, oldEnd: oldStart + head, newStart, newEnd: newStart + head, same: true });
    push(segments, { oldStart: oldStart + head, oldEnd: oldEnd - tail, newStart: newStart + head, newEnd: newEnd - tail, same: false });
    push(segments, { oldStart: oldEnd - tail, oldEnd, newStart: newEnd - tail, newEnd, same: true });
  };
  for (const [i, j] of pairs) {
    changed(i, j);
    push(segments, { oldStart: a.starts[i] as number, oldEnd: a.starts[i + 1] as number, newStart: b.starts[j] as number, newEnd: b.starts[j + 1] as number, same: true });
    oldAt = i + 1;
    newAt = j + 1;
  }
  changed(a.lines.length, b.lines.length);
  return segments;
}

/** The segment that holds the old character at an offset. */
function holding(segments: readonly Segment[], offset: number): Segment | undefined {
  return segments.find((one) => one.oldStart <= offset && offset < one.oldEnd);
}

/** Follow a range of the old text into the new one. */
export function carry(segments: readonly Segment[], range: Span): Carried {
  const [start, end] = range;
  const first = holding(segments, start);
  const last = holding(segments, end - 1);
  if (first === undefined || last === undefined) return { status: "gone" };
  if (first === last && first.same) return { status: "unchanged", range: [first.newStart + (start - first.oldStart), first.newStart + (end - first.oldStart)] };
  const newStart = first.same ? first.newStart + (start - first.oldStart) : first.newStart;
  const newEnd = last.same ? last.newStart + (end - last.oldStart) : last.newEnd;
  return newStart >= newEnd ? { status: "gone" } : { status: "touched", range: [newStart, newEnd] };
}
