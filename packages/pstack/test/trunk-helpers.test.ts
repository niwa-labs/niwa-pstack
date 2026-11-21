// The script helpers that read trunk and carry a stack, on a real repository: git runs where `proc.run` is asked to
// run it, and the forge answers the pull requests a test names.

import { afterEach, expect, test } from "bun:test";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { tempDir } from "@niwa-labs/testing";

import { restack, trunkAffects } from "../src/workflows/lib/trunk.ts";
import { commitFile, gitIn } from "./support.ts";

const globals = globalThis as Record<string, unknown>;
afterEach(() => {
  for (const name of ["call", "agent"]) delete globals[name];
});

const repo = { host: "gitlab.example.com", path: "acme/billing" };

/** Script globals over a forge that answers these pull requests, and a `proc.run` that runs for real. */
function scriptWith(prs: Record<number, { state?: string; branch: string; base?: string; head: string }>): void {
  globals.agent = async () => ({});
  globals.call = async (name: string, input: any) => {
    if (name === "proc.run") {
      const ran = Bun.spawnSync(input.cmd, { cwd: input.cwd, stdout: "pipe", stderr: "pipe" });
      return { exit: ran.exitCode, tail: ran.stdout.toString() + ran.stderr.toString(), truncated: false };
    }
    if (name === "forge.pr.read") {
      const pr = prs[input.number as number];
      if (pr === undefined) throw new Error(`no pull request ${String(input.number)}`);
      return { state: pr.state ?? "open", branch: pr.branch, base: pr.base ?? "main", head: pr.head };
    }
    throw new Error(`no answer for ${name}`);
  };
}

async function repository(): Promise<string> {
  const dir = realpathSync(await tempDir("trunk"));
  gitIn(dir, "init", "-q", "-b", "main");
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "invoice.ts"), "export const invoice = 1;\n");
  writeFileSync(join(dir, "src", "report.ts"), "export const report = 1;\n");
  writeFileSync(join(dir, "package.json"), "{}\n");
  writeFileSync(join(dir, "bun.lock"), "lock 1\n");
  gitIn(dir, "add", ".");
  gitIn(dir, "commit", "-q", "-m", "start");
  return dir;
}

/** A branch off main with a commit of its own: its head. */
function branch(dir: string, name: string, file: string, text: string): string {
  gitIn(dir, "checkout", "-q", "-b", name, "main");
  const head = commitFile(dir, file, text);
  gitIn(dir, "checkout", "-q", "main");
  return head;
}

test("what trunk did to a pull request is read from the two sides of its fork", async () => {
  const dir = await repository();
  const patch = branch(dir, "topic", "src/invoice.ts", "export const invoice = 2;\n");
  const pr = { repo, number: 7 };
  scriptWith({ 7: { branch: "topic", head: patch } });
  expect(await trunkAffects("t1", { pr, base: "main", cwd: dir })).toEqual({ kind: "none", files: [] });

  // Trunk names the patched file in a file of its own: a dependent.
  commitFile(dir, "src/report.ts", 'import { invoice } from "./invoice";\n');
  expect(await trunkAffects("t2", { pr, base: "main", cwd: dir })).toEqual({ kind: "dependency", files: ["src/report.ts"] });

  // Trunk moved a manifest.
  const manifest = branch(dir, "topic-2", "src/invoice.ts", "export const invoice = 3;\n");
  gitIn(dir, "reset", "-q", "--hard", "HEAD~1");
  commitFile(dir, "package.json", '{ "name": "billing" }\n');
  scriptWith({ 7: { branch: "topic-2", head: manifest } });
  expect(await trunkAffects("t3", { pr, base: "main", cwd: dir })).toEqual({ kind: "dependency", files: ["package.json"] });
});

test("a conflict, a lockfile both sides changed, and a file both sides changed are told apart", async () => {
  const dir = await repository();
  const pr = { repo, number: 7 };
  const conflicting = branch(dir, "conflict", "src/invoice.ts", "export const invoice = 2;\n");
  const locked = branch(dir, "locked", "bun.lock", "lock 2\n");
  gitIn(dir, "checkout", "-q", "-b", "both", "main");
  writeFileSync(join(dir, "src", "invoice.ts"), "// billing\nexport const invoice = 1;\n");
  const both = commitFile(dir, "src/invoice.ts", "// billing\nexport const invoice = 1;\n");
  gitIn(dir, "checkout", "-q", "main");
  writeFileSync(join(dir, "src", "invoice.ts"), "export const invoice = 1;\nexport const tax = 1;\n");
  writeFileSync(join(dir, "bun.lock"), "lock 1\nlock 3\n");
  gitIn(dir, "commit", "-q", "-am", "trunk moves");

  scriptWith({ 1: { branch: "conflict", head: conflicting }, 2: { branch: "locked", head: locked }, 3: { branch: "both", head: both } });
  expect(await trunkAffects("c", { pr: { ...pr, number: 1 }, base: "main", cwd: dir })).toEqual({ kind: "conflict", files: ["src/invoice.ts"] });
  expect((await trunkAffects("l", { pr: { ...pr, number: 2 }, base: "main", cwd: dir })).kind).toBe("conflict");
  expect(await trunkAffects("b", { pr: { ...pr, number: 3 }, base: "main", cwd: dir })).toEqual({ kind: "both-touched", files: ["src/invoice.ts"] });
});

