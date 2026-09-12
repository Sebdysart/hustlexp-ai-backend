export type TimingFacts = {
  urgency?: 'asap' | 'scheduled' | 'flexible';
  dayReference?: string;
  timeWindow?: {
    start: string;
    end: string;
  };
};

export function extractTimingFacts(input: string): TimingFacts {
  const text = input.toLowerCase();
  const facts: TimingFacts = {};

  if (/\basap\b|\bas soon as possible\b/i.test(text)) {
    facts.urgency = 'asap';
  }

  if (/\btomorrow\b/i.test(text)) {
    facts.dayReference = 'tomorrow';
    facts.urgency ??= 'scheduled';
  } else if (/\btoday\b/i.test(text)) {
    facts.dayReference = 'today';
    facts.urgency ??= 'scheduled';
  }

  const betweenMatch = text.match(
    /\bbetween\s+([0-9]{1,2}(?::[0-9]{2})?\s*(?:am|pm)?)\s+and\s+([0-9]{1,2}(?::[0-9]{2})?\s*(?:am|pm)?)\b/i,
  );

  if (betweenMatch) {
    facts.timeWindow = {
      start: betweenMatch[1].trim(),
      end: betweenMatch[2].trim(),
    };

    facts.urgency ??= 'scheduled';
  }

  return facts;
}
