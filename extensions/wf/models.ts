/**
 * Models per role: resolving and validating the configured `provider/id` strings against
 * Pi's model registry, and knowing each model's context window.
 */
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { Config } from "./ledger.ts";

export type Role = "manager" | "worker" | "reviewer" | "tester";
export const ROLES: Role[] = ["tester", "manager", "worker", "reviewer"];

interface ModelLike {
  provider: string;
  id: string;
  contextWindow?: number;
}

const key = (m: ModelLike) => `${m.provider}/${m.id}`;

/** Find a configured model string ("provider/id", optional ":thinking" suffix, or a bare id). */
export function findModel(ctx: ExtensionCommandContext, spec: string): ModelLike | undefined {
  const reg = (ctx as { modelRegistry?: { getAll(): ModelLike[]; find(p: string, id: string): ModelLike | undefined } }).modelRegistry;
  if (!reg) return undefined;
  const bare = spec.replace(/:[a-z]+$/, "");
  const slash = bare.indexOf("/");
  if (slash > 0) return reg.find(bare.slice(0, slash), bare.slice(slash + 1));
  return reg.getAll().find((m) => m.id === bare);
}

/** Models you can use right now (credentials present), for pickers. */
export function availableModels(ctx: ExtensionCommandContext): ModelLike[] {
  const reg = (ctx as { modelRegistry?: { getAvailable(): ModelLike[] } }).modelRegistry;
  return reg ? reg.getAvailable() : [];
}

export const modelLabel = (m: ModelLike) => `${key(m)}${m.contextWindow ? ` · ${Math.round(m.contextWindow / 1000)}k context` : ""}`;

/** Context window of a configured model, or of the session model when none is set. */
export function contextWindow(ctx: ExtensionCommandContext, spec: string | undefined): number | undefined {
  if (!spec) return (ctx.model as ModelLike | undefined)?.contextWindow;
  return findModel(ctx, spec)?.contextWindow;
}

/** Every configured model that Pi doesn't know or can't use, as readable problems (empty = all good). */
export function validateModels(ctx: ExtensionCommandContext, cfg: Config): string[] {
  if (!(ctx as { modelRegistry?: unknown }).modelRegistry) return [];
  const configured: [string, string][] = [
    ...Object.entries(cfg.models).filter((e): e is [string, string] => !!e[1]),
    ...(cfg.escalate?.model ? ([["escalate", cfg.escalate.model]] as [string, string][]) : []),
  ];
  const available = new Set(availableModels(ctx).map(key));
  const problems: string[] = [];
  for (const [role, spec] of configured) {
    const m = findModel(ctx, spec);
    if (!m) problems.push(`${role}: "${spec}" is not a model Pi knows`);
    else if (!available.has(key(m))) problems.push(`${role}: "${spec}" has no credentials configured in Pi`);
  }
  return problems;
}
