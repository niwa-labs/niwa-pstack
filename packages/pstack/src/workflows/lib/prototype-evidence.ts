import { decisionProbe } from "./decision-probe.ts";
import { zod } from "./inputs.ts";

export function scratchFileSchema() {
  return zod().string().max(500).refine((path) => path.split("/").every((part) =>
    part !== "" && part !== "." && part !== ".." && part.toLowerCase() !== ".git" && !/[\\\x00-\x1f]/.test(part)),
  "Use a scratch-relative path");
}

export async function readScratchFile(label: string, cwd: string, path: string, image = false, allowMissing = false) {
  const result = await decisionProbe(label, cwd, ["bun", "-e", `
    import { realpath, stat } from "node:fs/promises";
    import { sep } from "node:path";
    const path = await realpath(Bun.argv[1]).catch((error) => {
      if (Bun.argv[3] === "optional" && error.code === "ENOENT") return undefined;
      throw error;
    });
    if (path === undefined) {
      console.log("null");
      process.exit(0);
    }
    const info = await stat(path, { bigint: true });
    if (!path.startsWith(await realpath(".") + sep) || !info.isFile()) {
      throw new Error("Artifact must be a file inside the scratch checkout");
    }
    if (Bun.argv[2] === "image") {
      const { stdout, exitCode } = Bun.spawnSync(["file", "-b", "--", path]);
      if (exitCode !== 0 || !/^(PNG|JPEG|WebP|RIFF.*Web\\/P|GIF)\\b/.test(stdout.toString())) {
        throw new Error("Artifact cannot be recognized as an image");
      }
      const digest = new Bun.CryptoHasher("sha256").update(await Bun.file(path).arrayBuffer()).digest("hex");
      console.log(JSON.stringify({ digest, stamp: String(info.ino) + ":" + String(info.mtimeNs) }));
    } else process.stdout.write(await Bun.file(path).text());
  `, path, image ? "image" : "text", allowMissing ? "optional" : "required"]);
  if (result.exit !== 0 || result.truncated || result.output.trim() === "") {
    throw new Error("Cannot read scratch artifact " + path + ": " + result.output);
  }
  return result.output;
}

export async function buildSwitcher(cwd: string, variants: Array<{ name: string; html: string }>) {
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><title>Prototype variants</title>
<style>body{margin:0;font:1rem system-ui}nav{display:flex;gap:.5rem;padding:.5rem}iframe{border:0;width:100%;height:calc(100vh - 3rem)}</style>
<nav aria-label="Variants">${variants.map(({ name }) => `<button type="button">${name}</button>`).join("")}</nav>
<iframe title="Selected prototype" sandbox="allow-scripts"></iframe>
<script>
const variants = ${JSON.stringify(variants.map(({ html }) => html)).replaceAll("<", "\\u003c")};
const buttons = [...document.querySelectorAll("button")];
function select(index) {
  document.querySelector("iframe").srcdoc = variants[index];
  buttons.forEach((button, i) => button.setAttribute("aria-pressed", String(i === index)));
}
buttons.forEach((button, index) => button.addEventListener("click", () => select(index)));
select(0);
</script></html>`;
  const result = await decisionProbe("switcher", cwd, ["bun", "-e",
    'import { writeFile } from "node:fs/promises"; await writeFile("pstack-variants.html", Bun.argv[1], { flag: "wx" });', html]);
  if (result.exit !== 0) throw new Error("Cannot create prototype switcher: " + result.output);
  return cwd + "/pstack-variants.html";
}
