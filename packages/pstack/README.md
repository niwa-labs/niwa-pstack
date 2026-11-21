# @niwa-labs/pstack

Delivery playbooks run as niwa's built-in workflows: an entry that routes a request to the playbook it needs, one
workflow per upstream playbook, Benny for issue reports when he is enabled, and a suite that tries every new version
of them before the host runs it.

## Composition

```ts
import { addressingOf, pstack } from "@niwa-labs/pstack";

const base = defaultComposition({ home, harnesses, kinds, agents });
export default [
  ...base,
  ...pstack({
    bind: addressingOf(base),
    forge: { servers: [{ host: "gitlab.example.com", url: "https://gitlab.example.com", token: secret("GITLAB_TOKEN") }] },
    roles: {
      lead: { harness: "claude" },
      author: { harness: "codex", box: true },
      reviewer: { harness: "claude" },
      verifier: { harness: "pi", vendor: "minimax" },
      judge: { harness: "pi", vendor: "glm" },
    },
    benny: { repo: { host: "gitlab.example.com", path: "acme/billing", local: "/work/billing" } },
  }),
  workflow(),
];
```

`pstack()` installs forge, evidence, watch and plan, then the pstack plugin. The host provides the sessions and git
modules before it and the workflow module after it. `bind` is the binding of the host's sessions and agents modules
(`addressingOf`), so a session attests under one address for its whole life and an agent's session as the agent.

## Roles

- `lead` frames, routes and judges, read-only.
- `author` writes code. It carries `box: true`: pstack's plugin starts its sessions (`pstack.author.start`) with writes
  limited to one of niwa's worktrees, by real path, and network limited to the forges' hosts. A place outside niwa's
  worktrees is refused before a session exists.
- `reviewer` judges review threads.
- `verifier` re-runs the gates and shows the behaviour live. It must run on another harness than the author, and it
  attests its verdicts under its own name.
- `judge` grades an evaluation. It is of another vendor than the candidates.

## Playbooks

| Playbook | What it does |
|---|---|
| investigation | Answers a question about the code, with sources |
| trace-forensics, runtime-forensics | Hold hypotheses against a trace or runtime evidence, and name the cause one confirmed hypothesis leaves |
| bug-fix, feature, refactoring, perf-issue, visual-parity, authoring-a-skill | The lead frames the work, and an owner lane carries it to a verified pull request |
| hillclimb | One metric, one change at a time: kept when the measurement moved, reverted in full otherwise |
| autonomous-run | Iterates in a boxed worktree until a done predicate holds |
| prototype | Throwaway variants in scratch worktrees, and a recommendation |
| eval | Variants answer blind; a judge of another vendor grades them on a rubric they never see |
| multi-phase-plan | Writes the plan as a revision in niwa and asks the owner's go, attested node by node |
| autopilot-full | One owner lane per plan node, in parallel off trunk; the nodes land one at a time under the merge policy |
| autopilot-stack | The same, stacked where one node builds on another, without merging; it can carry a stack onto a new lower head |
| shipping | Lands a verified stack bottom up under the merge policy |
| opening-a-pr | Opens a ready pull request with the briefing upstream asks for |
| babysit | Conflicts, threads, then CI, in `check`, `threads-only` or `drive` mode; it never merges or rebases |
| pause-safely | A `wip:` commit and a resume note in the worktree the work is in |
| session-pickup | Where the work stands, from the plan and what was attested on it |
| worktree-cleanup | On a merge on the forge, removes the clean worktrees the merged head was built in |

A lane builds in a worktree off trunk with a boxed author. It opens the pull request only for the commit the author
made; a head on the forge that the author did not answer is a push the lane did not make. Verifiers that did not write
the code attest the `gates` and `live` verdicts on that head.

## The merge policy

A pull request lands only when all of these hold at its current head:

- the owner's go covers each plan node it delivers. A go is bound by digest to the plan's revision, the node and the
  change, and only the owner or a run may give one. A revised plan needs a new go.
- the `gates` and `live` verdicts passed, from someone other than the patch's author;
- the pipeline of the head is green;
- the merge result of the pair the forge would merge now is green and attested with that pair of commits.

Trunk that conflicts with the patch stops the landing before anything is asked of the forge. Any other move of trunk
(a file both sides changed, a lockfile, a manifest, a file that names a patched one) is what the merge result tests.
The merge is made at the head the policy was checked on, and is read back from the forge.

## Candidates and the suite

Every built-in but the suite is offered gated. A new version comes in as a candidate that the host neither installs nor
runs on events. Before any version was accepted, the candidate is shown and runs on nothing.

The suite (`pstack-suite`) is started by the owner on a fixture: a repository it may change, on a forge project it may
merge into. It runs every scenario in order on the set under trial, each built-in started by its version. The entry is
pinned to the playbook versions of the set, and one scenario hands its plan to the next. Only when every scenario passes
does it promote the candidates, in one `workflow.builtin.promote` with its run's id. On its own fixture's plans, the
suite gives the go itself, as a run may.

## Benny

With `benny`, the plugin offers the agent `benny` to the agents module, an action `benny.report`, and two gated
automations. Every report is triaged as data. A report triaged as a bug is reproduced twice before any code is touched,
and then fixed in a draft pull request. Benny never merges or deploys.

## The upstream snapshot

`upstream/` keeps the pstack plugin of [cursor/plugins](https://github.com/cursor/plugins) (MIT) at the commit in
`upstream/SOURCE.json`: the operator's skill, the worker rules, the playbooks, the reference they name, and the Benny
pack. The scripts read the texts from `src/workflows/texts/`, which a refresh writes from the snapshot:

```sh
bun packages/pstack/scripts/refresh-upstream.ts <path to the pstack folder of a cursor/plugins checkout>
```

A playbook whose text changed gets a new version, which comes in as a candidate and goes through the suite.

## What niwa does not give yet

- A script's `uses` holds call rules only, so a run cannot hold the write and network rules of a box. The author's box
  is a right of the pstack plugin.
- The git module's actions carry no target, so the entry's `git.*@{repo.local}` reaches none of them. The entry names
  the worktree actions it calls untargeted.
