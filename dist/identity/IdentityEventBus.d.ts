export interface IdentityEvent {
    type: 'email.verified' | 'phone.verified' | 'identity.fully_verified';
    userId: string;
    timestamp: string;
    data?: any;
}
export declare class IdentityEventBus {
    /**
     * Dispatch an identity event to internal handlers
     * Replaces the old webhook system
     */
    static emit(event: IdentityEvent): Promise<void>;
    private static persistEvent;
    private static handleEvent;
}
//# sourceMappingURL=IdentityEventBus.d.ts.map