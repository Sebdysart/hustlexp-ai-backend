#!/usr/bin/env node
/**
 * HustleXP Test Runner MCP Server
 * 
 * Provides test execution via MCP protocol using Vitest.
 * Executes backend tests and returns structured results.
 * 
 * Authority: Tier 0 (Truth & Enforcement)
 * Rule: No logic ships without passing tests
 * 
 * Usage: tsx backend/tests/mcp-server.ts
 * Environment: DATABASE_URL (optional, for tests that need DB)
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs';
import * as z from 'zod/v4';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const execAsync = promisify(exec);

// ============================================================================
// CONFIGURATION
// ============================================================================

const PROJECT_ROOT = path.resolve(__dirname, '../..');
const VITEST_CONFIG = path.join(PROJECT_ROOT, 'vitest.config.ts');

// ============================================================================
// MCP SERVER SETUP
// ============================================================================

const server = new McpServer(
  {
    name: 'hustlexp-test-runner-mcp',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
      resources: {},
    },
  }
);

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Parse Vitest JSON output into structured results
 */
function parseVitestOutput(output: string): {
  passed: boolean;
  totalTests: number;
  passedTests: number;
  failedTests: number;
  duration: number;
  results: Array<{
    file: string;
    name: string;
    status: 'passed' | 'failed' | 'skipped';
    duration?: number;
    error?: string;
  }>;
} {
  try {
    // Try to extract JSON from output (Vitest can output JSON with --reporter=json)
    const lines = output.split('\n');
    const jsonLines: string[] = [];
    let inJson = false;
    
    for (const line of lines) {
      if (line.trim().startsWith('{')) {
        inJson = true;
      }
      if (inJson) {
        jsonLines.push(line);
        if (line.trim().endsWith('}')) {
          break;
        }
      }
    }
    
    if (jsonLines.length > 0) {
      const jsonStr = jsonLines.join('\n');
      const parsed = JSON.parse(jsonStr);
      
      return {
        passed: parsed.numPassedTests === parsed.numTotalTests,
        totalTests: parsed.numTotalTests || 0,
        passedTests: parsed.numPassedTests || 0,
        failedTests: parsed.numFailedTests || 0,
        duration: parsed.duration || 0,
        results: parsed.testResults?.flatMap((result: any) =>
          result.assertionResults?.map((test: any) => ({
            file: result.name,
            name: test.fullName || test.title || 'unknown',
            status: test.status || 'unknown',
            duration: test.duration,
            error: test.failureMessages?.join('\n'),
          })) || []
        ) || [],
      };
    }
    
    // Fallback: Parse text output
    const passedMatch = output.match(/(\d+) passed/);
    const failedMatch = output.match(/(\d+) failed/);
    const totalMatch = output.match(/Tests\s+(\d+)/);
    const durationMatch = output.match(/Duration\s+([\d.]+)s/);
    
    return {
      passed: !failedMatch && (passedMatch || totalMatch),
      totalTests: totalMatch ? parseInt(totalMatch[1], 10) : 0,
      passedTests: passedMatch ? parseInt(passedMatch[1], 10) : 0,
      failedTests: failedMatch ? parseInt(failedMatch[1], 10) : 0,
      duration: durationMatch ? parseFloat(durationMatch[1]) : 0,
      results: [],
    };
  } catch (error) {
    return {
      passed: false,
      totalTests: 0,
      passedTests: 0,
      failedTests: 0,
      duration: 0,
      results: [],
    };
  }
}

/**
 * Execute Vitest with given arguments
 */
async function runVitest(args: string[]): Promise<string> {
  const command = `npx vitest run ${args.join(' ')}`;
  
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        NODE_ENV: 'test',
      },
      maxBuffer: 10 * 1024 * 1024, // 10MB buffer for large test outputs
    });
    
    // Combine stdout and stderr (Vitest logs to both)
    return stdout + (stderr ? '\n' + stderr : '');
  } catch (error: any) {
    // Vitest exits with non-zero on test failures, but we still want the output
    if (error.stdout || error.stderr) {
      return (error.stdout || '') + '\n' + (error.stderr || '');
    }
    throw error;
  }
}

// ============================================================================
// TOOLS (Test Execution)
// ============================================================================

// Tool 1: Run all tests
server.registerTool('test.run_all', {
  title: 'Run All Tests',
  description: 'Executes all tests in the backend test suite. Returns structured test results.',
  inputSchema: z.object({}),
}, async (_args, _extra) => {
  try {
    console.error('🔍 Running all tests...');
    const output = await runVitest(['--reporter=verbose']);
    const results = parseVitestOutput(output);
    
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: true,
            ...results,
            rawOutput: output.substring(0, 5000), // Limit raw output size
          }, null, 2),
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
          }, null, 2),
        },
      ],
      isError: true,
    };
  }
});

