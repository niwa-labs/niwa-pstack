import { map } from "@niwa-labs/flow";
import { makeWorktree } from "@niwa-labs/flow-code";
import type { Worktree } from "@niwa-labs/flow-code";
import type { ScriptApi } from "@niwa-labs/script";
import type { z as Z } from "zod";

import { changeResult, changedSchema, frame, titleOf } from "./lib/change.ts";
import { gitOut } from "./lib/git.ts";
import { playbookInput } from "./lib/inputs.ts";
import { deliverBuilt } from "./lib/lane.ts";
import { artifactName, capture, evidenceSchema, exactCheckout, localAuthor, publishVerified } from "./lib/parity-proof.ts";
import { roles, stepTag } from "./lib/script.ts";
import { brief } from "./lib/texts.ts";
import text from "./texts/visual-parity.json";

declare const workflow: ScriptApi["workflow"];
declare const z: ScriptApi["z"];
declare function phase(title: string): void;

const detail = z.string().trim().min(1).max(2000);
const image = z.string().regex(/^(?!\/)(?!.*(?:^|\/)\.{1,2}(?:\/|$))[a-zA-Z0-9_./-]+\.png$/);
const state = z.strictObject({ name: detail, reference: image, actual: image }).refine((one) => one.reference !== one.actual);
const component = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,30}$/), paths: z.array(detail).min(1).max(100), states: z.array(state).min(1).max(30),
});
const comparison = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("ready"), reference: detail, surface: detail, baseline: detail, differences: z.array(detail).max(30),
    command: detail, protectedPaths: z.array(detail).min(1).max(100), components: z.array(component).min(1).max(20),
    shared: component.nullable(), rounds: z.number().int().positive().optional(),
  }),
  z.strictObject({ kind: z.literal("blocked"), why: detail }),
]);
const pixels = z.strictObject({
  name: detail, referencePath: image, actualPath: image, reference: z.string().nullable(),
  actual: z.string().nullable(), count: z.number().nullable(), receipt: evidenceSchema(),
});
const captureSchema = z.strictObject({ worktree: z.string(), run: evidenceSchema(), states: z.array(pixels) });
type Component = Z.output<typeof component>;

async function compare(key: string, wt: Worktree, command: string, states: Component["states"]) {
  const run = await capture(`${key}-capture`, wt.path, ["sh", "-ec", [
    'command=$1; shift',
    'for actual do',
    '  [ ! -L "./$actual" ] || exit 1',
    '  if [ -e "./$actual" ]; then git check-ignore -q -- "$actual" && [ -f "./$actual" ] || exit 1; rm "./$actual"; fi',
    'done',
    'sh -c "$command"',
    'for actual do [ -f "./$actual" ] && [ ! -L "./$actual" ] || exit 1; done',
  ].join("\n"), "visual", command, ...new Set(states.map(({ actual }) => actual))]);
  if (!run.complete || run.exit !== 0) return { worktree: wt.path, run, states: [] as Array<Z.output<typeof pixels>> };
  const diffs = [];
  for (const [index, state] of states.entries()) {
    const result = await capture(`${key}-pixels-${index + 1}`, wt.path, [
      "sh", "-ec", [
        'for file do [ -f "./$file" ] && [ ! -L "./$file" ]; done',
        'scratch=$(mktemp -d "${TMPDIR:-/tmp}/pstack-pixels.XXXXXX"); trap \'rm -rf -- "$scratch"\' EXIT',
        'ref=$(magick identify -ping -format "%wx%h" "png:./$1"); actual=$(magick identify -ping -format "%wx%h" "png:./$2")',
        'magick "png:./$1" -alpha on -depth 16 RGBA:"$scratch/reference.rgba"',
        'magick "png:./$2" -alpha on -depth 16 RGBA:"$scratch/actual.rgba"',
        'fingerprint=$(shasum -a 256 "$scratch/reference.rgba"); fingerprint=${fingerprint%% *}',
        'observed=$(shasum -a 256 "$scratch/actual.rgba"); observed=${observed%% *}',
        'if [ "$ref" != "$actual" ]; then ae=-1; elif cmp -s "$scratch/reference.rgba" "$scratch/actual.rgba"; then ae=0; else',
        '  ae=$(python3 -c \'import sys; a,b=(open(p,"rb").read() for p in sys.argv[1:]); print(sum(a[i:i+8]!=b[i:i+8] for i in range(0,len(a),8)))\' "$scratch/reference.rgba" "$scratch/actual.rgba")',
        'fi',
        'printf "%s:%s %s:%s %s\\n" "$ref" "$fingerprint" "$actual" "$observed" "$ae"',
      ].join("\n"), "pixel-diff", state.reference, state.actual,
    ]);
    const row = result.complete && result.exit === 0 ? /^(\d+x\d+:[a-f0-9]{64}) (\d+x\d+:[a-f0-9]{64}) (-?\d+)$/.exec(result.tail.trim()) : null;
    diffs.push({ name: state.name, referencePath: state.reference, actualPath: state.actual,
      reference: row?.[1] ?? null, actual: row?.[2] ?? null, count: row ? Number(row[3]) : null, receipt: result });
  }
  return { worktree: wt.path, run, states: diffs };
}

