/**
 * pstack: delivery playbooks run as niwa's built-in workflows. The entry routes a request to the playbook it needs;
 * the suite tries every new version of them on scenarios before the host runs it.
 */

export { PSTACK_NEEDS, pstack } from "./composition.ts";
export type { PstackCompositionOptions } from "./composition.ts";
export { addressingOf } from "./binding.ts";
export type { Binding } from "./binding.ts";
export { AuthorRefusal, authorLaunch } from "./author.ts";
export type { AuthorRefusalCode } from "./author.ts";
export { BENNY, ENTRY, GATED, PLAYBOOKS, SUITE, SUITE_BUILTIN, SYNC, SYNC_BUILTIN, UNGATED, gatedOf, scriptOf } from "./catalog.ts";
export type { Builtin } from "./catalog.ts";
export { pstackPlugin } from "./plugin.ts";
export type { BennyOptions, PstackOptions } from "./plugin.ts";
export { BennyReported, SessionAddress, bennyReport, pstackAuthorStart, pstackRoles } from "./records.ts";
export { GO, VERDICTS, decide, goCovers, goDigest, goSubject, mayGiveGo, mergeRequirements } from "./policy.ts";
export type { Found, MergeSubject, PlanRevision, Required } from "./policy.ts";
export { isLockfile, isManifest, trunkKind } from "./trunk.ts";
export type { TrunkFacts, TrunkKind } from "./trunk.ts";
export { AuthorRole, Roles, SeatRole } from "./roles.ts";
export type { RolesInput } from "./roles.ts";
export { refreshUpstream, playbookNames } from "./upstream.ts";
export type { UpstreamSource } from "./upstream.ts";
export { accept, advance, analyze, assemble, formatMapping, formatReport, parseMapping } from "./mapping/index.ts";
export type { AssembledText, Mapping, Report } from "./mapping/index.ts";
