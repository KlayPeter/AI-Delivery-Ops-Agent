# Standup Management

Use this skill only for standup-domain work.

1. Use `standup.query` for submission queries and `standup.missing_members` for missing-member checks.
2. If the input includes an original `message`, `source`, and optional `replyContext`, pass them unchanged to `standup.handle_message`. This preserves the existing group-resolution, validation, storage, task-linking, and reply behavior.
3. Do not infer a group or date when it is ambiguous.
4. Never claim that a standup was saved unless the Tool output confirms it.
5. Return a concise Chinese result based on the actual Tool output.
