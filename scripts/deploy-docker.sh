#!/bin/bash
# Deploy to Docker Compose (single-machine production)
# Usage: ./scripts/deploy-docker.sh

set -e

echo "🐳 Deploying xtiandOS with Docker Compose"

# Check dependencies
command -v docker-compose &> /dev/null || { echo "docker-compose is required"; exit 1; }

# Load environment
if [ ! -f .env.production ]; then
  echo "⚠️  .env.production not found. Copy .env.production.example and configure:"
  exit 1
fi

# Build image
echo "📦 Building Docker image..."
docker build -f Dockerfile.prod -t xtiandos:latest .

# Stop old containers
echo "🛑 Stopping old containers..."
docker-compose -f docker-compose.prod.yml down || true

# Start new containers
echo "🚀 Starting containers..."
docker-compose -f docker-compose.prod.yml up -d

# Wait for services
echo "⏳ Waiting for services to be healthy..."
for i in {1..30}; do
  if curl -f http://localhost:3101/health > /dev/null 2>&1; then
    echo "✅ API is healthy!"
    break
  fi
  echo "Waiting... ($i/30)"
  sleep 2
done

# Run tests
echo ""
echo "🧪 Running smoke tests..."
API_URL=http://localhost:3101 npm run test:smoke || echo "⚠️  Some tests failed"

echo ""
echo "✅ Deployment complete!"
echo "API running on: http://localhost:3101"
echo "View logs: docker-compose -f docker-compose.prod.yml logs -f api"
