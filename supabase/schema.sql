-- 听页 ListenPage - Supabase 数据库表结构
-- 在 Supabase SQL Editor 中执行以下 SQL 来创建所需的表

-- 启用 UUID 扩展（如果尚未启用）
create extension if not exists "pgcrypto";

-- ============================================
-- 书籍表 - 存储用户的 EPUB 书籍
-- ============================================
create table if not exists public.books (
  id uuid primary key,
  user_id uuid references auth.users(id) on delete cascade not null,
  title text not null,
  author text not null default '',
  cover_data_url text,
  file_name text not null,
  epub_data text not null,
  chapters text not null,
  created_at bigint not null,
  updated_at bigint not null,
  cloud_updated_at timestamptz default now()
);

create index if not exists books_user_id_idx on public.books(user_id);
create index if not exists books_updated_at_idx on public.books(updated_at desc);

-- ============================================
-- 阅读进度表 - 存储每本书的阅读进度
-- ============================================
create table if not exists public.reading_progress (
  book_id uuid not null,
  user_id uuid references auth.users(id) on delete cascade not null,
  chapter_index integer not null default 0,
  paragraph_index integer not null default 0,
  updated_at bigint not null,
  cloud_updated_at timestamptz default now(),
  primary key (book_id, user_id)
);

create index if not exists reading_progress_user_id_idx on public.reading_progress(user_id);

-- ============================================
-- 用户设置表 - 存储用户的 API 配置和语音设置
-- ============================================
create table if not exists public.user_settings (
  user_id uuid references auth.users(id) on delete cascade primary key,
  settings jsonb not null,
  updated_at bigint not null,
  cloud_updated_at timestamptz default now()
);

-- ============================================
-- Row Level Security (RLS) 策略
-- 确保用户只能访问自己的数据
-- ============================================
alter table public.books enable row level security;
alter table public.reading_progress enable row level security;
alter table public.user_settings enable row level security;

-- 书籍表策略
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

-- 阅读进度表策略
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

-- 用户设置表策略
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
-- 自动更新 cloud_updated_at 触发器
-- ============================================
create or replace function public.update_cloud_updated_at()
returns trigger as $$
begin
  new.cloud_updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists update_books_cloud_updated_at on public.books;
create trigger update_books_cloud_updated_at
  before update on public.books
  for each row
  execute function public.update_cloud_updated_at();

drop trigger if exists update_progress_cloud_updated_at on public.reading_progress;
create trigger update_progress_cloud_updated_at
  before update on public.reading_progress
  for each row
  execute function public.update_cloud_updated_at();

drop trigger if exists update_settings_cloud_updated_at on public.user_settings;
create trigger update_settings_cloud_updated_at
  before update on public.user_settings
  for each row
  execute function public.update_cloud_updated_at();
