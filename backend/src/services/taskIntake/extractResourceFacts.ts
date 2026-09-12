export type ResourceFact = {
  resource: string;
  mode: 'provided' | 'required';
  evidence: string;
  confidence: number;
};

export function extractResourceFacts(input: string): ResourceFact[] {
  const text = input.toLowerCase();
  const facts: ResourceFact[] = [];

  const add = (fact: ResourceFact) => {
    if (
      !facts.some(
        (existing) =>
          existing.resource === fact.resource &&
          existing.mode === fact.mode,
      )
    ) {
      facts.push(fact);
    }
  };

  const requiredVehicle = text.match(
    /\b(?:need|needs|require|requires|required|with|bring)\b[^.!?]{0,30}\b(truck|van|car|suv)\b/i,
  );

  if (requiredVehicle) {
    add({
      resource: requiredVehicle[1].toLowerCase(),
      mode: 'required',
      evidence: requiredVehicle[0],
      confidence: 0.99,
    });
  }

  const providedTool = text.match(
    /\b(?:i have|we have|have a|have an|provided|here for you)\b[^.!?]{0,40}\b(rake|leaf blower|mower|drill|ladder|tools?)\b/i,
  );

  if (providedTool) {
    add({
      resource: providedTool[1].toLowerCase(),
      mode: 'provided',
      evidence: providedTool[0],
      confidence: 0.97,
    });
  }

  const providerTool = text.match(
    /\b(?:bring your own|you(?:'ll| will) need|provider needs?)\b[^.!?]{0,40}\b(rake|leaf blower|mower|drill|ladder|tools?)\b/i,
  );

  if (providerTool) {
    add({
      resource: providerTool[1].toLowerCase(),
      mode: 'required',
      evidence: providerTool[0],
      confidence: 0.97,
    });
  }

  const someoneWithResource = text.match(
    /\b(?:someone|somebody|provider|person)\s+with\s+(?:an?\s+|their\s+own\s+)?(drill|ladder|mower|rake|leaf blower|tools?)\b/i,
  );
  if (someoneWithResource) {
    add({
      resource: someoneWithResource[1].toLowerCase(),
      mode: 'required',
      evidence: someoneWithResource[0],
      confidence: 0.98,
    });
  }

  return facts;
}
