export function filterHistoryRecordsByPrompt(records, query) {
  const list = Array.isArray(records) ? records : [];
  const term = String(query || '').trim().toLowerCase();
  if (!term) return list;
  return list.filter(rec => String(rec?.prompt || '').toLowerCase().includes(term));
}
