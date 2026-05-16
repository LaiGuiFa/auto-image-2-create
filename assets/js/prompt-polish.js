export function normalizePolishText(value) {
  return String(value ?? '')
    .replace(/[\u200b\u200c\u200d\ufeff]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
