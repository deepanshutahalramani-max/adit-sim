import type {
  AppConfig, SimResult, TranscriptEval,
  DebugAnalysis, GeneratedScenario,
} from "./types";

const BASE = "/api";

/** Google ID token (set by the auth gate) — attached so the backend can
 *  verify the user and attribute audit actions. */
export function authHeader(): Record<string, string> {
  const t = localStorage.getItem("adit_id_token");
  return t ? { "X-Id-Token": t } : {};
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeader() },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({ detail: r.statusText }));
    throw new Error(err.detail ?? r.statusText);
  }
  return r.json();
}

async function getJson<T>(path: string): Promise<T> {
  const r = await fetch(`${BASE}${path}`, { headers: { ...authHeader() } });
  if (!r.ok) {
    const err = await r.json().catch(() => ({ detail: r.statusText }));
    throw new Error(err.detail ?? r.statusText);
  }
  return r.json();
}

/* ── Auth ── */
export interface AuthUser { email: string; name: string; picture?: string; is_admin: boolean; }
export async function fetchAuthConfig(): Promise<{ enabled: boolean; google_client_id: string; allowed_domain: string }> {
  return (await fetch(`${BASE}/auth/config`)).json();
}
export async function authMe(): Promise<AuthUser> { return post("/auth/me", {}); }

/* ── Admin ── */
export async function fetchAdminUsage(): Promise<{
  users: { email: string; actions: number; simulations: number; last_seen: number; first_seen: number }[];
  totals: { users: number; actions: number; sessions: number };
}> { return getJson("/admin/usage"); }

export async function fetchAdminAudit(): Promise<{
  audit: { ts: number; email: string; action: string; detail: string; ago_s: number }[];
}> { return getJson("/admin/audit"); }

/* ── Self-improving feedback (LLM re-analysis) ── */
export async function reanalyzeFeedback(params: { session_id?: string; issue_title?: string; comment: string }):
  Promise<{ refined_analysis: string; comment: string; author: string }> {
  return post("/feedback/reanalyze", params);
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
  latency_s: number;
}

export interface RealSession {
  session_id: string;
  trigger_type: string;
  patient_number: string;
  practice_number: string;
  env: string;
  scenario_id: string;
  scenario_label: string;
  goal: string;
  mode: string;
  patient_name: string;
  status: string;
  outcome: string;
  failure_type: string;
  call_sid: string;
  call_status: string;
  recording_sid: string;
  recording_url: string;
  recording_duration_s: number;
  turns: RealTurn[];
  events: { ts: number; msg: string }[];
  score: number;
  judge_reason: string;
  suite_id: string;
  first_sms_latency_s: number;
  avg_reply_latency_s: number;
  ehr_calls?: { name: string; ok: boolean; business_ok: boolean; latency_ms: number; result: string }[];
  issues?: { severity: string; title: string; detail: string }[];
  triage?: string;
  issues?: { severity: string; title: string; detail: string }[];
  error: string;
  created_at: number;
  updated_at: number;
  cooldown_remaining_s: number;
}

export interface SuiteRun {
  suite_id: string;
  kind: string;
  scenario_ids: string[];
  trigger_type: string;
  practice_number: string;
  env: string;
  status: string;
  current_idx: number;
  done?: number;
  session_ids: string[];
  started_at: number;
  finished_at: number;
  passed?: number;
  failed?: number;
  total?: number;
}

export interface RealConfig {
  configured: boolean;
  patient_numbers: {
    number: string;
    identity: { first?: string; last?: string; dob?: string; insurance?: string };
    busy: boolean;
    cooldowns: Record<string, number>;
    booked: Record<string, boolean>;
  }[];
  practice_numbers: Record<string, string>;
  webhook_base: string;
  trigger_types: string[];
  reply_timeout_s: number;
  followup_timeout_s: number;
  supabase_configured?: boolean;
}

export interface RealInsights {
  total: number;
  not_testable?: number;
  passed?: number;
  failed?: number;
  pass_rate?: number;
  agent_reply_latency?: { avg_s: number; p95_s: number; max_s: number; samples: number };
  by_trigger?: Record<string, { total: number; passed: number; avg_first_sms_latency_s: number; p95_first_sms_latency_s: number }>;
  by_scenario?: Record<string, { total: number; passed: number; avg_score: number }>;
  failure_taxonomy?: Record<string, number>;
  envs?: Record<string, { total: number; passed: number }>;
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

export async function runRealSuite(params: {
  scenario_ids?: string[];
  trigger_type?: string;
  env?: string;
  practice_number?: string;
  kind?: string;
}): Promise<SuiteRun> {
  return post("/real/run-suite", params);
}

export async function fetchRealSuites(): Promise<{ suites: SuiteRun[] }> {
  const r = await fetch(`${BASE}/real/suites`);
  return r.json();
}

export async function fetchRealInsights(): Promise<RealInsights> {
  const r = await fetch(`${BASE}/real/insights`);
  return r.json();
}

export interface RealActive {
  active_sessions: number;
  running_suites: number;
  busy: boolean;
  sessions: { session_id: string; label: string; env: string; status: string; trigger: string }[];
}

export async function fetchRealActive(): Promise<RealActive> {
  const r = await fetch(`${BASE}/real/active`);
  return r.json();
}

export async function stopAllReal(): Promise<{ stopped_sessions: number; aborted_suites: number }> {
  return post("/real/stop-all", {});
}

export interface ApiMetricRow {
  count: number; errors: number; error_rate: number;
  avg_ms: number; p95_ms: number; cost: number;
  provider?: string; operation?: string;
}
export interface ApiMetrics {
  total: number;
  total_cost: number;
  total_errors: number;
  providers: Record<string, ApiMetricRow>;
  operations: ApiMetricRow[];
  recent: {
    ts: number; provider: string; operation: string; latency_ms: number;
    ok: boolean; cost: number; session_id: string; env: string; detail: string; ago_s: number;
  }[];
}

export async function fetchApiMetrics(): Promise<ApiMetrics> {
  const r = await fetch(`${BASE}/real/api-metrics`);
  return r.json();
}

export interface EhrMetrics {
  total: number;
  total_failures?: number;
  functions: {
    name: string; label: string; count: number; success: number;
    failures: number; success_rate: number; avg_ms: number;
  }[];
  issues?: { severity: string; title: string; detail: string; env: string; scenario_id: string; ago_s: number }[];
  recent: {
    ts: number; name: string; ok: boolean; business_ok: boolean;
    latency_ms: number; result: string; env: string; scenario_id: string; ago_s: number;
  }[];
}

export async function fetchEhrMetrics(): Promise<EhrMetrics> {
  const r = await fetch(`${BASE}/real/ehr-metrics`);
  return r.json();
}

export interface Trends {
  days: { date: string; total: number; passed: number; pass_rate: number; avg_score: number }[];
  suites: { suite_id: string; env: string; created: string; total: number; passed: number; pass_rate: number; avg_score: number }[];
}

export async function fetchTrends(): Promise<Trends> {
  const r = await fetch(`${BASE}/real/trends`);
  return r.json();
}

export async function manualStart(params: {
  env?: string;
  practice_number?: string;
  patient_number?: string;
  message?: string;
  trigger_type?: string;
}): Promise<{ session: RealSession }> {
  return post("/real/manual/start", params);
}

export async function manualSend(params: {
  session_id: string;
  message: string;
}): Promise<RealSession> {
  return post("/real/manual/send", params);
}

export async function manualEnd(sessionId: string): Promise<RealSession> {
  return post(`/real/manual/${sessionId}/end`, {});
}
