import { createHash, randomUUID } from 'node:crypto';
import {
  deleteFile,
  downloadFile,
  uploadFile,
  verifyFile,
} from '../backend/src/storage/r2.js';

const MAX_PROBE_BYTES = 4096;

async function main(): Promise<void> {
  const probeId = randomUUID();
  const key = `probes/hxos/${probeId}.txt`;
  const payload = Buffer.from(`HustleXP object-storage probe ${probeId}`, 'utf8');
  const expectedSha256 = createHash('sha256').update(payload).digest('hex');
  let deleted = false;

  try {
    const uploaded = await uploadFile(key, payload, 'text/plain', { probe: 'hxos-production' });
    const verified = await verifyFile(key);
    const downloaded = await downloadFile(key, MAX_PROBE_BYTES);
    const downloadedSha256 = createHash('sha256').update(downloaded.data).digest('hex');
    if (
      uploaded.sha256 !== expectedSha256 ||
      verified.exists !== true ||
      verified.sha256 !== expectedSha256 ||
      downloadedSha256 !== expectedSha256 ||
      !downloaded.data.equals(payload)
    ) {
      throw new Error('Object storage probe failed integrity verification.');
    }
    await deleteFile(key);
    deleted = true;
    const absent = await verifyFile(key);
    if (absent.exists) throw new Error('Object storage probe cleanup could not be verified.');
    console.log(
      JSON.stringify({
        provider: 's3-compatible-object-storage',
        probe_id: probeId,
        bytes: payload.length,
        sha256: expectedSha256,
        upload: true,
        metadata_verify: true,
        bounded_readback: true,
        checksum_match: true,
        delete: true,
        post_delete_absent: true,
        tested_at: new Date().toISOString(),
      }),
    );
  } finally {
    if (!deleted) {
      try {
        await deleteFile(key);
      } catch {
        // Preserve the primary failure. The random key is emitted only on success.
      }
    }
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Object storage probe failed.');
  process.exitCode = 1;
});
