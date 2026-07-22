# 听页 ListenPage

上传 EPUB 电子书，通过 MiniMax Token Plan API 进行语音朗读，支持断点续读、本地书库与云端账号同步。

## 功能

- 上传 / 拖放 EPUB，解析章节与正文
- 书籍保存在浏览器 IndexedDB（刷新不丢失）
- 可选 Supabase 邮箱登录：同步电子书、阅读进度、MiniMax 设置
- 配置 MiniMax Token Plan API Key、节点、语音与语速
- 按段落朗读，高亮当前段落；支持断点续读与段间预取

## 在线访问

`https://shatianrui.github.io/epub-tts-reader/`

## 本地开发

```bash
npm install
cp .env.example .env.local   # 填入 Supabase（可选，不配则仅本机模式）
npm run dev
```

打开 [http://localhost:3000](http://localhost:3000)，先在「配置 API / 语音」中填入 MiniMax Subscription Key，再上传 EPUB。

## 云端同步（Supabase）

1. 创建 [Supabase](https://supabase.com) 项目
2. 在 SQL Editor 执行仓库内 [`supabase/schema.sql`](supabase/schema.sql)（会创建表、RLS 与 `epubs` Storage bucket）
3. Authentication → Providers 开启 Email；个人使用建议关闭 **Confirm email**，注册后可立即登录
4. Project Settings → API 复制 **Project URL** 与 **anon public** key
5. 本地：写入 `.env.local`

```env
NEXT_PUBLIC_SUPABASE_URL=https://xxxx.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ...
```

6. GitHub Pages 部署：在仓库 Settings → Secrets and variables → Actions 添加同名 Secrets：
   - `NEXT_PUBLIC_SUPABASE_URL`
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY`

未配置上述变量时，站点仍可本机使用，登录入口会显示「云端未配置」。

### 同步内容

| 数据 | 存储位置 |
| --- | --- |
| EPUB 文件 | Supabase Storage `epubs/{user_id}/{book_id}.epub` |
| 书籍元数据 | Postgres `books` |
| 阅读进度 | Postgres `reading_progress` |
| MiniMax 等设置 | Postgres `user_settings` |

登录后会自动双向同步；也可在用户菜单点击「同步数据」。

## API 说明

- 默认国内节点 `https://api.minimaxi.com`，可切换国际节点 `https://api.minimax.io`
- Token Plan Subscription Key 与按量 API Key 不同，见控制台 Billing → Token Plan
- 浏览器直连 MiniMax（静态托管无服务端代理）

## 技术栈

Next.js（静态导出） · IndexedDB · JSZip · Supabase Auth/DB/Storage · MiniMax T2A
