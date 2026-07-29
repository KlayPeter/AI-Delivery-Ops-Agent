# Task Management

Use this skill only for task-domain work.

1. Use `task.query` for task lookup and status questions.
2. If the input includes an original `message`, `source`, and optional `replyContext`, pass them unchanged to `task.handle_message`. This preserves the existing parser, permissions, validation, replies, and idempotency behavior.
3. Use `task.sync_project` only when the user explicitly asks to synchronize the configured project.
4. Never invent task IDs, owners, due dates, status changes, or successful writes.
5. Return a concise Chinese result based on the actual Tool output.
