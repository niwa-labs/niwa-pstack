/**
 * Where the texts the mapping points into are read from: the upstream snapshot and, for a commit the snapshot is not
 * at, the upstream checkout; and this repository, at a commit or as it is in the working tree.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { SNAPSHOT_META, checkoutPathOf, snapshotFiles, snapshotPathOf, sourceOf } from "../upstream.ts";
import { Git } from "./git.ts";

/** A side of the mapping: its texts at a commit, and what became of its files between a commit and the current one. */
export interface Texts {
  /** The commit the current texts are at. */
  readonly current: string;
  /** A file at a commit; undefined when the commit has no such file. A commit it cannot read throws. */
  at(commit: string, file: string): string | undefined;
  /** What became of the files of a commit by the current one: renamed ones by new path, deleted ones null. */
  moved(commit: string): Map<string, string | null>;
  /** Whether two commits are the same commit. */
  same(a: string, b: string): boolean;
}

/** The upstream side: the snapshot is the current text, and an older commit is read from an upstream checkout. */
export class UpstreamTexts implements Texts {
  readonly current: string;
  private readonly git: Git | undefined;

  constructor(
    readonly snapshot: string,
    checkout?: string,
  ) {
    this.current = sourceOf(snapshot).commit;
    this.git = checkout === undefined ? undefined : new Git(checkout);
  }

  /** The files of the snapshot that carry upstream's text. */
  files(): string[] {
    return snapshotFiles(this.snapshot).filter((file) => !SNAPSHOT_META.includes(file));
  }

  same(a: string, b: string): boolean {
    return a === b || (this.git !== undefined && this.git.resolve(a) !== undefined && this.git.resolve(a) === this.git.resolve(b));
  }

  private checkout(commit: string): Git {
    if (this.git === undefined) throw new Error(`the mapping has a range at upstream commit ${commit}, the snapshot is at ${this.current}: give the upstream checkout to read it from`);
    return this.git;
  }

  at(commit: string, file: string): string | undefined {
    if (this.same(commit, this.current)) {
      const path = join(this.snapshot, file);
      return existsSync(path) ? readFileSync(path, "utf8") : undefined;
    }
    return this.checkout(commit).show(commit, checkoutPathOf(file));
  }

  moved(commit: string): Map<string, string | null> {
    const moved = new Map<string, string | null>();
    for (const [from, to] of this.checkout(commit).moved(commit, this.current)) {
      const was = snapshotPathOf(from.split("\\").join("/"));
      if (was === undefined) continue;
      moved.set(was, to === null ? null : (snapshotPathOf(to.split("\\").join("/")) ?? null));
    }
    return moved;
  }
}

/** The current commit of a checkout, or the working tree. */
export const WORKTREE = "worktree";

/** Our side: this repository, its files by path from its root. */
export class OursTexts implements Texts {
  readonly current: string;
  private readonly git: Git;

  /** `head` is a revision of the repository, or `WORKTREE` for the files as they are on disk. */
  constructor(
    readonly root: string,
    head = "HEAD",
  ) {
    this.git = new Git(root);
    const resolved = head === WORKTREE ? WORKTREE : this.git.resolve(head);
    if (resolved === undefined) throw new Error(`${root} has no revision ${head}`);
    this.current = resolved;
  }

  same(a: string, b: string): boolean {
    if (a === WORKTREE || b === WORKTREE) return a === b;
    return this.git.resolve(a) === this.git.resolve(b);
  }

  at(commit: string, file: string): string | undefined {
    if (commit === WORKTREE) {
      const path = join(this.root, file);
      return existsSync(path) ? readFileSync(path, "utf8") : undefined;
    }
    return this.git.show(commit, file);
  }

  moved(commit: string): Map<string, string | null> {
    return this.git.moved(commit, this.current === WORKTREE ? undefined : this.current);
  }
}
