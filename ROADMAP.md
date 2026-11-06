# Roadmap

The product direction is a self-hosted Agent plugin workbench for developers and
small software teams, using their own knowledge to complete verifiable work.
See the [design proposal](docs/PROJECT_DIRECTION.md) for users, evidence,
plugin boundaries and acceptance criteria. Items below are planned unless marked
complete; they are not current product claims or release-date promises.

Prioritize a clear first task, personal knowledge and visible execution evidence.
The initial user hypothesis is developers maintaining technical plans from their own
notes and changing references; demand and repeated use are not yet validated.
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
- [x] Contribute default-bot capability entries through the message registry; news
  routing and follow-up state belong to its plugin. Generic ingress keeps scope,
  availability checks and neutral task feedback; independent bots retain their path.
- [x] Move Feishu directory APIs and automatic group membership sync into
  `builtin.directory`; disabled/empty/personal profiles do not query directories.
  Team SDK/profile add this plugin while keeping seven Agents and prior sync rules.
- [x] Contribute group business schedules through feature plugins, preserving calendar,
  retry, idempotency and shared project sync; drain active ticks before teardown.
- [x] Move the existing team configuration page and API into builtin.configuration;
  preserve URLs, mask secrets, reject malformed replacement payloads before writes,
  distinguish persisted-but-not-reloaded state, and close both entries when absent.
- [ ] Move remaining business entrypoints, integrations, runtime services, triggers and UI
  contributions behind plugin registration, preserving current behavior.
- [x] Provide explicit empty, knowledge, release, community-tool and team profiles;
  the HTTP workspace also has a default no-credential sample composition.
- [x] Verify missing dependencies, disabled plugins, setup failure and cleanup in
  plugin lifecycle and workspace tests. In-place plugin replacement is not provided.

## C. First useful product

- [x] Keep the default home on a task overview: ask personal sources, prepare a
  research draft and review earlier evidence, showing only contributed pages.
  Release preparation appears when its plugin is installed; the Agent composer
  remains under an advanced disclosure and explicit capability links still work.
  Secondary plugin pages and Agent/plugin catalogs are grouped under Tools and Plugins;
  runtime management is collapsed separately, with deep-link sections opened automatically.
- [ ] Validate one technical-plan maintenance scenario with 3–5 independent users:
  compare the same task manually and with the product, record useful output,
  review time, false alarms and second-week reuse. Invitations are maintainer-led.
- [ ] Evaluate passage/conclusion-level change impact and a user-reviewed revision
  draft against real examples. Current checks detect document version changes and optional exact quote presence;
  they do not establish that a conclusion is wrong or update it automatically.

- [x] Supplement version reviews with bounded exact quote presence checks across
  notes, extracted webpages and mixed sources. Changed documents still need review;
  quote presence does not establish unchanged context or semantic correctness.

- [x] Add an optional knowledge watch plugin for up to 20 explicitly selected cited
  results: persistent intervals, pause/resume, governed native checks and run provenance.
  It runs with the local host and does not assess semantic correctness.

- [x] Let first-time users enable bundled Skill/OpenAPI inspectors on the default
  plugin page and apply saved local preferences. Explicit file compositions retain
  control; actual third-party capabilities require source and grant review before activation.

- [x] Compose reviewed Skill, MCP and OpenAPI export files through a plugin-owned
  preview/download page, preserving the personal workspace and original grants.
  One export per kind; custom native configs and authenticated onboarding remain separate.
- [x] Save reviewed compositions privately and apply through the local launcher, with
  explicit-file priority, revision conflicts and restore-to-personal without deleting
  profiles or history. Standalone mode needs a restart; startup failure has a local
  reset command, with no automatic rollback.

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
- [x] Add explicitly selected public OpenAPI 3.0/3.1 discovery, visible unsupported
  operations, successful-run-bound review/export and pinned anonymous GET execution.
  This is a bounded subset, not arbitrary repository execution or full OpenAPI support.
