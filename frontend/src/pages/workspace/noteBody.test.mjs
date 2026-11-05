import { expect, test } from 'bun:test';
import { noteBody } from './noteBody';

test('note preview preserves the complete authored body, including marker-like text, and falls back for unknown formats', () => {
  const footer = '\n\n---\n\n## 引用来源与保存依据\n\n```json\n[]\n```\n';
  const body = '# 我的笔记\n\n保持原文。' + footer + '用户正文仍在这里。';
  expect(noteBody('---\n{"title":"demo"}\n---\n\n' + body + footer)).toBe(body);
  for (const value of ['', '# 普通 Markdown', '---\nunknown', '---\n{}\n---\n\n没有来源尾部']) expect(noteBody(value)).toBe(value);
});
