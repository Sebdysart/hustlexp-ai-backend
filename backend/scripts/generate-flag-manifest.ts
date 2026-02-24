/**
 * Feature Flag Manifest Generator v1.0.0
 *
 * Generates JSON manifest of all feature flags for iOS validation.
 * Ensures iOS code only references flags that exist in the backend.
 *
 * @see backend/src/services/FeatureFlagService.ts
 * @see .github/workflows/holodeck.yml (dispatches manifest to iOS)
 */

import fs from 'fs';
import path from 'path';

// Known feature flags (expand as new flags are added)
export const FEATURE_FLAGS = {
  // Core features
  'live-mode': {
    name: 'live-mode',
    description: 'Real-time task discovery and instant matching',
    defaultEnabled: false,
    rolloutPercentage: 0,
  },
  'ai-matchmaking': {
    name: 'ai-matchmaking',
    description: 'AI-powered task-worker matchmaking',
    defaultEnabled: true,
    rolloutPercentage: 100,
  },
  'task-batching': {
    name: 'task-batching',
    description: 'Route optimization for multi-task batches',
    defaultEnabled: true,
    rolloutPercentage: 100,
  },
  'geofence-smart-start': {
    name: 'geofence-smart-start',
    description: 'Automatic task start when entering geofence',
    defaultEnabled: true,
    rolloutPercentage: 100,
  },

  // Advanced features
  'squads-mode': {
    name: 'squads-mode',
    description: 'Multi-worker collaborative tasks',
    defaultEnabled: false,
    rolloutPercentage: 0,
  },
  'professional-licensing': {
    name: 'professional-licensing',
    description: 'Locked quests requiring verified licenses',
    defaultEnabled: true,
    rolloutPercentage: 100,
  },
  'biometric-verification': {
    name: 'biometric-verification',
    description: 'Face verification for high-value tasks',
    defaultEnabled: true,
    rolloutPercentage: 100,
  },
  'jury-disputes': {
    name: 'jury-disputes',
    description: 'Community jury for dispute resolution',
    defaultEnabled: false,
    rolloutPercentage: 0,
  },

  // AI features
  'ai-scoper': {
    name: 'ai-scoper',
    description: 'AI task pricing and scope validation',
    defaultEnabled: true,
    rolloutPercentage: 100,
  },
  'ai-dispute-resolution': {
    name: 'ai-dispute-resolution',
    description: 'AI-assisted dispute mediation',
    defaultEnabled: false,
    rolloutPercentage: 0,
  },

  // System features
  'greptile-reviews': {
    name: 'greptile-reviews',
    description: 'Codebase-aware AI PR reviews',
    defaultEnabled: true,
    rolloutPercentage: 100,
  },
  'incident-intelligence': {
    name: 'incident-intelligence',
    description: 'Automated anomaly detection and diagnosis',
    defaultEnabled: false,
    rolloutPercentage: 0,
  },
};

interface FlagManifest {
  version: string;
  generatedAt: string;
  totalFlags: number;
  flags: Array<{
    name: string;
    description: string;
    defaultEnabled: boolean;
    rolloutPercentage: number;
  }>;
}

/**
 * Generate flag manifest
 */
export function generateFlagManifest(): FlagManifest {
  const flags = Object.values(FEATURE_FLAGS);

  return {
    version: '1.0.0',
    generatedAt: new Date().toISOString(),
    totalFlags: flags.length,
    flags: flags.map(flag => ({
      name: flag.name,
      description: flag.description,
      defaultEnabled: flag.defaultEnabled,
      rolloutPercentage: flag.rolloutPercentage,
    })),
  };
}

/**
 * CLI entry point
 */
if (require.main === module) {
  const manifest = generateFlagManifest();

  console.log('===== FEATURE FLAG MANIFEST =====\n');
  console.log(`Total Flags: ${manifest.totalFlags}\n`);

  // Group by status
  const enabled = manifest.flags.filter(f => f.defaultEnabled);
  const disabled = manifest.flags.filter(f => !f.defaultEnabled);

  console.log(`✅ Enabled (${enabled.length}):`);
  enabled.forEach(f => {
    console.log(`  ${f.name.padEnd(30)} ${f.rolloutPercentage}% rollout`);
    console.log(`     ${f.description}`);
  });
  console.log();

  console.log(`⏸️  Disabled (${disabled.length}):`);
  disabled.forEach(f => {
    console.log(`  ${f.name.padEnd(30)} ${f.rolloutPercentage}% rollout`);
    console.log(`     ${f.description}`);
  });
  console.log();

  // Write JSON manifest
  const outputPath = path.join(process.cwd(), 'flag-manifest.json');
  fs.writeFileSync(outputPath, JSON.stringify(manifest, null, 2));
  console.log(`Manifest saved to: ${outputPath}`);

  // Output for GitHub Actions
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(
      process.env.GITHUB_OUTPUT,
      `flag_manifest_path=${outputPath}\n` +
      `total_flags=${manifest.totalFlags}\n`
    );
  }
}
