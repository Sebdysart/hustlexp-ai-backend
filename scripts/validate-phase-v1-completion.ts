/**
 * Phase V1 Completion Validation Script
 * 
 * Systematically verifies that Phase V1 (Product Validation) was completed.
 * 
 * Phase V1 consists of:
 * - V1.1: Xcode Validation & Flow Verification
 * - V1.2: Minimal Task-Scoped Messaging
 * - V1.3: Maps Screens (EN_ROUTE Gated)
 */

import * as fs from 'fs';
import * as path from 'path';

// Conditionally import db if DATABASE_URL is set
let db: any = null;
const hasDatabaseUrl = !!process.env.DATABASE_URL;

if (hasDatabaseUrl) {
  try {
    db = (await import('../backend/src/db')).db;
  } catch (error) {
    console.warn('⚠️  Warning: Could not import database client. Database checks will be skipped.');
  }
}

interface ValidationResult {
  phase: string;
  item: string;
  status: 'PASS' | 'FAIL' | 'PARTIAL' | 'NOT_FOUND';
  details: string;
}

const results: ValidationResult[] = [];

function log(phase: string, item: string, status: ValidationResult['status'], details: string) {
  results.push({ phase, item, status, details });
  const icon = status === 'PASS' ? '✅' : status === 'FAIL' ? '❌' : status === 'PARTIAL' ? '⚠️' : '🔍';
  console.log(`${icon} [${phase}] ${item}: ${details}`);
}

// ============================================================================
// V1.1: Xcode Validation & Flow Verification
// ============================================================================

async function validateV1_1() {
  console.log('\n========================================');
  console.log('V1.1: Xcode Validation & Flow Verification');
  console.log('========================================\n');

  // Check package.json exists
  const packageJsonPath = path.join(process.cwd(), 'hustlexp-app', 'package.json');
  if (fs.existsSync(packageJsonPath)) {
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
    log('V1.1', 'package.json', 'PASS', `Found with ${Object.keys(packageJson.dependencies || {}).length} dependencies`);
  } else {
    log('V1.1', 'package.json', 'FAIL', 'package.json not found');
  }

  // Check App.tsx exists
  const appTsxPath = path.join(process.cwd(), 'hustlexp-app', 'App.tsx');
  if (fs.existsSync(appTsxPath)) {
    log('V1.1', 'App.tsx', 'PASS', 'Root app file exists');
  } else {
    log('V1.1', 'App.tsx', 'FAIL', 'App.tsx not found');
  }

  // Check navigation files
  const navFiles = [
    'hustlexp-app/navigation/types.ts',
    'hustlexp-app/navigation/guards.ts',
    'hustlexp-app/navigation/HustlerStack.tsx',
    'hustlexp-app/navigation/PosterStack.tsx',
  ];

  for (const file of navFiles) {
    const filePath = path.join(process.cwd(), file);
    if (fs.existsSync(filePath)) {
      log('V1.1', path.basename(file), 'PASS', `Navigation file exists: ${file}`);
    } else {
      log('V1.1', path.basename(file), 'FAIL', `Navigation file missing: ${file}`);
    }
  }

  // Check core screens
  const coreScreens = [
    'hustlexp-app/screens/hustler/HustlerHomeScreen.tsx',
    'hustlexp-app/screens/hustler/TaskFeedScreen.tsx',
    'hustlexp-app/screens/hustler/TaskInProgressScreen.tsx',
    'hustlexp-app/screens/poster/TaskCreationScreen.tsx',
  ];

  for (const screen of coreScreens) {
    const screenPath = path.join(process.cwd(), screen);
    if (fs.existsSync(screenPath)) {
      log('V1.1', path.basename(screen, '.tsx'), 'PASS', `Screen exists: ${screen}`);
    } else {
      log('V1.1', path.basename(screen, '.tsx'), 'FAIL', `Screen missing: ${screen}`);
    }
  }

  // Check for validation report
  const reportPath = path.join(process.cwd(), 'V1_1_XCODE_VALIDATION_REPORT.md');
  if (fs.existsSync(reportPath)) {
    log('V1.1', 'Validation Report', 'PASS', 'V1_1_XCODE_VALIDATION_REPORT.md exists');
  } else {
    log('V1.1', 'Validation Report', 'NOT_FOUND', 'V1_1_XCODE_VALIDATION_REPORT.md not found (deliverable not created)');
  }
}

// ============================================================================
// V1.2: Minimal Task-Scoped Messaging
// ============================================================================

