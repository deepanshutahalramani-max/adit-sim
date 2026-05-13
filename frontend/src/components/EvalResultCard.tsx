import { EvalResult } from "../api/runs";
import { CheckCircle, XCircle, MinusCircle } from "lucide-react";
import clsx from "clsx";

interface Props {
  eval_results: EvalResult[];
}

// Safely pull a typed value out of Record<string, unknown>
function str(v: unknown): string { return v != null ? String(v) : ""; }
function num(v: unknown): number { return Number(v ?? 0); }
function bool(v: unknown): boolean { return Boolean(v); }
function rec(v: unknown): Record<string, unknown> {
  return (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
}

function PassIcon({ passed }: { passed: boolean | null }) {
  if (passed === true) return <CheckCircle className="w-4 h-4 text-green-500" />;
  if (passed === false) return <XCircle className="w-4 h-4 text-red-500" />;
  return <MinusCircle className="w-4 h-4 text-gray-400" />;
}

function ScoreBadge({ score }: { score: number | null }) {
  if (score === null) return null;
  const color =
    score >= 4 ? "text-green-700 bg-green-50 border-green-200"
    : score >= 3 ? "text-yellow-700 bg-yellow-50 border-yellow-200"
    : "text-red-700 bg-red-50 border-red-200";
  return (
    <span className={clsx("text-xs font-semibold px-2 py-0.5 rounded border", color)}>
      {score.toFixed(1)} / 5
    </span>
  );
}

function DeterministicCard({ result }: { result: EvalResult }) {
  const checks = rec(result.details?.checks);
  return (
    <div className="border border-gray-200 rounded-xl p-4 bg-white">
      <div className="flex items-center gap-2 mb-3">
        <PassIcon passed={result.passed} />
        <span className="font-semibold text-sm">Deterministic Evaluator</span>
        {result.passed !== null && (
          <span
            className={clsx(
              "ml-auto text-xs font-semibold px-2 py-0.5 rounded",
              result.passed ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"
            )}
          >
            {result.passed ? "PASS" : "FAIL"}
          </span>
        )}
      </div>
      <table className="w-full text-xs">
        <thead>
          <tr className="text-gray-500 border-b">
            <th className="text-left py-1 font-medium">Check</th>
            <th className="text-left py-1 font-medium">Expected</th>
            <th className="text-left py-1 font-medium">Detected</th>
            <th className="text-center py-1 font-medium">Pass</th>
          </tr>
        </thead>
        <tbody>
          {Object.entries(checks).map(([key, c]) => {
            const row = rec(c);
            return (
              <tr key={key} className="border-b last:border-0">
                <td className="py-1.5 font-mono">{key}</td>
                <td className="py-1.5 text-gray-600">{JSON.stringify(row.expected)}</td>
                <td className="py-1.5 text-gray-600">{JSON.stringify(row.detected)}</td>
                <td className="py-1.5 text-center">
                  {bool(row.pass) ? "✓" : <span className="text-red-500">✗</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="text-xs text-gray-400 mt-2">
        {num(result.details?.turn_count)} turns total
      </p>
    </div>
  );
}

function LLMJudgeCard({ result }: { result: EvalResult }) {
  if (result.details?.skipped) {
    return (
      <div className="border border-gray-200 rounded-xl p-4 bg-white">
        <div className="flex items-center gap-2 mb-1">
          <MinusCircle className="w-4 h-4 text-gray-400" />
          <span className="font-semibold text-sm">LLM Judge</span>
          <span className="ml-auto text-xs text-gray-400 italic">
            {str(result.details.reason)}
          </span>
        </div>
      </div>
    );
  }

  const scores = rec(result.details?.scores);
  const rationale = str(result.details?.rationale);
  const critical = str(result.details?.critical_failure);

  return (
    <div className="border border-gray-200 rounded-xl p-4 bg-white">
      <div className="flex items-center gap-2 mb-3">
        <PassIcon passed={result.passed} />
        <span className="font-semibold text-sm">LLM Judge</span>
        <ScoreBadge score={result.score} />
        {result.passed !== null && (
          <span
            className={clsx(
              "ml-auto text-xs font-semibold px-2 py-0.5 rounded",
              result.passed ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"
            )}
          >
            {result.passed ? "PASS" : "FAIL"}
          </span>
        )}
      </div>

      <div className="grid grid-cols-5 gap-2 mb-3">
        {Object.entries(scores).map(([dim, val]) => {
          const v = Number(val);
          return (
            <div key={dim} className="text-center">
              <div className={clsx(
                "text-lg font-bold",
                v >= 4 ? "text-green-600" : v >= 3 ? "text-yellow-600" : "text-red-600"
              )}>
                {v}
              </div>
              <div className="text-xs text-gray-500 capitalize leading-tight">
                {dim.replace("_", " ")}
              </div>
            </div>
          );
        })}
      </div>

      {rationale ? (
        <p className="text-xs text-gray-600 italic border-t pt-2">{rationale}</p>
      ) : null}
      {critical ? (
        <p className="text-xs text-red-600 font-medium mt-1">Critical: {critical}</p>
      ) : null}
    </div>
  );
}

export function EvalResultCard({ eval_results }: Props) {
  const det = eval_results.find((e) => e.evaluator_type === "deterministic");
  const llm = eval_results.find((e) => e.evaluator_type === "llm_judge");

  if (!det && !llm) {
    return (
      <div className="text-sm text-gray-400 italic py-4 text-center">
        Evaluation not yet available.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {det && <DeterministicCard result={det} />}
      {llm && <LLMJudgeCard result={llm} />}
    </div>
  );
}
