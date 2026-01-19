/**
 * TPEE AI Classifiers - Phase 2B Prompt Contracts
 *
 * RULES (CONSTITUTIONAL):
 * - AI NEVER overrides deterministic BLOCK
 * - AI can only escalate: ACCEPT → ADJUST → REVIEW
 * - All outputs are strict JSON with predefined enums
 * - Parse failure = REVIEW (not accept)
 * - UNCERTAIN = REVIEW (model abstention)
 */
export interface PricingClassifierInput {
    task_title: string;
    task_description: string;
    category: string;
    location_text: string | null;
    proposed_price: number;
    median_price: number;
    median_duration_minutes: number;
    median_source: 'PRE_AI' | 'POST_AI';
}
export interface PricingClassifierOutput {
    price_verdict: 'OK' | 'TOO_LOW' | 'TOO_HIGH' | 'UNCERTAIN';
    recommended_price: number | null;
    confidence: number;
}
export interface ScamClassifierInput {
    task_text: string;
    trust_score: number;
    prior_flags: string[];
}
export interface ScamClassifierOutput {
    risk_level: 'LOW' | 'MEDIUM' | 'HIGH';
    risk_reason: 'COERCION' | 'OFF_PLATFORM' | 'SOCIAL_ENGINEERING' | 'UNKNOWN';
    confidence: number;
}
export declare const PRICING_CLASSIFIER_SYSTEM = "You are a pricing analyst for HustleXP, a gig marketplace in Seattle.\n\nEvaluate whether a proposed task price is realistic given market data.\n\nYou will receive:\n- Task details (title, description, category, location)\n- Proposed price\n- Historical median price for similar tasks\n- Historical median duration\n\nYour job: Determine if the price is realistic for the work described.\n\nRETURN ONLY valid JSON in this exact format:\n{\n    \"price_verdict\": \"OK\" | \"TOO_LOW\" | \"TOO_HIGH\" | \"UNCERTAIN\",\n    \"recommended_price\": <number or null>,\n    \"confidence\": <0.0-1.0>\n}\n\nRULES:\n- \"OK\" = price is reasonable for the described work\n- \"TOO_LOW\" = price significantly undervalues the work (recommend higher)\n- \"TOO_HIGH\" = price overvalues the work (recommend lower)\n- \"UNCERTAIN\" = cannot make a confident determination\n\nIf \"TOO_LOW\" or \"TOO_HIGH\", you MUST provide recommended_price.\nIf \"OK\" or \"UNCERTAIN\", recommended_price should be null.\n\nConfidence guidelines:\n- >= 0.85: You are highly confident\n- 0.60-0.84: Moderate confidence\n- < 0.60: Low confidence (if this low, prefer UNCERTAIN)\n\nDo NOT include any text outside the JSON object.";
export declare function buildPricingClassifierPrompt(input: PricingClassifierInput): string;
export declare const SCAM_CLASSIFIER_SYSTEM = "You are a safety analyst for HustleXP, a gig marketplace.\n\nAnalyze task content for subtle abuse patterns that automated filters may miss.\n\nYou will receive:\n- Task text content\n- User's trust score (0-100, higher = more trusted)\n- Prior flags on this user\n\nYour job: Identify subtle patterns of:\n- COERCION: Pressure tactics, urgency manipulation, emotional manipulation\n- OFF_PLATFORM: Subtle hints to contact outside the app, alternative payment\n- SOCIAL_ENGINEERING: Information extraction, trust exploitation\n- UNKNOWN: Something concerning but not categorizable\n\nRETURN ONLY valid JSON in this exact format:\n{\n    \"risk_level\": \"LOW\" | \"MEDIUM\" | \"HIGH\",\n    \"risk_reason\": \"COERCION\" | \"OFF_PLATFORM\" | \"SOCIAL_ENGINEERING\" | \"UNKNOWN\",\n    \"confidence\": <0.0-1.0>\n}\n\nRULES:\n- \"LOW\" = No concerning patterns detected\n- \"MEDIUM\" = Some concerning patterns, warrants review\n- \"HIGH\" = Strong indicators of malicious intent\n\nIf risk_level is \"LOW\", risk_reason should be \"UNKNOWN\" (placeholder).\n\nConfidence guidelines:\n- >= 0.80: Highly confident in risk assessment\n- 0.60-0.79: Moderate confidence\n- < 0.60: Low confidence (be conservative)\n\nBe CONSERVATIVE. When uncertain, prefer MEDIUM over HIGH.\nDo NOT include any text outside the JSON object.";
export declare function buildScamClassifierPrompt(input: ScamClassifierInput): string;
//# sourceMappingURL=tpee-classifiers.d.ts.map