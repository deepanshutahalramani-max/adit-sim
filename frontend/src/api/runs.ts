import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "./client";

export interface Turn {
  id: string;
  direction: "inbound" | "outbound";
  content: string;
  turn_index: number;
  timestamp: string;
  provider_message_id: string | null;
}

export interface EvalResult {
  id: string;
  evaluator_type: "deterministic" | "llm_judge";
  passed: boolean | null;
  score: number | null;
  details: Record<string, unknown>;
  created_at: string;
}

export interface Run {
  id: string;
  scenario_id: string;
  provider: string;
  status: string;
  error: string | null;
  started_at: string;
  completed_at: string | null;
  turns?: Turn[];
  eval_results?: EvalResult[];
}

export type RunsFilter = {
  scenario_id?: string;
  status?: string;
  passed?: boolean;
  date_from?: string;
  date_to?: string;
};

const ACTIVE_STATUSES = ["pending", "running", "awaiting_reply", "completing"];

function buildQuery(filters: RunsFilter): string {
  const p = new URLSearchParams();
  if (filters.scenario_id) p.set("scenario_id", filters.scenario_id);
  if (filters.status) p.set("status", filters.status);
  if (filters.passed !== undefined) p.set("passed", String(filters.passed));
  if (filters.date_from) p.set("date_from", filters.date_from);
  if (filters.date_to) p.set("date_to", filters.date_to);
  const s = p.toString();
  return s ? `?${s}` : "";
}

export function useRuns(filters: RunsFilter = {}) {
  return useQuery({
    queryKey: ["runs", filters],
    queryFn: () => api.get<Run[]>(`/runs${buildQuery(filters)}`),
    refetchInterval: 5_000,
  });
}

export function useRun(runId: string) {
  return useQuery({
    queryKey: ["runs", runId],
    queryFn: () => api.get<Run>(`/runs/${runId}`),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status && ACTIVE_STATUSES.includes(status) ? 1500 : false;
    },
    enabled: !!runId,
  });
}

export function useCreateRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { scenario_id: string; provider: string }) =>
      api.post<Run>("/runs", body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["runs"] });
    },
  });
}