async function validateV1_2() {
  console.log('\n========================================');
  console.log('V1.2: Minimal Task-Scoped Messaging');
  console.log('========================================\n');

  // Check migration file exists
  const migrationPath = path.join(process.cwd(), 'migrations', '20250117_v1_2_task_messaging.sql');
  if (fs.existsSync(migrationPath)) {
    log('V1.2', 'Migration File', 'PASS', 'Migration file exists');
  } else {
    log('V1.2', 'Migration File', 'FAIL', 'Migration file not found');
  }

  // Check if tables exist in database
  if (db && hasDatabaseUrl) {
    try {
      const conversationsResult = await db.query(
        `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = 'task_conversations'`
      );
      
      if (conversationsResult.rows.length > 0) {
        log('V1.2', 'task_conversations table', 'PASS', 'Table exists in database');
      } else {
        log('V1.2', 'task_conversations table', 'FAIL', 'Table does not exist in database (migration not applied)');
      }

      const messagesResult = await db.query(
        `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = 'task_messages'`
      );
      
      if (messagesResult.rows.length > 0) {
        log('V1.2', 'task_messages table', 'PASS', 'Table exists in database');
      } else {
        log('V1.2', 'task_messages table', 'FAIL', 'Table does not exist in database (migration not applied)');
      }
    } catch (error: any) {
      log('V1.2', 'Database Tables', 'FAIL', `Database error: ${error.message}`);
    }
  } else {
    log('V1.2', 'Database Tables', 'NOT_FOUND', 'DATABASE_URL not set - skipping database checks');
  }

  // Check backend tRPC endpoints
  const trpcFiles = [
    'backend/trpc/routes/tasks/messages/list.ts',
    'backend/trpc/routes/tasks/messages/send.ts',
    'backend/trpc/routes/tasks/messages/conversation.ts',
  ];

  for (const file of trpcFiles) {
    const filePath = path.join(process.cwd(), file);
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf-8');
      // Check if it's not a stub
      const isImplemented = !content.includes('TODO') || content.includes('protectedProcedure');
      if (isImplemented) {
        log('V1.2', path.basename(file, '.ts'), 'PASS', `Endpoint implemented: ${file}`);
      } else {
        log('V1.2', path.basename(file, '.ts'), 'PARTIAL', `Endpoint exists but may be stub: ${file}`);
      }
    } else {
      log('V1.2', path.basename(file, '.ts'), 'FAIL', `Endpoint missing: ${file}`);
    }
  }

  // Check if endpoints are registered in app-router
  const appRouterPath = path.join(process.cwd(), 'backend', 'trpc', 'app-router.ts');
  if (fs.existsSync(appRouterPath)) {
    const content = fs.readFileSync(appRouterPath, 'utf-8');
    const hasMessagesRoute = content.includes('tasksMessagesListProcedure') &&
                             content.includes('tasksMessagesSendProcedure') &&
                             content.includes('tasksMessagesGetConversationProcedure');
    if (hasMessagesRoute) {
      log('V1.2', 'tRPC Router Integration', 'PASS', 'Messages endpoints registered in app-router.ts');
    } else {
      log('V1.2', 'tRPC Router Integration', 'FAIL', 'Messages endpoints not registered in app-router.ts');
    }
  } else {
    log('V1.2', 'tRPC Router Integration', 'FAIL', 'app-router.ts not found');
  }

  // Check React Native messaging screen
  const messagingScreenPath = path.join(process.cwd(), 'hustlexp-app', 'screens', 'shared', 'TaskConversationScreen.tsx');
  if (fs.existsSync(messagingScreenPath)) {
    const content = fs.readFileSync(messagingScreenPath, 'utf-8');
    const hasRequiredFeatures = content.includes('ScrollView') && 
                                 content.includes('TextInput') && 
                                 content.includes('send');
    if (hasRequiredFeatures) {
      log('V1.2', 'TaskConversationScreen', 'PASS', 'Messaging screen implemented with required features');
    } else {
      log('V1.2', 'TaskConversationScreen', 'PARTIAL', 'Messaging screen exists but may be incomplete');
    }
  } else {
    log('V1.2', 'TaskConversationScreen', 'FAIL', 'TaskConversationScreen.tsx not found');
  }

  // Check navigation integration
  const hustlerStackPath = path.join(process.cwd(), 'hustlexp-app', 'navigation', 'HustlerStack.tsx');
  const posterStackPath = path.join(process.cwd(), 'hustlexp-app', 'navigation', 'PosterStack.tsx');
  
  let hustlerHasConversation = false;
  let posterHasConversation = false;

  if (fs.existsSync(hustlerStackPath)) {
    const content = fs.readFileSync(hustlerStackPath, 'utf-8');
    hustlerHasConversation = content.includes('TaskConversation');
  }

  if (fs.existsSync(posterStackPath)) {
    const content = fs.readFileSync(posterStackPath, 'utf-8');
    posterHasConversation = content.includes('TaskConversation');
  }

  if (hustlerHasConversation && posterHasConversation) {
    log('V1.2', 'Navigation Integration', 'PASS', 'TaskConversation screen registered in both stacks');
  } else if (hustlerHasConversation || posterHasConversation) {
    log('V1.2', 'Navigation Integration', 'PARTIAL', 'TaskConversation screen registered in only one stack');
  } else {
    log('V1.2', 'Navigation Integration', 'FAIL', 'TaskConversation screen not registered in navigation');
  }
}

