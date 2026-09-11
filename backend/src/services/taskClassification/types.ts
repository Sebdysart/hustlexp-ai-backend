export type TaskCategory =
  | 'yard'
  | 'cleaning'
  | 'moving'
  | 'assembly'
  | 'delivery'
  | 'handyman'
  | 'home_services'
  | 'auto'
  | 'events'
  | 'pet_care'
  | 'other';

export interface TrainingExample {
  input: string;
  expected: TaskCategory;
}

export interface ClassificationScore {
  label: TaskCategory;
  value: number;
}

export interface TaskClassification {
  category: TaskCategory;
  scores: ClassificationScore[];
}
