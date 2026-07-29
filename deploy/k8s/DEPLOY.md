# Manual Kubernetes deployment

This guide intentionally avoids assumptions about a registry, CI provider,
ingress controller, or cloud vendor.

## Prepare

Build and push images to a registry you control:

```bash
docker build -f docker/server/Dockerfile.k8s -t REGISTRY/delivery-ops-backend:TAG backend
docker build -f docker/web/Dockerfile.k8s -t REGISTRY/delivery-ops-frontend:TAG .
docker push REGISTRY/delivery-ops-backend:TAG
docker push REGISTRY/delivery-ops-frontend:TAG
```

Copy the configuration template outside the repository, then replace all
credential placeholders with values for your own Feishu, TAPD, and model
provider accounts:

```bash
cp deploy/k8s/10-config.yaml /tmp/delivery-ops-config.yaml
```

Update the image fields in private copies of the Deployment manifests. Do not
commit production credentials or private registry addresses.

## Apply

```bash
kubectl apply -f deploy/k8s/00-namespace.yaml
kubectl apply -f /tmp/delivery-ops-config.yaml
kubectl apply -f deploy/k8s/20-pvc.yaml
kubectl apply -f deploy/k8s/40-service.yaml
kubectl apply -f /tmp/delivery-ops-backend.yaml
kubectl apply -f /tmp/delivery-ops-frontend.yaml
```

Check health:

```bash
kubectl -n delivery-ops get pods,svc,pvc
kubectl -n delivery-ops rollout status deployment/delivery-ops-backend
kubectl -n delivery-ops rollout status deployment/delivery-ops-frontend
kubectl -n delivery-ops logs deployment/delivery-ops-backend
```

## Security and storage

- The application has no built-in authentication. Expose it only through a
  trusted network boundary or an authenticated reverse proxy.
- The PVC contains SQLite data and must be backed up outside the Pod.
- Keep exactly one backend writer. Scaling the frontend is safe; scaling the
  SQLite backend above one replica is not.
- Rotate credentials through your cluster secret manager. Never commit the
  rendered Secret manifest.

## Rollback

Deploy immutable image tags and roll back with your normal Kubernetes process:

```bash
kubectl -n delivery-ops rollout undo deployment/delivery-ops-backend
kubectl -n delivery-ops rollout undo deployment/delivery-ops-frontend
```
