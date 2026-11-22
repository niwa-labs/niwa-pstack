import { decisionProbe } from "./decision-probe.ts";

const validate = String.raw`
import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
const root = await realpath(".");
const input = Bun.argv[1];
const path = async (requested) => {
  const physical = await realpath(requested);
  if (!physical.startsWith(root + sep)) throw new Error("Reference leaves the repository: " + requested);
  return physical;
};
const skill = await path(resolve(root, input));
const source = await readFile(skill, "utf8");
const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
if (!match) throw new Error("Missing YAML frontmatter");
const meta = Bun.YAML.parse(match[1]);
for (const key of ["name", "description"]) {
  if (typeof meta?.[key] !== "string" || !meta[key].trim()) throw new Error("Missing frontmatter " + key);
}
const body = source.slice(match[0].length).replace(/^\s*(?:\x60{3,}|~{3,})[^\n]*\n[\s\S]*?^\s*(?:\x60{3,}|~{3,})[^\n]*$/gm, "");
const links = [
  ...Array.from(body.matchAll(/\[[^\]\n]+\]\(\s*(?:<([^>]+)>|([^\s)]+))/g), (link) => link[1] ?? link[2]),
  ...Array.from(body.matchAll(/^\s*\[[^\]\n]+\]:\s*(?:<([^>]+)>|(\S+))/gm), (link) => link[1] ?? link[2]),
];
const checked = [];
const referencedPaths = new Set(JSON.parse(Bun.argv[2]));
for (const [_, target] of body.matchAll(/\x60((?:\.\.?\/|skills\/)[^\x60\n]+)\x60/g)) {
  if (!target.includes(" ") && !target.includes("<")) referencedPaths.add(target);
}
for (const link of new Set(links)) {
  if (/^(?:[a-z][a-z\d+.-]*:|#|\/\/)/i.test(link)) continue;
  const target = decodeURIComponent(link.split("#")[0].split("?")[0]);
  const linked = await path(resolve(dirname(skill), target));
  await stat(linked);
  checked.push(target);
}
for (const reference of referencedPaths) {
  const directory = reference.startsWith("skills/") ? root : dirname(skill);
  const linked = await path(resolve(directory, reference));
  await stat(linked);
  if (!checked.includes(reference)) checked.push(reference);
}
console.log(JSON.stringify({ name: meta.name, description: meta.description, checked }));
`;

export async function validateSkill(cwd: string, file: string, references: string[] = []) {
  const result = await decisionProbe("skill-structure", cwd, ["bun", "-e", validate, file, JSON.stringify(references)]);
  if (result.exit !== 0 || result.truncated) throw new Error("Skill validation failed: " + result.output);
  return result;
}
