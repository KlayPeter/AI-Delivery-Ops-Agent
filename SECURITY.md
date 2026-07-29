# Security policy

## Supported versions

Security fixes are applied to the latest code on the default branch. Until the
first stable release, no older version receives guaranteed backports.

## Reporting a vulnerability

Do not open a public issue containing credentials, personal data, exploit
details, or private deployment information. Use GitHub's private vulnerability
reporting feature for this repository. If it is unavailable, open a minimal
issue asking a maintainer for a private contact channel without disclosing the
vulnerability.

Include the affected revision, impact, reproduction conditions, and any
suggested mitigation. Maintainers should acknowledge a report within seven
days and coordinate disclosure after a fix is available.

## Deployment boundary

The application currently has no built-in authentication. Run it only on a
trusted network or behind an authenticated reverse proxy. Local Docker ports
bind to `127.0.0.1` by default. Kubernetes operators must provide their own
network policy, ingress authentication, secret management, TLS, and backups.

Never commit `.env` files, rendered Secret manifests, databases, logs, or
production configuration.
