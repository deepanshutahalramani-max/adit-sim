import type {
  AppConfig, SimResult, TranscriptEval,
  DebugAnalysis, GeneratedScenario,
} from "./types";

const BASE = "/api";

async function post<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({ detail: r.statusText }));
    throw new Error(err.detail ?? r.statusText);
  }
  return r.json();
}

export async function fetchConfig(): Promise<AppConfig> {
  const r = await fetch(`${BASE}/config`);
  return r.json();
}

export async function runSimulation(params: {
  scenario_id: string;
  api_base: string;
  bearer_token: string;
  agent_phone: string;
  openai_key: string;
  use_judge: boolean;
}): Promise<SimResult> {
  return post("/simulate", params);
}

export async function runParallel(params: {
  scenario_ids: string[];
  repeats: number;
  max_parallel: number;
  api_base: string;
  bearer_token: string;
  agent_phone: string;
  openai_key: string;
  use_judge: boolean;
}): Promise<{ results: SimResult[] }> {
  return post("/simulate/parallel", params);
}

export async function runChain(params: {
  api_base: string;
  bearer_token: string;
  agent_phone: string;
  openai_key: string;
}): Promise<Record<string, SimResult>> {
  return post("/simulate/chain", params);
}

export async function analyzeDebug(
  screenshot: File,
  systemPrompt: string,
  extraContext: string,
  openaiKey: string,
): Promise<DebugAnalysis> {
  const fd = new FormData();
  fd.append("screenshot", screenshot);
  fd.append("system_prompt", systemPrompt);
  fd.append("extra_context", extraContext);
  fd.append("openai_key", openaiKey);
  const r = await fetch(`${BASE}/debug/analyze`, { method: "POST", body: fd });
  if (!r.ok) {
    const err = await r.json().catch(() => ({ detail: r.statusText }));
    throw new Error(err.detail ?? r.statusText);
  }
  return r.json();
}

export async function runValidation(params: {
  repro_opener: string;
  root_cause: string;
  n_runs: number;
  api_base: string;
  bearer_token: string;
  agent_phone: string;
  openai_key: string;
}): Promise<{ results: SimResult[] }> {
  return post("/debug/validate", params);
}

export async function evaluateTranscript(params: {
  transcript: string;
  system_prompt: string;
  openai_key: string;
}): Promise<TranscriptEval> {
  return post("/evaluate/transcript", params);
}

export async function generateScenarios(params: {
  instruction: string;
  openai_key: string;
}): Promise<GeneratedScenario[]> {
  return post("/generate/scenarios", params);
}

export async function runGeneratedScenario(params: {
  scenario_name: string;
  goal: string;
  opener: string;
  api_base: string;
  bearer_token: string;
  agent_phone: string;
  openai_key: string;
}): Promise<SimResult> {
  const fd = new FormData();
  Object.entries(params).forEach(([k, v]) => fd.append(k, v));
  const r = await fetch(`${BASE}/simulate/generated`, { method: "POST", body: fd });
  if (!r.ok) {
    const err = await r.json().catch(() => ({ detail: r.statusText }));
    throw new Error(err.detail ?? r.statusText);
  }
  return r.json();
}

export async function analyzeDebugText(params: {
  description: string;
  system_prompt: string;
  extra_context: string;
  openai_key: string;
}): Promise<import("./types").DebugAnalysis> {
  return post("/debug/analyze-text", params);
}

export async function applyFix(params: {
  prompt_text: string;
  section_at_fault: string;
  suggested_fix: string;
}): Promise<{ modified_prompt: string; applied_inline: boolean }> {
  return post("/debug/apply-fix", params);
}

export async function runRegression(params: {
  api_base: string;
  bearer_token: string;
  agent_phone: string;
  openai_key: string;
  use_judge: boolean;
  scenario_ids?: string[];
}): Promise<{
  results: SimResult[];
  summary: { total: number; passed: number; failed: number; pass_rate: number; avg_score: number };
}> {
  return post("/debug/regression", params);
}
