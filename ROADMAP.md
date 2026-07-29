# Roadmap

This roadmap is directional and does not promise release dates.

## Before v1.0

- Define an application authentication and authorization model.
- Formalize release packaging, upgrades, migrations, and support policy.
- Expand end-to-end tests for external integrations and failure recovery.
- Audit dependency licenses and automate software-bill-of-materials output.

## Later

- Evaluate additional model profiles without weakening current configuration
  boundaries.
- Reduce oversized runtime modules through behavior-preserving refactors.
- Evaluate databases and deployment topologies beyond single-writer SQLite.
- Consider multi-tenant isolation.
- Consider additional messaging platforms such as Slack or Teams.

These items are intentionally outside the initial open-source migration. The
current release keeps the stable Agent Runtime, integration behavior, and
single-writer SQLite deployment model unchanged.
