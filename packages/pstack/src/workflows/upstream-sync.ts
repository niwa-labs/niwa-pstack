// Upstream sync: take a new snapshot of upstream's pstack and carry pstack's map of it to the new text. The snapshot
// is refreshed in a worktree of its own; then, round after round, a deterministic tool measures the map (what the
// map covers, and what became of each entry's ranges on both sides) and an author boxed to the worktree works on what
// the report shows: it maps uncovered text, follows touched and gone entries into our code and texts, and drops what
// it does not take, with the reason. The tool measures and concludes nothing; every conclusion is the author's. The
// loop ends when the coverage reaches its minimum and no entry is touched or gone, or after a bounded number of
// rounds. What would change what a workflow does is the owner's to decide, and goes to the owner as a question. The
// run ends on a branch of commits: the workflows it changed come in as candidates, and the suite tries them.
//
// The tool and git run on the host, through the pstack plugin's actions, not in `proc.run`: a real box reads only its
// own directory, so it can read neither the upstream checkout nor the repository a worktree belongs to, and git does
// not run in a worktree there. The boxed author therefore only edits files: it answers which entries are settled, and
// the workflow records them and commits.

import { makeWorktree } from "@niwa-labs/flow-code";
import type { ScriptApi } from "@niwa-labs/script";

import { api, authorOptions, roles, seatOptions, stepTag } from "./lib/script.ts";

declare const workflow: ScriptApi["workflow"];
declare const z: ScriptApi["z"];
declare function phase(title: string): void;

/** The numbers a measurement answers. */
interface Summary {
  problems: number;
  textProblems: number;
  coverage: number;
  entries: number;
  unchanged: number;
  touched: number;
  gone: number;
  uncovered: number;
}

/** Whether the map is where the sync wants it: sound, covering enough, and nothing touched or gone. The texts lag the map until they are assembled, so they are not asked of it. */
const settled = (summary: Summary, min: number): boolean => summary.problems === 0 && summary.coverage >= min && summary.touched === 0 && summary.gone === 0;

const answered = z.strictObject({
  summary: z.string().min(1).max(4000).describe("What was changed, linked and dropped this round, and why"),
  decisions: z.array(z.strictObject({ question: z.string().min(1).max(1000), why: z.string().min(1).max(2000) })).max(20).describe("What would change what a prompt or a workflow does: left alone, for the owner"),
  accept: z.array(z.string().min(1).max(200)).max(1000).default([]).describe("The ids of the entries whose ranges are settled where the report carried them: the workflow records them"),
});

