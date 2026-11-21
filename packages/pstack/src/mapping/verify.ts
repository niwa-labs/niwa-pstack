/**
 * The texts the scripts give their sessions held to the map: a text equals the upstream files it is made of except
 * exactly where an `adapted` entry replaces a range with our wording and where a `dropped` entry takes a range out.
 * The files are read as they are on disk and compared with the snapshot and with the linked ranges of ours, so a text
 * edited by hand, an upstream range no entry accounts for and a block that is left out without an entry that says so
 * are each a problem. A text is the files it is made of, one after the other, each cut at its last non-blank
 * character and followed by one blank line; that is the only glue.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { textSpecs, titleOf } from "./assemble.ts";
import type { Problem } from "./analyze.ts";
import type { Entry, Mapping } from "./schema.ts";
import type { Texts, UpstreamTexts } from "./sources.ts";

/** One text of a script, as its JSON file holds it. */
export interface TextFile {
  readonly name?: unknown;
  readonly title?: unknown;
  readonly text?: unknown;
}

/** What differs at the first place two texts part, said with a little of each. */
function firstDifference(expected: string, found: string): string {
  let at = 0;
  while (at < expected.length && at < found.length && expected[at] === found[at]) at += 1;
  const show = (text: string): string => JSON.stringify(text.slice(Math.max(0, at - 20), at + 60));
  return `they part at character ${String(at)}: the map says ${show(expected)}, the text has ${show(found)}`;
}

/** The blocks of one upstream file of a text, in order, and what is wrong with how they cover it. */
function blocksOf(mapping: Mapping, upstream: UpstreamTexts, file: string, text: string): { entries: Entry[]; problems: Problem[] } {
  const problems: Problem[] = [];
  const entries = mapping.entries.filter((one) => one.upstream.file === file).sort((a, b) => a.upstream.range[0] - b.upstream.range[0]);
  let at = 0;
  for (const entry of entries) {
    if (!upstream.same(entry.upstream.commit, upstream.current)) {
      problems.push({ entry: entry.id, message: `${file} is recorded at upstream commit ${entry.upstream.commit}, not at the snapshot's: the text cannot be checked until the entry is carried to the snapshot` });
      continue;
    }
    if (entry.upstream.range[0] > at) problems.push({ message: `${file} [${String(at)}, ${String(entry.upstream.range[0])}) is in no entry, so the text may leave it out unrecorded` });
    at = Math.max(at, entry.upstream.range[1]);
  }
  if (at < text.length) problems.push({ message: `${file} [${String(at)}, ${String(text.length)}) is in no entry, so the text may leave it out unrecorded` });
  return { entries, problems };
}

/** What the map says one upstream file contributes to a text: its prompt blocks verbatim, its adapted blocks as ours. */
function contribution(entries: readonly Entry[], upstreamText: string, ours: Texts): { text: string; problems: Problem[] } {
  const problems: Problem[] = [];
  let text = "";
  for (const entry of entries) {
    if (entry.kind === "prompt") text += upstreamText.slice(...entry.upstream.range);
    else if (entry.kind === "adapted") {
      for (const link of entry.ours) {
        const found = ours.at(link.commit, link.file);
        if (found === undefined) problems.push({ entry: entry.id, message: `the adapted text is in ${link.file}, which does not exist at ${link.commit}` });
        else text += found.slice(...link.range);
      }
    }
  }
  return { text, problems };
}

/**
 * The problems of the texts against the map. `read` answers the JSON file of a text by its name, or undefined when
 * there is none. A text with no block that goes into a prompt has no file, and one that has a file it should not
 * have is a problem.
 */
export function verifyTexts(mapping: Mapping, upstream: UpstreamTexts, ours: Texts, read: (name: string) => string | undefined, existing: readonly string[]): Problem[] {
  const problems: Problem[] = [];
  const specs = textSpecs(upstream.snapshot);
  for (const spec of specs) {
    const where = (message: string, entry?: string): Problem => ({ ...(entry === undefined ? {} : { entry }), message: `text ${spec.name}: ${message}` });
    const pieces: string[] = [];
    const left: Entry[] = [];
    let sound = true;
    for (const file of spec.files) {
      const upstreamText = upstream.at(upstream.current, file);
      if (upstreamText === undefined) continue;
      const { entries, problems: gaps } = blocksOf(mapping, upstream, file, upstreamText);
      for (const one of gaps) problems.push(where(one.message, one.entry));
      if (gaps.length > 0) sound = false;
      left.push(...entries.filter((one) => one.kind === "code"));
      const made = contribution(entries, upstreamText, ours);
      for (const one of made.problems) problems.push(where(one.message, one.entry));
      if (made.problems.length > 0) sound = false;
      if (made.text !== "") pieces.push(made.text);
    }
    // A file no block of which goes into a prompt is implemented by code of ours, and has no text to differ.
    if (pieces.length > 0) for (const one of left) problems.push(where(`${one.upstream.file} goes into this text, and its block is left out as code: a text differs from upstream only where an adapted or a dropped entry says so`, one.id));
    const raw = read(spec.name);
    if (pieces.length === 0) {
      if (raw !== undefined) problems.push(where("no block of the map goes into it, and it has a file"));
      continue;
    }
    if (raw === undefined) {
      problems.push(where("the map puts blocks into it, and it has no file"));
      continue;
    }
    let file: TextFile;
    try {
      file = JSON.parse(raw) as TextFile;
    } catch (error) {
      problems.push(where(`its file is not JSON: ${(error as Error).message}`));
      continue;
    }
    if (typeof file.text !== "string") {
      problems.push(where("its file has no text"));
      continue;
    }
    if (file.name !== spec.name) problems.push(where(`its file names it ${JSON.stringify(file.name)}`));
    const expected = pieces.map((piece, index) => (index < pieces.length - 1 ? `${piece.replace(/\s+$/, "")}\n\n` : piece)).join("");
    if (sound && file.text !== expected) problems.push(where(`it is not what the map says: ${firstDifference(expected, file.text)}`));
    const title = spec.title ?? titleOf(expected, spec.name);
    if (sound && file.title !== title) problems.push(where(`its title is ${JSON.stringify(file.title)}, the map's text says ${JSON.stringify(title)}`));
  }
  const names = new Set(specs.map((one) => one.name));
  for (const name of existing) if (!names.has(name)) problems.push({ message: `text ${name}: a text of no spec of the map is in the texts folder` });
  return problems;
}

/** The problems of the texts in a folder, which is where the scripts import them from. */
export function verifyTextsIn(mapping: Mapping, upstream: UpstreamTexts, ours: Texts, dir: string): Problem[] {
  const existing = existsSync(dir) ? readdirSync(dir).filter((file) => file.endsWith(".json")).map((file) => file.slice(0, -".json".length)) : [];
  const read = (name: string): string | undefined => (existing.includes(name) ? readFileSync(join(dir, `${name}.json`), "utf8") : undefined);
  return verifyTexts(mapping, upstream, ours, read, existing);
}
