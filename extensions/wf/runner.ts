/**
 * Fresh-context runner: every manager / worker / reviewer call is a separate
 * `pi` process with no session history (paper §2: "every role is the same
 * model in a fresh context"). It only knows what the brief and the repo tell it.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface RunOptions {
  cwd: string;
  role: string;
  systemPrompt: string;
  brief: string;
  /** null = no tools at all */
  tools: string[] | null;
  model?: string;
  thinking?: string;
  childExtensions: boolean;
  signal?: AbortSignal;
  onActivity?: (line: string) => void;
}

export interface RunResult {
  text: string; // final assistant text
  stopReason?: string;
  error?: string;
  exitCode: number;
  cost: number;
  turns: number;
  /** compact transcript (assistant text + tool calls), for the cut-off summarizer */
  transcript: string;
  aborted: boolean;
}

function piInvocation(args: string[]): { command: string; args: string[] } {
  // Override for custom installs and for the test suite's mock.
  const override = process.env.PI_WF_PI_COMMAND;
  if (override) return { command: override, args };
  // Same resolution strategy as Pi's own subagent example.
  const script = process.argv[1];
  if (script && !script.startsWith("/$bunfs/root/") && fs.existsSync(script)) {
    return { command: process.execPath, args: [script, ...args] };
  }
  const exe = path.basename(process.execPath).toLowerCase();
  if (!/^(node|bun)(\.exe)?$/.test(exe)) return { command: process.execPath, args };
  return { command: "pi", args };
}

function preview(args: Record<string, unknown>): string {
  const v = (args.command ?? args.path ?? args.file_path ?? args.pattern ?? "") as string;
  const s = String(v).replace(/\s+/g, " ");
  return s.length > 70 ? `${s.slice(0, 70)}…` : s;
}

export async function runFresh(o: RunOptions): Promise<RunResult> {
  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), `pi-wf-${o.role}-`));
  const sysFile = path.join(tmp, "system.md");
  const briefFile = path.join(tmp, "brief.md");
  await fs.promises.writeFile(sysFile, o.systemPrompt, { mode: 0o600 });
  await fs.promises.writeFile(briefFile, o.brief, { mode: 0o600 });

  const args = ["--mode", "json", "-p", "--no-session"];
  if (!o.childExtensions) args.push("--no-extensions");
  if (o.model) args.push("--model", o.model);
  if (o.thinking) args.push("--thinking", o.thinking);
  if (o.tools === null) args.push("--no-tools");
  else args.push("--tools", o.tools.join(","));
  args.push("--append-system-prompt", sysFile, `@${briefFile}`, "Carry out the brief in the attached file.");

  const res: RunResult = { text: "", exitCode: 0, cost: 0, turns: 0, transcript: "", aborted: false };
  const transcript: string[] = [];

  try {
    res.exitCode = await new Promise<number>((resolve) => {
      const inv = piInvocation(args);
      const proc = spawn(inv.command, inv.args, { cwd: o.cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
      let buf = "";
      let stderr = "";

      const onLine = (line: string) => {
        if (!line.trim()) return;
        let ev: any;
        try {
          ev = JSON.parse(line);
        } catch {
          return;
        }
        if (ev.type !== "message_end" || ev.message?.role !== "assistant") return;
        const m = ev.message;
        res.turns++;
        res.cost += m.usage?.cost?.total ?? 0;
        if (m.stopReason) res.stopReason = m.stopReason;
        if (m.errorMessage) res.error = m.errorMessage;
        const texts: string[] = [];
        for (const part of m.content ?? []) {
          if (part.type === "text" && part.text?.trim()) {
            texts.push(part.text);
            transcript.push(part.text);
          } else if (part.type === "toolCall") {
            const line = `${part.name} ${preview(part.arguments ?? {})}`;
            transcript.push(`[tool] ${line}`);
            o.onActivity?.(line);
          }
        }
        if (texts.length) res.text = texts.join("\n");
      };

      proc.stdout.on("data", (d) => {
        buf += d.toString();
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const l of lines) onLine(l);
      });
      proc.stderr.on("data", (d) => {
        stderr += d.toString();
      });
      proc.on("close", (code) => {
        if (buf.trim()) onLine(buf);
        if ((code ?? 0) !== 0 && !res.error) res.error = stderr.trim().slice(-2000) || `exit code ${code}`;
        resolve(code ?? 0);
      });
      proc.on("error", (e) => {
        res.error = e.message;
        resolve(1);
      });
      if (o.signal) {
        const kill = () => {
          res.aborted = true;
          proc.kill("SIGTERM");
          setTimeout(() => {
            if (!proc.killed) proc.kill("SIGKILL");
          }, 5000);
        };
        if (o.signal.aborted) kill();
        else o.signal.addEventListener("abort", kill, { once: true });
      }
    });
  } finally {
    await fs.promises.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
  res.transcript = transcript.join("\n");
  return res;
}

/** Escape raw newlines/tabs inside JSON strings: a common slip of smaller models that JSON.parse rejects. */
function escapeControlInStrings(s: string): string {
  let out = "";
  let inStr = false;
  let esc = false;
  for (const ch of s) {
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      else if (ch === "\n" || ch === "\r" || ch === "\t") {
        out += ch === "\n" ? "\\n" : ch === "\r" ? "\\r" : "\\t";
        continue;
      }
    } else if (ch === '"') inStr = true;
    out += ch;
  }
  return out;
}

/** Extract the last ```<tag> fenced JSON block (falls back to the last ```json block). */
export function extractJson<T>(text: string, tag: string): T | undefined {
  const noTrailingCommas = (s: string) => s.replace(/,\s*([}\]])/g, "$1");
  const tryParse = (s: string): T | undefined => {
    for (const candidate of [s, noTrailingCommas(s), noTrailingCommas(escapeControlInStrings(s))]) {
      try {
        return JSON.parse(candidate) as T;
      } catch {
        /* try the next repair */
      }
    }
    return undefined;
  };
  for (const re of [new RegExp("```" + tag + "\\s*([\\s\\S]*?)```", "g"), /```json\s*([\s\S]*?)```/g]) {
    const all = [...text.matchAll(re)];
    for (let i = all.length - 1; i >= 0; i--) {
      const v = tryParse(all[i][1].trim());
      if (v) return v;
    }
  }
  return undefined;
}

/** Content of the last ```<tag> fenced block (free text, e.g. wf-notes), or undefined. */
export function extractBlock(text: string, tag: string): string | undefined {
  const all = [...text.matchAll(new RegExp("```" + tag + "[^\\S\\n]*\\n([\\s\\S]*?)```", "g"))];
  const last = all.at(-1)?.[1].trim();
  return last || undefined;
}

/** Text before the fenced block, for showing prose to the human. */
export function stripFence(text: string, tag: string): string {
  return text.replace(new RegExp("```" + tag + "[\\s\\S]*?```", "g"), "").trim();
}
