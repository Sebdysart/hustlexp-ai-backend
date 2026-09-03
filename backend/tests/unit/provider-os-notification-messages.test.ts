import { describe, expect, it } from 'vitest';
import {
  buildProviderOsMessage,
  PROVIDER_OS_NOTIFICATION_EVENTS,
} from '../../src/services/ProviderOsNotificationService.js';

describe('ProviderOsNotificationService messages', () => {
  it('exposes the four Provider OS SMS event types', () => {
    expect(PROVIDER_OS_NOTIFICATION_EVENTS).toEqual([
      'CLIENT_ONBOARDED',
      'CLIENT_TASK_CREATED',
      'PROVIDER_QUOTE_APPROVED',
      'TASK_PAYMENT_CONFIRMED',
    ]);
  });

  it('builds concise display-safe SMS bodies', () => {
    expect(buildProviderOsMessage('CLIENT_ONBOARDED', {
      posterName: 'John Smith',
    })).toBe(
      'John Smith has successfully joined HustleXP through your Provider OS onboarding link.',
    );

    expect(buildProviderOsMessage('CLIENT_TASK_CREATED', {
      posterName: 'John Smith',
      taskTitle: 'Kitchen faucet repair',
    })).toBe(
      'John Smith posted a new task: "Kitchen faucet repair". Open Provider OS to review and quote it.',
    );

    expect(buildProviderOsMessage('PROVIDER_QUOTE_APPROVED', {
      posterName: 'John Smith',
      taskTitle: 'Kitchen faucet repair',
    })).toBe(
      'John Smith approved your quote for "Kitchen faucet repair".',
    );

    expect(buildProviderOsMessage('TASK_PAYMENT_CONFIRMED', {
      posterName: 'John Smith',
      taskTitle: 'Kitchen faucet repair',
    })).toBe(
      'Payment has been confirmed for "Kitchen faucet repair". The task is ready to proceed.',
    );
  });

  it('falls back safely when name/title are missing', () => {
    expect(buildProviderOsMessage('CLIENT_ONBOARDED', {
      posterName: '  ',
    })).toContain('Your client');

    expect(buildProviderOsMessage('CLIENT_TASK_CREATED', {
      posterName: 'Ada',
      taskTitle: null,
    })).toContain('"a new task"');
  });
});
