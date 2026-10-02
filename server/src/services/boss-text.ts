/** BOSS's loaded kanzhun font maps U+E031..U+E03A to 0..9 (verified against rendered glyphs). */
export function decodeBossText(value: string): string {
  return String(value || '').replace(/[\uE031-\uE03A]/g, (char) => String(char.charCodeAt(0) - 0xe031));
}

export function readableBossSalary(value: string): string {
  const decoded = decodeBossText(value);
  return /[\uE000-\uF8FF]/.test(decoded) ? '薪资待确认' : decoded;
}
