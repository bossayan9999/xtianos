#!/bin/bash
# Deploy to Kubernetes cluster
# Usage: ./scripts/deploy-k8s.sh <environment> <image-tag>

set -e

ENVIRONMENT=${1:-staging}
IMAGE_TAG=${2:-latest}

echo "🚀 Deploying xtiandOS to $ENVIRONMENT (image: $IMAGE_TAG)"

# Set kubectl context
if [ "$ENVIRONMENT" = "production" ]; then
  kubectl config use-context production-cluster
elif [ "$ENVIRONMENT" = "staging" ]; then
  kubectl config use-context staging-cluster
fi

# Build and push Docker image
echo "📦 Building Docker image..."
docker build -f Dockerfile.prod -t xtiandos:$IMAGE_TAG .
docker tag xtiandos:$IMAGE_TAG your-registry.azurecr.io/xtiandos:$IMAGE_TAG

echo "📤 Pushing to registry..."
docker push your-registry.azurecr.io/xtiandos:$IMAGE_TAG

# Apply Kubernetes manifests
echo "☸️  Applying Kubernetes manifests..."
kubectl apply -f k8s/storage-secrets.yaml
kubectl apply -f k8s/deployment-postgres.yaml
kubectl apply -f k8s/deployment-redis.yaml
kubectl apply -f k8s/deployment-api.yaml

# Wait for rollout
echo "⏳ Waiting for deployment to be ready..."
kubectl rollout status deployment/xtiandos-api -n default --timeout=5m

echo "✅ Deployment complete!"
echo ""
echo "Access your cluster:"
kubectl port-forward svc/xtiandos-api 3101:80 &
echo "API: http://localhost:3101"
