import { zod } from "./inputs.ts";
import { captureFreshFile, evidenceSchema, replay } from "./parity-proof.ts";
import { reduceTrace, traceCaptureSchema } from "./trace-reduction.ts";

export function workloadSchema() {
  const z = zod();
  const detail = z.string().trim().min(1).max(2000);
  return z.strictObject({
    surface: detail, driver: detail, unit: detail, workload: detail, limiter: detail, comparability: detail,
    easier: detail, profile: detail, profilePath: detail.optional(), gate: detail, harnessPaths: z.array(detail).max(40).default([]),
    samples: z.number().int().min(5).max(21).default(5),
  });
}

export type Workload = ReturnType<typeof workloadSchema>["_output"];
function sampleSchema() {
  const z = zod();
  return z.strictObject({ receipt: evidenceSchema(), value: z.number().nullable(), work: z.number().nullable() });
}

export type Sample = ReturnType<typeof sampleSchema>["_output"];

export function profileSchema() {
  return zod().strictObject({ receipt: evidenceSchema(), capture: traceCaptureSchema().nullable() });
}

export function calibrationSchema() {
  const z = zod();
  return z.strictObject({
    environment: evidenceSchema(), profile: evidenceSchema(), capture: traceCaptureSchema().nullable(),
    easier: z.array(sampleSchema()), baseline: z.array(sampleSchema()), gate: evidenceSchema(),
  });
}

export function pairedSchema() {
  const z = zod();
  const summary = z.strictObject({ median: z.number(), min: z.number(), max: z.number(), work: z.number() }).nullable();
  return z.strictObject({ before: summary, after: summary, baseline: z.array(sampleSchema()), candidate: z.array(sampleSchema()) });
}

export async function sample(key: string, cwd: string, command: string, spec: Workload): Promise<Sample> {
  const receipt = await replay(key, cwd, command);
  try {
    const report = zod().strictObject({
      metric: zod().number(), errors: zod().literal(0), work: zod().number().int().positive(),
      surface: zod().literal(spec.surface), driver: zod().literal(spec.driver),
    }).parse(JSON.parse(receipt.tail.trim().split("\n").at(-1) ?? ""));
    if (receipt.complete && receipt.exit === 0) return { receipt, value: report.metric, work: report.work };
  } catch {
    // Missing counters, wrong surface and invalid reports cannot be compared.
  }
  return { receipt, value: null, work: null };
}

export function summarize(samples: readonly Sample[], expectedWork?: number) {
  const work = expectedWork ?? samples[0]?.work;
  if (!work || samples.some((one) => one.value === null || one.work !== work)) return null;
  const values = samples.map((one) => one.value as number).sort((a, b) => a - b);
  const middle = Math.floor(values.length / 2);
  return {
    median: (values[middle]! + values[Math.floor((values.length - 1) / 2)]!) / 2,
    min: values[0]!, max: values.at(-1)!, work,
  };
}

export async function series(key: string, cwd: string, command: string, spec: Workload) {
  const samples: Sample[] = [];
  for (let i = 0; i < spec.samples; i += 1) samples.push(await sample(`${key}-${i + 1}`, cwd, command, spec));
  return samples;
}

export async function profileRun(key: string, cwd: string, spec: Workload) {
  const receipt = spec.profilePath ? await captureFreshFile(key, cwd, spec.profile, spec.profilePath) : await replay(key, cwd, spec.profile);
  const capture = spec.profilePath && receipt.complete && receipt.exit === 0 ?
    await reduceTrace(`${key}-trace`, cwd, spec.profilePath) : null;
  return { receipt, capture };
}

export async function calibrate(cwd: string, command: string, spec: Workload, direction: "lower" | "higher") {
  const environment = await replay("bench-host", cwd, "uptime && getconf _NPROCESSORS_ONLN");
  const profileResult = await profileRun("bench-profile", cwd, spec);
  const { receipt: profile, capture } = profileResult;
  const easier = await series("easier", cwd, spec.easier, spec);
  const baseline = await series("baseline", cwd, command, spec);
  const gate = await replay("baseline-gate", cwd, spec.gate);
  const reference = summarize(baseline);
  const contrast = summarize(easier);
  const separated = reference && contrast && (direction === "lower" ? contrast.max < reference.min : contrast.min > reference.max);
  return {
    reference: environment.exit === 0 && profile.exit === 0 && profile.complete &&
      (spec.profilePath ? !!capture?.reduced?.count : !!profile.tail.trim()) && gate.exit === 0 && gate.complete && separated ? reference : null,
    evidence: { environment, profile, capture, easier, baseline, gate },
  };
}

export async function paired(key: string, before: string, after: string, command: string, spec: Workload, work: number) {
  const baseline: Sample[] = [];
  const candidate: Sample[] = [];
  for (let i = 0; i < spec.samples; i += 1) {
    baseline.push(await sample(`${key}-before-${i + 1}`, before, command, spec));
    candidate.push(await sample(`${key}-after-${i + 1}`, after, command, spec));
  }
  return { before: summarize(baseline, work), after: summarize(candidate, work), baseline, candidate };
}

export function separated(
  before: NonNullable<ReturnType<typeof summarize>>,
  after: NonNullable<ReturnType<typeof summarize>>,
  direction: "lower" | "higher",
  noise = 0,
) {
  return direction === "lower" ? before.min - after.max > noise : after.min - before.max > noise;
}
