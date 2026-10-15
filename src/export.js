// Phase 5: CSV export helper (pure, tested). Never leaks other businesses — caller filters rows.
export function toCsv(rows, columns) {
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  return [columns.join(','), ...rows.map(r => columns.map(c => esc(r[c])).join(','))].join('\n');
}

export function repeatStats(balances) {
  // balances: [{visits}] for ONE business
  const total = balances.length;
  const repeat = balances.filter(b => (b.visits ?? 0) > 1).length;
  return { total, repeat, repeatRate: total ? Math.round(repeat * 1000 / total) / 10 : 0 };
}
