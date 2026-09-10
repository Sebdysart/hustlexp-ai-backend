export type TaskCategory = 'yard'|'cleaning'|'moving'|'assembly'|'delivery'|'handyman'|'home_services'|'auto'|'events'|'pet_care'|'other';
export type IntakeAnswer = string|boolean|string[]|number;
export type IntakeAnswers = Record<string, IntakeAnswer>;
export type QuestionKind = 'yesno'|'select'|'multiselect'|'text'|'number';
export type QuestionImportance = 'required'|'recommended'|'optional';
export type QuestionCondition = { key:string; operator:'equals'|'not_equals'; value:IntakeAnswer }|{ key:string; operator:'includes'; value:string }|{ key:string; operator:'truthy' };
export interface IntakeQuestion { key:string; label:string; kind:QuestionKind; importance:QuestionImportance; conditions?:QuestionCondition[] }
export interface IntakeValidationResult { readyForDraft:boolean; missingRequired:string[]; missingRecommended:string[]; quality:'low'|'medium'|'high' }
