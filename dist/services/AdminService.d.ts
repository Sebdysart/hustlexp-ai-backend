export type AdminOverrideAction = 'force_refund' | 'force_payout' | 'force_cancel';
export interface AdminOverrideInput {
    adminId: string;
    taskId: string;
    action: AdminOverrideAction;
    reason: string;
}
export declare class AdminServiceClass {
    /**
     * D12: Admin Override API
     * The "Panic Lever" for Seattle Beta.
     */
    overrideTaskState(input: AdminOverrideInput): Promise<{
        success: boolean;
        message: string;
    }>;
}
export declare const AdminService: AdminServiceClass;
//# sourceMappingURL=AdminService.d.ts.map