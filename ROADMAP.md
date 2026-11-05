# Roadmap

The product direction is a self-hosted Agent plugin workbench for developers and
small software teams, using their own knowledge to complete verifiable work.
See the [design proposal](docs/PROJECT_DIRECTION.md) for users, evidence,
plugin boundaries and acceptance criteria. Items below are planned unless marked
complete; they are not current product claims or release-date promises.

## A. Public migration baseline

- [x] Import sanitized delivery workflows and public CI.
- [x] Migrate reusable standup, report, calendar and reliability updates.
- [x] Run local regression, frontend quality gates and secret scanning.
- [x] Confirm remote CI for the migration batch.

## B. Every capability is a plugin

- [x] Use Cordis lifecycle and dependency composition, following DeepSeek Harness.
- [x] Publish a versioned plugin contract and one tested authoring template.
- [x] Split the seven built-in Agent registrations into independently composed plugins.
- [ ] Move remaining business entrypoints, integrations, runtime services, triggers and UI
  contributions behind plugin registration, preserving current behavior.
- [ ] Provide minimal, personal-knowledge, GitHub-team and Feishu-team composition profiles.
- [ ] Verify missing dependencies, disabled plugins, setup failure and cleanup.

## C. First useful product

- [ ] Provide a GitHub-first onboarding path and an explicitly labeled offline demo.
- [ ] Connect selected Markdown/Obsidian folders and public webpage URLs as source plugins;
  preserve source links, properties and versions. See the
  [personal knowledge design](docs/PERSONAL_KNOWLEDGE_DESIGN.md).
- [ ] Handle source changes and deletions; restrict retrieval to explicitly selected sources.
- [ ] Add an onboarding assistant for existing MCP and HTTP/OpenAPI capabilities;
  produce reviewable adapters and report unsupported repositories accurately.
- [ ] Add plugin acceptance contracts, sample checks and execution receipts.
- [ ] Deliver project digests and release preparation with linked source evidence.
- [ ] Add a knowledge retrieval plugin with citations, source versions and Obsidian links.
- [ ] Track source-to-artifact references and flag drafts affected by knowledge changes.
- [ ] Add application authentication, project access checks, secret handling and
  concrete write approval before opening external trials.

## D. Reuse and adoption

- [ ] Turn verified runs into user-reviewed reusable recipes.
- [ ] Propose knowledge write-back as reviewable patches with source-version conflict checks.
- [ ] Replay redacted fixtures to compare plugin and model versions without live writes.
- [ ] Validate onboarding and repeated use with independent maintainers or teams.
- [ ] Enable an external contributor to build and verify a plugin from documentation.
- [ ] Publish measured success, latency, cost and recovery results with test scope.

Keep single-writer SQLite until measured needs justify another topology. Broader
multi-tenant hosting, a marketplace service, arbitrary repository execution and
unattended code changes remain outside the first release.
