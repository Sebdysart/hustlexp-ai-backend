#!/usr/bin/env tsx
/**
 * Verify HustleXP Documentation Alignment
 * 
 * Usage:
 *   tsx scripts/verify-docs-alignment.ts [file-path]
 * 
 * Examples:
 *   tsx scripts/verify-docs-alignment.ts backend/src/services/TaskService.ts
 *   tsx scripts/verify-docs-alignment.ts                     # Check all files
 */

import { readFile, readdir, stat } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const HUSTLEXP_DOCS_PATH = '/Users/sebastiandysart/HustleXP/HUSTLEXP-DOCS';
const BACKEND_PATH = join(__dirname, '..', 'backend');

interface AlignmentCheck {
  file: string;
  checks: {
    name: string;
    passed: boolean;
    details?: string;
  }[];
}

/**
 * Check if file references HustleXP docs
 */
async function checkDocReferences(filePath: string): Promise<boolean> {
  try {
    const content = await readFile(filePath, 'utf-8');
    const hasDocReference = 
      content.includes('HUSTLEXP_DOCS_PATH') ||
      content.includes('HUSTLEXP-DOCS') ||
      content.includes('PRODUCT_SPEC') ||
      content.includes('ARCHITECTURE') ||
      content.includes('AI_INFRASTRUCTURE') ||
      content.includes('@see') ||
      content.includes('CONSTITUTIONAL');
    return hasDocReference;
  } catch (error) {
    return false;
  }
}

/**
 * Check if file follows constitutional patterns
 */
async function checkConstitutionalPatterns(filePath: string): Promise<{
  passed: boolean;
  issues: string[];
}> {
  const issues: string[] = [];
  
  try {
    const content = await readFile(filePath, 'utf-8');
    
    // Check for HX error code handling
    if (content.includes('catch') && !content.includes('HX')) {
      // Might be missing HX error handling
      if (content.includes('await') && content.includes('Service')) {
        issues.push('Missing HX error code handling');
      }
    }
    
    // Check for proper ServiceResult return types
    if (content.includes('Service') && content.includes('async')) {
      if (!content.includes('ServiceResult')) {
        issues.push('Missing ServiceResult return type');
      }
    }
    
    // Check for authority validation in AI code
    if (filePath.includes('ai/') && content.includes('async')) {
      if (!content.includes('authority') && !content.includes('Authority')) {
        issues.push('Missing authority validation in AI code');
      }
    }
    
    return {
      passed: issues.length === 0,
      issues,
    };
  } catch (error) {
    return {
      passed: false,
      issues: [`Error reading file: ${error}`],
    };
  }
}

/**
 * Verify file alignment
 */
async function verifyFileAlignment(filePath: string): Promise<AlignmentCheck> {
  const checks: AlignmentCheck['checks'] = [];
  
  // Check 1: References documentation
  const hasDocRefs = await checkDocReferences(filePath);
  checks.push({
    name: 'References HustleXP Docs',
    passed: hasDocRefs,
    details: hasDocRefs ? 'File references constitutional documentation' : 'Missing documentation references',
  });
  
  // Check 2: Constitutional patterns
  const patternCheck = await checkConstitutionalPatterns(filePath);
  checks.push({
    name: 'Follows Constitutional Patterns',
    passed: patternCheck.passed,
    details: patternCheck.issues.length > 0 ? patternCheck.issues.join(', ') : 'All patterns followed',
  });
  
  return {
    file: filePath,
    checks,
  };
}

/**
 * Find all TypeScript files in directory
 */
async function findTSFiles(dir: string, fileList: string[] = []): Promise<string[]> {
  try {
    const files = await readdir(dir);
    
    for (const file of files) {
      const filePath = join(dir, file);
      const fileStat = await stat(filePath);
      
      if (fileStat.isDirectory() && !file.includes('node_modules') && !file.includes('dist')) {
        await findTSFiles(filePath, fileList);
      } else if (file.endsWith('.ts') && !file.endsWith('.d.ts')) {
        fileList.push(filePath);
      }
    }
    
    return fileList;
  } catch (error) {
    return fileList;
  }
}

/**
 * Main verification function
 */
async function main() {
  const targetFile = process.argv[2];
  
  console.log('🔍 HustleXP Documentation Alignment Verification\n');
  console.log('─'.repeat(60));
  
  if (targetFile) {
    // Verify specific file
    console.log(`\n📄 Checking: ${targetFile}\n`);
    const result = await verifyFileAlignment(targetFile);
    
    console.log(`File: ${result.file}`);
    console.log('');
    result.checks.forEach((check, index) => {
      const icon = check.passed ? '✅' : '❌';
      console.log(`${icon} ${check.name}`);
      if (check.details && !check.passed) {
        console.log(`   ${check.details}`);
      }
    });
    
    const allPassed = result.checks.every(c => c.passed);
    console.log('');
    if (allPassed) {
      console.log('✅ All alignment checks passed!');
    } else {
      console.log('⚠️  Some alignment checks failed. Review documentation.');
    }
  } else {
    // Verify all backend files
    console.log('\n📁 Checking all backend files...\n');
    const files = await findTSFiles(BACKEND_PATH);
    
    console.log(`Found ${files.length} TypeScript files\n`);
    console.log('─'.repeat(60));
    
    const results: AlignmentCheck[] = [];
    for (const file of files.slice(0, 20)) { // Limit to first 20 for demo
      const result = await verifyFileAlignment(file);
      results.push(result);
    }
    
    // Summary
    console.log('\n📊 Summary:\n');
    const totalChecks = results.reduce((sum, r) => sum + r.checks.length, 0);
    const passedChecks = results.reduce((sum, r) => 
      sum + r.checks.filter(c => c.passed).length, 0
    );
    
    console.log(`Files checked: ${results.length}`);
    console.log(`Checks passed: ${passedChecks}/${totalChecks}`);
    console.log(`Alignment: ${((passedChecks / totalChecks) * 100).toFixed(1)}%`);
    
    // Show failed checks
    const failed = results.filter(r => !r.checks.every(c => c.passed));
    if (failed.length > 0) {
      console.log('\n⚠️  Files needing attention:\n');
      failed.forEach(result => {
        console.log(`📄 ${result.file}`);
        result.checks.filter(c => !c.passed).forEach(check => {
          console.log(`   ❌ ${check.name}: ${check.details}`);
        });
      });
    }
  }
  
  console.log('\n─'.repeat(60));
  console.log('\n💡 Tip: Reference HustleXP docs at:');
  console.log(`   ${HUSTLEXP_DOCS_PATH}`);
  console.log('\n📚 Key Documents:');
  console.log('   - PRODUCT_SPEC.md (Product requirements)');
  console.log('   - ARCHITECTURE.md (System architecture)');
  console.log('   - AI_INFRASTRUCTURE.md (AI authority model)');
  console.log('   - schema.sql (Database schema)');
  console.log('   - UI_SPEC.md (UI specifications)');
}

main().catch(console.error);
