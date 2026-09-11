export type TaskCategory = 'yard' | 'cleaning' | 'moving' | 'assembly' | 'delivery' | 'handyman' | 'home_services' | 'auto' | 'events' | 'pet_care' | 'other';
export type ServiceTaskCategory = Exclude<TaskCategory, 'other'>;
export interface ClassifierModelArtifact { format_version: 1; classifier: 'linear_svc'; training_embedding_model: string; runtime_embedding_model: string; embedding_dimensions: number; ambiguity_threshold: number; training_examples: number; classes: ServiceTaskCategory[]; weights: number[][]; bias: number[]; }
export interface ClassificationCandidate { category: ServiceTaskCategory; score: number; }
export interface RawTaskClassification { category: ServiceTaskCategory; score: number; secondCategory: ServiceTaskCategory; secondScore: number; margin: number; candidates: ClassificationCandidate[]; }
export interface TaskClassificationResult { category: ServiceTaskCategory | null; primaryCategory: ServiceTaskCategory | null; secondaryIntents: ServiceTaskCategory[]; needsClarification: boolean; margin: number; threshold: number; source: 'ml' | 'override'; candidates: ClassificationCandidate[]; overrideReason?: string; }
