/**
 * HustleXP Configuration - Root Export
 * 
 * Re-exports configuration from backend/src/config.ts for consistency.
 * This ensures all services use the same configuration values.
 * 
 * @see backend/src/config.ts for full configuration
 */

// Re-export from backend config
export { config, validateConfig } from '../backend/src/config.js';

// Also export as default for compatibility
export { config as default, validateConfig as defaultValidateConfig } from '../backend/src/config.js';
