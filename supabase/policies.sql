-- Enable RLS
alter table profiles enable row level security;
alter table blog_posts enable row level security;
alter table games enable row level security;
alter table scores enable row level security;
alter table ebook_requests enable row level security;
alter table orders enable row level security;
alter table contact_messages enable row level security;

-- Profiles: users can read public data and update their own profile
create policy if not exists "Public profiles read" on profiles for select using (true);
create policy if not exists "Users manage own profile" on profiles for update using (auth.uid() = id);

-- Blog posts: public read, service role writes
create policy if not exists "Public blog read" on blog_posts for select using (true);

-- Games: public read
create policy if not exists "Public games read" on games for select using (true);

-- Scores: users can insert their own scores, everyone can read aggregated data
create policy if not exists "Public scores read" on scores for select using (true);
create policy if not exists "Users insert scores" on scores for insert with check (auth.uid() = user_id);

-- Ebook requests: users insert their own, admin read
create policy if not exists "Users insert ebook requests" on ebook_requests for insert with check (auth.uid() = user_id);
create policy if not exists "Owner read ebook requests" on ebook_requests for select using (auth.role() = 'service_role');

-- Orders: read and insert restricted
create policy if not exists "Owner manage orders" on orders for all using (auth.role() = 'service_role');

-- Contact messages: service role only
create policy if not exists "Owner read contact" on contact_messages for select using (auth.role() = 'service_role');
create policy if not exists "Public send contact" on contact_messages for insert with check (true);
