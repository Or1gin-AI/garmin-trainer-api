#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

docker compose pull app worker migrate
docker compose run --rm migrate
docker compose up -d app worker