- [x] Add public GitHub SKILL.md inspection, fixed commit/content/license snapshots,
  reviewed local profile export and actual Prompt Skill Runtime text execution with
  zero external tools. Scripts and referenced resources require explicit adapters.
  A reviewed catalog now exports up to eight pinned Skills in one profile, supports
  explicit per-run selection, separates namesakes and revisions by content/source ID,
  and rejects removed selections without sending other Skill bodies to the model.
  Optional personal-base composition in Skill, MCP and OpenAPI exports keeps
  knowledge/research/library/recipes available;
  a manual task can preview and confirm a stored retrieval snapshot, send only selected
  excerpts, and retain selection provenance even on model failure or cancellation.
  This does not verify actual source use, output citations or source currentness.
- [ ] Design authenticated MCP/OpenAPI onboarding and credential destination grants.
- [x] Add versioned plugin result contracts, sample checks and recorded execution
  receipts. Checks cover structure and required steps, not semantic correctness.
- [x] Deliver GitHub fact collection and release preparation with linked knowledge
  evidence; optional model-generated drafts do not publish or write remotely.
- [x] Add a knowledge retrieval plugin with citations, source versions and Obsidian links.
- [x] Track actual source-to-artifact citations and explicitly check historical
  results for changed, missing or unavailable knowledge; retain the original result.
  The review center filters successful answers/drafts among the latest 50 root runs and
  checks up to 20 selected results; list refresh only reads dated cached assessments.
- [x] Reanswer a successful root knowledge answer after reviewing its original question
  and current source/model selection. Retrieve current evidence through the existing
  RAG Agent, retain the original and link the independent new result; reject stale
  review context and durable recipe reuse of the per-review input.
- [ ] Locate semantic impacts on individual conclusions and propose reviewable revisions;
  document versions, exact quote presence and a fresh answer do not prove correctness.
- [x] Capture public pages and convert local documents through pinned Microsoft
  MarkItDown; explicitly collect results into a private searchable application library.
- [x] Integrate the real Context7 MCP service and import its standard SKILL.md with
  separately granted tools. This does not install arbitrary repositories.
- [ ] Add application authentication, project access checks, secret handling and
  concrete write approval before opening external trials.

- [x] Add durable local launch receipts, same-key retry, four active manual root limits,
  live details and cooperative root/descendant cancellation; retain completed effects
  and history, and drain accepted background tasks before plugin teardown.

## D. Reuse and adoption

- [x] Let research delegate explicitly reviewed fixed MCP/OpenAPI requests alongside
  personal knowledge, pin destination/contracts, restore approval after pause/restart,
  and enforce the exact parameters before child execution. No automatic grant expansion.

- [x] Add a bounded personal research Model Loop with actual child-run evidence,
  human continuation, durable delegation limits and a completion gate. Summary
  semantics remain unverified; model protocol tests use local fixtures.
- [x] Turn successful runs with a single execution receipt and matching original input
  into user-reviewed reusable recipes; recheck the selected contract at execution,
  retain provenance, and state that model/tool/environment replay is not provided.
- [x] Propose reviewed new-note patches from cited answers/drafts, recheck source versions
  at explicit manual confirmation, create files exclusively and recover missing receipts.
- [ ] Extend write-back to reviewed replacements of existing notes; the current writer
  only creates a new note in an explicitly configured inbox.
- [x] Run a fixed six-case synthetic RAG evaluation through the actual retrieval/citation
  pipeline, with offline scripted controls, explicitly confirmed current-model mode,
  bounded requests, JSON/CLI gates and same-mode rule comparisons. This is deterministic
  regression evidence, not semantic model accuracy or a historical environment replay.
- [ ] Extend redacted historical tool/environment replay to other plugin workflows.
- [ ] Validate onboarding and repeated use with independent maintainers or teams.
- [ ] Enable an external contributor to build and verify a plugin from documentation.
- [ ] Publish measured success, latency, cost and recovery results with test scope.

Keep single-writer SQLite until measured needs justify another topology. Broader
multi-tenant hosting, a marketplace service, arbitrary repository execution and
unattended code changes remain outside the first release.
