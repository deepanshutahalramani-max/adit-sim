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

export async function fetchEnvConfig(apiBase: string): Promise<{
  sms_agent_id: string;
  call_agent_id: string;
  agent_phone: string;
}> {
  const r = await fetch(`${BASE}/env-config?api_base=${encodeURIComponent(apiBase)}`);
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
  extra_context?: string;
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

export async function fetchRetellPrompt(agentPhone?: string, agentId?: string, apiBase?: string): Promise<{
  prompt: string;
  llm_id: string;
  agent_id: string;
  model: string;
}> {
  const params = new URLSearchParams();
  if (agentPhone) params.set("agent_phone", agentPhone);
  if (agentId)    params.set("agent_id",    agentId);
  if (apiBase)    params.set("api_base",    apiBase);
  const qs = params.toString();
  const r = await fetch(`${BASE}/retell/fetch-prompt${qs ? `?${qs}` : ""}`);
  if (!r.ok) {
    const err = await r.json().catch(() => ({ detail: r.statusText }));
    throw new Error(err.detail ?? r.statusText);
  }
  return r.json();
}

export async function runCallSimulation(params: {
  scenario_id: string;
  call_agent_prompt: string;
  openai_key: string;
  max_turns?: number;
}): Promise<SimResult> {
  return post("/simulate/call", params);
}

export async function runCallParallel(params: {
  scenario_ids: string[];
  repeats: number;
  max_parallel: number;
  call_agent_prompt: string;
  openai_key: string;
  max_turns?: number;
  extra_context?: string;
}): Promise<{ results: SimResult[] }> {
  return post("/simulate/call/parallel", params);
}

export async function fetchRetellCallPrompt(agentPhone?: string, agentId?: string, apiBase?: string): Promise<{
  prompt: string;
  llm_id: string;
  agent_id: string;
  model: string;
}> {
  const params = new URLSearchParams();
  if (agentPhone) params.set("agent_phone", agentPhone);
  if (agentId)    params.set("agent_id",    agentId);
  if (apiBase)    params.set("api_base",    apiBase);
  const qs = params.toString();
  const r = await fetch(`${BASE}/retell/fetch-call-prompt${qs ? `?${qs}` : ""}`);
  if (!r.ok) {
    const err = await r.json().catch(() => ({ detail: r.statusText }));
    throw new Error(err.detail ?? r.statusText);
  }
  return r.json();
}

export interface PromptToggles {
  schedule_new: boolean;
  schedule_existing: boolean;
  rescheduling: boolean;
  cancellation: boolean;
}

export async function resolvePrompt(params: {
  template: string;
} & PromptToggles): Promise<{ prompt: string; substitutions: PromptToggles }> {
  return post("/retell/resolve-prompt", params);
}

/* ── Manual SMS ── */
export async function smsStart(params: {
  api_base: string;
  bearer_token: string;
  agent_phone: string;
  message: string;
}): Promise<{ patient_phone: string; chat_id: string; agent_response: string; api_events: string[] }> {
  return post("/sms/start", params);
}

export async function smsSend(params: {
  api_base: string;
  bearer_token: string;
  agent_phone: string;
  patient_phone: string;
  chat_id: string;
  message: string;
}): Promise<{ chat_id: string; agent_response: string; latency_ms: number; api_events: string[] }> {
  return post("/sms/send", params);
}

/* ── Real Retell Web Call ── */
export async function createWebCall(params?: {
  agent_id?: string;
  agent_phone?: string;
  scenario_id?: string;
  mode?: string;
  api_base?: string;   // ADIT env URL → selects correct Retell key server-side
}): Promise<{ call_id: string; access_token: string; agent_id: string }> {
  return post("/retell/create-web-call", params ?? {});
}

export async function fetchAgentInfo(
  agentPhone?: string,
  smsAgentId?: string,
  callAgentId?: string,
  apiBase?: string,
): Promise<{
  sms_agent_id: string;
  call_agent_id: string;
  sms_agent_name: string;
  call_agent_name: string;
  persona_name: string;
}> {
  const params = new URLSearchParams();
  if (agentPhone)  params.set("agent_phone",   agentPhone);
  if (smsAgentId)  params.set("sms_agent_id",  smsAgentId);
  if (callAgentId) params.set("call_agent_id", callAgentId);
  if (apiBase)     params.set("api_base",       apiBase);
  const qs = params.toString();
  const url = `${BASE}/retell/agent-info${qs ? `?${qs}` : ""}`;
  const r = await fetch(url);
  if (!r.ok) {
    const err = await r.json().catch(() => ({ detail: r.statusText }));
    throw new Error(err.detail ?? r.statusText);
  }
  return r.json();
}

export async function analyzeCallDebugScreenshot(
  screenshot: File,
  systemPrompt: string,
  extraContext: string,
  openaiKey: string,
): Promise<import("./types").DebugAnalysis> {
  const fd = new FormData();
  fd.append("screenshot", screenshot);
  fd.append("system_prompt", systemPrompt);
  fd.append("extra_context", extraContext);
  fd.append("openai_key", openaiKey);
  const r = await fetch(`${BASE}/debug/analyze-call-screenshot`, { method: "POST", body: fd });
  if (!r.ok) {
    const err = await r.json().catch(() => ({ detail: r.statusText }));
    throw new Error(err.detail ?? r.statusText);
  }
  return r.json();
}

export async function analyzeCallDebug(params: {
  transcript: string;
  system_prompt: string;
  extra_context: string;
  openai_key: string;
}): Promise<import("./types").DebugAnalysis> {
  return post("/debug/analyze-call", params);
}

export async function listRetellCalls(params?: {
  agent_id?: string;
  limit?: number;
  sort_order?: string;
  api_base?: string;   // ADIT env URL → selects correct Retell key server-side
}): Promise<{ calls: unknown[] }> {
  return post("/retell/list-calls", params ?? {});
}

/* ── Registered patient ── */
export async function fetchRegisteredPatient(): Promise<{
  registered: boolean;
  first_name?: string;
  last_name?: string;
  dob?: string;
  insurance?: string;
  phone?: string;
}> {
  const r = await fetch(`${BASE}/registered-patient`);
  return r.json();
}

export async function clearRegisteredPatient(): Promise<void> {
  await fetch(`${BASE}/registered-patient`, { method: "DELETE" });
}

export async function setRegisteredPatient(data: {
  first_name: string; last_name: string; dob: string;
  insurance?: string; phone?: string; reason?: string;
}): Promise<void> {
  await fetch(`${BASE}/registered-patient`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

export async function extractContextFromImage(
  screenshot: File,
  openaiKey: string,
): Promise<{ context: string }> {
  const fd = new FormData();
  fd.append("screenshot", screenshot);
  fd.append("openai_key", openaiKey);
  const r = await fetch(`${BASE}/extract-context`, { method: "POST", body: fd });
  if (!r.ok) {
    const err = await r.json().catch(() => ({ detail: r.statusText }));
    throw new Error(err.detail ?? r.statusText);
  }
  return r.json();
}

export async function runCallRegression(params: {
  call_agent_prompt: string;
  openai_key: string;
  max_turns?: number;
}): Promise<{ results: SimResult[] }> {
  const ALL_CALL_SCENARIOS = [
    "new-patient-cleaning",
    "dental-emergency",
    "existing-routine",
    "reschedule",
    "cancel",
    "insurance-book",
    "office-hours-book",
    "post-treatment-followup",
  ];
  return post("/simulate/call/parallel", {
    scenario_ids: ALL_CALL_SCENARIOS,
    repeats: 1,
    max_parallel: 5,
    call_agent_prompt: params.call_agent_prompt,
    openai_key: params.openai_key,
    max_turns: params.max_turns ?? 12,
  });
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

/* ── Real Phone mode (Twilio) ── */
export interface RealTurn {
  role: string;
  message: string;
  channel: string;
  ts: number;
}

export interface RealSession {
  session_id: string;
  trigger_type: string;
  patient_number: string;
  practice_number: string;
  scenario_id: string;
  goal: string;
  status: string;
  outcome: string;
  call_sid: string;
  call_status: string;
  turns: RealTurn[];
  events: { ts: number; msg: string }[];
  error: string;
  created_at: number;
  updated_at: number;
  cooldown_remaining_s: number;
}

export interface RealConfig {
  configured: boolean;
  patient_numbers: { number: string; cooldowns: Record<string, number> }[];
  practice_numbers: Record<string, string>;
  webhook_base: string;
  trigger_types: string[];
}

export async function fetchRealConfig(): Promise<RealConfig> {
  const r = await fetch(`${BASE}/real/config`);
  return r.json();
}

export async function triggerReal(params: {
  trigger_type: string;
  practice_number?: string;
  env?: string;
  scenario_id?: string;
  patient_number?: string;
  opener?: string;
}): Promise<{ session: RealSession; cooldown_warning_s: number }> {
  return post("/real/trigger", params);
}

export async function fetchRealSessions(): Promise<{ sessions: RealSession[] }> {
  const r = await fetch(`${BASE}/real/sessions`);
  return r.json();
}

export async function stopRealSession(sessionId: string): Promise<RealSession> {
  return post(`/real/session/${sessionId}/stop`, {});
}

export async function setupRealWebhooks(): Promise<{ configured: { number: string; sms_webhook: string }[] }> {
  return post("/real/setup", {});
}
