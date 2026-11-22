/** The files and assembled texts that pstack carries from the upstream plugin. */

import { readdirSync } from "node:fs";
import { basename, join } from "node:path";

import {
  UpstreamTexts as MapUpstreamTexts,
  checkoutPathOf as mappedCheckoutPath,
  pathsIn,
  refreshUpstream as refreshSnapshot,
  snapshotPathOf as mappedSnapshotPath,
} from "@niwa-labs/upstream-map";
import type { SnapshotSpec, TextSpec, UpstreamMapConfig, UpstreamSource } from "@niwa-labs/upstream-map";

export type { UpstreamSource };

export const PACKAGE_DIR = join(import.meta.dir, "..");
export const PACKAGE_PATHS = pathsIn(PACKAGE_DIR);
export const UPSTREAM_DIR = PACKAGE_PATHS.upstream;
export const TEXTS_DIR = PACKAGE_PATHS.texts;
export const MAPPING_FILE = PACKAGE_PATHS.mapping;

const SNAPSHOT = {
  name: "pstack",
  repository: "https://github.com/cursor/plugins",
  path: "pstack",
  paths: [
    { snapshot: "LICENSE", from: "LICENSE" },
    { snapshot: "poteto-mode", from: "skills/poteto-mode", keep: ["SKILL.md", "worker.md", "playbooks/", "references/"] },
    { snapshot: "benny", from: "automations/benny" },
  ],
  requiredFiles: ["LICENSE", "poteto-mode/SKILL.md", "poteto-mode/worker.md"],
  requiredDirectories: ["poteto-mode/playbooks"],
} satisfies SnapshotSpec;

export function checkoutPathOf(file: string): string {
  return mappedCheckoutPath(file, SNAPSHOT);
}

export function snapshotPathOf(path: string): string | undefined {
  return mappedSnapshotPath(path, SNAPSHOT);
}

/** The names of the playbooks of a snapshot, sorted. */
export function playbookNames(upstream: string = UPSTREAM_DIR): string[] {
  return readdirSync(join(upstream, "poteto-mode", "playbooks"))
    .filter((file) => file.endsWith(".md"))
    .map((file) => basename(file, ".md"))
    .sort();
}

const SKILLS = "benny/skills";

function textSpecs(snapshot: string): TextSpec[] {
  return [
    ...playbookNames(snapshot).map((name) => ({ name, files: [`poteto-mode/playbooks/${name}.md`] })),
    { name: "worker", title: "Worker rules", files: ["poteto-mode/worker.md", "poteto-mode/SKILL.md"] },
    { name: "bugbot-triage", files: ["poteto-mode/references/bugbot-triage.md"] },
    { name: "benny-triage", files: [`${SKILLS}/triage-issue-reports/SKILL.md`] },
    {
      name: "benny-reproduce",
      files: [
        `${SKILLS}/reproduce-and-fix-issues/SKILL.md`,
        `${SKILLS}/reproduce-and-fix-issues/references/verify-existing-fix.md`,
        `${SKILLS}/reproduce-and-fix-issues/references/control-adapter.md`,
      ],
    },
  ];
}

export function upstreamMapConfig(dir: string = PACKAGE_DIR): UpstreamMapConfig {
  return { paths: pathsIn(dir), snapshot: SNAPSHOT, textSpecs };
}

export class UpstreamTexts extends MapUpstreamTexts {
  constructor(snapshot: string, checkout?: string) {
    super(snapshot, SNAPSHOT, checkout, textSpecs);
  }
}

export function refreshUpstream(checkout: string, { upstream = UPSTREAM_DIR, commit }: { upstream?: string; commit?: string } = {}): UpstreamSource {
  return refreshSnapshot(checkout, SNAPSHOT, { upstream, ...(commit === undefined ? {} : { commit }) });
}
