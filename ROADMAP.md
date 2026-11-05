# Roadmap

The product direction is a self-hosted Agent plugin workbench for developers and
small software teams, using their own knowledge to complete verifiable work.
See the [design proposal](docs/PROJECT_DIRECTION.md) for users, evidence,
plugin boundaries and acceptance criteria. Items below are planned unless marked
complete; they are not current product claims or release-date promises.

Prioritize personal knowledge, plugin onboarding and visible execution evidence.
Existing team workflows remain compatibility features; deployment and Docker work
are deferred while the local product is being validated.

## A. Public migration baseline

- [x] Import sanitized delivery workflows and public CI.
- [x] Migrate reusable standup, report, calendar and reliability updates.
- [x] Run local regression, frontend quality gates and secret scanning.
- [x] Confirm remote CI for the migration batch.

## B. Every capability is a plugin

- [x] Use Cordis lifecycle and dependency composition, following DeepSeek Harness.
- [x] Publish a versioned plugin contract and one tested authoring template.
- [x] Split the seven built-in Agent registrations into independently composed plugins.
- [x] Register deterministic message routes, reply contexts and help through feature plugins;
  drain in-flight messages before plugin teardown.
- [x] Contribute group business schedules through feature plugins, preserving calendar,
  retry, idempotency and shared project sync; drain active ticks before teardown.
- [ ] Move remaining business entrypoints, integrations, runtime services, triggers and UI
  contributions behind plugin registration, preserving current behavior.
- [x] Provide explicit empty, knowledge, release, community-tool and team profiles;
  the HTTP workspace also has a default no-credential sample composition.
- [x] Verify missing dependencies, disabled plugins, setup failure and cleanup in
  plugin lifecycle and workspace tests. In-place plugin replacement is not provided.

## C. First useful product

- [x] Provide local no-credential onboarding with labeled fictional notes, plus
  optional GitHub connection and release preparation from the workspace.
- [x] Connect selected Markdown/Obsidian folders and public webpage URLs as source plugins;
  preserve source links, properties and versions. See the
  [personal knowledge design](docs/PERSONAL_KNOWLEDGE_DESIGN.md).
- [x] Deliver a read-only Markdown/Obsidian plugin and local CLI with versioned keyword
  retrieval, source citations, link status, exclusions and in-memory change tracking.
  Public webpage retrieval is separately implemented with bounded public-URL fetching.
- [x] Add an explicitly selected mixed knowledge plugin that combines existing note/web
  tools, retains per-origin evidence and coverage, and reuses RAG/research/release/version
  checks with one shared budget. This is interleaved keyword retrieval, not vector search.
- [x] Add an optional RAG answer plugin using governed retrieval and the host model
  service; validate citation IDs and exact quotes before publishing. Semantic support
  is not automatically verified; integration tests use a local mock model endpoint.
- [x] Handle source changes and deletions with content versions; restrict retrieval
  to explicitly selected sources. Change tracking is rebuilt in memory, not a Vault backup.
- [x] Add anonymous public HTTPS MCP discovery, explicit read review, downloadable
  local configuration and a generic governed runner; verify the downloaded profile
  against the real Context7 service without a custom adapter or model.
- [ ] Extend onboarding to reviewed HTTP/OpenAPI adapters and accurately report
  unsupported repositories; authenticated MCP discovery still needs a separate design.
- [x] Add versioned plugin result contracts, sample checks and recorded execution
  receipts. Checks cover structure and required steps, not semantic correctness.
- [x] Deliver GitHub fact collection and release preparation with linked knowledge
  evidence; optional model-generated drafts do not publish or write remotely.
- [x] Add a knowledge retrieval plugin with citations, source versions and Obsidian links.
- [x] Track actual source-to-artifact citations and explicitly check historical
  results for changed, missing or unavailable knowledge; retain the original result.
- [x] Capture public pages and convert local documents through pinned Microsoft
  MarkItDown; explicitly collect results into a private searchable application library.
- [x] Integrate the real Context7 MCP service and import its standard SKILL.md with
  separately granted tools. This does not install arbitrary repositories.
- [ ] Add application authentication, project access checks, secret handling and
  concrete write approval before opening external trials.

## D. Reuse and adoption

- [x] Add a bounded personal research Model Loop with actual child-run evidence,
  human continuation, durable delegation limits and a completion gate. Summary
  semantics remain unverified; model protocol tests use local fixtures.
- [x] Turn successful runs with a single execution receipt and matching original input
  into user-reviewed reusable recipes; recheck the selected contract at execution,
  retain provenance, and state that model/tool/environment replay is not provided.
- [ ] Propose knowledge write-back as reviewable patches with source-version conflict checks.
- [ ] Replay redacted fixtures to compare plugin and model versions without live writes.
- [ ] Validate onboarding and repeated use with independent maintainers or teams.
- [ ] Enable an external contributor to build and verify a plugin from documentation.
- [ ] Publish measured success, latency, cost and recovery results with test scope.

Keep single-writer SQLite until measured needs justify another topology. Broader
multi-tenant hosting, a marketplace service, arbitrary repository execution and
unattended code changes remain outside the first release.
