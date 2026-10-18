// Metrics every workload reports, computed from the shared record shape (runner.buildRecord).
// Plan 30 §5.3: medians and worst cases with sample sizes; no percentile claims from n < 30.

export function median(values) {
  const v = values.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

export function max(values) {
  const v = values.filter((x) => typeof x === 'number' && Number.isFinite(x));
  return v.length ? Math.max(...v) : null;
}

export function sum(values) {
  return values.reduce((s, x) => s + (typeof x === 'number' ? x : 0), 0);
}

export function rate(count, n) {
  return `${count}/${n}`;
}

export function commonMetrics(records) {
  const n = records.length;
  const stopCounts = {};
  for (const r of records) {
    const key = r.stopReason ?? (r.error ? 'error' : 'none');
    stopCounts[key] = (stopCounts[key] ?? 0) + 1;
  }
  const totalCost = sum(records.map((r) => r.costUsd));
  return {
    'n': n,
    'service errors': rate(records.filter((r) => r.error).length, n),
    'stop reasons': Object.entries(stopCounts).map(([k, v]) => `${k} ${v}`).join(', '),
    'wall ms median / max': `${median(records.map((r) => r.wallMs))} / ${max(records.map((r) => r.wallMs))}`,
    'first event ms median / max': `${median(records.map((r) => r.firstEventMs))} / ${max(records.map((r) => r.firstEventMs))}`,
    'input tok median': median(records.map((r) => r.usage.input_tokens)),
    'output tok median / max': `${median(records.map((r) => r.usage.output_tokens))} / ${max(records.map((r) => r.usage.output_tokens))}`,
    'cache read tok median': median(records.map((r) => r.usage.cache_read_input_tokens)),
    'cost per record median ($)': median(records.map((r) => r.costUsd))?.toFixed(5) ?? null,
    'total cost ($)': totalCost.toFixed(4),
  };
}