test("a lockfile both sides changed without a conflict is a lockfile case", async () => {
  const dir = await repository();
  writeFileSync(join(dir, "bun.lock"), "a\nb\nc\nd\ne\nf\n");
  gitIn(dir, "commit", "-q", "-am", "a longer lock");
  const locked = branch(dir, "locked", "bun.lock", "a\nB\nc\nd\ne\nf\n");
  writeFileSync(join(dir, "bun.lock"), "a\nb\nc\nd\ne\nF\n");
  gitIn(dir, "commit", "-q", "-am", "trunk locks");
  scriptWith({ 2: { branch: "locked", head: locked } });
  expect(await trunkAffects("l", { pr: { repo, number: 2 }, base: "main", cwd: dir })).toEqual({ kind: "lockfile", files: ["bun.lock"] });
});

test("a stack carried onto a new lower head keeps the patch of the one above, and says when it does not", async () => {
  const dir = await repository();
  // lower: one commit off main; upper: one commit on lower.
  const lowerOld = branch(dir, "lower", "src/invoice.ts", "export const invoice = 2;\n");
  gitIn(dir, "checkout", "-q", "-b", "upper", "lower");
  const upperHead = commitFile(dir, "src/report.ts", "export const report = 2;\n");
  // The lower pull request gets a fix round: a new head.
  gitIn(dir, "checkout", "-q", "lower");
  const lowerNew = commitFile(dir, "notes.md", "a fix round\n");
  gitIn(dir, "checkout", "-q", "--detach", "main");

  scriptWith({ 1: { branch: "lower", head: lowerNew }, 2: { branch: "upper", base: "lower", head: upperHead } });
  const [moved] = await restack("r", { lower: { repo, number: 1 }, from: lowerOld, upper: [{ repo, number: 2 }], cwd: dir });
  expect(moved?.patchKept).toBe(true);
  expect(gitIn(dir, "rev-parse", `${moved?.head ?? ""}~1`)).toBe(lowerNew);

  // The fix round changes a line the upper patch shows as context: it rebases cleanly, but it is not the patch it was.
  const lines = (changed: Record<number, string>) => `${Array.from({ length: 10 }, (_, at) => changed[at + 1] ?? `line ${String(at + 1)}`).join("\n")}\n`;
  gitIn(dir, "checkout", "-q", "-b", "lower-2", "main");
  const lower2Old = commitFile(dir, "numbers.txt", lines({}));
  gitIn(dir, "checkout", "-q", "-b", "upper-2", "lower-2");
  const upper2 = commitFile(dir, "numbers.txt", lines({ 6: "six" }));
  gitIn(dir, "checkout", "-q", "lower-2");
  const lower2 = commitFile(dir, "numbers.txt", lines({ 3: "three" }));
  gitIn(dir, "checkout", "-q", "--detach", "main");
  scriptWith({ 1: { branch: "lower-2", head: lower2 }, 2: { branch: "upper-2", base: "lower-2", head: upper2 } });
  const [changed] = await restack("s", { lower: { repo, number: 1 }, from: lower2Old, upper: [{ repo, number: 2 }], cwd: dir });
  expect(changed?.patchKept).toBe(false);
});

test("a stack whose upper patch conflicts with the new lower head is not carried", async () => {
  const dir = await repository();
  const lowerOld = branch(dir, "lower", "src/invoice.ts", "export const invoice = 2;\n");
  gitIn(dir, "checkout", "-q", "-b", "upper", "lower");
  const upperHead = commitFile(dir, "src/invoice.ts", "export const invoice = 3;\n");
  gitIn(dir, "checkout", "-q", "-b", "lower-fixed", lowerOld);
  const lowerNew = commitFile(dir, "src/invoice.ts", "export const invoice = 4;\n");
  gitIn(dir, "checkout", "-q", "--detach", "main");
  scriptWith({ 1: { branch: "lower-fixed", head: lowerNew }, 2: { branch: "upper", head: upperHead } });
  await expect(restack("r", { lower: { repo, number: 1 }, from: lowerOld, upper: [{ repo, number: 2 }], cwd: dir })).rejects.toThrow("does not rebase onto");
  expect(gitIn(dir, "status", "--porcelain")).toBe("");
});