// ============================================================================
// V1.3: Maps Screens (EN_ROUTE Gated)
// ============================================================================

async function validateV1_3() {
  console.log('\n========================================');
  console.log('V1.3: Maps Screens (EN_ROUTE Gated)');
  console.log('========================================\n');

  // Check package.json for map dependencies
  const packageJsonPath = path.join(process.cwd(), 'hustlexp-app', 'package.json');
  if (fs.existsSync(packageJsonPath)) {
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
    const deps = packageJson.dependencies || {};
    
    const hasReactNativeMaps = !!deps['react-native-maps'];
    const hasExpoLocation = !!deps['expo-location'];

    if (hasReactNativeMaps) {
      log('V1.3', 'react-native-maps dependency', 'PASS', `react-native-maps@${deps['react-native-maps']} in package.json`);
    } else {
      log('V1.3', 'react-native-maps dependency', 'FAIL', 'react-native-maps not in package.json');
    }

    if (hasExpoLocation) {
      log('V1.3', 'expo-location dependency', 'PASS', `expo-location@${deps['expo-location']} in package.json`);
    } else {
      log('V1.3', 'expo-location dependency', 'FAIL', 'expo-location not in package.json');
    }

    // Check if dependencies are actually installed
    const mapsInstalled = fs.existsSync(path.join(process.cwd(), 'hustlexp-app', 'node_modules', 'react-native-maps'));
    const locationInstalled = fs.existsSync(path.join(process.cwd(), 'hustlexp-app', 'node_modules', 'expo-location'));

    if (mapsInstalled) {
      log('V1.3', 'react-native-maps installed', 'PASS', 'node_modules/react-native-maps exists');
    } else {
      log('V1.3', 'react-native-maps installed', 'FAIL', 'node_modules/react-native-maps not found (npm install needed)');
    }

    if (locationInstalled) {
      log('V1.3', 'expo-location installed', 'PASS', 'node_modules/expo-location exists');
    } else {
      log('V1.3', 'expo-location installed', 'FAIL', 'node_modules/expo-location not found (npm install needed)');
    }
  }

  // Check HustlerEnRouteMapScreen
  const enRouteMapPath = path.join(process.cwd(), 'hustlexp-app', 'screens', 'hustler', 'HustlerEnRouteMapScreen.tsx');
  if (fs.existsSync(enRouteMapPath)) {
    const content = fs.readFileSync(enRouteMapPath, 'utf-8');
    const hasMapView = content.includes('MapView');
    const hasLocation = content.includes('expo-location');
    const hasEnRouteGate = content.includes('EN_ROUTE') || content.includes('ACCEPTED');

    if (hasMapView && hasLocation && hasEnRouteGate) {
      log('V1.3', 'HustlerEnRouteMapScreen', 'PASS', 'Map screen implemented with MapView, location, and EN_ROUTE gating');
    } else {
      log('V1.3', 'HustlerEnRouteMapScreen', 'PARTIAL', `Screen exists but missing: ${!hasMapView ? 'MapView ' : ''}${!hasLocation ? 'Location ' : ''}${!hasEnRouteGate ? 'EN_ROUTE gate' : ''}`);
    }
  } else {
    log('V1.3', 'HustlerEnRouteMapScreen', 'FAIL', 'HustlerEnRouteMapScreen.tsx not found');
  }

  // Check TaskInProgressScreen has map integration
  const taskInProgressPath = path.join(process.cwd(), 'hustlexp-app', 'screens', 'hustler', 'TaskInProgressScreen.tsx');
  if (fs.existsSync(taskInProgressPath)) {
    const content = fs.readFileSync(taskInProgressPath, 'utf-8');
    const hasMapIntegration = content.includes('MapView') || content.includes('react-native-maps');
    const hasEnRouteConditional = content.includes('EN_ROUTE') && content.includes('status');

    if (hasMapIntegration && hasEnRouteConditional) {
      log('V1.3', 'TaskInProgressScreen Map Integration', 'PASS', 'Map embedded with EN_ROUTE conditional');
    } else if (hasMapIntegration) {
      log('V1.3', 'TaskInProgressScreen Map Integration', 'PARTIAL', 'Map present but may not be properly gated');
    } else {
      log('V1.3', 'TaskInProgressScreen Map Integration', 'FAIL', 'Map not integrated in TaskInProgressScreen');
    }
  } else {
    log('V1.3', 'TaskInProgressScreen Map Integration', 'FAIL', 'TaskInProgressScreen.tsx not found');
  }

  // Check HustlerOnWayScreen has map integration
  const hustlerOnWayPath = path.join(process.cwd(), 'hustlexp-app', 'screens', 'poster', 'HustlerOnWayScreen.tsx');
  if (fs.existsSync(hustlerOnWayPath)) {
    const content = fs.readFileSync(hustlerOnWayPath, 'utf-8');
    const hasMapIntegration = content.includes('MapView') || content.includes('react-native-maps');

    if (hasMapIntegration) {
      log('V1.3', 'HustlerOnWayScreen Map Integration', 'PASS', 'Map embedded for poster tracking');
    } else {
      log('V1.3', 'HustlerOnWayScreen Map Integration', 'FAIL', 'Map not integrated in HustlerOnWayScreen');
    }
  } else {
    log('V1.3', 'HustlerOnWayScreen Map Integration', 'FAIL', 'HustlerOnWayScreen.tsx not found');
  }

  // Check navigation guards for map access
  const guardsPath = path.join(process.cwd(), 'hustlexp-app', 'navigation', 'guards.ts');
  if (fs.existsSync(guardsPath)) {
    const content = fs.readFileSync(guardsPath, 'utf-8');
    const hasMapGuard = content.includes('canAccessMap');

    if (hasMapGuard) {
      log('V1.3', 'Navigation Guards (canAccessMap)', 'PASS', 'canAccessMap guard implemented');
    } else {
      log('V1.3', 'Navigation Guards (canAccessMap)', 'FAIL', 'canAccessMap guard not found');
    }
  } else {
    log('V1.3', 'Navigation Guards', 'FAIL', 'guards.ts not found');
  }
}

