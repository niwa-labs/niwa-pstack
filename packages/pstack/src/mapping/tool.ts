/**
 * The map tool on a package folder: what `scripts/upstream-map.ts` does by hand and what the pstack plugin does for
 * the sync in a worktree. Every path comes from the package folder it is given, so the same code serves this package
 * and the copy of it in a worktree, and nothing here knows which.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import type { PackagePaths } from "../upstream.ts";
import { analyze } from "./analyze.ts";
import type { Report } from "./analyze.ts";
import { assemble, jsonOf, writeTexts } from "./assemble.ts";
import type { AssembledText } from "./assemble.ts";
import { accept, advance } from "./maintain.ts";
import { formatMapping, parseMapping } from "./schema.ts";
import type { Mapping } from "./schema.ts";
import { OursTexts, UpstreamTexts, WORKTREE } from "./sources.ts";
import { verifyTextsIn } from "./verify.ts";

/** What the tool works on: a package folder, the repository it is in, and where upstream's older commits are read from. */
export interface ToolContext {
  readonly paths: PackagePaths;
  /** The root of the repository the package folder is in: our side of the map is read from it. */
  readonly root: string;
  /** A checkout of upstream, needed only while the map has ranges at an upstream commit other than the snapshot's. */
  readonly checkout?: string;
  /** The revision of ours the map is measured against: HEAD by default, or `WORKTREE` for the files on disk. */
  readonly head?: string;
  /** Another file than the package's own mapping. */
  readonly map?: string;
}

/** Read the map and measure it, texts included. A map that cannot be read throws. */
export function openMap(ctx: ToolContext): { upstream: UpstreamTexts; ours: OursTexts; mapping: Mapping; report: Report } {
  const upstream = new UpstreamTexts(ctx.paths.upstream, ctx.checkout === undefined ? undefined : resolve(ctx.checkout));
  const ours = new OursTexts(ctx.root, ctx.head ?? "HEAD");
  const mapping = parseMapping(readFileSync(ctx.map ?? ctx.paths.mapping, "utf8"));
  return { upstream, ours, mapping, report: { ...analyze(mapping, upstream, ours), texts: verifyTextsIn(mapping, upstream, ours, ctx.paths.texts) } };
}

/** Record the entries that are unchanged, and then the named ones, at the positions their ranges were carried to: how many entries changed. */
export function recordMap(ctx: ToolContext, ids: readonly string[] | "unchanged"): number {
  const { mapping, report } = openMap(ctx);
  if (report.problems.length > 0) throw new Error(`the mapping has ${String(report.problems.length)} problems: run check`);
  const next = ids === "unchanged" ? advance(mapping, report) : accept(mapping, report, ids);
  writeFileSync(ctx.paths.mapping, formatMapping(next));
  return next.entries.filter((one, index) => JSON.stringify(one) !== JSON.stringify(mapping.entries[index])).length;
}

/** The texts the map assembles. */
export function assembledTexts(ctx: ToolContext): AssembledText[] {
  const { mapping, upstream, ours } = openMap(ctx);
  return assemble(mapping, upstream, ours);
}

/** The names of the texts on disk that differ from the ones the map assembles. */
export function differingTexts(ctx: ToolContext): string[] {
  return assembledTexts(ctx)
    .filter((one) => {
      try {
        return readFileSync(join(ctx.paths.texts, `${one.name}.json`), "utf8") !== jsonOf(one);
      } catch {
        return true;
      }
    })
    .map((one) => one.name);
}

/** Write the texts the map assembles: how many. */
export function writeAssembled(ctx: ToolContext): number {
  const made = assembledTexts(ctx);
  writeTexts(made, ctx.paths.texts);
  return made.length;
}

export { WORKTREE };
