/**
 * Whether trunk's changes since a patch branched can affect the patch: what decides if a pull request lands as it was
 * tested, is tested again on the merge result, or is rebased first.
 *
 * - `conflict`: the patch does not merge cleanly into trunk; it must be rebased.
 * - `lockfile`: both sides changed a lockfile; a frozen install on the merge result decides.
 * - `both-touched`: both sides changed the same file; the code that would land was never tested.
 * - `dependency`: trunk changed what the patch builds on (a manifest, or a file that names a file the patch changed);
 *   the patch's checks run on the merge result.
 * - `none`: nothing trunk did reaches the patch; it lands as it was tested.
 *
 * The order is the order of how much it costs to be wrong: the first kind that applies is the answer.
 */

/** What trunk did to a patch. */
export type TrunkKind = "none" | "conflict" | "both-touched" | "dependency" | "lockfile";

/** Files whose change pins what a build installs. */
const LOCKFILES = new Set(["bun.lock", "bun.lockb", "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "Cargo.lock", "go.sum", "poetry.lock", "uv.lock", "Gemfile.lock", "composer.lock"]);

/** Files whose change moves what a build depends on. */
const MANIFESTS = new Set(["package.json", "Cargo.toml", "go.mod", "pyproject.toml", "requirements.txt", "Gemfile", "composer.json", "tsconfig.json"]);

const nameOf = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

export const isLockfile = (path: string): boolean => LOCKFILES.has(nameOf(path));
export const isManifest = (path: string): boolean => MANIFESTS.has(nameOf(path));

/** What was found of a patch and of trunk since the patch branched. */
export interface TrunkFacts {
  /** The files the patch changed. */
  readonly patch: readonly string[];
  /** The files trunk changed since the patch branched. */
  readonly trunk: readonly string[];
  /** The files a merge of the two leaves in conflict. */
  readonly conflicts: readonly string[];
  /** The files trunk changed that name a file of the patch. */
  readonly dependents: readonly string[];
}

/** What trunk's changes mean for the patch, and the files that say so. */
export function trunkKind(facts: TrunkFacts): { kind: TrunkKind; files: string[] } {
  const sorted = (files: Iterable<string>) => [...new Set(files)].sort();
  if (facts.conflicts.length > 0) return { kind: "conflict", files: sorted(facts.conflicts) };
  const patch = new Set(facts.patch);
  const both = facts.trunk.filter((file) => patch.has(file));
  const locks = both.filter(isLockfile);
  if (locks.length > 0) return { kind: "lockfile", files: sorted(locks) };
  if (both.length > 0) return { kind: "both-touched", files: sorted(both) };
  const moved = facts.trunk.filter(isManifest);
  if (moved.length > 0 || facts.dependents.length > 0) return { kind: "dependency", files: sorted([...moved, ...facts.dependents]) };
  return { kind: "none", files: [] };
}

/** The words a dependent file would name a changed file by: its name without the extension, when it says something. */
export function stemsOf(files: readonly string[]): string[] {
  const stems = files.map((file) => nameOf(file).replace(/\.[^.]+$/, "")).filter((stem) => stem.length >= 3 && !/^(index|main|mod|lib|init|__init__)$/.test(stem));
  return [...new Set(stems)].sort();
}
