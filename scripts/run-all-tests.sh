#!/bin/bash

# Test Suite Runner for xtiandOS Production Validation
# Runs all test categories with reporting

set -e

echo "🧪 Starting xtiandOS Comprehensive Test Suite"
echo "================================================"

API_URL=${API_URL:-http://localhost:3101}
AUTH_TOKEN=${AUTH_TOKEN:-test-token}
export API_URL AUTH_TOKEN

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

TEST_RESULTS={}
TOTAL_TESTS=0
PASSED_TESTS=0
FAILED_TESTS=0

run_test_suite() {
  local suite_name=$1
  local test_file=$2

  echo ""
  echo -e "${YELLOW}▶ Running $suite_name${NC}"
  
  if npm run test -- "$test_file" --reporter=verbose; then
    echo -e "${GREEN}✓ $suite_name passed${NC}"
    PASSED_TESTS=$((PASSED_TESTS + 1))
  else
    echo -e "${RED}✗ $suite_name failed${NC}"
    FAILED_TESTS=$((FAILED_TESTS + 1))
  fi
  TOTAL_TESTS=$((TOTAL_TESTS + 1))
}

# 1. Smoke Tests
run_test_suite "Smoke Tests" "apps/api/src/__tests__/smoke.test.ts"

# 2. Functional Tests
run_test_suite "Functional Tests" "apps/api/src/__tests__/functional.test.ts"

# 3. Integration Tests
run_test_suite "Integration Tests" "apps/api/src/__tests__/integration.test.ts"

# 4. Security Tests
run_test_suite "Security Tests" "apps/api/src/__tests__/security.test.ts"

# 5. Load Tests (optional, slower)
if [ "${SKIP_LOAD_TESTS}" != "true" ]; then
  run_test_suite "Load Tests" "apps/api/src/__tests__/load.test.ts"
fi

# 6. UI Tests
run_test_suite "UI Tests" "apps/api/src/__tests__/ui.test.ts"

# 7. Cache Service Tests
run_test_suite "Cache Service Tests" "apps/api/src/services/cache.test.ts"

# 8. Orchestrator Tests
run_test_suite "Orchestrator Tests" "apps/api/src/services/orchestrator.test.ts"

echo ""
echo "================================================"
echo -e "${YELLOW}Test Summary${NC}"
echo "================================================"
echo -e "Total Tests: $TOTAL_TESTS"
echo -e "${GREEN}Passed: $PASSED_TESTS${NC}"
echo -e "${RED}Failed: $FAILED_TESTS${NC}"
echo ""

if [ $FAILED_TESTS -eq 0 ]; then
  echo -e "${GREEN}✓ All tests passed!${NC}"
  exit 0
else
  echo -e "${RED}✗ Some tests failed. Review output above.${NC}"
  exit 1
fi
