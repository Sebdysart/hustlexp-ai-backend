export type TaskAction = {
  type:
    | 'move'
    | 'deliver'
    | 'pickup'
    | 'assemble'
    | 'install'
    | 'mount'
    | 'clean'
    | 'remove'
    | 'haul'
    | 'walk'
    | 'feed'
    | 'watch'
    | 'repair'
    | 'other';

  object?: string;
  quantity?: number;
  evidence?: string;
};

export type TaskFacts = {
  goal?: string;

  actions?: TaskAction[];

  objects?: Array<{
    type: string;
    quantity?: number;
    description?: string;
  }>;

  location?: {
    propertyType?: string;
    areas?: string[];
    floor?: number;
  };

  access?: {
    stairs?: boolean;
    stairFlights?: number;
    elevatorAvailable?: boolean;
    narrowAccess?: boolean;
  };

  resources?: {
    provided?: string[];
    required?: string[];
    vehicleRequired?: boolean;
  };

  serviceDetails?: string[];

  staffing?: {
    workerCount?: number;
  };

  measurements?: {
    durationMinutes?: number;
    distanceMiles?: number;
    weight?: number;
    dimensions?: string[];
  };

  disposal?: {
    required?: boolean;
    materials?: string[];
  };

  timing?: {
    urgency?: 'asap' | 'scheduled' | 'flexible';
    dayReference?: string;
    timeWindow?: {
      start: string;
      end: string;
    };
    preference?: string;
  };

  constraints?: string[];
  notes?: string[];
};
