# Kubernetes manifests

These manifests are public templates for a single-backend deployment in the
`delivery-ops` namespace. They do not contain a deployment pipeline, registry
credentials, cluster addresses, or production secrets.

| File | Purpose |
| --- | --- |
| `00-namespace.yaml` | Creates the `delivery-ops` namespace |
| `10-config.yaml` | Safe defaults and `CHANGE_ME` credential placeholders |
| `20-pvc.yaml` | Persistent storage for SQLite |
| `30-deployment-backend.yaml` | One backend writer with health probes |
| `31-deployment-frontend.yaml` | Frontend and in-cluster backend upstream |
| `40-service.yaml` | Backend and frontend services |

Before applying the templates:

1. Copy `10-config.yaml` to a private location and replace every `CHANGE_ME`.
2. Replace `CHANGE_ME/delivery-ops-*.latest` in both Deployment manifests with
   image references you control.
3. Review the StorageClass and frontend Service type for your cluster.
4. Put the application behind an authenticated reverse proxy or restrict it to
   a trusted network. The application does not provide built-in authentication.

SQLite supports one backend writer only. Keep
`30-deployment-backend.yaml` at `replicas: 1` and do not mount the same database
file into multiple writer Pods.

See [DEPLOY.md](DEPLOY.md) for a manual deployment walkthrough.
