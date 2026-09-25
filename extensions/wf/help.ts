/**
 * Situational help. workflow-help.md is the single source: tagged regions
 * (`<!-- wf:tip key -->` … `<!-- /wf -->`, same for `wf:topic`) are shown after
 * phase results and by /wf:help, so the doc and the in-session text can't drift.
 */
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";

export const HELP_PATH = fileURLToPath(new URL("./workflow-help.md", import.meta.url));

interface Regions {
  tip: Map<string, string>;
  topic: Map<string, string>;
}

let cache: Regions | undefined;

function regions(): Regions {
  if (cache) return cache;
  cache = { tip: new Map(), topic: new Map() };
  let md = "";
  try {
    md = fs.readFileSync(HELP_PATH, "utf8");
  } catch {
    return cache; // help is best-effort; never break a phase over it
  }
  for (const m of md.matchAll(/<!-- wf:(tip|topic) ([\w.-]+) -->\n([\s\S]*?)<!-- \/wf -->/g)) {
    cache[m[1] as keyof Regions].set(m[2], m[3].trim());
  }
  return cache;
}

/** Short "What now" block for a phase result; `{name}` placeholders are filled from vars. */
export function tip(key: string, vars: Record<string, string | number> = {}): string {
  return (regions().tip.get(key) ?? "").replace(/\{(\w+)\}/g, (all, k) => (k in vars ? String(vars[k]) : all));
}

/** A full help section, or undefined if there is no such topic. */
export function topic(name: string): string | undefined {
  return regions().topic.get(name);
}

/** Topic names with their headings, in document order. */
export function topics(): { name: string; title: string }[] {
  return [...regions().topic].map(([name, body]) => ({ name, title: body.match(/^#+\s*(.+)$/m)?.[1] ?? name }));
}