export default workflow(
  {
    name: "pstack-upstream-sync",
    description: "Carry the upstream map to a new snapshot of upstream",
    input: z.strictObject({
      repo: z.strictObject({ local: z.string().min(1).describe("The real path of the local clone of the pstack repository") }),
      worktrees: z.string().min(1).describe("The real path of the folder niwa keeps its worktrees in, <home>/worktrees"),
      base: z.string().min(1).default("main"),
      package: z.string().min(1).default("packages/pstack").describe("The folder of the pstack package in the repository"),
      upstream: z.strictObject({
        checkout: z.string().min(1).describe("The real path of a checkout of upstream's pstack folder; it is read through git, never written"),
        commit: z.string().min(1).optional().describe("The commit of it to take; its HEAD by default"),
      }),
      min: z.number().min(0).max(100).default(95).describe("The share of upstream's characters the map must cover, in percent"),
      rounds: z.number().int().min(1).max(10).default(4).describe("How many rounds the author gets before the run reports what is left"),
    }),
    output: z.strictObject({
      status: z.enum(["synced", "unfinished", "stalled"]),
      upstream: z.string(),
      worktree: z.string(),
      branch: z.string(),
      head: z.string(),
      summary: z.strictObject({ problems: z.number(), textProblems: z.number(), coverage: z.number(), entries: z.number(), unchanged: z.number(), touched: z.number(), gone: z.number(), uncovered: z.number() }),
      rounds: z.array(z.strictObject({ round: z.number(), before: z.string(), summary: z.string() })),
      decisions: z.array(z.strictObject({ question: z.string(), why: z.string(), answer: z.string() })),
      changed: z.array(z.string()),
    }),
    uses: [
      "pstack.roles",
      "session.start.*",
      "pstack.author.options",
      "session.ask",
      "session.end",
      "git.worktree.create",
      "pstack.upstream.refresh",
      "pstack.upstream.measure",
      "pstack.upstream.record",
      "pstack.upstream.assemble",
      "pstack.upstream.commit",
      "pstack.upstream.state",
      "request.ask",
    ],
    phases: [
      { title: "Refresh", detail: "The snapshot is taken from the checkout, in a worktree" },
      { title: "Carry", detail: "The tool measures, the author works on what it shows, until the map is settled" },
      { title: "Decide", detail: "What would change a workflow goes to the owner" },
      { title: "Record", detail: "The texts are assembled from the map and committed" },
    ],
  },
  async ({ repo, base, package: pkg, upstream, min, rounds }) => {
    const seats = await roles();
    const wt = await makeWorktree({ repo: repo.local, base, description: "Carry the map of upstream's pstack to a new snapshot" });
    const report = ".upstream-map-report.json";
    const place = { place: wt.path, package: pkg };
    const given = { ...place, checkout: upstream.checkout };
    const commit = async (key: string, message: string, paths: readonly string[]): Promise<string> =>
      ((await api().call("pstack.upstream.commit", { place: wt.path, message, paths }, { label: key })) as { head: string }).head;
    const headOf = async (key: string): Promise<string> => ((await api().call("pstack.upstream.state", { place: wt.path }, { label: key })) as { head: string }).head;
    const measure = async (key: string): Promise<Summary> => (await api().call("pstack.upstream.measure", given, { label: key })) as Summary;
    const record = async (key: string, message: string, accept: readonly string[] = []): Promise<void> => {
      // A map with problems is not recorded: the next measurement says so and the author mends it. Nothing here throws.
      await api().call("pstack.upstream.record", { ...given, accept }, { label: `${key}-record` });
      await commit(key, message, [pkg]);
    };

    phase("Refresh");
    const refreshed = (await api().call("pstack.upstream.refresh", { ...given, ...(upstream.commit === undefined ? {} : { commit: upstream.commit }) }, { label: "refresh" })) as { commit: string };
    const taken = refreshed.commit;
    await commit("snapshot", `Take upstream pstack at ${taken.slice(0, 9)}`, [`${pkg}/upstream`]);

    phase("Carry");
    const author = await api().session({ ...await authorOptions("author", wt.path), label: "author" });
    const log: Array<{ round: number; before: string; summary: string }> = [];
    const asked: Array<{ question: string; why: string }> = [];
    let status: "synced" | "unfinished" | "stalled" = "unfinished";
    let summary = await measure("measure-0");
    const work = async (key: string, round: number, say: string[]): Promise<boolean> => {
      const before = await headOf(`${key}-before`);
      const said = await author.ask(
        [
          stepTag("upstream-sync", "round"),
          "",
          `You carry pstack's map of the upstream playbooks to a new snapshot of upstream. Work in ${wt.path}, on the branch ${wt.branch}.`,
          `The map is ${pkg}/upstream/mapping.json: entries { id, upstream, ours, kind, note }. A range is [start, end) in characters of a file at a commit, and nothing quoted is stored.`,
          "The kinds: prompt, a block that goes into a prompt as upstream wrote it; adapted, a block our own text replaces in a prompt (the text is in the file the entry links to); code, a block that code of ours implements; dropped, a block we do not take, with the reason in its note. Dropped counts as covered. `ours` links an entry to the ranges that carry it.",
          `The tool measures the map and decides nothing: its whole report is in ${report}, as JSON, and the numbers are below. It reports the coverage of upstream's characters per file with the uncovered ranges, and for each entry whether it is unchanged, touched (with the old and the new text of the range) or gone, on the upstream side and on ours. It also holds the texts the scripts import to the map: a text equals upstream except where an adapted entry puts our wording in and a dropped one takes a range out.`,
          "You cannot run the tool or git here. Edit the files of the worktree; the workflow commits them when you answer, then records the entries and measures again. The map is measured at the commit of the worktree.",
          `Settle: first the problems the report lists, if any; then map each uncovered range (prompt, adapted, code or dropped with a note), follow each touched entry into our code and texts, and link again or drop each gone one. The coverage must reach ${String(min)}% and no entry may stay touched or gone.`,
          "An entry that is touched only because its range moved or changed where our text is still upstream's is settled as it is: answer its id in `accept`, and the workflow records it at the positions the report carried it to. Edit the entry by hand instead to link other ranges or to change its kind.",
          "Carry what upstream changed verbatim where our text is its text. A change that would alter what a prompt or a workflow does is not yours to make: leave it, and answer it as a decision with the reason.",
          ...say,
          "",
          `The report now: ${JSON.stringify(summary)}`,
          "Answer what you did this round, the decisions left for the owner, and the ids to accept.",
        ].join("\n"),
        { schema: answered, label: key },
      );
      for (const one of said.decisions) if (!asked.some((seen) => seen.question === one.question)) asked.push(one);
      log.push({ round, before, summary: said.summary });
      await commit(`${key}-work`, `Map the upstream changes, round ${String(round)}`, [pkg]);
      // What the author changed or settled is progress; recording the unchanged entries is not.
      const moved = (await headOf(`${key}-after`)) !== before || said.accept.length > 0;
      await record(`${key}-carry`, "Record the upstream ranges that did not change", said.accept);
      return moved;
    };
    for (let round = 1; round <= rounds && !settled(summary, min); round += 1) {
      const moved = await work(`round-${String(round)}`, round, []);
      summary = await measure(`measure-${String(round)}`);
      if (!moved && !settled(summary, min)) {
        status = "stalled";
        break;
      }
    }

    phase("Decide");
    const decisions: Array<{ question: string; why: string; answer: string }> = [];
    for (const [index, one] of asked.entries()) {
      decisions.push({ ...one, answer: await api().ask.text([`The sync of upstream's pstack leaves this to you: ${one.question}`, "", one.why].join("\n"), { label: `decision-${String(index)}` }) });
    }
    if (decisions.length > 0) {
      status = "unfinished";
      await work("decided", log.length + 1, ["The owner answered what you left to them. Carry out each answer, and leave nothing of it undone:", ...decisions.map((one) => `- ${one.question}: ${one.answer}`)]);
      summary = await measure("measure-decided");
    }
    await author.end();
    if (settled(summary, min)) status = "synced";

    phase("Record");
    if (status === "synced") {
      await api().call("pstack.upstream.assemble", given, { label: "assemble" });
      await commit("texts", "Assemble the playbook texts from the map", [`${pkg}/src/workflows/texts`]);
      // The texts followed the map: held to it again, they must equal what it says, or the run is not done.
      summary = await measure("measure-texts");
      if (summary.problems > 0 || summary.textProblems > 0) status = "unfinished";
    }
    const state = (await api().call("pstack.upstream.state", { place: wt.path, base, paths: [`${pkg}/src`] }, { label: "state" })) as { head: string; changed: string[] };
    return { status, upstream: taken, worktree: wt.path, branch: wt.branch, head: state.head, summary, rounds: log, decisions, changed: state.changed };
  },
);
