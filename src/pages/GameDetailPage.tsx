import React, { useMemo, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { gamesCatalog } from '../data/games';
import { PropertyTycoonGame } from '../features/games/PropertyTycoonGame';
import { TypingSprintGame } from '../features/games/TypingSprintGame';
import { Button } from '../components/Button';
import { LeaderboardTable } from '../components/LeaderboardTable';
import { useAuthContext } from '../providers/AuthProvider';
import { useScoreSubmission } from '../hooks/useScoreSubmission';

const gameComponentMap: Record<string, React.ComponentType<{ onFinish?: (score: number) => void }>> = {
  PropertyTycoonGame,
  TypingSprintGame
};

const supabaseGameIds: Record<string, number> = {
  'property-tycoon': 1,
  'typing-sprint': 2
};

export const GameDetailPage: React.FC = () => {
  const { slug } = useParams<{ slug: string }>();
  const game = gamesCatalog.find((item) => item.slug === slug);
  const { requireAuth, user } = useAuthContext();
  const [canPlay, setCanPlay] = useState(false);
  const [scorePosted, setScorePosted] = useState<string>('');
  const gameId = slug ? supabaseGameIds[slug] ?? null : null;
  const submitScore = useScoreSubmission(gameId ?? null);

  const GameComponent = useMemo(() => {
    if (!game?.internalComponent) return null;
    return gameComponentMap[game.internalComponent];
  }, [game?.internalComponent]);

  const startPlay = async () => {
    await requireAuth(() => {
      setCanPlay(true);
      setScorePosted('');
    });
  };

  const onScore = async (score: number) => {
    if (!user) return;
    try {
      await submitScore.mutateAsync(score);
      setScorePosted('Score submitted! Check the leaderboard.');
    } catch (error) {
      setScorePosted((error as Error).message);
    }
  };

  if (!game) {
    return (
      <div className="space-y-4">
        <h1 className="text-3xl font-bold text-ink">Game not found</h1>
        <Link to="/games" className="text-primary">
          Back to games
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-10">
      <Link to="/games" className="text-sm font-semibold text-primary">
        ← Back to games
      </Link>
      <header className="space-y-3">
        <h1 className="text-4xl font-bold text-ink">{game.title}</h1>
        <p className="text-ink/70">{game.summary}</p>
        <div className="flex flex-wrap gap-4 text-sm text-ink/60">
          <span>Category: {game.category.replace('_', ' ')}</span>
          <span>Difficulty: {game.difficulty}</span>
          <span>Estimated time: {game.estimatedTime}</span>
        </div>
      </header>

      <section className="grid gap-8 md:grid-cols-[2fr,1fr]">
        <div className="space-y-6">
          <div className="rounded-3xl bg-white p-6 shadow-md">
            <h2 className="text-2xl font-bold text-ink">How to play</h2>
            <p className="mt-2 text-ink/70">{game.howToPlay}</p>
            <h3 className="mt-4 text-sm font-semibold uppercase tracking-widest text-ink/60">Learning goals</h3>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-ink/70">
              {game.learningGoals.map((goal) => (
                <li key={goal}>{goal}</li>
              ))}
            </ul>
          </div>

          {GameComponent ? (
            <div className="space-y-4 rounded-3xl bg-white p-6 shadow-md">
              {!canPlay ? (
                <div className="space-y-4 text-center">
                  <p className="text-sm text-ink/70">
                    Sign in to play and have your score saved to the leaderboard.
                  </p>
                  <Button onClick={() => void startPlay()}>Sign in & start</Button>
                </div>
              ) : (
                <GameComponent onFinish={onScore} />
              )}
              {scorePosted && <p className="text-sm text-primary">{scorePosted}</p>}
            </div>
          ) : game.iframeUrl ? (
            <iframe
              src={game.iframeUrl}
              title={game.title}
              className="h-[600px] w-full rounded-3xl border border-primary/10 bg-white"
              allowFullScreen
            />
          ) : (
            <p className="rounded-3xl bg-white p-6 text-ink/60">Game build coming soon. Stay tuned for the weekly drop.</p>
          )}
        </div>

        <aside className="space-y-6">
          <div className="rounded-3xl bg-white p-6 shadow-md">
            <h2 className="text-xl font-bold text-ink">Leaderboard</h2>
            <LeaderboardTable gameId={gameId ?? null} />
          </div>
        </aside>
      </section>
    </div>
  );
};
