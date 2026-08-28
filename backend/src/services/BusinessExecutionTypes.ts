export interface BusinessProviderPreferenceSummary {
  id: string;
  locationId: string | null;
  locationName: string | null;
  serviceCategory: string;
  providerName: string;
  priority: 'PRIMARY' | 'BACKUP';
}

export interface BusinessWorkOrderSummary {
  taskId: string;
  locationName: string | null;
  title: string;
  category: string | null;
  taskState: string;
  progressState: string;
  workerName: string | null;
  customerTotalCents: number;
  escrowState: string;
  refundedCents: number;
  deadline: string | null;
  completedAt: string | null;
  completedOnTime: boolean | null;
  createdAt: string;
}

export interface BusinessProviderPerformanceSummary {
  providerName: string;
  category: string | null;
  assignedCount: number;
  completedCount: number;
  disputedCount: number;
  onTimeCount: number;
  cancelledCount: number;
}

export interface BusinessInvoiceSnapshotSummary {
  id: string;
  periodStart: string;
  periodEnd: string;
  transactionCount: number;
  customerTotalCents: number;
  refundedTotalCents: number;
  settledTotalCents: number;
  status: 'SNAPSHOT';
  createdAt: string;
}
