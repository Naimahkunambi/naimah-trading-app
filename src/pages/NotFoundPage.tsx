import React from 'react';
import { Link } from 'react-router-dom';

export const NotFoundPage: React.FC = () => {
  return (
    <div className="space-y-4 text-center">
      <h1 className="text-5xl font-bold text-ink">404 — Lost at sea</h1>
      <p className="text-ink/70">This wave doesn’t exist. Paddle back home and keep exploring.</p>
      <Link to="/" className="rounded-full bg-primary px-6 py-3 font-semibold text-white">
        Back home
      </Link>
    </div>
  );
};
