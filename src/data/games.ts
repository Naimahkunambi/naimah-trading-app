import { addWeeks, isWithinInterval, subDays } from 'date-fns';

export type GameCategory = 'sales_marketing' | 'real_estate' | 'skills';

export type Game = {
  slug: string;
  title: string;
  category: GameCategory;
  summary: string;
  howToPlay: string;
  learningGoals: string[];
  difficulty: 'easy' | 'medium' | 'hard';
  estimatedTime: string;
  releaseDate: string;
  iframeUrl?: string;
  internalComponent?: string;
};

export const gamesCatalog: Game[] = [
  {
    slug: 'property-tycoon',
    title: 'Property Tycoon',
    category: 'real_estate',
    summary: 'Make fast buy/hold/sell calls on Zanzibar properties while the market shifts beneath you.',
    howToPlay:
      'Evaluate each property card, decide whether to buy, hold, or pass. Prices change every round based on sentiment and macro cues.',
    learningGoals: ['Practice deal analysis speed', 'Spot red flags in seconds', 'Balance risk vs. liquidity'],
    difficulty: 'medium',
    estimatedTime: '5 minutes',
    releaseDate: addWeeks(new Date('2024-08-01'), 0).toISOString(),
    internalComponent: 'PropertyTycoonGame'
  },
  {
    slug: 'typing-sprint',
    title: 'Typing Sprint: Sales Vocabulary',
    category: 'skills',
    summary: 'Drill persuasive phrases, speed, and accuracy with a Zanzibar sales vocabulary sprint.',
    howToPlay: 'Type the prompts accurately before the clock runs out. Earn bonus multipliers for zero mistakes.',
    learningGoals: ['Improve typing speed', 'Reinforce sales-ready messaging', 'Build muscle memory for follow-ups'],
    difficulty: 'easy',
    estimatedTime: '3 minutes',
    releaseDate: addWeeks(new Date('2024-08-08'), 0).toISOString(),
    internalComponent: 'TypingSprintGame'
  },
  {
    slug: 'kunambi-tycoon',
    title: 'Kunambi Tycoon (Coming Soon)',
    category: 'sales_marketing',
    summary: 'A strategic funnel-builder inspired by weekly releases.',
    howToPlay: 'Preview the roadmap and get ready for the next launch.',
    learningGoals: ['Plan campaigns', 'Sequence follow-ups', 'Allocate budgets wisely'],
    difficulty: 'hard',
    estimatedTime: '10 minutes',
    releaseDate: addWeeks(new Date(), 1).toISOString(),
    iframeUrl: 'https://example.com/kunambi-tycoon'
  }
];

export const isNewThisWeek = (releaseDate: string): boolean => {
  const published = new Date(releaseDate);
  const now = new Date();
  return isWithinInterval(published, { start: subDays(now, 7), end: now });
};
