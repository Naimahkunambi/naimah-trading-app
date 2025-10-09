import React, { useState } from 'react';
import { gamesCatalog } from '../data/games';
import { LeaderboardTable } from '../components/LeaderboardTable';

const supabaseGameIds: Record<string, number> = {
  'property-tycoon': 1,
  'typing-sprint': 2,
  'kunambi-tycoon': 3
};

export const LeaderboardsPage: React.FC = () => {
  const [selectedSlug, setSelectedSlug] = useState<string>('property-tycoon');
  const selectedGame = gamesCatalog.find((game) => game.slug === selectedSlug);

  return (
    <div className="space-y-6">
      <header className="space-y-3">
        <h1 className="text-4xl font-bold text-ink">Leaderboards</h1>
        <p className="max-w-2xl text-ink/70">
          Track weekly and all-time champions across every Kunambi game. Anti-cheat is enforced through Supabase sanity caps and
          manual reviews.
        </p>
      </header>

      <div className="flex flex-wrap gap-3">
        {gamesCatalog.map((game) => (
          <button
            key={game.slug}
            onClick={() => setSelectedSlug(game.slug)}
            className={`rounded-full px-4 py-2 text-sm font-semibold ${selectedSlug === game.slug ? 'bg-primary text-white' : 'bg-white text-ink/70'}`}
          >
            {game.title}
          </button>
        ))}
      </div>

      <section className="rounded-3xl bg-white p-6 shadow-md">
        <h2 className="text-2xl font-bold text-ink">{selectedGame?.title}</h2>
        <p className="mt-2 text-sm text-ink/70">{selectedGame?.summary}</p>
        <div className="mt-6">
          <LeaderboardTable gameId={supabaseGameIds[selectedSlug] ?? null} />
        </div>
      </section>
    </div>
  );
};
