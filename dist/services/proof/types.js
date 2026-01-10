/**
 * PROOF ENGINE — TYPES & ENUMS
 *
 * Core type definitions for the proof system.
 * Proofs are append-only and immutable once locked.
 */
export var ProofState;
(function (ProofState) {
    ProofState["NONE"] = "none";
    ProofState["REQUESTED"] = "requested";
    ProofState["SUBMITTED"] = "submitted";
    ProofState["ANALYZING"] = "analyzing";
    ProofState["VERIFIED"] = "verified";
    ProofState["REJECTED"] = "rejected";
    ProofState["ESCALATED"] = "escalated";
    ProofState["LOCKED"] = "locked";
})(ProofState || (ProofState = {}));
export var ProofType;
(function (ProofType) {
    ProofType["PHOTO"] = "photo";
    ProofType["SCREENSHOT"] = "screenshot";
    ProofType["VIDEO"] = "video";
})(ProofType || (ProofType = {}));
export var ProofReason;
(function (ProofReason) {
    ProofReason["TASK_COMPLETION"] = "task_completion";
    ProofReason["LOCATION_CONFIRMATION"] = "location_confirmation";
    ProofReason["DAMAGE_EVIDENCE"] = "damage_evidence";
    ProofReason["SCREEN_STATE"] = "screen_state";
    ProofReason["BEFORE_AFTER"] = "before_after";
    ProofReason["IDENTITY_VERIFICATION"] = "identity_verification";
})(ProofReason || (ProofReason = {}));
export var ProofEventType;
(function (ProofEventType) {
    ProofEventType["REQUEST_CREATED"] = "request_created";
    ProofEventType["REQUEST_EXPIRED"] = "request_expired";
    ProofEventType["SUBMISSION_RECEIVED"] = "submission_received";
    ProofEventType["ANALYSIS_STARTED"] = "analysis_started";
    ProofEventType["ANALYSIS_COMPLETED"] = "analysis_completed";
    ProofEventType["VERIFIED"] = "verified";
    ProofEventType["REJECTED"] = "rejected";
    ProofEventType["ESCALATED"] = "escalated";
    ProofEventType["LOCKED"] = "locked";
    ProofEventType["ADMIN_OVERRIDE"] = "admin_override";
})(ProofEventType || (ProofEventType = {}));
// State transition rules
export const PROOF_TRANSITIONS = {
    [ProofState.NONE]: [ProofState.REQUESTED],
    [ProofState.REQUESTED]: [ProofState.SUBMITTED, ProofState.NONE], // can expire
    [ProofState.SUBMITTED]: [ProofState.ANALYZING],
    [ProofState.ANALYZING]: [ProofState.VERIFIED, ProofState.REJECTED, ProofState.ESCALATED],
    [ProofState.VERIFIED]: [ProofState.LOCKED],
    [ProofState.REJECTED]: [ProofState.REQUESTED], // can re-request
    [ProofState.ESCALATED]: [ProofState.VERIFIED, ProofState.REJECTED], // admin decides
    [ProofState.LOCKED]: [] // terminal
};
export function canTransition(from, to) {
    return PROOF_TRANSITIONS[from]?.includes(to) ?? false;
}
//# sourceMappingURL=types.js.map