const verified = z.strictObject({
  status: z.enum(["verified", "unverified", "matched"]), framed: z.strictObject({ reference: detail, surface: detail, baseline: detail, differences: z.array(detail) }),
  components: z.array(z.strictObject({ id: z.string(), status: z.enum(["matched", "verified", "unverified", "blocked"]),
    runs: z.array(captureSchema), delivery: changedSchema().optional(), reason: z.string().optional(),
  })),
});
const retry = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("continue"), next: detail }),
  z.strictObject({ kind: z.literal("blocked"), why: detail }),
]);

export default workflow(
  {
    name: "pstack-visual-parity",
    description: "Match every component state to its pixel baseline",
    input: playbookInput(),
    output: z.discriminatedUnion("status", [verified, z.strictObject({ status: z.literal("blocked"), why: detail, evidence: captureSchema.optional() })]),
    uses: [
      "pstack.roles", "session.start.*", "session.ask", "session.end", "pstack.author.options", "box.net@{repo.host}",
      "git.worktree.create", "git.worktree.get", "proc.run@{worktrees}/*", "pstack.pr.bind",
      "forge.pr.ensure@{repo.host}/{repo.path}/pr/*", "forge.pr.read@{repo.host}/{repo.path}",
      "forge.pipeline.read@{repo.host}/{repo.path}", "forge.checks.read@{repo.host}/{repo.path}",
      "evidence.attest", "evidence.covers", "evidence.list",
    ],
    phases: [{ title: "Frame" }, { title: "Baseline" }, { title: "Primitives" }, { title: "Components" }],
  },
  async ({ task, repo, worktrees, base }) => {
    const seats = await roles();
    phase("Frame");
    const got = await frame(text, { task, repo, roles: seats, schema: comparison, ask: [
      "Identify the existing unmodified harness and exact command for this surface. Give relative reference and actual PNG paths per state, exact allowed committed paths per component, and all immutable harness and baseline paths. List a blocking shared primitive slice if needed. Block if the reference is missing or inconsistent.",
    ] });
    const blocked = (why: string, evidence?: Z.output<typeof captureSchema>) => ({ status: "blocked" as const, why, ...(evidence ? { evidence } : {}) });
    if (got.kind === "blocked") return blocked(got.why);
    const all = [...(got.shared ? [got.shared] : []), ...got.components];
    const paths = all.flatMap((one) => one.paths);
    const references = new Set(all.flatMap((one) => one.states.map(({ reference }) => reference)));
    if (all.some((one) => one.states.some(({ actual }) => references.has(actual)))) {
      return blocked("A surface capture path overlaps the frozen reference images");
    }
    const protectedPaths = [...got.protectedPaths, ...references];
    if (new Set(all.map((one) => one.id)).size !== all.length || new Set(paths).size !== paths.length ||
        paths.some((path) => protectedPaths.some((protectedPath) => path === protectedPath || path.startsWith(protectedPath + "/")))) {
      return blocked("Shared and component scopes must be disjoint from each other and the frozen baseline");
    }
    if (all.some((one) => new Set(one.states.map(({ name }) => name)).size !== one.states.length)) return blocked("States need unique names within a component");
    phase("Baseline");
    const original = await makeWorktree({ repo: repo.local, base, description: "Capture the untouched visual baseline" });
    const originalHead = await exactCheckout(original, "visual-original");
    const captured = await compare("original", original, got.command, all.flatMap((one) => one.states));
    await exactCheckout(original, "visual-original-after", originalHead);
    if (captured.states.length !== all.flatMap((one) => one.states).length || captured.states.some((one) => one.reference === null || one.count === null)) {
      return blocked("The untouched harness did not produce readable baseline and surface captures", captured);
    }
    let offset = 0;
    const baseline = new Map(all.map((one) => {
      const from = offset;
      offset += one.states.length;
      return [one.id, { worktree: original.path, run: captured.run, states: captured.states.slice(from, offset) }] as const;
    }));
    const framed = { reference: got.reference, surface: got.surface, baseline: got.baseline, differences: got.differences };
    let parent = originalHead;
    let branch = base;

    type Result = Z.output<typeof verified>["components"][number];
    const migrate = async (part: Component): Promise<{ report: Result; head?: string; branch?: string }> => {
      const initial = baseline.get(part.id)!;
      const runs = [initial];
      const report = (status: Result["status"], reason?: string): Result => ({ id: part.id, status, runs, ...(reason ? { reason } : {}) });
      if (initial.states.every((one) => one.count === 0) && parent === originalHead) return { report: report("matched") };
      const wt = await makeWorktree({ repo: repo.local, base: parent, description: `Visual component ${part.id}` });
      const author = await localAuthor(`visual-${part.id}`, wt);
      let last = parent;
      let summary = "";
      let nextDirection = "";
      try {
        if (parent !== originalHead) {
          const current = await compare(`${part.id}-incoming`, wt, got.command, part.states);
          await exactCheckout(wt, `${part.id}-incoming-head`, parent);
          runs.push(current);
          if (current.states.length !== initial.states.length || current.states.some((one, index) => one.reference !== initial.states[index]?.reference || one.count === null)) {
            return { report: report("blocked", "The shared migration altered the frozen reference or capture") };
          }
          if (current.states.every((one) => one.count === 0)) return { report: report("matched") };
        }
        for (let round = 1; ; round += 1) {
          const answer = await author.ask(brief(stepTag("visual-parity", "component"), text, task, [
            `Component ${part.id}, scope ${part.paths.join(", ")}. Preserve harness, source structure and baseline. Commit the minimal pixel correction.`,
            JSON.stringify(runs.at(-1)?.states.map(({ name, count }) => ({ name, count }))),
            nextDirection,
          ]), { label: `pixels-${round}`, schema: z.strictObject({ summary: detail }) });
          summary = answer.summary;
          const key = `${part.id}-${round}`;
          const head = await exactCheckout(wt, `${key}-head`);
          const lineage = await gitOut(`${key}-parent`, wt.path, ["rev-list", "--parents", "-n", "1", head]);
          const edited = await gitOut(`${key}-scope`, wt.path, ["diff", "--no-renames", "--name-only", "-z", parent, head]);
          if (lineage !== `${head} ${last}` || !edited || edited.split("\0").filter(Boolean).some((path) => !part.paths.includes(path))) {
            return { report: report("blocked", "The component changed a protected/out-of-scope file or rewrote its verified lineage") };
          }
          last = head;
          const next = await compare(key, wt, got.command, part.states);
          await exactCheckout(wt, `${key}-diff-head`, head);
          runs.push(next);
          if (next.states.length !== initial.states.length || next.states.some((one, index) => one.reference !== initial.states[index]?.reference || one.count === null)) {
            return { report: report("blocked", "Capture was inconclusive or the frozen reference changed") };
          }
          if (next.states.every((one) => one.count === 0)) break;
          const previous = runs.at(-2);
          const unchanged = next.states.every((one, index) => one.actual === previous?.states[index]?.actual);
          if (unchanged || round === got.rounds) {
            const decision = await frame(text, { task, repo, roles: seats, schema: retry, label: `${key}-retry`, ask: [
              `Own the next visual decision for ${part.id}. The latest capture still differs from the frozen baseline. Name a remaining scoped correction or block with its specific reason.`,
              JSON.stringify(next.states.map(({ name, count, actual, reference }) => ({ name, count, actual, reference }))),
            ] });
            if (decision.kind === "blocked") return { report: report("unverified", decision.why) };
            nextDirection = decision.next;
          }
        }
      } finally {
        await author.end();
      }
      await publishVerified(`${part.id}-publish`, wt, last);
      const proof = `${got.surface}, ${got.baseline}: zero pixels across ${part.states.map((one) => one.name).join(", ")}. ${artifactName(runs.at(-1)!.run)}.`;
      const done = await deliverBuilt(part.id, {
        playbook: text, repo, base: branch, worktrees, roles: seats, task, title: titleOf(`${part.id}: ${task}`), prEvidence: proof,
        verification: [proof, `Independently replay ${got.command} and compare the decoded pixels for ${JSON.stringify(part.states)}`],
      }, { wt, author: author.address, sha: last, summary });
      return { report: { ...report(done.verified ? "verified" : "unverified"), delivery: changeResult(done) }, head: last, branch: wt.branch };
    };

    const results: Result[] = [];
    if (got.shared) {
      phase("Primitives");
      const shared = await migrate(got.shared);
      results.push(shared.report);
      if (shared.report.status !== "verified" && shared.report.status !== "matched") return { status: "unverified" as const, framed, components: results };
      parent = shared.head ?? parent;
      branch = shared.branch ?? branch;
    }
    phase("Components");
    const lanes = await map("components", got.components, { key: (one) => one.id }, migrate);
    results.push(...lanes.map((lane, index): Result => lane.ok ? lane.value.report : {
      id: got.components[index]!.id, status: "blocked", reason: lane.error.message, runs: [],
    }));
    return {
      status: results.every((one) => one.status === "matched") ? "matched" as const :
        results.every((one) => one.status === "verified" || one.status === "matched") ? "verified" as const : "unverified" as const,
      framed, components: results,
    };
  },
);
