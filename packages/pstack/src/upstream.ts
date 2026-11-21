/**
 * The snapshot of the upstream pstack playbooks that this package carries, and how it is refreshed.
 *
 * Upstream is the `pstack` plugin of `cursor/plugins` (MIT). The snapshot keeps its operator skill, the worker rules,
 * the playbooks, the references they name, and the Benny automation pack, byte for byte, under `upstream/`, with the
 * commit they were taken from. A refresh reads a commit of an upstream checkout through git and replaces the snapshot
 * whole; the checkout's working tree is never read, and the checkout is never written. What the snapshot became in
 * pstack is recorded in `upstream/mapping.json`; see `mapping/`.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { Git } from "./mapping/git.ts";

/** Where the parts of a package folder that the upstream map works on are: its snapshot, its texts and its mapping. */
export interface PackagePaths {
  /** The folder of the package. */
  readonly dir: string;
  /** Where the snapshot lives. */
  readonly upstream: string;
  /** Where the texts the scripts import live. */
  readonly texts: string;
  /** Where the mapping of the snapshot lives, in the snapshot's folder. */
  readonly mapping: string;
}

/** The paths of the package folder `dir`: the folder of this package, or the same folder in a worktree of its repository. */
export function pathsIn(dir: string): PackagePaths {
  const upstream = join(dir, "upstream");
  return { dir, upstream, texts: join(dir, "src", "workflows", "texts"), mapping: join(upstream, "mapping.json") };
}

/** The folder of this package. */
export const PACKAGE_DIR = join(import.meta.dir, "..");

/** The paths of this package. */
export const PACKAGE_PATHS = pathsIn(PACKAGE_DIR);

/** Where the snapshot lives in this package. */
export const UPSTREAM_DIR = PACKAGE_PATHS.upstream;

/** Where the texts the scripts import live in this package. */
export const TEXTS_DIR = PACKAGE_PATHS.texts;

/** Where the mapping of the snapshot lives, in the snapshot's folder. */
export const MAPPING_FILE = PACKAGE_PATHS.mapping;

/**
 * Where the snapshot's files come from in an upstream checkout (the `pstack` folder of `cursor/plugins`): a folder of
 * the snapshot, the folder of the checkout it is taken from, and the files of it the snapshot keeps (all, when none).
 */
export const SNAPSHOT_PATHS = [
  { snapshot: "LICENSE", from: "LICENSE" },
  { snapshot: "poteto-mode", from: join("skills", "poteto-mode"), keep: ["SKILL.md", "worker.md", "playbooks/", "references/"] },
  { snapshot: "benny", from: join("automations", "benny") },
] as const;

/** The files of the snapshot that are not upstream's text: what the snapshot says about itself, and the license. */
export const SNAPSHOT_META: readonly string[] = ["SOURCE.json", "LICENSE", "mapping.json"];

/** Where the snapshot was taken from. */
export interface UpstreamSource {
  readonly repository: string;
  readonly path: string;
  readonly commit: string;
}

/** The path of a snapshot file in an upstream checkout. */
export function checkoutPathOf(file: string): string {
  for (const one of SNAPSHOT_PATHS) {
    if (file === one.snapshot) return one.from;
    if (file.startsWith(`${one.snapshot}/`)) return `${one.from}/${file.slice(one.snapshot.length + 1)}`;
  }
  throw new Error(`${file} is not a file of the upstream snapshot`);
}

/** The path in the snapshot of a file of an upstream checkout, or undefined when the snapshot keeps no such file. */
export function snapshotPathOf(path: string): string | undefined {
  for (const one of SNAPSHOT_PATHS) {
    const root = one.from.split("\\").join("/");
    if (path !== root && !path.startsWith(`${root}/`)) continue;
    const rest = path === root ? "" : path.slice(root.length + 1);
    if ("keep" in one && !one.keep.some((entry) => (entry.endsWith("/") ? rest.startsWith(entry) : rest === entry))) return undefined;
    return rest === "" ? one.snapshot : `${one.snapshot}/${rest}`;
  }
  return undefined;
}

/** The commit the snapshot was taken at. */
export function sourceOf(upstream: string = UPSTREAM_DIR): UpstreamSource {
  return JSON.parse(readFileSync(join(upstream, "SOURCE.json"), "utf8")) as UpstreamSource;
}

/** The files of a snapshot, as paths from its folder with `/`, sorted. */
export function snapshotFiles(upstream: string = UPSTREAM_DIR): string[] {
  const found: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path, `${prefix}${name}/`);
      else found.push(`${prefix}${name}`);
    }
  };
  walk(upstream, "");
  return found.sort();
}

/** The names of the playbooks of a snapshot, sorted. */
export function playbookNames(upstream: string = UPSTREAM_DIR): string[] {
  return readdirSync(join(upstream, "poteto-mode", "playbooks"))
    .filter((file) => file.endsWith(".md"))
    .map((file) => basename(file, ".md"))
    .sort();
}

/**
 * Take a new snapshot from an upstream checkout (the `pstack` folder of `cursor/plugins`) at a commit, the checkout's
 * HEAD by default: the snapshot is replaced whole, so a file upstream removed goes too. A checkout that lacks what a
 * snapshot needs is refused before anything is replaced.
 */
export function refreshUpstream(checkout: string, into: { upstream?: string; commit?: string } = {}): UpstreamSource {
  const upstream = into.upstream ?? UPSTREAM_DIR;
  const git = new Git(checkout);
  const commit = git.resolve(into.commit ?? "HEAD");
  if (commit === undefined) throw new Error(`${checkout} has no commit ${into.commit ?? "HEAD"}: it is not a git checkout of upstream`);
  const files = new Map<string, string>();
  for (const one of SNAPSHOT_PATHS) {
    for (const path of git.list(commit, one.from)) {
      const file = snapshotPathOf(path.split("\\").join("/"));
      const text = file === undefined ? undefined : git.show(commit, path);
      if (file !== undefined && text !== undefined) files.set(file, text);
    }
  }
  const playbooks = [...files.keys()].filter((file) => file.startsWith("poteto-mode/playbooks/"));
  for (const needed of ["LICENSE", "poteto-mode/SKILL.md", "poteto-mode/worker.md"]) {
    if (!files.has(needed)) throw new Error(`${checkout} is not an upstream pstack checkout at ${commit}: ${checkoutPathOf(needed)} is missing`);
  }
  if (playbooks.length === 0) throw new Error(`${checkout} is not an upstream pstack checkout at ${commit}: it has no playbooks`);
  const source: UpstreamSource = { repository: "https://github.com/cursor/plugins", path: "pstack", commit };
  // The mapping belongs to the snapshot's folder and survives a refresh; the old files go.
  const kept = existsSync(join(upstream, "mapping.json")) ? readFileSync(join(upstream, "mapping.json"), "utf8") : undefined;
  rmSync(upstream, { recursive: true, force: true });
  for (const [file, text] of files) {
    mkdirSync(dirname(join(upstream, file)), { recursive: true });
    writeFileSync(join(upstream, file), text);
  }
  writeFileSync(join(upstream, "SOURCE.json"), `${JSON.stringify(source, null, 2)}\n`);
  if (kept !== undefined) writeFileSync(join(upstream, "mapping.json"), kept);
  return source;
}
