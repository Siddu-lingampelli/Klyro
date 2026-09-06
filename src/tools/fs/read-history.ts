/** Track files read this session for write guard (3.2) */
const sessionReadFiles = new Set<string>();
export function markRead(p: string): void {
  sessionReadFiles.add(p);
  // Also add normalized
  sessionReadFiles.add(p.replace(/\\/g, '/'));
}
export function wasRead(p: string): boolean {
  return sessionReadFiles.has(p) || sessionReadFiles.has(p.replace(/\\/g, '/'));
}
export function clearReadHistory(): void {
  sessionReadFiles.clear();
}
