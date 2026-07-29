# Frontend

The AI Delivery Ops Agent management console is built with React, TypeScript,
Vite, Ant Design, React Router, SWR, and Axios.

## Features

- Project dashboard and human-resource Gantt view
- Audit logs and conversation contexts
- Standup and weekly-report history
- Manual job and Agent triggers
- Runtime, group, member, email, and scheduling configuration

## Development

```bash
pnpm install --frozen-lockfile
pnpm dev
```

The development server reads `VITE_API_BASE` from `.env`; copy `.env.example`
for local use. Do not put credentials in frontend environment variables.

## Checks

```bash
pnpm lint
pnpm typecheck
bun test
pnpm build
```

Production output is written to `dist/`. The public Docker image serves it with
Nginx and proxies `/api` to `BACKEND_UPSTREAM`.

The application has no built-in authentication. Serve it only on a trusted
network or behind an authenticated reverse proxy.
