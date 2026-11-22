# pstack

`@niwa-labs/pstack` brings the pstack delivery playbooks from
[cursor/plugins](https://github.com/cursor/plugins/tree/aaeb0ea3a0584995aa8f55ce44c6c5259414b896/pstack)
to [Niwa](https://github.com/niwa-labs/niwa) as 22 built-in workflows.
An entry workflow routes requests to the appropriate playbook, from code
investigation and bug fixes to pull request review and shipping. The package
also includes Benny, an optional agent for triaging and reproducing issue
reports with your tracker, report channel and product-control plugins.

## Use pstack

Once the packages are available in your registry, add pstack to your Niwa
composition project.

```sh
bun add @niwa-labs/pstack
```

Use `pstack()` after the sessions and git modules and before the workflow module.
The [package guide](packages/pstack/README.md) has a composition example,
playbook list and role settings.

New workflow versions are registered as candidates. Run `pstack-suite` with a
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

## License

Niwa Labs contributions use the [MIT License](LICENSE). The upstream material
retains [its original MIT notice](packages/pstack/upstream/LICENSE). The npm
package includes both notices.
