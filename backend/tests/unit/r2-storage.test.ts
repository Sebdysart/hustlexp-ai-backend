import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock config before imports
vi.mock('../../src/config', () => ({
  config: {
    cloudflare: {
      r2: {
        accountId: 'test-account-id',
        endpoint: 'https://test-account-id.r2.cloudflarestorage.com',
        accessKeyId: 'test-access-key',
        secretAccessKey: 'test-secret-key',
        bucketName: 'test-bucket',
        region: 'auto',
      },
    },
  },
}));

// Shared mock send function — must be created with vi.hoisted so it's available inside vi.mock factories
const { mockSend } = vi.hoisted(() => ({
  mockSend: vi.fn(),
}));

// Mock AWS SDK
vi.mock('@aws-sdk/client-s3', () => {
  return {
    S3Client: class MockS3Client {
      send = mockSend;
    },
    PutObjectCommand: class MockPutObjectCommand {
      _type = 'PutObject';
      input: unknown;
      constructor(input: unknown) { this.input = input; }
    },
    GetObjectCommand: class MockGetObjectCommand {
      _type = 'GetObject';
      input: unknown;
      constructor(input: unknown) { this.input = input; }
    },
    HeadObjectCommand: class MockHeadObjectCommand {
      _type = 'HeadObject';
      input: unknown;
      constructor(input: unknown) { this.input = input; }
    },
  };
});

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: vi.fn().mockResolvedValue('https://signed-url.example.com/test'),
}));

import {
  generateTaskProofKey,
  generateExportKey,
  uploadFile,
  getSignedUrlForObject,
  verifyFile,
} from '../../src/storage/r2';

describe('R2 Storage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ===========================================================================
  // generateTaskProofKey
  // ===========================================================================
  describe('generateTaskProofKey', () => {
    it('generates correct key format', () => {
      const key = generateTaskProofKey('task-123', 1700000000000);
      expect(key).toBe('tasks/task-123/proof_1700000000000.jpg');
    });

    it('handles different task IDs', () => {
      const key = generateTaskProofKey('abc-def-ghi', 999);
      expect(key).toBe('tasks/abc-def-ghi/proof_999.jpg');
    });

    it('uses jpg extension', () => {
      const key = generateTaskProofKey('any', 0);
      expect(key).toMatch(/\.jpg$/);
    });
  });

  // ===========================================================================
  // generateExportKey
  // ===========================================================================
  describe('generateExportKey', () => {
    it('generates correct key format', () => {
      const key = generateExportKey(
        'user-1',
        'export-1',
        'json',
        new Date('2026-03-10T12:00:00Z'),
      );
      expect(key).toBe('exports/user-1/export-1/2026-03-10/export_export-1.json');
    });

    it('uses createdAt date for deterministic keys', () => {
      const date = new Date('2025-12-25T00:00:00Z');
      const key = generateExportKey('u1', 'e1', 'csv', date);
      expect(key).toContain('2025-12-25');
    });

    it('supports different formats', () => {
      const date = new Date('2026-01-01T00:00:00Z');
      expect(generateExportKey('u', 'e', 'zip', date)).toMatch(/\.zip$/);
      expect(generateExportKey('u', 'e', 'csv', date)).toMatch(/\.csv$/);
      expect(generateExportKey('u', 'e', 'json', date)).toMatch(/\.json$/);
    });
  });

  // ===========================================================================
  // uploadFile
  // ===========================================================================
  describe('uploadFile', () => {
    it('uploads file and returns result', async () => {
      mockSend.mockResolvedValueOnce({});

      const data = Buffer.from('hello world');
      const result = await uploadFile('test/key.txt', data, 'text/plain');

      expect(result.key).toBe('test/key.txt');
      expect(result.size).toBe(data.length);
      expect(result.contentType).toBe('text/plain');
      expect(result.sha256).toBeDefined();
      expect(typeof result.sha256).toBe('string');
      expect(result.sha256.length).toBe(64); // SHA256 hex = 64 chars
    });

    it('defaults contentType to application/octet-stream', async () => {
      mockSend.mockResolvedValueOnce({});

      const data = Buffer.from('binary data');
      const result = await uploadFile('test/binary', data);

      expect(result.contentType).toBe('application/octet-stream');
    });

    it('calculates consistent SHA256 hash', async () => {
      mockSend.mockResolvedValue({});

      const data = Buffer.from('consistent content');
      const result1 = await uploadFile('key1', data);
      const result2 = await uploadFile('key2', data);

      expect(result1.sha256).toBe(result2.sha256);
    });

    it('calls S3Client.send with PutObjectCommand', async () => {
      mockSend.mockResolvedValueOnce({});

      await uploadFile('my/key', Buffer.from('data'), 'image/jpeg');

      expect(mockSend).toHaveBeenCalledTimes(1);
      const call = mockSend.mock.calls[0][0];
      expect(call._type).toBe('PutObject');
    });

    it('propagates S3 errors', async () => {
      mockSend.mockRejectedValueOnce(new Error('Upload failed'));

      await expect(uploadFile('key', Buffer.from('x'))).rejects.toThrow('Upload failed');
    });
  });

  // ===========================================================================
  // getSignedUrlForObject
  // ===========================================================================
  describe('getSignedUrlForObject', () => {
    it('returns signed URL when object exists', async () => {
      // HeadObject succeeds
      mockSend.mockResolvedValueOnce({});

      const url = await getSignedUrlForObject('existing/key');
      expect(url).toBe('https://signed-url.example.com/test');
    });

    it('throws when object does not exist', async () => {
      mockSend.mockRejectedValueOnce(new Error('NotFound'));

      await expect(getSignedUrlForObject('missing/key')).rejects.toThrow(
        'R2 object not found: missing/key',
      );
    });

    it('calls HeadObject first to verify existence', async () => {
      mockSend.mockResolvedValueOnce({});

      await getSignedUrlForObject('test/key');

      expect(mockSend).toHaveBeenCalledTimes(1);
      const call = mockSend.mock.calls[0][0];
      expect(call._type).toBe('HeadObject');
    });
  });

  // ===========================================================================
  // verifyFile
  // ===========================================================================
  describe('verifyFile', () => {
    it('returns file metadata when file exists', async () => {
      mockSend.mockResolvedValueOnce({
        ContentLength: 12345,
        ContentType: 'application/json',
        Metadata: { sha256: 'abc123' },
        LastModified: new Date('2026-01-01'),
      });

      const result = await verifyFile('existing/key');

      expect(result.exists).toBe(true);
      expect(result.size).toBe(12345);
      expect(result.contentType).toBe('application/json');
      expect(result.sha256).toBe('abc123');
      expect(result.lastModified).toEqual(new Date('2026-01-01'));
    });

    it('returns exists: false when file not found', async () => {
      mockSend.mockRejectedValueOnce(new Error('NotFound'));

      const result = await verifyFile('missing/key');

      expect(result.exists).toBe(false);
      expect(result.size).toBeUndefined();
      expect(result.contentType).toBeUndefined();
    });

    it('handles file with no metadata', async () => {
      mockSend.mockResolvedValueOnce({
        ContentLength: 100,
        ContentType: 'text/plain',
        Metadata: {},
      });

      const result = await verifyFile('key');

      expect(result.exists).toBe(true);
      expect(result.sha256).toBeUndefined();
    });
  });
});
