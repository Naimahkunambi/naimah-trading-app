import React from 'react';
import { Link } from 'react-router-dom';
import { Game, isNewThisWeek } from '../data/games';
import { BadgeCheck, Flame, Timer } from 'lucide-react';

export const GameCard: React.FC<{ game: Game }> = ({ game }) => {
  const label =
    game.category === 'real_estate' ? 'Real Estate' : game.category === 'sales_marketing' ? 'Sales & Marketing' : 'Skill Builder';

  return (
    <div className="flex h-full flex-col justify-between rounded-3xl border border-primary/10 bg-white p-6 shadow-sm transition-transform hover:-translate-y-1 hover:shadow-lg">
      <div className="space-y-4">
        <div className="flex items-center justify-between text-xs font-semibold uppercase tracking-widest text-ink/60">
          <span>{label}</span>
          {isNewThisWeek(game.releaseDate) && (
            <span className="inline-flex items-center gap-1 text-primary">
              <Flame size={14} /> New this week
            </span>
          )}
        </div>
        <h3 className="text-xl font-bold text-ink">{game.title}</h3>
        <p className="text-sm text-ink/70">{game.summary}</p>
      </div>
      <div className="mt-6 flex items-center justify-between text-xs text-ink/60">
        <span className="inline-flex items-center gap-1">
          <Timer size={14} /> {game.estimatedTime}
        </span>
        <span className="inline-flex items-center gap-1">
          <BadgeCheck size={14} /> {game.difficulty}
        </span>
      </div>
      <Link
        className="mt-6 inline-flex items-center justify-center rounded-full bg-primary px-4 py-2 text-sm font-semibold text-white hover:bg-primary/90"
        to={`/games/${game.slug}`}
      >
        Play
      </Link>
    </div>
  );
};
