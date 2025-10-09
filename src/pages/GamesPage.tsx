import React, { useMemo, useState } from 'react';
import { gamesCatalog, GameCategory } from '../data/games';
import { GameCard } from '../components/GameCard';

const tabs: { key: GameCategory | 'all'; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'sales_marketing', label: 'Sales & Marketing' },
  { key: 'real_estate', label: 'Real Estate' },
  { key: 'skills', label: 'Skill Builders' }
];

export const GamesPage: React.FC = () => {
  const [activeTab, setActiveTab] = useState<GameCategory | 'all'>('all');

  const filteredGames = useMemo(() => {
    if (activeTab === 'all') return gamesCatalog;
    return gamesCatalog.filter((game) => game.category === activeTab);
  }, [activeTab]);

  return (
    <div className="space-y-10">
      <header className="space-y-4">
        <h1 className="text-4xl font-bold text-ink">Games</h1>
        <p className="max-w-2xl text-ink/70">
          I publish one new game every week. Learn faster by doing: sales, marketing, real estate, and core skills (typing,
          grammar, reasoning). Compete on leaderboards. Win by learning.
        </p>
        <div className="flex flex-wrap gap-3">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`rounded-full px-4 py-2 text-sm font-semibold ${activeTab === tab.key ? 'bg-primary text-white' : 'bg-white text-ink/70'}`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </header>

      <section className="grid gap-6 md:grid-cols-3">
        {filteredGames.map((game) => (
          <GameCard key={game.slug} game={game} />
        ))}
      </section>
    </div>
  );
};
