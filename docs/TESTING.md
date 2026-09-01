# xtiandOS Production Testing Guide

## Test Suites Overview

This document describes all test categories and how to run them.

### 1. **Smoke Tests** (`smoke.test.ts`)
- **Purpose:** Verify critical endpoints are accessible
- **Coverage:**
  - `/health` endpoint responds with correct status
  - Metrics endpoint available
  - Docker status endpoint
  - Invalid auth rejection
- **Run:** `npm run test -- smoke.test.ts`
- **Duration:** ~5 seconds

### 2. **Functional Tests** (`functional.test.ts`)
- **Purpose:** Verify core features work end-to-end
- **Coverage:**
  - Conversation creation/retrieval
  - Chat message handling
  - Agent listing
  - Memory operations
  - Image config management
- **Run:** `npm run test -- functional.test.ts`
- **Duration:** ~15 seconds

### 3. **Integration Tests** (`integration.test.ts`)
- **Purpose:** Verify multi-service workflows
- **Coverage:**
  - End-to-end chat workflow (create → send → retrieve)
  - MCP server registration and tool discovery
  - Cross-service project/task workflows
- **Run:** `npm run test -- integration.test.ts`
- **Duration:** ~20 seconds

### 4. **Security Tests** (`security.test.ts`)
- **Purpose:** Verify security controls work
- **Coverage:**
  - Authentication enforcement
  - Invalid token rejection
  - SQL injection prevention
  - Command injection blocking (destructive patterns)
  - Rate limiting
  - Error message sanitization
- **Run:** `npm run test -- security.test.ts`
- **Duration:** ~10 seconds

### 5. **Load Tests** (`load.test.ts`)
- **Purpose:** Verify performance under concurrent load
- **Coverage:**
  - Health endpoint throughput (target: >100 req/sec)
  - Concurrent chat requests (20 connections)
  - Error rate thresholds (<10%)
  - Latency percentiles (p99 <1s)
- **Run:** `npm run test -- load.test.ts` (or skip with `SKIP_LOAD_TESTS=true`)
- **Duration:** ~30 seconds per test
- **Note:** Requires tuned system; may fail on CI without resource limits

### 6. **UI Tests** (`ui.test.ts`)
- **Purpose:** Verify web app integration and rendering
- **Coverage:**
  - Web app entry point serving
  - CORS headers present
  - Static asset caching
  - SSE streaming without corruption
- **Run:** `npm run test -- ui.test.ts`
- **Duration:** ~10 seconds

### 7. **Service Unit Tests**
- **Cache Service** (`cache.test.ts`): Redis caching, TTL, cache hits/misses
- **Orchestrator** (`orchestrator.test.ts`): Task dependency resolution, circular detection, retry logic
- **Run:** `npm run test` (runs all unit tests)
- **Duration:** ~5 seconds

## Quick Start

### Run All Tests
```bash
bash scripts/run-all-tests.sh
```

### Run Specific Suite
```bash
# Smoke tests only
npm run test -- smoke.test.ts

# Security tests
npm run test -- security.test.ts

# Skip load tests (faster CI)
SKIP_LOAD_TESTS=true bash scripts/run-all-tests.sh
```

### With Custom API URL
```bash
API_URL=https://staging.xtiandos.com AUTH_TOKEN=my-token bash scripts/run-all-tests.sh
```

## CI/CD Integration

### GitHub Actions Example
```yaml
name: Test
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16
        env:
          POSTGRES_PASSWORD: test
      redis:
        image: redis:7
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: '22'
      - run: npm ci
      - run: npm run build
      - run: npm run dev:api &
      - run: sleep 5
      - run: SKIP_LOAD_TESTS=true bash scripts/run-all-tests.sh
```

## Test Results

All test results are saved to `test-results/` directory:
- `smoke-results.json`
- `functional-results.json`
- `security-results.json`
- `load-results.html` (performance metrics)

## Troubleshooting

### Tests fail with "Connection refused"
- Ensure API is running: `npm run dev:api`
- Check port: API should be on 3101
- Verify AUTH_TOKEN is set if required

### Load tests show high error rates
- May indicate resource constraints
- Run on dedicated system or increase connection timeouts
- Check Redis/DB availability

### Security tests pass but feel incomplete
- Add custom tests to `security.test.ts` for your specific threats
- Coordinate with security team for penetration testing

## Success Criteria

✅ **Ready for Production when:**
- All smoke tests pass (0% failures)
- All functional tests pass (0% failures)
- All integration tests pass (0% failures)
- All security tests pass (0% failures)
- Load tests show >50 req/sec throughput
- Error rate <1% under normal load
- UI tests verify rendering without issues
