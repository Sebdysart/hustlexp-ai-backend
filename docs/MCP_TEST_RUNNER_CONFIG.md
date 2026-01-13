# Test Runner MCP Configuration

**Date**: January 2025  
**Status**: ✅ **CONFIGURED**  
**Authority**: Tier 0 (Truth & Enforcement)  
**Enforcement Rule**: "No logic ships without passing tests"

---

## Overview

The Test Runner MCP provides programmatic test execution via the MCP protocol. It uses Vitest to execute backend tests and returns structured results.

**Purpose**: Enable AI to verify code correctness by executing tests and validating results.

---

## Configuration

### MCP Config (`~/.cursor/mcp.json`)

```json
{
  "test-runner-mcp": {
    "command": "bash",
    "args": [
      "/Users/sebastiandysart/HustleXP/hustlexp-ai-backend/backend/tests/mcp-server-wrapper.sh"
    ],
    "cwd": "/Users/sebastiandysart/HustleXP/hustlexp-ai-backend"
  }
}
```

### Files

- **MCP Server**: `backend/tests/mcp-server.ts`
- **Wrapper Script**: `backend/tests/mcp-server-wrapper.sh`
- **Vitest Config**: `vitest.config.ts`

---

## Available Tools

### 1. `test.run_all`

**Description**: Executes all tests in the backend test suite.

**Input**: None

**Output**: Structured test results including:
- `passed`: Boolean indicating if all tests passed
- `totalTests`: Total number of tests executed
- `passedTests`: Number of tests that passed
- `failedTests`: Number of tests that failed
- `duration`: Test execution duration in seconds
- `results`: Array of individual test results

**Example**:
```json
{
  "success": true,
  "passed": true,
  "totalTests": 45,
  "passedTests": 45,
  "failedTests": 0,
  "duration": 12.34,
  "results": [...]
}
```

---

### 2. `test.run_pattern`

**Description**: Executes tests matching a file or test name pattern.

**Input**:
- `pattern` (required): Glob pattern for test files (e.g., `"**/inv*.test.ts"`)
- `testNamePattern` (optional): Test name pattern (regex)

**Output**: Same as `test.run_all`, with `pattern` and `testNamePattern` fields.

**Example**:
```json
{
  "pattern": "**/inv*.test.ts",
  "testNamePattern": "INV-1",
  "passed": true,
  "totalTests": 3,
  ...
}
```

---

### 3. `test.run_invariants`

**Description**: Executes invariant/kill tests that verify database-level enforcement. These tests should fail when invariants are violated.

**Input**: None

**Output**: Same as `test.run_all`, with `category: "invariants"` field.

**Example**:
```json
{
  "success": true,
  "category": "invariants",
  "passed": true,
  "totalTests": 6,
  ...
}
```

---

### 4. `test.run_file`

**Description**: Executes a specific test file by path.

**Input**:
- `filePath` (required): Path to test file (e.g., `"backend/tests/invariants/inv-1.test.ts"`)

**Output**: Same as `test.run_all`, with `filePath` field.

**Example**:
```json
{
  "success": true,
  "filePath": "/path/to/inv-1.test.ts",
  "passed": true,
  "totalTests": 2,
  ...
}
```

---

### 5. `test.list_files`

**Description**: Returns a list of all available test files in the backend test directory.

**Input**: None

**Output**:
```json
{
  "success": true,
  "testFiles": [
    "backend/tests/invariants/inv-1.test.ts",
    "backend/tests/invariants/inv-2.test.ts",
    ...
  ],
  "count": 12,
  "testDir": "/path/to/backend/tests"
}
```

---

## Usage Examples

### Via MCP Client (Cursor)

```
User: Run all invariant tests
AI: [Calls test.run_invariants]
AI: ✅ All 6 invariant tests passed

User: Run tests for the rating service
AI: [Calls test.run_pattern with pattern "**/rating*.test.ts"]
AI: ✅ 8/8 rating service tests passed

User: What test files exist?
AI: [Calls test.list_files]
AI: Found 12 test files: inv-1.test.ts, inv-2.test.ts, ...
```

---

## Authority & Enforcement

### Tier 0 Enforcement Rule

**"No logic ships without passing tests"**

This means:
- ✅ All code changes must have corresponding tests
- ✅ Tests must pass before code is merged
- ✅ AI should verify tests pass before declaring work complete
- ✅ Test failures block deployment

### Limitations

- **Read-Only**: Can only execute tests, cannot modify code
- **No Code Changes**: Cannot edit test files or source code
- **Results Only**: Returns test results, does not enforce policy (enforcement must be done by AI or CI/CD)

---

## Implementation Details

### Vitest Execution

The Test Runner MCP executes Vitest via CLI:
```bash
npx vitest run [args]
```

### Output Parsing

The server parses Vitest output (text or JSON) and converts it to structured results. Supports:
- JSON output (when `--reporter=json` is used)
- Text output (fallback parsing)

### Environment

- Loads `DATABASE_URL` from `env.backend` if available (for tests that need DB)
- Sets `NODE_ENV=test`
- Uses project root as working directory

---

## Testing

### Manual Test

```bash
# Test server startup
cd /Users/sebastiandysart/HustleXP/hustlexp-ai-backend
bash backend/tests/mcp-server-wrapper.sh

# Should output:
# ✅ HustleXP Test Runner MCP Server started
#    Project root: /path/to/project
#    Vitest config: /path/to/vitest.config.ts
#    Tools registered: ...
```

### Via MCP Client

After restarting Cursor:
1. MCP server should start automatically
2. Tools should be discoverable
3. Execute `test.list_files` to verify connectivity
4. Execute `test.run_invariants` to verify test execution

---

## Status

✅ **CONFIGURED** - Ready for use

**Next Steps**:
1. Restart Cursor to load MCP configuration
2. Verify server starts successfully
3. Test tool execution via MCP client
4. Integrate test execution into alignment workflow

---

**Last Updated**: January 2025  
**Version**: 1.0.0