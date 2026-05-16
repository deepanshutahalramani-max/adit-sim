export interface Turn {
  role: "patient" | "agent";
  message: string;
  latency_ms: number;
}

export interface SimResult {
  scenario: string;
  scenario_label: string;
  patient_phone: string;
  turns: Turn[];
  passed: boolean;
  score: number;
  failure_reason: string;
  failure_reason_clean: string;
  total_ms: number;
  chat_id: string;
  outcome_type: "booking_confirmed" | "task_created" | "incomplete" | "error" | "";
  error?: string;
}

export interface ScenarioConfig {
  id: string;
  label: string;
  goal: string;
  opener: string;
  type: string;
}

export interface AppConfig {
  scenarios: ScenarioConfig[];
  default_agent_phone: string;
  max_parallel: number;
  hosts: Record<string, string>;
}

export interface TranscriptEval {
  score: number;
  outcome: string;
  passed: boolean;
  what_went_well: string[];
  issues: string[];
  prompt_violations: string[];
  tone: string;
  summary: string;
  error?: string;
}

export interface DebugAnalysis {
  what_happened: string;
  severity: "low" | "medium" | "high" | "critical";
  scenario_type: string;
  root_cause: string;
  prompt_section_at_fault: string;
  suggested_fix: string;
  fix_explanation: string;
  repro_opener: string;
  repro_followups: string[];
  confidence: "high" | "medium" | "low";
  error?: string;
}

export interface GeneratedScenario {
  name: string;
  goal: string;
  opener: string;
  followups: string[];
}

/** Sidebar/config state shared across the whole app */
export interface Config {
  environment: string; // "live" | "dev"
  apiBase: string;
  bearerToken: string;
  agentPhone: string;
  openaiKey: string;
  useLlmJudge: boolean;
}