// ============================================================================
// Main Execution
// ============================================================================

async function main() {
  console.log('╔════════════════════════════════════════════════════════════════════╗');
  console.log('║   Phase V1 Product Validation - Completion Verification           ║');
  console.log('╚════════════════════════════════════════════════════════════════════╝');

  try {
    await validateV1_1();
    await validateV1_2();
    await validateV1_3();
  } catch (error: any) {
    console.error('\n❌ Validation error:', error.message);
    process.exit(1);
  }

  // Summary
  console.log('\n========================================');
  console.log('SUMMARY');
  console.log('========================================\n');

  const summary = {
    PASS: results.filter(r => r.status === 'PASS').length,
    FAIL: results.filter(r => r.status === 'FAIL').length,
    PARTIAL: results.filter(r => r.status === 'PARTIAL').length,
    NOT_FOUND: results.filter(r => r.status === 'NOT_FOUND').length,
  };

  console.log(`✅ PASS: ${summary.PASS}`);
  console.log(`❌ FAIL: ${summary.FAIL}`);
  console.log(`⚠️  PARTIAL: ${summary.PARTIAL}`);
  console.log(`🔍 NOT_FOUND: ${summary.NOT_FOUND}`);
  console.log(`\nTotal checks: ${results.length}`);

  const successRate = (summary.PASS / results.length * 100).toFixed(1);
  console.log(`\nSuccess rate: ${successRate}%`);

  // Phase-by-phase breakdown
  console.log('\n========================================');
  console.log('PHASE BREAKDOWN');
  console.log('========================================\n');

  for (const phase of ['V1.1', 'V1.2', 'V1.3']) {
    const phaseResults = results.filter(r => r.phase === phase);
    const phasePasses = phaseResults.filter(r => r.status === 'PASS').length;
    const phaseRate = (phasePasses / phaseResults.length * 100).toFixed(1);
    
    const phaseIcon = phaseRate === '100.0' ? '✅' : parseFloat(phaseRate) >= 80 ? '⚠️' : '❌';
    console.log(`${phaseIcon} ${phase}: ${phasePasses}/${phaseResults.length} checks passed (${phaseRate}%)`);
  }

  // Critical issues
  const criticalFails = results.filter(r => r.status === 'FAIL' && (
    r.item.includes('table') ||
    r.item.includes('Migration') ||
    r.item.includes('dependency')
  ));

  if (criticalFails.length > 0) {
    console.log('\n========================================');
    console.log('CRITICAL ISSUES');
    console.log('========================================\n');
    
    for (const fail of criticalFails) {
      console.log(`❌ [${fail.phase}] ${fail.item}`);
      console.log(`   ${fail.details}\n`);
    }
  }

  process.exit(summary.FAIL > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
