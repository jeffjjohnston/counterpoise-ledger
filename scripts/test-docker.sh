#!/bin/sh
set -e

echo "Building and starting Docker stack..."
docker compose up -d --build

echo "Waiting for app to be ready..."
for i in $(seq 1 30); do
  if curl -sfL http://localhost:3000 > /dev/null 2>&1; then
    echo "App is ready!"
    break
  fi
  if [ "$i" = "30" ]; then
    echo "FAIL: App did not become ready in 30 seconds"
    docker compose logs app
    docker compose down
    exit 1
  fi
  sleep 1
done

echo "Testing health..."
STATUS=$(curl -sfL -o /dev/null -w "%{http_code}" http://localhost:3000)
if [ "$STATUS" != "200" ]; then
  echo "FAIL: Expected 200, got $STATUS"
  docker compose logs app
  docker compose down
  exit 1
fi

echo "PASS: Docker stack is healthy"
docker compose down
