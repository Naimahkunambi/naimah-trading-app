import React, { useMemo, useState } from 'react';
import { seedBlogPosts } from '../data/blogPosts';
import { Link } from 'react-router-dom';
import { format } from 'date-fns';

const tags = ['All', 'Zanzibar', 'Sales Ops', 'AI Workflow', 'Investing'];

export const BlogIndexPage: React.FC = () => {
  const [activeTag, setActiveTag] = useState<string>('All');

  const filteredPosts = useMemo(() => {
    if (activeTag === 'All') return seedBlogPosts;
    return seedBlogPosts.filter((post) => post.tags.map((tag) => tag.toLowerCase()).includes(activeTag.toLowerCase()));
  }, [activeTag]);

  return (
    <div className="space-y-10">
      <div className="space-y-4">
        <h1 className="text-4xl font-bold text-ink">Blog</h1>
        <p className="max-w-2xl text-ink/70">
          Weekly strategies, stories, and systems from Zanzibar’s straight-shooting broker. Filter by topic to zero in on what
          you need.
        </p>
        <div className="flex flex-wrap gap-3">
          {tags.map((tag) => (
            <button
              key={tag}
              onClick={() => setActiveTag(tag)}
              className={`rounded-full px-4 py-2 text-sm font-semibold ${activeTag === tag ? 'bg-primary text-white' : 'bg-white text-ink/70'}`}
            >
              {tag}
            </button>
          ))}
        </div>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        {filteredPosts.map((post) => (
          <article key={post.slug} className="space-y-3 rounded-3xl border border-primary/10 bg-white p-6 shadow-sm">
            <div className="flex items-center justify-between text-xs uppercase tracking-widest text-ink/50">
              <span>{format(new Date(post.publishedAt), 'dd MMM yyyy')}</span>
              <span>{post.tags.join(' · ')}</span>
            </div>
            <h2 className="text-2xl font-bold text-ink">
              <Link to={`/blog/${post.slug}`} className="hover:text-primary">
                {post.title}
              </Link>
            </h2>
            <p className="text-sm text-ink/70">{post.summary}</p>
            <Link to={`/blog/${post.slug}`} className="text-sm font-semibold text-primary">
              Read more →
            </Link>
          </article>
        ))}
      </div>
    </div>
  );
};
