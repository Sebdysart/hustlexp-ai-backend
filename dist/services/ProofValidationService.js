/**
 * Proof Validation Service - Phase B
 * TEMPORARILY DISABLED FOR MIGRATION
 * ref: Gate-1 Refund Architecture Hardening
 */
// ============================================
// Service Class (STUBBED)
// ============================================
class ProofValidationServiceClass {
    // Seattle Bounding Box (Rough Match for Beta)
    // North: 47.734, South: 47.495, West: -122.435, East: -122.235
    SEATTLE_BOUNDS = {
        north: 47.734,
        south: 47.495,
        west: -122.435,
        east: -122.235
    };
    isWithinSeattle(lat, lng) {
        return (lat >= this.SEATTLE_BOUNDS.south &&
            lat <= this.SEATTLE_BOUNDS.north &&
            lng >= this.SEATTLE_BOUNDS.west &&
            lng <= this.SEATTLE_BOUNDS.east);
    }
    getNeighborhood(lat, lng) {
        // Simple grid-based neighborhood approximation for Beta
        if (lat > 47.65)
            return 'North Seattle';
        if (lat < 47.55)
            return 'South Seattle';
        if (lng < -122.35)
            return 'West Seattle/Ballard';
        if (lng > -122.30)
            return 'Capitol Hill/Central';
        return 'Downtown/Belltown';
    }
    validateGPS(gps) {
        if (!gps || !gps.latitude || !gps.longitude) {
            return { valid: false, neighborhood: 'Unknown', reason: 'Missing GPS data' };
        }
        const inCity = this.isWithinSeattle(gps.latitude, gps.longitude);
        const neighborhood = this.getNeighborhood(gps.latitude, gps.longitude);
        if (!inCity) {
            return {
                valid: false,
                neighborhood,
                reason: `Location (${gps.latitude.toFixed(4)}, ${gps.longitude.toFixed(4)}) is outside Seattle Beta zone.`
            };
        }
        return { valid: true, neighborhood };
    }
    async uploadPhoto(photoData, taskId, hustlerId, photoType) {
        return { url: 'https://stubbed.url/photo.jpg', hash: 'stubhash', sizeBytes: 100 };
    }
    startSession(taskId, hustlerId, category) {
        return {
            sessionId: 'stub_session',
            taskId,
            hustlerId,
            category,
            proofs: [],
            attemptCount: 0,
            maxAttempts: 3,
            requiredProofTypes: [],
            completedTypes: [],
            status: 'active',
            createdAt: new Date()
        };
    }
    getOrCreateSession(taskId, hustlerId, category) {
        return this.startSession(taskId, hustlerId, category);
    }
    getSession(sessionId) { return undefined; }
    getSessionByTask(taskId) {
        // Return undefined to mimic "not found" or stubbed active session?
        // User asked to neutralize calls. Returning undefined is safest to avoid downstream logic trying to use it.
        return undefined;
    }
    async submitProof(submission) {
        return {
            success: false,
            error: 'Proof submission disabled during migration',
            verificationStatus: 'failed'
        };
    }
    canApprove(taskId) {
        return { canApprove: false, reason: 'Disabled' };
    }
    async approveTask(taskId, posterId, options) {
        return { success: false, message: 'Approval disabled via ProofService', error: 'DISABLED' };
    }
    async rejectTask(taskId, posterId, reason, action = 'dispute') {
        return { success: false, message: 'Rejection disabled via ProofService', error: 'DISABLED' };
    }
    getProofsForTask(taskId) { return []; }
    getHustlerProofs(hustlerId, limit = 50) { return []; }
    getTaskVerificationStatus(taskId) {
        return {
            hasProofs: false,
            proofCount: 0,
            gpsVerified: false,
            status: 'no_proofs',
            requiredTypes: [],
            completedTypes: []
        };
    }
    logModerationAction(action) { }
    getModerationLogs(taskId) { return []; }
}
export const ProofValidationService = new ProofValidationServiceClass();
//# sourceMappingURL=ProofValidationService.js.map