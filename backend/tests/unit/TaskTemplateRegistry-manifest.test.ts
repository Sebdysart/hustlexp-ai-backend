import { describe, it, expect } from 'vitest';
import {
  TaskTemplateRegistry,
  getManifest,
  TEMPLATE_SLUGS,
} from '../../../backend/src/services/TaskTemplateRegistry.js';

describe('TaskTemplateRegistry one_line_desc', () => {
  it('all 8 templates have one_line_desc', () => {
    for (const template of Object.values(TaskTemplateRegistry)) {
      expect(template.one_line_desc).toBeTruthy();
      expect(typeof template.one_line_desc).toBe('string');
      expect(template.one_line_desc.length).toBeGreaterThan(10);
    }
  });

  it('one_line_desc is human-readable (no underscores or slug-style)', () => {
    for (const template of Object.values(TaskTemplateRegistry)) {
      expect(template.one_line_desc).not.toMatch(/_/);
    }
  });
});

describe('getManifest()', () => {
  it('returns all 8 templates', () => {
    const manifest = getManifest();
    expect(manifest).toHaveLength(8);
  });

  it('each entry has slug, display_name, one_line_desc', () => {
    const manifest = getManifest();
    for (const entry of manifest) {
      expect(entry.slug).toBeTruthy();
      expect(entry.display_name).toBeTruthy();
      expect(entry.one_line_desc).toBeTruthy();
    }
  });

  it('includes wildcard_bizarre', () => {
    const manifest = getManifest();
    const wc = manifest.find(m => m.slug === TEMPLATE_SLUGS.WILDCARD_BIZARRE);
    expect(wc).toBeDefined();
    expect(wc?.display_name).toBe('Wildcard / Custom');
  });

  it('includes care template', () => {
    const manifest = getManifest();
    const care = manifest.find(m => m.slug === TEMPLATE_SLUGS.CARE);
    expect(care).toBeDefined();
    expect(care?.one_line_desc).toContain('care');
  });
});
