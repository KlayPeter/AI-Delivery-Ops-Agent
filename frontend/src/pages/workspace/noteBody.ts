export function noteBody(content: string): string {
  const header = '\n---\n\n', sources = '\n\n---\n\n## 引用来源与保存依据\n\n```json\n';
  const start = content.indexOf(header), end = content.lastIndexOf(sources);
  return content.startsWith('---\n') && start >= 4 && end >= start + header.length ? content.slice(start + header.length, end) : content;
}
