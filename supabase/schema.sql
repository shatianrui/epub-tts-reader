-- 听页 ListenPage - Supabase schema
-- 在 Supabase SQL Editor 中执行一次

create extension if not exists "pgcrypto";

-- ============================================
-- 书籍元数据（EPUB 文件放在 Storage，不入库）
-- ============================================
create table if not exists public.books (
  id uuid primary key,
  user_id uuid references auth.users(id) on delete cascade not null,
  title text not null,
  author text not null default '',
  cover_data_url text,
  file_name text not null,
  created_at bigint not null,
  updated_at bigint not null
);

create index if not exists books_user_id_idx on public.books(user_id);
create index if not exists books_updated_at_idx on public.books(updated_at desc);

-- ============================================
-- 阅读进度
-- ============================================
create table if not exists public.reading_progress (
  book_id uuid not null,
  user_id uuid references auth.users(id) on delete cascade not null,
  chapter_index integer not null default 0,
  paragraph_index integer not null default 0,
  updated_at bigint not null,
  primary key (book_id, user_id)
);

create index if not exists reading_progress_user_id_idx on public.reading_progress(user_id);

-- ============================================
-- 用户设置（含 MiniMax API Key 等）
-- ============================================
create table if not exists public.user_settings (
  user_id uuid references auth.users(id) on delete cascade primary key,
  settings jsonb not null,
  updated_at bigint not null
);

-- ============================================
-- RLS
-- ============================================
alter table public.books enable row level security;
alter table public.reading_progress enable row level security;
alter table public.user_settings enable row level security;

drop policy if exists "Users can view their own books" on public.books;
create policy "Users can view their own books"
  on public.books for select
  using (auth.uid() = user_id);

drop policy if exists "Users can insert their own books" on public.books;
create policy "Users can insert their own books"
  on public.books for insert
  with check (auth.uid() = user_id);

drop policy if exists "Users can update their own books" on public.books;
create policy "Users can update their own books"
  on public.books for update
  using (auth.uid() = user_id);

drop policy if exists "Users can delete their own books" on public.books;
create policy "Users can delete their own books"
  on public.books for delete
  using (auth.uid() = user_id);

drop policy if exists "Users can view their own progress" on public.reading_progress;
create policy "Users can view their own progress"
  on public.reading_progress for select
  using (auth.uid() = user_id);

drop policy if exists "Users can insert their own progress" on public.reading_progress;
create policy "Users can insert their own progress"
  on public.reading_progress for insert
  with check (auth.uid() = user_id);

drop policy if exists "Users can update their own progress" on public.reading_progress;
create policy "Users can update their own progress"
  on public.reading_progress for update
  using (auth.uid() = user_id);

drop policy if exists "Users can delete their own progress" on public.reading_progress;
create policy "Users can delete their own progress"
  on public.reading_progress for delete
  using (auth.uid() = user_id);

drop policy if exists "Users can view their own settings" on public.user_settings;
create policy "Users can view their own settings"
  on public.user_settings for select
  using (auth.uid() = user_id);

drop policy if exists "Users can insert their own settings" on public.user_settings;
create policy "Users can insert their own settings"
  on public.user_settings for insert
  with check (auth.uid() = user_id);

drop policy if exists "Users can update their own settings" on public.user_settings;
create policy "Users can update their own settings"
  on public.user_settings for update
  using (auth.uid() = user_id);

drop policy if exists "Users can delete their own settings" on public.user_settings;
create policy "Users can delete their own settings"
  on public.user_settings for delete
  using (auth.uid() = user_id);

-- ============================================
-- Storage: epubs bucket
-- ============================================
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'epubs',
  'epubs',
  false,
  104857600,
  array['application/epub+zip', 'application/octet-stream', 'application/zip']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- 路径约定：{user_id}/{book_id}.epub
drop policy if exists "Users can read own epubs" on storage.objects;
create policy "Users can read own epubs"
  on storage.objects for select
  using (
    bucket_id = 'epubs'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

drop policy if exists "Users can upload own epubs" on storage.objects;
create policy "Users can upload own epubs"
  on storage.objects for insert
  with check (
    bucket_id = 'epubs'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

drop policy if exists "Users can update own epubs" on storage.objects;
create policy "Users can update own epubs"
  on storage.objects for update
  using (
    bucket_id = 'epubs'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

drop policy if exists "Users can delete own epubs" on storage.objects;
create policy "Users can delete own epubs"
  on storage.objects for delete
  using (
    bucket_id = 'epubs'
    and auth.uid()::text = (storage.foldername(name))[1]
  );
