# Just Another Kunambi — Static Site

Production-ready static site for **Just Another Kunambi** (Naimah Kunambi). Built with React, Vite, TailwindCSS, Supabase, and Stripe; deployable to GitHub Pages.

## Getting Started

```bash
npm install
npm run dev
```

Set environment variables in `.env.local` (copy `.env.example`):

```
VITE_SUPABASE_URL=your-project-url
VITE_SUPABASE_ANON_KEY=your-anon-key
VITE_STRIPE_PK=pk_test_xxx
```

For Edge Functions add:

```
SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...
STRIPE_SK=sk_test_xxx
STRIPE_WEBHOOK_SECRET=whsec_xxx
```

## Scripts

- `npm run dev` – start local dev server.
- `npm run build` – build production bundle.
- `npm run preview` – preview build output.

## Content & Data

- Blog posts are seeded via `src/data/blogPosts.ts` and can be migrated to Supabase `blog_posts`.
- Games metadata lives in `src/data/games.ts` with two playable mini-games (`PropertyTycoonGame`, `TypingSprintGame`).
- Supabase schema and policies are defined in `supabase/schema.sql` and `supabase/policies.sql`.
- Edge Functions for Stripe checkout + webhooks in `supabase/functions/`.

## Deploying to GitHub Pages

GitHub Actions workflow (`.github/workflows/deploy.yml`) builds and deploys `/dist` to Pages. Set repository settings to use GitHub Pages → GitHub Actions.

## Environment Notes

- Without Supabase/Stripe keys the app runs in **demo mode** (sign-in modal works but stores data locally).
- Update `public/sitemap.xml` and `robots.txt` with your actual GitHub username before going live.

## License

MIT © Naimah Kunambi
