# pstack

`@niwa-labs/pstack` brings the pstack delivery playbooks from
[cursor/plugins](https://github.com/cursor/plugins/tree/aaeb0ea3a0584995aa8f55ce44c6c5259414b896/pstack)
to [Niwa](https://github.com/niwa-labs/niwa) as 22 built-in workflows.
An entry workflow routes requests to the appropriate playbook, from code
investigation and bug fixes to pull request review and shipping. Workflows
can wait for a decision or a forge result and resume through Niwa's journal.
In delivery lanes a boxed author works in a Git worktree. A separate verifier
records gate and live verdicts, and the forge reports the pipeline and the
commit pair considered for merging.

Niwa provides sessions, worktrees, workflow execution and operator surfaces.
[Niwa Plugins](https://github.com/niwa-labs/niwa-plugins) supplies forge for
merge requests and pipelines, evidence for attestations, watch for stalled
sessions and runs, and plan for revisions. The pstack composition installs
these four packages and its workflows tie the owner's approval to the
specific plan revision being delivered.

Benny is an optional agent that triages incoming reports, reproduces
confirmed bugs and can open a draft pull request. Enable him with plugins
that implement your issue tracker, report channel and product-control ports.

## Add pstack to a source host

Use the [Niwa source setup](https://github.com/niwa-labs/niwa#run-from-source)
and the sibling checkouts below. The [package guide](packages/pstack/README.md)
shows the TypeScript composition and each playbook. In the workspace's
`host.ts`, import `addressingOf` and `pstack` from
`./pstack/packages/pstack/src/index.ts` for that example. Give the composition
the forge configuration and map the lead, author, reviewer and verifier to
your harness installation IDs. Register those installations in the host's
harness registry and list their IDs in `workflow.harnesses` in
`defaultComposition`. Give the author a box and use a different harness for
verification. An evaluation can set a separate judge with a different model
vendor from its candidates.

Install the pstack composition after the sessions and Git modules and before
the workflow module. This lets pstack use the host's addressing and worktrees
and lets the workflow module register the built-ins it offers.

After restarting the host, use `niwa pstack.roles` to check the bindings and
`niwa workflow.list` to find the pstack built-ins. The first registration runs
in the background. New playbook versions are registered as candidates. Run
the pstack `suite` workflow with a
designated fixture repository and a forge project where the suite may create
test branches and pull requests and exercise the merge policy. The suite
promotes the pinned set only after every scenario passes. Shipping requires a
forge that can verify both the source and target commits atomically when
merging. On GitLab, the merge API checks only the source commit, so the
workflow leaves verified requests open.

## Develop from source

The workspace links dependencies from sibling checkouts. Clone the repositories
into the local names below and install them in order.

```sh
git clone https://github.com/niwa-labs/niwa.git niwa
git clone https://github.com/niwa-labs/niwa-plugins.git plugins
git clone https://github.com/niwa-labs/niwa-pstack.git pstack
(cd niwa && bun install)
(cd plugins && bun install)
cd pstack
bun install
```

From pstack, run the workspace checks and the upstream map check.

```sh
bun run typecheck
bun run check:boundaries
bun test
bun packages/pstack/scripts/upstream-map.ts check --summary
```

The [upstream snapshot](packages/pstack/upstream) records its source revision
and maps original passages to their corresponding prompts and workflow code.
The map check tracks changes to those passages and compares the prompt files
against what the map assembles.

## Registry installation

Once the packages are available in your registry, run
`bun add @niwa-labs/pstack` in your Niwa composition project.

## License

Niwa Labs contributions use the [MIT License](LICENSE). The upstream material
retains [its original MIT notice](packages/pstack/upstream/LICENSE). The npm
package includes both notices.
