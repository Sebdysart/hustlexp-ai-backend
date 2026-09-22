import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SERVICE_CATEGORY_CODES } from '../../src/contracts/serviceCategories.js';
import { B, TASK_CATEGORIES } from '../../src/services/taskIntake/definitions.js';
import { validateTaskIntake } from '../../src/services/taskIntake/validateIntake.js';

const expected = ['yard', 'cleaning', 'moving', 'assembly', 'delivery', 'handyman', 'home_services', 'auto', 'events', 'pet_care', 'painting', 'plumbing', 'electrical', 'other'];
describe('canonical service category contract', () => {
  it('retains all intake categories and the existing question keys without classifier changes', () => {
    expect([...SERVICE_CATEGORY_CODES]).toEqual(expected);
    expect(TASK_CATEGORIES).toBe(SERVICE_CATEGORY_CODES);
    expect(Object.keys(B).sort()).toEqual([...expected].sort());
  });
  it('keeps other available to customer intake independently of business manual review', () => {
    expect(validateTaskIntake('other', {task_goal:'Organize the workshop',task_duration_estimate:'1_3_hours'}).readyForDraft).toBe(true);
  });
  it('seeds precisely the canonical registry and conservatively requires manual policy review', () => {
    const sql = readFileSync(resolve('backend/database/migrations/20261007_business_service_category_policy.sql'), 'utf8');
    for (const code of expected) expect(sql).toContain(`('${code}',`);
    expect(sql).toContain("'US-WA', 'MANUAL_REVIEW_REQUIRED'");
    expect(sql).not.toContain("'US-WA', 'UNRESTRICTED'");
    expect(sql).toContain('eligibility_reviewed_policy_id');
    expect(sql).toContain('selected_by_business');
  });
  const frontend = resolve('../hustlexp-frontend/src/features/serviceCategories.ts');
  it.skipIf(!existsSync(frontend))('keeps the two repository contracts aligned when both checkouts are available', () => {
    expect(readFileSync(frontend, 'utf8')).toBe(readFileSync(resolve('backend/src/contracts/serviceCategories.ts'), 'utf8'));
  });
});
