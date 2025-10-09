import React from 'react';
import { useLeaderboard } from '../hooks/useLeaderboard';
import { formatDistanceToNow } from 'date-fns';

export const LeaderboardTable: React.FC<{ gameId: number | null }> = ({ gameId }) => {
  const [range, setRange] = React.useState<'weekly' | 'alltime'>('weekly');
  const { data = [], isLoading } = useLeaderboard(gameId, range);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 text-sm font-semibold text-ink/80">
        <button
          className={`rounded-full px-4 py-2 ${range === 'weekly' ? 'bg-primary text-white' : 'bg-white text-ink/70'}`}
          onClick={() => setRange('weekly')}
        >
          Weekly
        </button>
        <button
          className={`rounded-full px-4 py-2 ${range === 'alltime' ? 'bg-primary text-white' : 'bg-white text-ink/70'}`}
          onClick={() => setRange('alltime')}
        >
          All-time
        </button>
      </div>
      <div className="overflow-hidden rounded-3xl border border-primary/10">
        <table className="min-w-full divide-y divide-primary/10">
          <thead className="bg-primary/5 text-left text-xs font-semibold uppercase tracking-widest text-ink/60">
            <tr>
              <th className="px-4 py-3">Rank</th>
              <th className="px-4 py-3">Player</th>
              <th className="px-4 py-3">Score</th>
              <th className="px-4 py-3">Posted</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-primary/10 bg-white text-sm">
            {isLoading && (
              <tr>
                <td colSpan={4} className="px-4 py-6 text-center text-ink/60">
                  Loading leaderboard…
                </td>
              </tr>
            )}
            {!isLoading && data.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-6 text-center text-ink/60">
                  No scores yet. Be the first to compete!
                </td>
              </tr>
            )}
            {data.map((entry, index) => (
              <tr key={entry.id}>
                <td className="px-4 py-3">#{index + 1}</td>
                <td className="px-4 py-3 font-semibold">
                  {entry.display_name ?? (entry.identifier ? `Player ${entry.identifier.slice(0, 8)}` : 'Anonymous')}
                </td>
                <td className="px-4 py-3 text-primary font-bold">{entry.score}</td>
                <td className="px-4 py-3 text-ink/60">
                  {formatDistanceToNow(new Date(entry.created_at), { addSuffix: true })}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!gameId && (
        <p className="text-xs text-ink/60">Connect Supabase to enable live leaderboards.</p>
      )}
    </div>
  );
};
