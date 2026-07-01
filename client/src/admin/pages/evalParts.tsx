const scoreColor = (v: number | null) =>
  v == null ? '#9ca3af' : v < 3 ? '#dc2626' : v < 4 ? '#d97706' : '#16a34a';
export const Score = ({ v }: { v: number | null }) => (
  <span style={{ color: scoreColor(v), fontWeight: 700 }}>{v == null ? '—' : v.toFixed(1)}</span>
);
// A change vs the previous run, shown next to a score (green up / red down).
const Delta = ({ v, prev }: { v: number | null; prev?: number | null }) => {
  if (v == null || prev == null) return null;
  const d = v - prev;
  if (Math.abs(d) < 0.005)
    return (
      <span className="muted" style={{ fontSize: '.66rem', marginLeft: 4 }}>
        ±0
      </span>
    );
  return (
    <span
      style={{
        fontSize: '.66rem',
        fontWeight: 700,
        marginLeft: 4,
        color: d > 0 ? '#16a34a' : '#dc2626',
      }}
    >
      {d > 0 ? '▲' : '▼'}
      {Math.abs(d).toFixed(2)}
    </span>
  );
};
export const Dim = ({
  label,
  v,
  prev,
}: {
  label: string;
  v: number | null;
  prev?: number | null;
}) => (
  <div>
    <div className="muted" style={{ fontSize: '.72rem', textTransform: 'uppercase' }}>
      {label}
    </div>
    <div style={{ fontSize: '1.5rem', fontWeight: 800, color: scoreColor(v) }}>
      {v == null ? '—' : v.toFixed(2)}
      <Delta v={v} prev={prev} />
    </div>
  </div>
);
export const runWhen = (t: number) =>
  new Date(t).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
// Line-level diff (LCS) for reviewing a suggested prompt against the current one.
type DiffLine = { type: 'same' | 'add' | 'del'; text: string };
export function lineDiff(a: string, b: string): DiffLine[] {
  const A = a.split('\n'),
    B = b.split('\n'),
    m = A.length,
    n = B.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--)
    for (let jj = n - 1; jj >= 0; jj--)
      dp[i][jj] = A[i] === B[jj] ? dp[i + 1][jj + 1] + 1 : Math.max(dp[i + 1][jj], dp[i][jj + 1]);
  const out: DiffLine[] = [];
  let i = 0,
    j = 0;
  while (i < m && j < n) {
    if (A[i] === B[j]) {
      out.push({ type: 'same', text: A[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ type: 'del', text: A[i] });
      i++;
    } else {
      out.push({ type: 'add', text: B[j] });
      j++;
    }
  }
  while (i < m) out.push({ type: 'del', text: A[i++] });
  while (j < n) out.push({ type: 'add', text: B[j++] });
  return out;
}
export const ConfBadge = ({ c }: { c: 'medium' | 'high' }) => (
  <span
    className="tag"
    style={{
      background: c === 'high' ? '#d1fae5' : '#fef3c7',
      color: c === 'high' ? '#065f46' : '#92400e',
    }}
  >
    {c} confidence
  </span>
);
