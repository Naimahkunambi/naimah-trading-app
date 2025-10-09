import React from 'react';
import { useParams, Link } from 'react-router-dom';
import { seedBlogPosts } from '../data/blogPosts';
import { marked } from 'marked';
import { format } from 'date-fns';

export const BlogPostPage: React.FC = () => {
  const { slug } = useParams<{ slug: string }>();
  const post = seedBlogPosts.find((item) => item.slug === slug);

  if (!post) {
    return (
      <div className="space-y-4">
        <h1 className="text-3xl font-bold text-ink">Post not found</h1>
        <Link to="/blog" className="text-primary">
          Back to blog
        </Link>
      </div>
    );
  }

  return (
    <article className="prose prose-lg max-w-none prose-headings:text-ink prose-p:text-ink/80">
      <Link to="/blog" className="text-sm font-semibold text-primary">
        ← Back to blog
      </Link>
      <h1>{post.title}</h1>
      <p className="text-sm uppercase tracking-widest text-ink/50">
        {format(new Date(post.publishedAt), 'dd MMM yyyy')} · {post.tags.join(' · ')}
      </p>
      <div dangerouslySetInnerHTML={{ __html: marked.parse(post.body) }} />
    </article>
  );
};
