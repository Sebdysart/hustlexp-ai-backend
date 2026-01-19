/**
 * Task Card AI Prompts
 * Transforms minimal task input into fully enriched, gamified task cards
 */
export const TASK_ENRICHMENT_PROMPT = `You are HustleXP's Task Card AI. Transform minimal task descriptions into rich, gamified task cards.

Input task:
{rawInput}

Location: {location}
Category hint: {categoryHint}
Current time: {currentTime}
Day: {dayOfWeek}

Generate a complete task card with:

1. **Title** - Bold, action-oriented (5 words max)
2. **Description** - Professional, 2-3 sentences, safety-conscious
3. **Category** - One of: delivery, moving, cleaning, pet_care, errands, handyman, tech_help, yard_work, event_help
4. **Duration** - Estimated hours/minutes
5. **Difficulty** - easy/medium/hard
6. **Equipment** - List of items needed (if any)
7. **SafetyNotes** - Any safety considerations
8. **ExperienceLevel** - none/some/experienced
9. **PriceBreakdown** - { min, recommended, max, hourlyEquivalent }

Respond with JSON only:
{
  "title": "Move Boxes Downtown",
  "description": "Help move 4 boxes from car to 2nd floor apartment. Light items, no heavy lifting required.",
  "category": "moving",
  "durationMinutes": 60,
  "durationText": "1-2 hours",
  "difficulty": "easy",
  "equipment": ["none required"],
  "safetyNotes": "Indoor task, elevator available",
  "experienceLevel": "none",
  "priceBreakdown": {
    "min": 30,
    "recommended": 45,
    "max": 65,
    "hourlyEquivalent": 30
  }
}`;
export const SEATTLE_CONTEXT_PROMPT = `You are analyzing Seattle-specific context for a task.

Task category: {category}
Location: {location}
Date/Time: {datetime}
Day of week: {dayOfWeek}

Consider Seattle factors:
- Capitol Hill: busy evenings/weekends, parking difficult
- UW Area: peak during academic year, move-in weeks
- Ballard: family-friendly, weekend surges
- Downtown: business hours busy, parking expensive
- Stadium District: game day surges (Seahawks, Mariners, Sounders)
- Rain is common - outdoor tasks affected

Respond with JSON:
{
  "surgeFactor": 1.15,  // 1.0 = normal, 1.15 = +15%
  "surgeReason": "Capitol Hill weekend surge",
  "weatherWarning": "Light rain expected at 4pm - bring waterproof gear",
  "trafficNote": "Heavy traffic expected near Pike Place until 3pm",
  "eventNote": "Mariners game at 7pm may affect parking",
  "recommendedTiming": "Best to start before 2pm",
  "hotspotBonus": true,
  "areaInsights": "High hustler availability in this area"
}`;
export const GAMIFICATION_PROMPT = `Calculate gamification elements for this task.

Task details:
- Category: {category}
- Difficulty: {difficulty}
- Duration: {durationMinutes} minutes
- Price: {recommended}
- User level: {userLevel}
- User streak: {userStreak}
- Category completion count: {categoryCount}

Calculate:
1. Base XP (difficulty-based: easy=50, medium=100, hard=200)
2. Duration bonus (every 30min = +25 XP)
3. Streak multiplier (streak 3+ = 1.25x, 7+ = 1.5x, 14+ = 2x)
4. Category progress (X/10 for next badge)
5. Potential badges
6. Double XP eligibility

Respond with JSON:
{
  "baseXP": 100,
  "durationBonus": 50,
  "totalXP": 187,
  "streakMultiplier": 1.25,
  "streakText": "+25% streak boost",
  "categoryProgress": { "current": 4, "max": 10, "badge": "Moving Pro" },
  "potentialBadges": ["Reliable Helper", "Quick Responder"],
  "doubleXPEligible": true,
  "doubleXPReason": "First task of the day"
}`;
//# sourceMappingURL=taskCard.js.map