// Tool 2: Run tests matching pattern
server.registerTool('test.run_pattern', {
  title: 'Run Tests Matching Pattern',
  description: 'Executes tests matching a file or test name pattern. Use glob patterns like "**/inv*.test.ts" or test names.',
  inputSchema: z.object({
    pattern: z.string().describe('Glob pattern for test files (e.g., "**/inv*.test.ts") or test name pattern'),
    testNamePattern: z.string().optional().describe('Optional: Test name pattern (regex)'),
  }),
}, async (args, _extra) => {
  try {
    const { pattern, testNamePattern } = args;
    console.error(`🔍 Running tests matching pattern: ${pattern}`);
    
    const vitestArgs = [pattern];
    if (testNamePattern) {
      vitestArgs.push('-t', testNamePattern);
    }
    vitestArgs.push('--reporter=verbose');
    
    const output = await runVitest(vitestArgs);
    const results = parseVitestOutput(output);
    
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: true,
            pattern,
            testNamePattern,
            ...results,
            rawOutput: output.substring(0, 5000),
          }, null, 2),
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
          }, null, 2),
        },
      ],
      isError: true,
    };
  }
});

// Tool 3: Run invariant tests (kill tests)
server.registerTool('test.run_invariants', {
  title: 'Run Invariant Tests',
  description: 'Executes invariant/kill tests that verify database-level enforcement. These tests should fail when invariants are violated.',
  inputSchema: z.object({}),
}, async (_args, _extra) => {
  try {
    console.error('🔍 Running invariant tests (kill tests)...');
    const output = await runVitest([
      'backend/tests/invariants/',
      '--reporter=verbose',
    ]);
    const results = parseVitestOutput(output);
    
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: true,
            category: 'invariants',
            ...results,
            rawOutput: output.substring(0, 5000),
          }, null, 2),
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
          }, null, 2),
        },
      ],
      isError: true,
    };
  }
});

// Tool 4: Run specific test file
server.registerTool('test.run_file', {
  title: 'Run Specific Test File',
  description: 'Executes a specific test file by path (relative to project root or absolute).',
  inputSchema: z.object({
    filePath: z.string().describe('Path to test file (e.g., "backend/tests/invariants/inv-1.test.ts")'),
  }),
}, async (args, _extra) => {
  try {
    const { filePath } = args;
    console.error(`🔍 Running test file: ${filePath}`);
    
    // Resolve path relative to project root
    const resolvedPath = path.isAbsolute(filePath) 
      ? filePath 
      : path.join(PROJECT_ROOT, filePath);
    
    if (!fs.existsSync(resolvedPath)) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: false,
              error: `Test file not found: ${filePath}`,
            }, null, 2),
          },
        ],
        isError: true,
      };
    }
    
    const output = await runVitest([
      resolvedPath,
      '--reporter=verbose',
    ]);
    const results = parseVitestOutput(output);
    
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: true,
            filePath: resolvedPath,
            ...results,
            rawOutput: output.substring(0, 5000),
          }, null, 2),
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
          }, null, 2),
        },
      ],
      isError: true,
    };
  }
});

// Tool 5: List available test files
server.registerTool('test.list_files', {
  title: 'List Available Test Files',
  description: 'Returns a list of all available test files in the backend test directory.',
  inputSchema: z.object({}),
}, async (_args, _extra) => {
  try {
    const testDir = path.join(PROJECT_ROOT, 'backend/tests');
    
    function findTestFiles(dir: string, baseDir: string = dir): string[] {
      const files: string[] = [];
      
      if (!fs.existsSync(dir)) {
        return files;
      }
      
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        const relativePath = path.relative(baseDir, fullPath);
        
        if (entry.isDirectory()) {
          files.push(...findTestFiles(fullPath, baseDir));
        } else if (entry.isFile() && entry.name.endsWith('.test.ts')) {
          files.push(relativePath);
        }
      }
      
      return files;
    }
    
    const testFiles = findTestFiles(testDir);
    
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: true,
            testFiles,
            count: testFiles.length,
            testDir,
          }, null, 2),
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
          }, null, 2),
        },
      ],
      isError: true,
    };
  }
});

// ============================================================================
// SERVER LIFECYCLE
// ============================================================================

async function main() {
  try {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    
    console.error('✅ HustleXP Test Runner MCP Server started');
    console.error(`   Project root: ${PROJECT_ROOT}`);
    console.error(`   Vitest config: ${VITEST_CONFIG}`);
    console.error('   Tools registered: test.run_all, test.run_pattern, test.run_invariants, test.run_file, test.list_files');
  } catch (error) {
    console.error('❌ Fatal error starting Test Runner MCP server:', error);
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGINT', async () => {
  console.error('\n🛑 Shutting down Test Runner MCP Server...');
  try {
    await server.close();
    process.exit(0);
  } catch (error) {
    console.error('Error during shutdown:', error);
    process.exit(1);
  }
});

process.on('SIGTERM', async () => {
  console.error('\n🛑 Shutting down Test Runner MCP Server...');
  try {
    await server.close();
    process.exit(0);
  } catch (error) {
    console.error('Error during shutdown:', error);
    process.exit(1);
  }
});

// Start server
main().catch((error) => {
  console.error('❌ Fatal error:', error);
  process.exit(1);
});