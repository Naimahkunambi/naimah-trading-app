import React from 'react';
import { LogoBadge } from '../components/LogoBadge';
import { Link } from 'react-router-dom';
import { seedBlogPosts } from '../data/blogPosts';
import { gamesCatalog } from '../data/games';
import { format, formatDistanceStrict } from 'date-fns';
import { CalendarDays, Gamepad2, NotebookPen } from 'lucide-react';

export const HomePage: React.FC = () => {
  const featuredPosts = seedBlogPosts.slice(0, 3);
  const featuredGames = gamesCatalog.slice(0, 3);
  const nextGame = [...gamesCatalog]
    .sort((a, b) => new Date(a.releaseDate).getTime() - new Date(b.releaseDate).getTime())[0];
  const countdown = nextGame
    ? formatDistanceStrict(new Date(nextGame.releaseDate), new Date(), { addSuffix: false })
    : null;

  return (
    <div className="space-y-16">
      <section className="rounded-3xl bg-gradient-to-br from-primary/10 via-white to-accent/10 p-10 text-center shadow-lg">
        <div className="flex flex-col items-center gap-6">
          <LogoBadge size="lg" />
          <h1 className="max-w-3xl text-4xl font-bold text-ink sm:text-5xl">
            Radically honest insights from Zanzibar’s straight-shooting broker.
          </h1>
          <p className="max-w-2xl text-lg text-ink/80">
            I’m <strong>Naimah Kunambi</strong> — I publish weekly blogs, bite-size tips, practical ebooks, and playful AI games
            that make sales & real estate easier (and smarter).
          </p>
          <div className="flex flex-wrap items-center justify-center gap-3">
            <Link to="/blog" className="rounded-full bg-primary px-5 py-2 font-semibold text-white shadow-sm hover:bg-primary/90">
              Read the Blog
            </Link>
            <Link
              to="/games"
              className="rounded-full border border-primary px-5 py-2 font-semibold text-primary hover:bg-primary/10"
            >
              Play Games
            </Link>
            <Link to="/ebooks" className="rounded-full px-5 py-2 font-semibold text-primary hover:bg-primary/10">
              Request an Ebook
            </Link>
            <Link to="/learn" className="rounded-full px-5 py-2 font-semibold text-primary hover:bg-primary/10">
              Learn Anything
            </Link>
          </div>
        </div>
      </section>

      <section className="grid gap-10 md:grid-cols-2">
        <div className="space-y-6 rounded-3xl bg-white p-8 shadow-md">
          <h2 className="flex items-center gap-2 text-2xl font-bold text-ink">
            <NotebookPen className="text-primary" /> Featured Blog
          </h2>
          <ul className="space-y-6">
            {featuredPosts.map((post) => (
              <li key={post.slug} className="rounded-2xl border border-primary/10 p-4">
                <div className="flex items-center justify-between text-xs uppercase tracking-widest text-ink/50">
                  <span>{format(new Date(post.publishedAt), 'dd MMM yyyy')}</span>
                  <span>{post.tags.join(' · ')}</span>
                </div>
                <Link to={`/blog/${post.slug}`} className="mt-2 block text-lg font-semibold text-primary">
                  {post.title}
                </Link>
                <p className="mt-2 text-sm text-ink/70">{post.summary}</p>
              </li>
            ))}
          </ul>
        </div>
        <div className="space-y-6 rounded-3xl bg-white p-8 shadow-md">
          <h2 className="flex items-center gap-2 text-2xl font-bold text-ink">
            <Gamepad2 className="text-primary" /> Featured Games
          </h2>
          {countdown && nextGame && (
            <p className="rounded-2xl bg-primary/10 px-4 py-3 text-sm font-semibold text-primary">
              Next game drops in {countdown}: {nextGame.title}
            </p>
          )}
          <ul className="space-y-6">
            {featuredGames.map((game) => (
              <li key={game.slug} className="rounded-2xl border border-primary/10 p-4">
                <div className="flex items-center justify-between text-xs uppercase tracking-widest text-ink/50">
                  <span>{format(new Date(game.releaseDate), 'dd MMM yyyy')}</span>
                  <span>{game.difficulty}</span>
                </div>
                <Link to={`/games/${game.slug}`} className="mt-2 block text-lg font-semibold text-primary">
                  {game.title}
                </Link>
                <p className="mt-2 text-sm text-ink/70">{game.summary}</p>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className="rounded-3xl bg-white p-10 shadow-lg">
        <h2 className="flex items-center gap-3 text-2xl font-bold text-ink">
          <CalendarDays className="text-primary" /> Weekly game releases
        </h2>
        <p className="mt-2 max-w-2xl text-ink/70">
          I publish one new game every week. Learn faster by doing: sales, marketing, real estate, and core skills (typing,
          grammar, reasoning). Compete on leaderboards. Win by learning.
        </p>
        <Link to="/games" className="mt-6 inline-flex text-sm font-semibold text-primary">
          Explore all games →
        </Link>
      </section>
    </div>
  );
};
