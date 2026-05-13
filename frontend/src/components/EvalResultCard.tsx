import { EvalResult } from "../api/runs";
import { CheckCircle, XCircle, MinusCircle } from "lucide-react";
import clsx from "clsx";

interface Props {
  eval_results: EvalResult[];
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
  const checks = (result.details?.checks ?? {}) as Record<
    string,
    { expected: unknown; detected: unknown; pass: boolean }
  >;
  return (
    <div className="border border-gray-200 rounded-xl p-4 bg-white">
      <div className="flex items-center gap-2 mb-3">
        <PassIcon passed={result.passed} />
        <span className="font-semibold text-sm">Deterministic Evaluator</span>
        {result.passed !== null && (
          <span
            className={clsx(
              "ml-auto text-xs font-semibold px-2 py-0.5 rounded",
              result.passed
                ? "bg-green-100 text-green-700"
                : "bg-red-100 text-red-700"
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
          {Object.entries(checks).map(([key, c]) => (
            <tr key={key} className="border-b last:border-0">
              <td className="py-1.5 font-mono">{key}</td>
              <td className="py-1.5 text-gray-600">{JSON.stringify(c.expected)}</td>
              <td className="py-1.5 text-gray-600">{JSON.stringify(c.detected)}</td>
              <td className="py-1.5 text-center">
                {c.pass ? "✓" : <span className="text-red-500">✗</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-xs text-gray-400 mt-2">
        {Number(result.details?.turn_count ?? 0)} turns total
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
            {String(result.details.reason ?? "")}
          </span>
        </div>
      </div>
    );
  }

  const scores = (result.details?.scores ?? {}) as Record<string, number>;
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
              result.passed
                ? "bg-green-100 text-green-700"
                : "bg-red-100 text-red-700"
            )}
          >
            {result.passed ? "PASS" : "FAIL"}
          </span>
        )}
      </div>

      <div className="grid grid-cols-5 gap-2 mb-3">
        {Object.entries(scores).map(([dim, val]) => (
          <div key={dim} className="text-center">
            <div
              className={clsx(
                "text-lg font-bold",
                val >= 4 ? "text-green-600" : val >= 3 ? "text-yellow-600" : "text-red-600"
              )}
            >
              {val}
            </div>
            <div className="text-xs text-gray-500 capitalize leading-tight">
              {dim.replace("_", " ")}
            </div>
          </div>
        ))}
      </div>

      {result.details?.rationale && (
        <p className="text-xs text-gray-600 italic border-t pt-2">
          {String(result.details.rationale)}
        </p>
      )}
      {result.details?.critical_failure && (
        <p className="text-xs text-red-600 font-medium mt-1">
          Critical: {String(result.details.critical_failure)}
        </p>
      )}
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
