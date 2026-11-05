# Contributing

Thank you for helping improve AI Delivery Ops Agent.

## Development workflow

1. Fork the repository and create a focused branch.
2. On first setup, copy `backend/.env.example` to `backend/.env`; preserve existing
   settings. Blank credentials support the local sample. Use test credentials
   when working on an external integration.
3. Keep changes scoped; update the relevant `FEATURE.md` whenever behavior
   changes.
4. Add or update tests for bug fixes and behavior changes.
5. Run the checks below before opening a pull request.

Use Git, Bun 1.3.x, Node.js 22 and pnpm 10. The backend suite exercises the real
MarkItDown converter, so it also requires a local Python environment with the pinned converter
(Python 3.10–3.14; CI uses 3.13). See the
[converter guide](docs/DOCUMENT_IMPORT.md) for the `uv` alternative.

```bash
cd backend
bun install --frozen-lockfile
bunx prisma generate
bunx prisma validate
bun run typecheck
python3 -m venv .data/markitdown
.data/markitdown/bin/python -m pip install -r src/connectors/markitdown/requirements.txt
TEST_DATABASE_PATH="$(mktemp)"
DATABASE_URL="file:${TEST_DATABASE_PATH}" bunx prisma db push --skip-generate
DATABASE_URL="file:${TEST_DATABASE_PATH}" bun test

cd ../frontend
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
bun test
pnpm build

cd ..
git diff --check
```

Pull requests must not include real credentials, internal URLs, customer or
employee data, private issue links, databases, logs, or generated reports.
Describe the user-visible outcome, tests run, and any migration or security
impact.

Keep machine-specific plugin configurations in `*.local.yaml` files; these are
ignored in every directory. Keep public, credential-free examples in ordinary
`.yaml` files. Local startup and the model-free first task are documented in
[local development](docs/LOCAL_DEVELOPMENT.md).
