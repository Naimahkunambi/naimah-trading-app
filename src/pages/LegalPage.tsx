import React from 'react';

export const LegalPage: React.FC = () => {
  return (
    <article className="prose max-w-none prose-headings:text-ink prose-p:text-ink/80">
      <h1>Terms & Privacy</h1>
      <p>Last updated: August 2024</p>

      <h2>Terms of Use</h2>
      <p>
        Just Another Kunambi provides educational content, games, and services to help sales and real estate professionals level
        up. Use the site responsibly, do not attempt to exploit the leaderboards, and respect other players.
      </p>

      <h2>Privacy</h2>
      <p>
        We collect your email when you request a magic link, submit forms, or purchase services. Data is stored in Supabase and
        payment details are handled securely by Stripe. We never sell your information.
      </p>

      <h2>Cookies & Tracking</h2>
      <p>Analytics is lightweight and focused on product improvement. No retargeting ads.</p>

      <h2>Contact</h2>
      <p>Email naimah@coldwellbanker.tz with any questions or requests.</p>
    </article>
  );
};
