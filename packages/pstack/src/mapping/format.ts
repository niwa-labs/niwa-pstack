/** The measurement as text for a reader. The JSON form of a report is the report itself. */

import type { Moved, Report } from "./analyze.ts";

const pct = (value: number): string => `${value.toFixed(2)}%`;
const span = (ref: { file: string; range: readonly [number, number] }): string => `${ref.file} [${String(ref.range[0])}, ${String(ref.range[1])})`;
const quote = (text: string, limit: number): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return JSON.stringify(flat.length > limit ? `${flat.slice(0, limit)}...` : flat);
};

function side(label: string, moved: Moved, limit: number): string[] {
  const where = moved.to === undefined ? `${span(moved.from)} -> gone` : `${span(moved.from)} -> ${span(moved.to)}`;
  const lines = [`    ${label}: ${moved.status}: ${where}`];
  if (moved.status === "touched") lines.push(`      old: ${quote(moved.old ?? "", limit)}`, `      new: ${quote(moved.new ?? "", limit)}`);
  return lines;
}

/** The report as lines: coverage per file, the uncovered ranges, and the entries that are not unchanged. */
export function formatReport(report: Report, opts: { limit?: number } = {}): string {
  const limit = opts.limit ?? 240;
  const out: string[] = [`upstream snapshot ${report.upstream.commit}`, `ours head ${report.ours.head}`, ""];
  if (report.problems.length > 0) {
    out.push(`PROBLEMS ${String(report.problems.length)}`);
    for (const one of report.problems) out.push(`  ${one.entry === undefined ? "" : `${one.entry}: `}${one.message}`);
    out.push("");
  }
  out.push(`COVERAGE ${pct(report.coverage.percent)} (${String(report.coverage.covered)} of ${String(report.coverage.size)} characters)`);
  for (const file of report.coverage.files) out.push(`  ${pct(file.percent).padStart(8)}  ${String(file.covered).padStart(6)}/${String(file.size).padEnd(6)}  ${file.file}`);
  const uncovered = report.coverage.files.flatMap((file) => file.uncovered.map((one) => ({ file: file.file, ...one })));
  out.push("", `UNCOVERED ${String(uncovered.length)} ranges`);
  for (const one of uncovered) out.push(`  ${one.file} [${String(one.start)}, ${String(one.end)}) ${String(one.end - one.start)} characters${one.added ? " added" : ""}: ${quote(one.text, limit)}`);
  const count = (status: string): number => report.entries.filter((one) => one.status === status).length;
  out.push("", `ENTRIES ${String(report.entries.length)}: ${String(count("unchanged"))} unchanged, ${String(count("touched"))} touched, ${String(count("gone"))} gone`);
  for (const entry of report.entries.filter((one) => one.status !== "unchanged")) {
    out.push(`  ${entry.status} ${entry.id} (${entry.kind})${entry.note === undefined ? "" : `: ${entry.note}`}`);
    out.push(...side("upstream", entry.upstream, limit));
    for (const one of entry.ours) out.push(...side("ours", one, limit));
  }
  return `${out.join("\n")}\n`;
}

/** The numbers of a report, for a caller that reads them: coverage, and what is not settled. */
export function summaryOf(report: Report): { problems: number; coverage: number; files: Array<{ file: string; percent: number }>; entries: number; unchanged: number; touched: number; gone: number; uncovered: number } {
  const count = (status: string): number => report.entries.filter((one) => one.status === status).length;
  return {
    problems: report.problems.length,
    coverage: report.coverage.percent,
    files: report.coverage.files.map((one) => ({ file: one.file, percent: one.percent })),
    entries: report.entries.length,
    unchanged: count("unchanged"),
    touched: count("touched"),
    gone: count("gone"),
    uncovered: report.coverage.files.reduce((sum, one) => sum + one.uncovered.length, 0),
  };
}
