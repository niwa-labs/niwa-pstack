// A tiny upstream checkout and a repository with a tiny pstack-shaped package folder that maps it, for the tests of the
// tool on a package folder and of the sync.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { tempDir } from "@niwa-labs/testing";

import { formatMapping } from "../src/mapping/index.ts";
import type { Entry } from "../src/mapping/index.ts";
import { refreshUpstream } from "../src/upstream.ts";
import { commitFiles, git } from "./mapping-support.ts";

export const UPSTREAM_FILES_V1: Record<string, string> = {
  LICENSE: "MIT License\n",
  "skills/poteto-mode/SKILL.md": "# Mode\n\nAlpha block.\n",
  "skills/poteto-mode/worker.md": "Work for the operator.\n",
  "skills/poteto-mode/playbooks/bug-fix.md": "### Bug fix\n\nReproduce it.\n\nFix the cause.\n",
};

/** The files of the snapshot, as the map names them, with their texts. */
export const SNAPSHOT_V1: Record<string, string> = {
  "poteto-mode/SKILL.md": UPSTREAM_FILES_V1["skills/poteto-mode/SKILL.md"] as string,
  "poteto-mode/worker.md": UPSTREAM_FILES_V1["skills/poteto-mode/worker.md"] as string,
  "poteto-mode/playbooks/bug-fix.md": UPSTREAM_FILES_V1["skills/poteto-mode/playbooks/bug-fix.md"] as string,
};

/** An upstream checkout, committed: its folder and the commit. */
export async function upstreamCheckout(files: Record<string, string> = UPSTREAM_FILES_V1): Promise<{ dir: string; commit: string }> {
  const dir = await tempDir("upstream");
  git(dir, "init", "-q", "-b", "main");
  return { dir, commit: commitFiles(dir, files, "upstream") };
}

/** The entries that cover a snapshot whole: the skill is dropped, the rest goes into prompts, linked to `ours`. */
export function entriesFor(upstreamCommit: string, oursCommit: string, texts: Record<string, string> = SNAPSHOT_V1): Entry[] {
  return Object.entries(texts).map(([file, text], index): Entry => {
    const upstream = { commit: upstreamCommit, file, range: [0, text.length] as [number, number] };
    return file.endsWith("SKILL.md")
      ? { id: `skill:${String(index)}`, upstream, ours: [], kind: "dropped", note: "Not taken: a skill of Cursor's." }
      : { id: `${file.split("/").at(-1)?.replace(/\.md$/, "") ?? file}:01`, upstream, ours: [{ commit: oursCommit, file: "README.md", range: [0, 1] }], kind: "prompt" };
  });
}

/** Put a package folder into the repository `root`: the snapshot of `checkout` at `commit` and a map that covers it, committed. */
export function seedPackage(root: string, checkout: string, commit: string, kinds: { worker?: Entry["kind"]; bugFix?: Entry["kind"] } = {}): { packageDir: string; oursCommit: string; entries: Entry[] } {
  const oursCommit = git(root, "rev-parse", "HEAD");
  const packageDir = join(root, "packages", "pstack");
  mkdirSync(packageDir, { recursive: true });
  refreshUpstream(checkout, { upstream: join(packageDir, "upstream"), commit });
  const entries = entriesFor(commit, oursCommit).map((one) => {
    const kind = one.upstream.file.endsWith("worker.md") ? kinds.worker : one.upstream.file.endsWith("bug-fix.md") ? kinds.bugFix : undefined;
    return kind === undefined ? one : { ...one, kind };
  });
  writeFileSync(join(packageDir, "upstream", "mapping.json"), formatMapping({ entries }));
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "snapshot and map");
  return { packageDir, oursCommit, entries };
}

/** A repository whose package folder holds the snapshot of `checkout` at `commit` and a map that covers it. */
export async function packageRepo(checkout: string, commit: string): Promise<{ root: string; packageDir: string; oursCommit: string }> {
  const root = await tempDir("repo");
  git(root, "init", "-q", "-b", "main");
  commitFiles(root, { "README.md": "The billing service.\n" }, "start");
  const seeded = seedPackage(root, checkout, commit);
  return { root, packageDir: seeded.packageDir, oursCommit: seeded.oursCommit };
}
