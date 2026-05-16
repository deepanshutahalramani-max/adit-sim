import type { SimResult } from "../types";

interface Props {
  results: SimResult[];
  chainResults: Record<string, SimResult> | null;
}

function scoreColor(s: number) {
  if (s >= 80) return "text-[#F5820D]";
  if (s >= 60) return "text-[#B45309]";
  return "text-red-600";
}

export function Dashboard({ results, chainResults }: Props) {
  const all = [...results, ...(chainResults ? Object.values(chainResults) : [])];

  if (all.length === 0) {
    return (
      <div className="text-center py-20 text-[#94A3B8]">
        <div className="text-[40px] mb-3">📊</div>
        <div className="text-[16px] font-semibold text-[#888]">No results yet</div>
        <div className="text-[13px] mt-1.5">
          Run simulations in the <strong>Simulations</strong> or <strong>E2E Chain</strong> tab to see results here.
        </div>
      </div>
    );
  }

  const nPass = all.filter(r => r.passed).length;
  const avgScore = Math.round(all.reduce((a, b) => a + b.score, 0) / all.length);
  const avgMs = all.reduce((a, b) => a + b.total_ms, 0) / all.length;

  // Per-scenario aggregation
  const byScenario = all.reduce<Record<string, SimResult[]>>((acc, r) => {
    const key = r.scenario_label || r.scenario;
    if (!acc[key]) acc[key] = [];
    acc[key].push(r);
    return acc;
  }, {});

  // CSV export
  const exportCsv = () => {
    const rows = all.map(r => ({
      Scenario: r.scenario_label,
      Passed: r.passed ? "✅" : "❌",
      Score: r.score,
      "Total ms": r.total_ms,
      Turns: Math.floor(r.turns.length / 2),
      Phone: r.patient_phone,
      "Outcome": r.outcome_type,
      "Note": (r.failure_reason_clean || r.failure_reason || "").slice(0, 100),
    }));
    const header = Object.keys(rows[0]).join(",");
    const lines = rows.map(r =>
      Object.values(r).map(v => `"${String(v).replace(/"/g, '""')}"`).join(",")
    );
    const csv = [header, ...lines].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `adit_sim_${new Date().toISOString().slice(0, 16).replace(/:/g, "-")}.csv`;
    a.click();
  };

  return (
    <div>
      <div className="mb-6 flex items-start justify-between">
        <div>
          <h1 className="text-[20px] font-extrabold text-[#111] tracking-tight mb-1">Results Dashboard</h1>
          <p className="text-[13.5px] text-[#888]">Aggregated pass rates, scores and latency across all simulation runs.</p>
        </div>
        <button
          onClick={exportCsv}
          className="flex items-center gap-1.5 border border-[#EAEAEA] bg-white text-[13px] font-semibold text-[#555] px-4 py-2 rounded-xl hover:bg-[#FAFAF8] transition-colors"
        >
          ⬇ Download CSV
        </button>
      </div>

      {/* KPI row */}
      <div className="grid grid-cols-4 gap-3 mb-6">
        {[
          { label: "Total runs", value: String(all.length) },
          { label: "Passed", value: `${nPass} (${Math.round(100 * nPass / all.length)}%)` },
          { label: "Avg score", value: `${avgScore}/100` },
          { label: "Avg time", value: `${(avgMs / 1000).toFixed(1)}s` },
        ].map(k => (
          <div key={k.label} className="bg-white border border-brand-500 rounded-xl px-5 py-4 shadow-sm">
            <div className="text-[10.5px] font-bold uppercase tracking-widest text-[#ADADAD] mb-1">{k.label}</div>
            <div className="text-[28px] font-extrabold text-[#111] leading-none tracking-tight">{k.value}</div>
          </div>
        ))}
      </div>

      {/* Per-scenario table */}
      <div className="bg-white border border-[#EAEAEA] rounded-xl overflow-hidden mb-5">
        <div className="px-5 py-3.5 border-b border-[#F0F0EE]">
          <h2 className="text-[13px] font-semibold text-[#333]">Per-Scenario Summary</h2>
        </div>
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b border-[#F0F0EE] text-[10.5px] font-bold uppercase tracking-widest text-[#ADADAD]">
              <th className="text-left px-5 py-3">Scenario</th>
              <th className="text-left px-4 py-3">Runs</th>
              <th className="text-left px-4 py-3">Pass Rate</th>
              <th className="text-left px-4 py-3">Avg Score</th>
              <th className="text-left px-4 py-3">Avg Time</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(byScenario).map(([label, rs]) => {
              const pCount = rs.filter(r => r.passed).length;
              const avgSc = Math.round(rs.reduce((a, r) => a + r.score, 0) / rs.length);
              const avgT = rs.reduce((a, r) => a + r.total_ms, 0) / rs.length;
              return (
                <tr key={label} className="border-b border-[#F0F0EE] last:border-0 hover:bg-[#FAFAF8]">
                  <td className="px-5 py-3 font-medium text-[#111]">{label}</td>
                  <td className="px-4 py-3 text-[#666]">{rs.length}</td>
                  <td className="px-4 py-3 text-[#666]">
                    <span className={pCount === rs.length ? "text-green-600 font-semibold" : pCount === 0 ? "text-red-600 font-semibold" : "text-amber-600 font-semibold"}>
                      {pCount}/{rs.length}
                    </span>
                  </td>
                  <td className={`px-4 py-3 font-semibold ${scoreColor(avgSc)}`}>{avgSc}</td>
                  <td className="px-4 py-3 text-[#666]">{(avgT / 1000).toFixed(1)}s</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* All runs table */}
      <div className="bg-white border border-[#EAEAEA] rounded-xl overflow-hidden">
        <div className="px-5 py-3.5 border-b border-[#F0F0EE]">
          <h2 className="text-[13px] font-semibold text-[#333]">All Runs</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-[12.5px]">
            <thead>
              <tr className="border-b border-[#F0F0EE] text-[10.5px] font-bold uppercase tracking-widest text-[#ADADAD]">
                <th className="text-left px-5 py-3">Scenario</th>
                <th className="text-left px-4 py-3">Pass</th>
                <th className="text-left px-4 py-3">Score</th>
                <th className="text-left px-4 py-3">Time</th>
                <th className="text-left px-4 py-3">Turns</th>
                <th className="text-left px-4 py-3">Outcome</th>
                <th className="text-left px-4 py-3">Phone</th>
              </tr>
            </thead>
            <tbody>
              {all.map((r, i) => (
                <tr key={i} className="border-b border-[#F0F0EE] last:border-0 hover:bg-[#FAFAF8]">
                  <td className="px-5 py-2.5 font-medium text-[#111] max-w-[220px] truncate">{r.scenario_label}</td>
                  <td className="px-4 py-2.5">{r.passed ? "✅" : "❌"}</td>
                  <td className={`px-4 py-2.5 font-semibold ${scoreColor(r.score)}`}>{r.score}</td>
                  <td className="px-4 py-2.5 text-[#666]">{(r.total_ms / 1000).toFixed(1)}s</td>
                  <td className="px-4 py-2.5 text-[#666]">{Math.floor(r.turns.length / 2)}</td>
                  <td className="px-4 py-2.5 text-[#666]">{r.outcome_type.replace(/_/g, " ")}</td>
                  <td className="px-4 py-2.5 font-mono text-[11px] text-[#ADADAD]">{r.patient_phone}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
