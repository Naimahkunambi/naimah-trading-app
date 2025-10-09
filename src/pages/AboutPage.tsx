import React from 'react';
import { BRAND_NAME, OWNER_NAME, SOCIAL_FB, SOCIAL_IG, SOCIAL_LI, EMAIL_PUBLIC, PHONE_PUBLIC } from '../data/siteMeta';
import { ExternalLink } from 'lucide-react';

export const AboutPage: React.FC = () => {
  return (
    <article className="prose prose-lg max-w-none prose-headings:text-ink prose-p:text-ink/80">
      <h1>About {BRAND_NAME}</h1>
      <p>
        I’m <strong>{OWNER_NAME}</strong>, a Zanzibar-based broker with a straight-shooting reputation for helping clients move
        from hesitation to confident action. My work blends sales operations, real estate strategy, and no-fluff education so
        investors and agents can win faster.
      </p>
      <h2>Where I operate</h2>
      <p>
        Zanzibar is my base. From Stone Town heritage builds to Matemwe beach villas and Fumba smart communities, I map the
        ground realities weekly so you’re never guessing what’s next.
      </p>
      <h2>Values</h2>
      <ul>
        <li><strong>Radical honesty:</strong> Clear feedback beats polite silence.</li>
        <li><strong>Encouraging action:</strong> Every insight comes with steps you can execute today.</li>
        <li><strong>Strategic focus:</strong> We prioritize plays that compound over time.</li>
      </ul>
      <h2>Connect</h2>
      <p>
        Email <a href={`mailto:${EMAIL_PUBLIC}`}>{EMAIL_PUBLIC}</a> or call <a href={`tel:${PHONE_PUBLIC}`}>{PHONE_PUBLIC}</a>.
      </p>
      <ul>
        <li>
          <a href={SOCIAL_IG} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2">
            Instagram <ExternalLink size={16} />
          </a>
        </li>
        <li>
          <a href={SOCIAL_FB} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2">
            Facebook <ExternalLink size={16} />
          </a>
        </li>
        <li>
          <a href={SOCIAL_LI} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2">
            LinkedIn <ExternalLink size={16} />
          </a>
        </li>
      </ul>
    </article>
  );
};
