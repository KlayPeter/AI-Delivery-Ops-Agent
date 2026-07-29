# Changelog

All notable changes to this project will be documented here.

The project follows semantic versioning after the first public release.

## Unreleased

### Added

- Public-source candidate based on the current stable Delivery Ops platform.
- AI News Radar, multi-bot routing, durable Agent Runtime, and public quality
  gates.
- Apache-2.0 licensing, contribution, security, conduct, and roadmap files.

### Changed

- Reorganized the README and public documentation around setup, verification,
  deployment, security boundaries, and audience-specific entry points.
- Replaced organization-specific branding, identifiers, deployment settings,
  people, and example data with public-safe values.
- Kubernetes templates now use the `delivery-ops` namespace and neutral image
  placeholders.
- Local Docker ports bind to `127.0.0.1` by default.

### Removed

- Organization deployment workflow, internal registry references, generated
  HTML documentation, and tracked runtime configuration.
