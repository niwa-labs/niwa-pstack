import { zod } from "./inputs.ts";
import { api } from "./script.ts";

export function commandSchema() {
  const z = zod();
  return z.array(z.string().min(1).max(2000)).min(1).max(40);
}

export async function decisionProbe(label: string, cwd: string, cmd: readonly string[]) {
  const { exit, tail, truncated } = await api().call("proc.run", {
    cmd: [...cmd], cwd, timeout: 60_000,
  }, { label }) as { exit: number | null; tail: string; truncated: boolean };
  return { cmd: [...cmd], exit, output: tail, truncated };
}
