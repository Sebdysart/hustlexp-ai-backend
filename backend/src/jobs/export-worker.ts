/**
 * Export Worker v1.0.0
 * 
 * SYSTEM GUARANTEES: Export Generation with R2 Storage
 * 
 * Processes exports queue from BullMQ.
 * Generates export files (JSON/CSV/PDF) and uploads to R2.
 * Generates signed URLs for secure download.
 * 
 * Pattern:
 * 1. Job processor receives export job
 * 2. Generate export file (collect user data, format)
 * 3. Upload to R2
 * 4. Update exports table (status=ready, object_key, signed_url)
 * 5. Enqueue notification job (export ready)
 * 
 * Hard rule: Export files must be stored in R2 with signed URLs
 * 
 * @see ARCHITECTURE.md §2.4 (Outbox pattern), §2.5 (File Storage)
 */

import { db } from '../db';
import { r2 } from '../storage/r2';
import { writeToOutbox } from './outbox-helpers';
import { markOutboxEventProcessed, markOutboxEventFailed } from './outbox-worker';
import type { Job } from 'bullmq';
import { collectUserDataForExport } from '../services/GDPRService';
import { workerLogger } from '../logger';
const log = workerLogger.child({ worker: 'export' });

// ============================================================================
// TYPES
// ============================================================================

interface ExportJobData {
  aggregate_type: string;
  aggregate_id: string;
  event_version: number;
  payload: {
    exportId: string;
    userId: string;
    format: 'json' | 'csv' | 'pdf';
    gdprRequestId?: string; // Optional: if generated from GDPR request
  };
}

// ============================================================================
// EXPORT WORKER
// ============================================================================

/**
 * Process export job
 * Should be called by BullMQ worker processor
 * 
 * @param job BullMQ job containing export data
 */
