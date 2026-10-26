export function frameAtTime(index, milliseconds) {
  let low = 0, high = index.length - 1;
  while (low < high) { const middle = Math.ceil((low + high) / 2); if (index[middle][0] <= milliseconds) low = middle; else high = middle - 1; }
  return low;
}
export function selectionQuality(index, first, last) {
  if (!Number.isInteger(first) || !Number.isInteger(last) || first < 0 || last < first || last >= index.length) return null;
  const segment = index[first][2], result = { count: last - first + 1, dual: 0, left: 0, right: 0, segment, crossSegment: false, duration_ms: index[last][0] - index[first][0] };
  for (let i = first; i <= last; ++i) { const row = index[i]; if (row[2] !== segment) result.crossSegment = true; result.left += row[3]; result.right += row[4]; if (row[3] && row[4]) ++result.dual; }
  return result;
}
export function formatTime(milliseconds) {
  const ms = Math.max(0, Math.round(milliseconds)), minutes = Math.floor(ms / 60000), seconds = Math.floor(ms / 1000) % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`;
}
