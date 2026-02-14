/**
 * TutorialQuestService v1.0.0
 *
 * CONSTITUTIONAL: Tutorial quest for worker onboarding (Gap 13 fix)
 *
 * Before workers can see real money tasks, they complete a simulated
 * "tutorial quest" that tests safety awareness and app literacy.
 * This is legally sturdier than "Click to Agree" because they
 * interact with the actual task flow.
 *
 * Also serves as Equipment Inventory scan via photo (Gap 14).
 */

import { db } from '../db';
import type { ServiceResult } from '../types';

// ============================================================================
// TYPES
// ============================================================================

interface TutorialScenario {
  id: string;
  title: string;
  description: string;
  hidden_flaw: string; // The "trick" - worker must identify this
  correct_action: 'flag_risk' | 'decline_task' | 'request_details';
  category: string;
}

interface TutorialResult {
  passed: boolean;
  score: number; // 0-100
  scenarios_attempted: number;
  scenarios_correct: number;
  feedback: string;
}

interface EquipmentScanResult {
  detected_items: string[];
  suggested_skills: string[];
  confidence: number;
}

// ============================================================================
// TUTORIAL SCENARIOS
// ============================================================================

const TUTORIAL_SCENARIOS: TutorialScenario[] = [
  {
    id: 'tut_01',
    title: 'Quick Cash - No Questions Asked',
    description: 'Need someone to pick up a "package" from an address downtown. $200 cash. No ID needed. Come alone.',
    hidden_flaw: 'Suspicious activity indicators: abnormally high pay, secrecy, no ID requirement',
    correct_action: 'flag_risk',
    category: 'safety',
  },
  {
    id: 'tut_02',
    title: 'Fix My Electrical Panel',
    description: 'My breaker keeps tripping. Need someone to open the panel and rewire circuit #3. Tools provided.',
    hidden_flaw: 'Electrical work requires a licensed electrician - this is a regulated trade',
    correct_action: 'decline_task',
    category: 'licensing',
  },
  {
    id: 'tut_03',
    title: 'Babysit My Kids Tonight',
    description: 'Need someone ASAP to watch 3 kids (ages 2, 5, 8) tonight from 6-midnight. $15/hour.',
    hidden_flaw: 'Childcare requires background check verification — worker cannot accept without it',
    correct_action: 'decline_task',
    category: 'background_check',
  },
  {
    id: 'tut_04',
    title: 'Help Me Move a Couch',
    description: 'Moving a couch from 3rd floor apartment to truck downstairs. About 30 minutes of work.',
    hidden_flaw: 'None — this is a legitimate, safe task to teach workers that not every task is a trap',
    correct_action: 'request_details', // Correct action: ask about stairs, weight, etc.
    category: 'normal',
  },
  {
    id: 'tut_05',
    title: 'Drive My Car to the Shop',
    description: 'My car broke down. Need someone to drive it to the mechanic 5 miles away. Keys under the mat.',
    hidden_flaw: 'Driving someone else\'s car has liability/insurance implications',
    correct_action: 'flag_risk',
    category: 'liability',
  },
];

// ============================================================================
// SERVICE
// ============================================================================

export const TutorialQuestService = {
  /**
   * Get tutorial scenarios for a new worker
   * Returns 3 random scenarios (mix of dangerous and safe)
   */
  getScenarios: async (): Promise<ServiceResult<Omit<TutorialScenario, 'hidden_flaw' | 'correct_action'>[]>> => {
    // Always include one "safe" scenario so workers learn not everything is a trap
    const safeScenarios = TUTORIAL_SCENARIOS.filter(s => s.category === 'normal');
    const dangerousScenarios = TUTORIAL_SCENARIOS.filter(s => s.category !== 'normal');

    // Pick 1 safe + 2 dangerous (random)
    const shuffled = dangerousScenarios.sort(() => Math.random() - 0.5);
    const selected = [
      ...shuffled.slice(0, 2),
      safeScenarios[Math.floor(Math.random() * safeScenarios.length)],
    ].sort(() => Math.random() - 0.5); // Shuffle order

    return {
      success: true,
      data: selected.map(s => ({
        id: s.id,
        title: s.title,
        description: s.description,
        category: s.category,
      })),
    };
  },

  /**
   * Submit tutorial answers and evaluate
   */
  submitAnswers: async (
    userId: string,
    answers: { scenarioId: string; action: string }[]
  ): Promise<ServiceResult<TutorialResult>> => {
    try {
      let correct = 0;

      for (const answer of answers) {
        const scenario = TUTORIAL_SCENARIOS.find(s => s.id === answer.scenarioId);
        if (scenario && answer.action === scenario.correct_action) {
          correct++;
        }
      }

      const score = Math.round((correct / answers.length) * 100);
      const passed = score >= 66; // Must get at least 2/3 right

      let feedback: string;
      if (score === 100) {
        feedback = 'Perfect score! You identified all safety concerns correctly.';
      } else if (passed) {
        feedback = 'Good job! You passed the safety check. Remember to always verify task requirements before accepting.';
      } else {
        feedback = 'You missed some safety concerns. Review the guidelines and try again. Your safety and the community\'s trust depend on it.';
      }

      // Update user record
      if (passed) {
        await db.query(
          `UPDATE users
           SET tutorial_quest_completed = TRUE,
               tutorial_quest_completed_at = NOW(),
               tutorial_quest_score = $1
           WHERE id = $2`,
          [score, userId]
        );
      } else {
        await db.query(
          `UPDATE users SET tutorial_quest_score = $1 WHERE id = $2`,
          [score, userId]
        );
      }

      return {
        success: true,
        data: {
          passed,
          score,
          scenarios_attempted: answers.length,
          scenarios_correct: correct,
          feedback,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: { code: 'DB_ERROR', message: error instanceof Error ? error.message : 'Unknown error' },
      };
    }
  },

  /**
   * GAP 14: Equipment Inventory Scan
   * Analyze photo of worker's equipment using AI vision
   */
  scanEquipment: async (photoUrl: string): Promise<ServiceResult<EquipmentScanResult>> => {
    try {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) {
        return {
          success: true,
          data: { detected_items: [], suggested_skills: [], confidence: 0 },
        };
      }

      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: 'gpt-4o',
          messages: [
            {
              role: 'system',
              content: `You analyze photos of tools and equipment for a gig work platform.
Identify tools/equipment and suggest related skills.
Respond with JSON only: {"items": ["item1", "item2"], "skills": ["skill_name1", "skill_name2"], "confidence": 0.0-1.0}
Map items to these skill names: lawn_mowing, furniture_assembly, painting_interior, tv_mounting, car_jumpstart, pressure_washing, etc.`,
            },
            {
              role: 'user',
              content: [
                { type: 'text', text: 'What tools/equipment do you see in this photo?' },
                { type: 'image_url', image_url: { url: photoUrl } },
              ],
            },
          ],
          max_tokens: 300,
          temperature: 0.1,
        }),
      });

      if (!response.ok) {
        throw new Error(`OpenAI API error: ${response.status}`);
      }

      const data = await response.json() as Record<string, any>;
      const content = data.choices?.[0]?.message?.content;
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      const parsed = JSON.parse(jsonMatch?.[0] || '{}');

      return {
        success: true,
        data: {
          detected_items: parsed.items || [],
          suggested_skills: parsed.skills || [],
          confidence: parsed.confidence || 0,
        },
      };
    } catch (error) {
      return {
        success: true,
        data: { detected_items: [], suggested_skills: [], confidence: 0 },
      };
    }
  },
};

export default TutorialQuestService;
