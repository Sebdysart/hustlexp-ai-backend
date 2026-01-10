import { sql } from '../db/index.js';
import { serviceLogger } from '../utils/logger.js';
export class IdentityEventBus {
    /**
     * Dispatch an identity event to internal handlers
     * Replaces the old webhook system
     */
    static async emit(event) {
        serviceLogger.info({
            type: event.type,
            userId: event.userId
        }, 'Identity Event Emitted');
        try {
            await this.persistEvent(event);
            await this.handleEvent(event);
        }
        catch (error) {
            serviceLogger.error({ error, event }, 'Failed to handle identity event');
            throw error;
        }
    }
    static async persistEvent(event) {
        if (!sql)
            return;
        await sql `
            INSERT INTO identity_events (
                user_id, 
                event_type, 
                channel, 
                metadata
            ) VALUES (
                ${event.userId}::uuid,
                ${event.type},
                'internal_bus',
                ${JSON.stringify(event.data || {})}
            )
        `;
    }
    static async handleEvent(event) {
        if (!sql)
            return;
        switch (event.type) {
            case 'email.verified':
                await sql `
                    UPDATE users 
                    SET email_verified = true,
                        updated_at = NOW()
                    WHERE id = ${event.userId}::uuid OR firebase_uid = ${event.userId}
                `;
                break;
            case 'phone.verified':
                await sql `
                    UPDATE users 
                    SET phone_verified = true,
                        updated_at = NOW()
                    WHERE id = ${event.userId}::uuid OR firebase_uid = ${event.userId}
                `;
                break;
            case 'identity.fully_verified':
                // The "Golden" Upgrade
                await sql `
                    UPDATE users 
                    SET verification_status = 'verified',
                        onboarding_unlocked = true,
                        trust_score = GREATEST(COALESCE(trust_score, 0), 85), 
                        updated_at = NOW()
                    WHERE id = ${event.userId}::uuid OR firebase_uid = ${event.userId}
                `;
                serviceLogger.info({ userId: event.userId }, 'User Fully Verified - Onboarding Unlocked');
                break;
        }
    }
}
//# sourceMappingURL=IdentityEventBus.js.map