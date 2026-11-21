// What the mapping tests share: an upstream checkout and its snapshot, a repository of ours, and entries written
// against the commits they were made at.

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { tempDir } from "@niwa-labs/testing";

import { OursTexts, UpstreamTexts } from "../src/mapping/index.ts";
import type { Entry, Mapping, Span } from "../src/mapping/index.ts";
import { refreshUpstream } from "../src/upstream.ts";

const ENV = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t.invalid" };

export function git(dir: string, ...args: string[]): string {
  const ran = Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe", env: { ...process.env, ...ENV } });
  if (ran.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${ran.stderr.toString()}`);
  return ran.stdout.toString().trim();
}

/** Write files into a checkout and commit them: the new commit. A file whose text is null is removed. */
export function commitFiles(dir: string, files: Record<string, string | null>, message = "change"): string {
  for (const [file, text] of Object.entries(files)) {
    if (text === null) rmSync(join(dir, file), { force: true });
    else {
      mkdirSync(dirname(join(dir, file)), { recursive: true });
      writeFileSync(join(dir, file), text);
    }
  }
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", message);
  return git(dir, "rev-parse", "HEAD");
}

/** The first upstream files: an operator skill, the worker rules, a playbook. */
export const UPSTREAM_FILES: Record<string, string> = {
  LICENSE: "MIT License\n",
  "skills/poteto-mode/SKILL.md": "# Mode\n\nAlpha block.\n\nBeta block.\n",
  "skills/poteto-mode/worker.md": "Work for the operator.\n",
  "skills/poteto-mode/playbooks/bug-fix.md": "### Bug fix\n\nReproduce it.\n\nFix the cause.\n",
};

/** Our first files: some code and a text of our own. */
export const OURS_FILES: Record<string, string> = {
  "src/brief.ts": "export const brief = 1;\n// the assembler\nexport const other = 2;\n",
  "src/adapted.md": "Own words.\n",
};

/** The offsets of a needle in a text. */
export function at(text: string, needle: string): Span {
  const start = text.indexOf(needle);
  if (start < 0) throw new Error(`${JSON.stringify(needle)} is not in the text`);
  return [start, start + needle.length];
}

/** An upstream checkout with its snapshot, and a repository of ours. */
export class World {
  constructor(
    readonly upstreamDir: string,
    readonly snapshot: string,
    readonly oursDir: string,
    public upstreamCommit: string,
    public oursCommit: string,
  ) {}

  static async make(): Promise<World> {
    const upstreamDir = await tempDir("upstream");
    git(upstreamDir, "init", "-q", "-b", "main");
    const upstreamCommit = commitFiles(upstreamDir, UPSTREAM_FILES, "upstream");
    const snapshot = join(await tempDir("snapshot"), "upstream");
    refreshUpstream(upstreamDir, { upstream: snapshot });
    const oursDir = await tempDir("ours");
    git(oursDir, "init", "-q", "-b", "main");
    const oursCommit = commitFiles(oursDir, OURS_FILES, "ours");
    return new World(upstreamDir, snapshot, oursDir, upstreamCommit, oursCommit);
  }

  /** Change the upstream files, commit them, and take a new snapshot. */
  evolveUpstream(files: Record<string, string | null>): string {
    this.upstreamCommit = commitFiles(this.upstreamDir, files, "upstream change");
    refreshUpstream(this.upstreamDir, { upstream: this.snapshot });
    return this.upstreamCommit;
  }

  /** Change our files and commit them. */
  evolveOurs(files: Record<string, string | null>): string {
    return commitFiles(this.oursDir, files, "ours change");
  }

  upstream(checkout = true): UpstreamTexts {
    return new UpstreamTexts(this.snapshot, checkout ? this.upstreamDir : undefined);
  }

  ours(head = "HEAD"): OursTexts {
    return new OursTexts(this.oursDir, head);
  }

  /** An entry for a needle of an upstream file at a commit (this world's upstream commit by default). */
  entry(id: string, kind: Entry["kind"], upstream: { file: string; text: string; needle: string; commit?: string }, ours: Array<{ file: string; text: string; needle: string; commit?: string }> = [], note?: string): Entry {
    return {
      id,
      kind,
      upstream: { commit: upstream.commit ?? this.upstreamCommit, file: upstream.file, range: at(upstream.text, upstream.needle) as [number, number] },
      ours: ours.map((one) => ({ commit: one.commit ?? this.oursCommit, file: one.file, range: at(one.text, one.needle) as [number, number] })),
      ...(note === undefined ? {} : { note }),
    };
  }
}

export const mapping = (...entries: Entry[]): Mapping => ({ entries });
