import { describe, it, expect } from 'vitest';
import { SafetyShield } from '../src/moderation/shield.js';

describe('SafetyShield Moderation Table-Driven Tests', () => {
  interface ModerationTestCase {
    description: string;
    input: string;
    expectedPassed: boolean;
    expectedCategory?: string;
  }

  const tableCases: ModerationTestCase[] = [
    // 1. Explicit Turkish adult terms (Must be rejected)
    {
      description: 'Turkish adult: "çıplak"',
      input: 'Rüyamda çıplak bir şekilde sahilde yürüyordum',
      expectedPassed: false,
      expectedCategory: 'NSFW_OR_ADULT'
    },
    {
      description: 'Turkish adult ASCII: "ciplak"',
      input: 'Denizde ciplak yuzuyordum',
      expectedPassed: false,
      expectedCategory: 'NSFW_OR_ADULT'
    },
    {
      description: 'Turkish adult: "pornografi"',
      input: 'Televizyonda pornografi yayını vardı',
      expectedPassed: false,
      expectedCategory: 'NSFW_OR_ADULT'
    },
    {
      description: 'Turkish adult: "cinsel ilişki"',
      input: 'Otel odasında cinsel ilişki yaşanıyordu',
      expectedPassed: false,
      expectedCategory: 'NSFW_OR_ADULT'
    },
    {
      description: 'Turkish adult insult: "orospu"',
      input: 'Sokakta bir orospu bağırdı',
      expectedPassed: false,
      expectedCategory: 'NSFW_OR_ADULT'
    },
    {
      description: 'Turkish adult insult: "fahişe"',
      input: 'Eski handa fahişe gördüm',
      expectedPassed: false,
      expectedCategory: 'NSFW_OR_ADULT'
    },

    // 2. English explicit adult & CSAM (Must be rejected)
    {
      description: 'English adult: "nude"',
      input: 'A nude statue in a quiet gallery',
      expectedPassed: false,
      expectedCategory: 'NSFW_OR_ADULT'
    },
    {
      description: 'English adult: "naked"',
      input: 'Walking naked through a crowded airport',
      expectedPassed: false,
      expectedCategory: 'NSFW_OR_ADULT'
    },
    {
      description: 'English adult: "erotica"',
      input: 'Reading ancient erotica in an underground vault',
      expectedPassed: false,
      expectedCategory: 'NSFW_OR_ADULT'
    },
    {
      description: 'CSAM zero-tolerance: "pedophile"',
      input: 'Encountered a pedophile in a dystopian dark alley',
      expectedPassed: false,
      expectedCategory: 'NSFW_OR_ADULT'
    },

    // 3. Graphic Gore & Mutilation (Must be rejected)
    {
      description: 'Graphic gore: "beheading"',
      input: 'A public square with a brutal beheading execution',
      expectedPassed: false,
      expectedCategory: 'GRAPHIC_GORE'
    },
    {
      description: 'Graphic gore: "dismemberment"',
      input: 'Corpses suffering dismemberment in a nightmare',
      expectedPassed: false,
      expectedCategory: 'GRAPHIC_GORE'
    },
    {
      description: 'Turkish gore: "kafa kesme"',
      input: 'Rüyamda vahşi bir kafa kesme sahnesi vardı',
      expectedPassed: false,
      expectedCategory: 'GRAPHIC_GORE'
    },
    {
      description: 'Turkish gore: "işkence"',
      input: 'Karanlık bir zindanda işkence odası gördüm',
      expectedPassed: false,
      expectedCategory: 'GRAPHIC_GORE'
    },

    // 4. Hate Speech (Must be rejected)
    {
      description: 'Hate speech slur',
      input: 'Shouting hate slurs like nigger in the street',
      expectedPassed: false,
      expectedCategory: 'HATE_SPEECH'
    },

    // 5. False-Positive Protections (MUST BE ALLOWED!)
    {
      description: 'English past tense: "got" (not Turkish "göt")',
      input: 'I got lost in a dark enchanted pine forest',
      expectedPassed: true
    },
    {
      description: 'Internet culture: "meme" (not Turkish breast slang)',
      input: 'Rüyamda komik bir kedi meme gördüm ve güldüm',
      expectedPassed: true
    },
    {
      description: 'Atmospheric color: "blood red"',
      input: 'A blood red sky overlooking calm obsidian waters',
      expectedPassed: true
    },
    {
      description: 'Atmospheric color: "kan kırmızısı"',
      input: 'Gökyüzü kan kırmızısı bulutlarla kaplıydı',
      expectedPassed: true
    },
    {
      description: 'Peaceful surrealism: ocean to forest',
      input: 'Denizde yüzüyordum, sonra kendimi bir çam ormanında buldum',
      expectedPassed: true
    },
    {
      description: 'Lucid dream motifs: flying over clouds',
      input: 'Bulutların üzerinde altın kanatlarla süzülüyordum',
      expectedPassed: true
    },
    {
      description: 'Surreal architecture: crystal temples',
      input: 'Kristal bir tapınakta mermer sütunlar arasında yürüyordum',
      expectedPassed: true
    },

    // 6. Boundary & Validation Checks
    {
      description: 'Empty prompt',
      input: '   ',
      expectedPassed: false,
      expectedCategory: 'EMPTY_INPUT'
    }
  ];

  it.each(tableCases)('$description', ({ input, expectedPassed, expectedCategory }) => {
    const result = SafetyShield.auditPrompt(input);
    expect(result.passed).toBe(expectedPassed);

    if (!expectedPassed && expectedCategory) {
      expect(result.flaggedCategories).toContain(expectedCategory);
    }
  });
});
