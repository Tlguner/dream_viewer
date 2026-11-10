import { ModerationResult } from '../types/index.js';

/**
 * High-precision, zero-tolerance pattern list for adult, CSAM, sexual, and extreme gore content.
 * Uses Unicode letter boundary checks instead of ASCII \b so Turkish characters (ç, ı, ş, ğ, ö, ü)
 * match correctly without false positives on words like "got" (English) or "meme" (internet culture).
 */

// Helper to match whole words with Unicode support
function createWordPattern(words: string[]): RegExp {
  // Matches word boundary taking into account any Unicode letters/numbers
  const pattern = words
    .map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
  return new RegExp(`(?<![\\p{L}\\p{N}])(${pattern})(?![\\p{L}\\p{N}])`, 'iu');
}

// 1. Strict Adult / NSFW / CSAM / Explicit Erotica
const EXPLICIT_ADULT_WORDS = [
  // English Adult
  'nude', 'naked', 'nudity', 'nsfw', 'porn', 'porno', 'pornography', 
  'erotic', 'erotica', 'boobs', 'penis', 'vagina', 'intercourse', 
  'fetish', 'hentai', 'gangbang', 'masturbate', 'masturbation',
  // Child Protection (CSAM) - Absolute Zero Tolerance
  'pedophile', 'pedophilia', 'childporn', 'lolita', 'underage sex',
  // Turkish Adult (Precise words without false positives like 'got' or 'meme')
  'çıplak', 'ciplak', 'pornografi', 'cinsel ilişki', 'amcık', 'yarrak', 
  'sikiş', 'sikis', 'orospu', 'fahişe', 'fahise', 'pedofili'
];

// 2. Extreme Graphic Gore & Mutilation (Allowing atmospheric dreams like "fog, shadows, cemetery, falling")
const GRAPHIC_GORE_WORDS = [
  'behead', 'beheading', 'decapitate', 'decapitation', 'dismember', 
  'dismemberment', 'mutilation', 'slaughter scene', 'torture chamber',
  'kafasını kes', 'kafa kesme', 'uzuv koparma', 'işkence'
];

// 3. Extreme Hate Speech
const HATE_SPEECH_WORDS = [
  'nigger', 'faggot', 'kike', 'cunt'
];

const ADULT_REGEX = createWordPattern(EXPLICIT_ADULT_WORDS);
const GORE_REGEX = createWordPattern(GRAPHIC_GORE_WORDS);
const HATE_REGEX = createWordPattern(HATE_SPEECH_WORDS);

export const UNIVERSAL_NEGATIVE_PROMPTS = [
  "nsfw",
  "nude",
  "naked",
  "erotic",
  "sexual",
  "gore",
  "graphic violence",
  "blood",
  "horror disfigurement",
  "close-up human face",
  "detailed facial features",
  "identifiable real person",
  "watermark",
  "low quality artifacts"
].join(', ');

export class SafetyShield {
  /**
   * Unicode-aware, precise text moderation audit
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

    if (trimmed.length > 2000) {
      return {
        passed: false,
        flaggedCategories: ['INPUT_TOO_LONG'],
        reason: 'Dream description is too long (maximum 2000 characters).'
      };
    }

    const flaggedCategories: string[] = [];

    if (ADULT_REGEX.test(trimmed)) {
      flaggedCategories.push('NSFW_OR_ADULT');
    }
    if (GORE_REGEX.test(trimmed)) {
      flaggedCategories.push('GRAPHIC_GORE');
    }
    if (HATE_REGEX.test(trimmed)) {
      flaggedCategories.push('HATE_SPEECH');
    }

    if (flaggedCategories.length > 0) {
      return {
        passed: false,
        flaggedCategories,
        reason: 'The Dream Weaver can only manifest peaceful, surreal, and safe visions. Your dream description contains elements our visualizer cannot bring to life (+18, explicit adult, or graphic gore). Try focusing on the environment, colors, or atmosphere.'
      };
    }

    return {
      passed: true,
      flaggedCategories: [],
      sanitizedPrompt: trimmed
    };
  }

  public static getNegativePrompt(customNegatives?: string): string {
    if (!customNegatives) return UNIVERSAL_NEGATIVE_PROMPTS;
    return `${UNIVERSAL_NEGATIVE_PROMPTS}, ${customNegatives}`;
  }
}
