-- profiles
create table if not exists profiles (
  id uuid primary key references auth.users on delete cascade,
  display_name text,
  avatar_url text,
  created_at timestamptz default now()
);

-- blog_posts
create table if not exists blog_posts (
  id bigserial primary key,
  slug text unique not null,
  title text not null,
  summary text,
  body_md text not null,
  tags text[] default '{}',
  published_at timestamptz default now(),
  author text default 'Naimah Kunambi'
);

-- games
create table if not exists games (
  id bigserial primary key,
  slug text unique not null,
  title text not null,
  category text check (category in ('sales_marketing','real_estate','skills')),
  summary text,
  how_to_play text,
  difficulty text check (difficulty in ('easy','medium','hard')) default 'easy',
  iframe_url text,
  internal_asset_path text,
  release_date date,
  created_at timestamptz default now()
);

-- scores
create table if not exists scores (
  id bigserial primary key,
  user_id uuid references auth.users on delete cascade,
  game_id bigint references games on delete cascade,
  score int not null check (score >= 0),
  meta jsonb default '{}'::jsonb,
  created_at timestamptz default now()
);
create index if not exists scores_game_idx on scores (game_id, score desc, created_at desc);

-- ebook_requests
create table if not exists ebook_requests (
  id bigserial primary key,
  user_id uuid references auth.users on delete set null,
  name text,
  email text,
  requested_titles text[],
  custom_request text,
  is_paid boolean default false,
  created_at timestamptz default now()
);

-- orders
create table if not exists orders (
  id bigserial primary key,
  user_id uuid references auth.users on delete set null,
  product_sku text not null,
  stripe_session_id text,
  stripe_payment_intent text,
  amount_cents int not null,
  currency text default 'usd',
  status text check (status in ('created','paid','failed','refunded')) default 'created',
  created_at timestamptz default now()
);

-- contact messages
create table if not exists contact_messages (
  id bigserial primary key,
  name text,
  email text,
  message text,
  created_at timestamptz default now()
);