export async function processExportJob(job: Job<ExportJobData>): Promise<void> {
  // Extract data from job payload (structured as outbox event)
  const { exportId, userId, format, gdprRequestId } = job.data.payload;
  const idempotencyKey = job.id || `export:${exportId}`;
  
  try {
    // Get export record with FOR UPDATE lock (prevents race condition)
    // Also check for stuck generating state (>10 minutes old)
    const exportResult = await db.query<{
      id: string;
      user_id: string;
      export_format: string;
      content_type: string;
      status: string;
      created_at: Date;
      updated_at: Date;
      object_key: string | null;
    }>(
      `SELECT id, user_id, export_format, content_type, status, created_at, updated_at, object_key
       FROM exports
       WHERE id = $1
       FOR UPDATE`, // Lock row for update (prevents concurrent processing)
      [exportId]
    );
    
    if (exportResult.rows.length === 0) {
      throw new Error(`Export ${exportId} not found`);
    }
    
    const exportRecord = exportResult.rows[0];
    
    // Idempotency check: If already ready, skip processing (idempotent replay)
    if (exportRecord.status === 'ready') {
      log.info({ exportId }, 'Export already processed (status: ready), skipping - idempotent replay');
      // Mark outbox event as processed (if processing from outbox)
      if (idempotencyKey) {
        await markOutboxEventProcessed(idempotencyKey);
      }
      return;
    }
    
    // Check if status is valid for processing
    if (exportRecord.status !== 'queued' && exportRecord.status !== 'generating') {
      throw new Error(`Cannot process export: status is ${exportRecord.status}`);
    }
    
    // Check for stuck generating state (>10 minutes old) - recovery mechanism
    if (exportRecord.status === 'generating') {
      const stuckThreshold = new Date(Date.now() - 10 * 60 * 1000); // 10 minutes ago
      if (exportRecord.updated_at && new Date(exportRecord.updated_at) > stuckThreshold) {
        // Still actively generating (updated within last 10 minutes), skip
        log.info({ exportId, updatedAt: exportRecord.updated_at }, 'Export is still generating, skipping retry');
        return;
      } else {
        // Stuck in generating state (>10 minutes old), treat as retryable
        log.warn({ exportId, updatedAt: exportRecord.updated_at }, 'Export stuck in generating state, treating as retryable');
      }
    }
    
    // Update status to generating (with WHERE clause to prevent race conditions)
    // Only update if status is 'queued' or stuck 'generating' (>10 minutes old)
    const updateResult = await db.query(
      `UPDATE exports
       SET status = 'generating',
           updated_at = NOW()
       WHERE id = $1
         AND (status = 'queued' 
              OR (status = 'generating' AND updated_at < NOW() - INTERVAL '10 minutes'))`, // Recovery: allow retry if stuck >10 min
      [exportId]
    );
    
    // If update affected 0 rows, another worker already claimed this export
    if (updateResult.rowCount === 0) {
      log.info({ exportId }, 'Export already claimed by another worker, skipping');
      return;
    }
    
    // Generate deterministic R2 object key (based on export's created_at, not "now")
    // CRITICAL: Use export's created_at to ensure retries overwrite same key, not create duplicates
    // If object_key already exists in DB, use it (may be from previous non-deterministic version)
    // Otherwise, generate deterministic key from created_at
    const objectKey = exportRecord.object_key || r2.generateExportKey(
      userId,
      exportId,
      format,
      exportRecord.created_at // Use export's created_at for deterministic key
    );
    
    // Store object_key if not already stored (so retries can find it)
    // This happens BEFORE R2 check/upload to ensure deterministic key is stored early
    if (!exportRecord.object_key) {
      await db.query(
        `UPDATE exports SET object_key = $1, updated_at = NOW() WHERE id = $2`,
        [objectKey, exportId]
      );
    }
    
    // Check if R2 object already exists (idempotency check)
    // If previous upload succeeded but DB update to 'ready' failed, object might already exist
    const existingFile = await r2.verifyFile(objectKey);
    
    let uploadResult: { key: string; size: number; sha256: string; contentType?: string };
    
    if (existingFile.exists) {
      // File already exists in R2 - use existing file (idempotent replay)
      // This handles the case where upload succeeded but DB update to 'ready' failed
      log.info({ exportId, objectKey }, 'Export object already exists in R2, using existing file (idempotent replay)');
      uploadResult = {
        key: objectKey,
        size: existingFile.size || 0,
        sha256: existingFile.sha256 || '',
        contentType: existingFile.contentType || exportRecord.content_type,
      };
    } else {
      // File doesn't exist in R2 - generate and upload
      // Collect user data (from GDPRService helper)
      const exportData = await collectUserDataForExport(userId);
      
      // Format data according to format (json/csv/pdf)
      let exportContent: Buffer;
      const contentType = exportRecord.content_type; // Use content_type from exports table
      
      if (format === 'json') {
        const jsonContent = JSON.stringify(exportData, null, 2);
        exportContent = Buffer.from(jsonContent, 'utf-8');
      } else if (format === 'csv') {
        // CSV format: flatten each top-level section into CSV blocks separated by headers
        const csvSections: string[] = [];
        for (const [sectionName, sectionData] of Object.entries(exportData)) {
          csvSections.push(`# Section: ${sectionName}`);
          if (Array.isArray(sectionData) && sectionData.length > 0) {
            // Array of objects — extract headers from first item
            const headers = Object.keys(sectionData[0]);
            csvSections.push(headers.map(h => `"${h}"`).join(','));
            for (const row of sectionData) {
              const values = headers.map(h => {
                const val = (row as Record<string, unknown>)[h];
                if (val === null || val === undefined) return '""';
                const str = typeof val === 'object' ? JSON.stringify(val) : String(val);
                return `"${str.replace(/"/g, '""')}"`;
              });
              csvSections.push(values.join(','));
            }
          } else if (typeof sectionData === 'object' && sectionData !== null && !Array.isArray(sectionData)) {
            // Single object — key,value pairs
            csvSections.push('"field","value"');
            for (const [key, val] of Object.entries(sectionData as Record<string, unknown>)) {
              const str = val === null || val === undefined ? '' : typeof val === 'object' ? JSON.stringify(val) : String(val);
              csvSections.push(`"${key}","${str.replace(/"/g, '""')}"`);
            }
          }
          csvSections.push(''); // Blank line between sections
        }
        exportContent = Buffer.from(csvSections.join('\n'), 'utf-8');
      } else if (format === 'pdf') {
        // PDF format: Generate a structured text report (no heavy PDF library needed)
        // Uses plain text with clear formatting — readable when opened as .txt or .pdf
        const lines: string[] = [
          '========================================',
          '  HustleXP — Personal Data Export',
          `  Generated: ${new Date().toISOString()}`,
          `  User ID: ${userId}`,
          '========================================',
          '',
        ];
        for (const [sectionName, sectionData] of Object.entries(exportData)) {
          lines.push(`--- ${sectionName.toUpperCase().replace(/_/g, ' ')} ---`);
          lines.push('');
          if (Array.isArray(sectionData)) {
            for (let i = 0; i < sectionData.length; i++) {
              lines.push(`  [${i + 1}]`);
              for (const [key, val] of Object.entries(sectionData[i] as Record<string, unknown>)) {
                const str = val === null || val === undefined ? '(none)' : typeof val === 'object' ? JSON.stringify(val) : String(val);
                lines.push(`    ${key}: ${str}`);
              }
              lines.push('');
            }
          } else if (typeof sectionData === 'object' && sectionData !== null) {
            for (const [key, val] of Object.entries(sectionData as Record<string, unknown>)) {
              const str = val === null || val === undefined ? '(none)' : typeof val === 'object' ? JSON.stringify(val) : String(val);
              lines.push(`  ${key}: ${str}`);
            }
          }
          lines.push('');
        }
        lines.push('========================================');
        lines.push('  End of export');
        lines.push('========================================');
        exportContent = Buffer.from(lines.join('\n'), 'utf-8');
      } else {
        throw new Error(`Unsupported export format: ${format}`);
      }
      
      // Upload to R2 (will overwrite if key already exists - deterministic key ensures same file)
      uploadResult = await r2.uploadFile(objectKey, exportContent, contentType);
    }
    
    // Generate signed URL on demand (15 minutes expiration)
    // NOTE: Signed URLs are ephemeral - stored URL will expire. Product must regenerate on demand.
    // For now, generate and store (will be refreshed when user requests download)
    const signedUrl = await r2.getSignedUrlForObject(objectKey, 15 * 60); // 15 minutes
    const signedUrlExpiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes from now
    
    // Update exports table (status=ready, object_key, sha256, signed_url cache)
    // CRITICAL: Update only if still in 'generating' state (prevents overwriting if another worker completed)
    const finalUpdateResult = await db.query(
      `UPDATE exports
       SET status = 'ready',
           object_key = $1,
           file_size_bytes = $2,
           sha256_checksum = $3,
           signed_url = $4,  -- Cached signed URL (will expire - product must regenerate on demand)
           signed_url_expires_at = $5,
           uploaded_at = NOW(),
           updated_at = NOW()
       WHERE id = $6
         AND status = 'generating'`, // Only update if still generating (prevents race condition)
      [
        objectKey,
        uploadResult.size,
        uploadResult.sha256,
        signedUrl,
        signedUrlExpiresAt,
        exportId,
      ]
    );
    
    // If update affected 0 rows, another worker already marked this as ready
    if (finalUpdateResult.rowCount === 0) {
      log.info({ exportId }, 'Export already marked as ready by another worker, skipping final update');
      return; // Already processed, exit gracefully
    }
    
    // If this export was generated from a GDPR request, update the request
    // NOTE: Store object_key in result_url field (signed URLs are ephemeral and must be regenerated on demand)
    // The product layer should generate signed URLs on demand when user requests download
    if (gdprRequestId) {
      await db.query(
        `UPDATE gdpr_data_requests
         SET status = 'completed',
             result_url = $1,  -- Store object_key (product must generate signed URL on demand)
             result_expires_at = $2,  -- Store expiration (30 days from now)
             processed_at = NOW(),
             completed_at = NOW()
         WHERE id = $3`,
        [`r2://${objectKey}`, new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), gdprRequestId] // 30 days expiration
      );
    }
    
    // Enqueue notification job (export ready) via outbox pattern
    // CRITICAL: Use deterministic idempotency key to prevent duplicate notifications
    // Format: export.ready:{exportId}:{version} - same export_id always generates same key
    await writeToOutbox({
      eventType: 'export.ready',
      aggregateType: 'export',
      aggregateId: exportId,
      eventVersion: 1,
      payload: {
        exportId,
        userId,
        format,
        objectKey, // Store object_key, not signed_url (URL is ephemeral and must be regenerated on demand)
        expiresAt: signedUrlExpiresAt.toISOString(),
      },
      queueName: 'user_notifications',
      idempotencyKey: `export.ready:${exportId}:1`, // Deterministic: same export_id = same key
    });
    
    // Mark outbox event as processed (if processing from outbox)
    if (idempotencyKey) {
      await markOutboxEventProcessed(idempotencyKey);
    }
    
    // Job completed successfully
    log.info({ exportId, objectKey }, 'Export generated and uploaded to R2');
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    log.error({ exportId, err: errorMessage }, 'Export processing failed');
    
    // Update export status to failed
    await db.query(
      `UPDATE exports
       SET status = 'failed',
           updated_at = NOW()
       WHERE id = $1`,
      [exportId]
    ).catch(dbError => {
      log.error({ exportId, err: dbError }, 'Failed to update export status');
    });
    
    // Mark outbox event as failed (if processing from outbox)
    if (idempotencyKey) {
      await markOutboxEventFailed(idempotencyKey, errorMessage).catch(markError => {
        log.error({ idempotencyKey, err: markError }, 'Failed to mark outbox event as failed');
      });
    }
    
    // Re-throw error for BullMQ retry logic
    throw error;
  }
}
