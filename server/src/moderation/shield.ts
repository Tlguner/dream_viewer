import { ModerationResult } from '../types/index.js';

// Comprehensive pattern match for vulgarity, adult content, violence, and hate speech
const EXPLICIT_PATTERNS = [
  // Adult & Nudity (+18)
  /\b(nude|naked|nudity|nsfw|porn|porno|pornography|erotic|boobs|breasts|penis|vagina|sex|sexual|masturbat|intercourse|fetish|hentai)\b/i,
  // Turkish +18 / Vulgarity
  /\b(ciplak|çıplak|porno|pornografi|seks|cinsel|amcık|yarrak|sik|sikiş|meme|got|göt|orospu|piç|fahişe)\b/i,
  // Violence & Gore
  /\b(gore|blood|behead|decapitat|mutilat|torture|dismember|slaughter|suicide|kill myself|murder scene)\b/i,
  /\b(kan|cinayet|işkence|katliam|intihar|kafasını kes)\b/i,
  // Hate speech & severe profanity
  /\b(nigger|faggot|kike|cunt|motherfucker|whore|slut)\b/i
];

export const UNIVERSAL_NEGATIVE_PROMPTS = [
  "nsfw",
  "nude",
  "naked",
  "erotic",
  "sexual",
  "gore",
  "blood",
  "extreme violence",
  "horror disfigurement",
  "close-up human face",
  "detailed facial features",
  "identifiable real person",
  "watermark",
  "low quality artifacts"
].join(', ');

export class SafetyShield {
  /**
   * Fast Layer-1 & Layer-2 text moderation check
   */
  public static auditPrompt(rawText: string): ModerationResult {
    const trimmed = rawText.trim();
    if (!trimmed) {
      return {
        passed: false,
        flaggedCategories: ['EMPTY_INPUT'],
        reason: 'Please enter a description of your dream.'
      };
    }

    const flaggedCategories: string[] = [];

    for (const pattern of EXPLICIT_PATTERNS) {
      if (pattern.test(trimmed)) {
        flaggedCategories.push('PROFANITY_OR_NSFW');
        break;
      }
    }

    if (flaggedCategories.length > 0) {
      return {
        passed: false,
        flaggedCategories,
        reason: 'The Dream Weaver can only manifest peaceful, surreal, and safe visions. Your dream description contains elements our visualizer cannot bring to life (+18, profanity, or violence). Try focusing on the environment, colors, or atmosphere.'
      };
    }

    return {
      passed: true,
      flaggedCategories: [],
      sanitizedPrompt: trimmed
    };
  }

  /**
   * Appends non-negotiable negative prompts to all generation payloads
   */
  public static getNegativePrompt(customNegatives?: string): string {
    if (!customNegatives) return UNIVERSAL_NEGATIVE_PROMPTS;
    return `${UNIVERSAL_NEGATIVE_PROMPTS}, ${customNegatives}`;
  }
}
