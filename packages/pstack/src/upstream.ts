/**
 * The snapshot of the upstream pstack playbooks that this package carries, and how it is refreshed.
 *
 * Upstream is the `pstack` plugin of `cursor/plugins` (MIT). The snapshot keeps its operator skill, the worker rules,
 * the playbooks, the references they name, and the Benny automation pack, byte for byte, under `upstream/`, with the
 * commit they were taken from. The scripts read the playbooks through `src/workflows/texts/`, one JSON file per
 * text, which a refresh writes from the snapshot: a script's version is the hash of the files it imports, so a
 * playbook whose text changed upstream comes in as a new candidate and goes through the suite like any other change.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

/** The folder of this package. */
export const PACKAGE_DIR = join(import.meta.dir, "..");

/** Where the snapshot lives in this package. */
export const UPSTREAM_DIR = join(PACKAGE_DIR, "upstream");

/** Where the texts the scripts import live in this package. */
export const TEXTS_DIR = join(PACKAGE_DIR, "src", "workflows", "texts");

/** The skill folder of the operator's mode, inside an upstream checkout. */
const MODE = join("skills", "poteto-mode");

/** Benny's two automations, by the name of their text: the skill folder of each in the Benny pack. */
const BENNY_SKILLS = { "benny-triage": "triage-issue-reports", "benny-reproduce": "reproduce-and-fix-issues" } as const;

/** One text a script imports: a playbook, the worker rules, or an automation of Benny. */
export interface PlaybookText {
  /** The file's name without `.md`: `bug-fix`. */
  readonly name: string;
  /** The heading of the text: `Bug fix`. */
  readonly title: string;
  /** The whole text, as upstream wrote it. */
  readonly text: string;
}

/** Where the snapshot was taken from. */
export interface UpstreamSource {
  readonly repository: string;
  readonly path: string;
  readonly commit: string;
}

/** The title of a playbook: its first heading, without the marks. */
export function titleOf(text: string, fallback: string): string {
  const heading = text.split("\n").find((line) => /^#{1,6}\s/.test(line));
  return heading === undefined ? fallback : heading.replace(/^#{1,6}\s+/, "").trim();
}

/** The names of the playbooks of a snapshot, sorted. */
export function playbookNames(upstream: string = UPSTREAM_DIR): string[] {
  return readdirSync(join(upstream, "poteto-mode", "playbooks"))
    .filter((file) => file.endsWith(".md"))
    .map((file) => basename(file, ".md"))
    .sort();
}

/** The texts the scripts import, as a snapshot holds them: every playbook, the worker rules, and Benny's automations. */
export function textsOf(upstream: string = UPSTREAM_DIR): PlaybookText[] {
  const read = (file: string) => readFileSync(file, "utf8");
  const playbooks = playbookNames(upstream).map((name) => {
    const text = read(join(upstream, "poteto-mode", "playbooks", `${name}.md`));
    return { name, title: titleOf(text, name), text };
  });
  const worker = read(join(upstream, "poteto-mode", "worker.md"));
  const benny = Object.entries(BENNY_SKILLS).flatMap(([name, skill]) => {
    const file = join(upstream, "benny", "skills", skill, "SKILL.md");
    if (!existsSync(file)) return [];
    const text = read(file);
    return [{ name, title: titleOf(text, name), text }];
  });
  return [...playbooks, { name: "worker", title: "Worker rules", text: worker }, ...benny];
}

/** Write the texts of a snapshot as the JSON files the scripts import, and remove the ones it no longer has. */
export function writeTexts(upstream: string = UPSTREAM_DIR, texts: string = TEXTS_DIR): void {
  mkdirSync(texts, { recursive: true });
  const wanted = textsOf(upstream);
  const names = new Set(wanted.map((one) => `${one.name}.json`));
  for (const file of readdirSync(texts)) if (file.endsWith(".json") && !names.has(file)) rmSync(join(texts, file));
  for (const one of wanted) writeFileSync(join(texts, `${one.name}.json`), `${JSON.stringify(one, null, 2)}\n`);
}

/** The commit an upstream checkout is at. */
function commitOf(checkout: string): string {
  const ran = Bun.spawnSync(["git", "-C", checkout, "rev-parse", "HEAD"], { stdout: "pipe", stderr: "pipe" });
  if (ran.exitCode !== 0) throw new Error(`${checkout} is not a git checkout: ${ran.stderr.toString().trim()}`);
  return ran.stdout.toString().trim();
}

/**
 * Take a new snapshot from an upstream checkout (the `pstack` folder of `cursor/plugins`): the snapshot is replaced
 * whole, so a file upstream removed goes too, and the texts are written again from it.
 */
export function refreshUpstream(checkout: string, into: { upstream?: string; texts?: string } = {}): UpstreamSource {
  const upstream = into.upstream ?? UPSTREAM_DIR;
  const mode = join(checkout, MODE);
  for (const needed of [join(checkout, "LICENSE"), join(mode, "SKILL.md"), join(mode, "worker.md"), join(mode, "playbooks")]) {
    if (!existsSync(needed)) throw new Error(`${checkout} is not an upstream pstack checkout: ${needed} is missing`);
  }
  const source: UpstreamSource = { repository: "https://github.com/cursor/plugins", path: "pstack", commit: commitOf(checkout) };
  rmSync(upstream, { recursive: true, force: true });
  mkdirSync(join(upstream, "poteto-mode"), { recursive: true });
  cpSync(join(checkout, "LICENSE"), join(upstream, "LICENSE"));
  for (const file of ["SKILL.md", "worker.md"]) cpSync(join(mode, file), join(upstream, "poteto-mode", file));
  for (const dir of ["playbooks", "references"]) {
    if (existsSync(join(mode, dir))) cpSync(join(mode, dir), join(upstream, "poteto-mode", dir), { recursive: true });
  }
  const benny = join(checkout, "automations", "benny");
  if (existsSync(benny)) cpSync(benny, join(upstream, "benny"), { recursive: true });
  writeFileSync(join(upstream, "SOURCE.json"), `${JSON.stringify(source, null, 2)}\n`);
  writeTexts(upstream, into.texts ?? TEXTS_DIR);
  return source;
}
