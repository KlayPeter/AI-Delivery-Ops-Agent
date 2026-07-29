# Contributing

Thank you for helping improve AI Delivery Ops Agent.

## Development workflow

1. Fork the repository and create a focused branch.
2. Copy `backend/.env.example` to `backend/.env` and use only test credentials.
3. Keep changes scoped; update the relevant `FEATURE.md` whenever behavior
   changes.
4. Add or update tests for bug fixes and behavior changes.
5. Run the checks below before opening a pull request.

```bash
cd backend
bun install --frozen-lockfile
bunx prisma generate
bunx prisma validate
bun run typecheck
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
