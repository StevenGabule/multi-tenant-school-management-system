# Gateway — Kubernetes manifests (kind / dev)

Plain-YAML manifests for deploying the `gateway` service into a local kind
cluster. Helm comes in Phase 2 once we have multiple services to template.

## Files

| File              | Resource                                  |
|-------------------|-------------------------------------------|
| `configmap.yaml`  | `ConfigMap` — non-secret env (NODE_ENV, OTel endpoint, service name) |
| `deployment.yaml` | `Deployment` — 1 replica, both probes, hostAliases for compose stack |
| `service.yaml`    | `Service` (ClusterIP) — exposes port 3000 |
| `secret.yaml`     | (gitignored) `Secret` — DATABASE_URL. Created with `kubectl create secret`; never committed. |

## Apply

```bash
# 1. Make sure compose is up (postgres, jaeger reachable on sms_default).
docker compose -f infra/docker-compose.yml up -d

# 2. Make sure kind cluster exists and the image is loaded.
kind get clusters | grep -q sms-dev || kind create cluster --name sms-dev
docker network connect sms_default sms-dev-control-plane 2>/dev/null || true
docker build -t sms-gateway:dev -f apps/gateway/Dockerfile .
kind load docker-image sms-gateway:dev --name sms-dev

# 3. Create the Secret from .env.local (never committed).
kubectl --context kind-sms-dev create secret generic gateway-secret \
  --from-literal=DATABASE_URL="$(grep ^DATABASE_URL .env.local | cut -d= -f2-)" \
  --dry-run=client -o yaml | kubectl --context kind-sms-dev apply -f -

# 4. Apply the rest.
kubectl --context kind-sms-dev apply -f infra/k8s/gateway/

# 5. Smoke test.
kubectl --context kind-sms-dev rollout status deploy/gateway --timeout=60s
kubectl --context kind-sms-dev port-forward svc/gateway 3010:3000 &
sleep 2
curl -s http://localhost:3010/livez
curl -s http://localhost:3010/readyz
```

## Caveats

- `hostAliases` carry literal IPs from the compose stack. If you `docker
  compose down -v` and recreate, postgres / jaeger may get different IPs;
  re-edit `deployment.yaml` and re-apply, or attach the kind node to
  `sms_default` and rely on Docker DNS at the node level (then use a
  ServiceWithoutSelector + Endpoints pattern, milestone 1.2 territory).
- `imagePullPolicy: IfNotPresent` matters: `kind load` puts the image on
  the node directly; if K8s tried to pull from a registry it would fail.
