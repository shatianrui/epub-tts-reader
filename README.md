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

Next.js（静态导出） · IndexedDB · JSZip · Supabase Auth/DB/Storage · MiniMax T2A · Capacitor（Android）

## Android APK

本应用使用 [Capacitor](https://capacitorjs.com/) 将静态网页打包为原生 Android 应用，数据与功能与网页版一致（本地书库、MiniMax 朗读、可选 Supabase 同步）。

### 方式一：GitHub Actions 自动构建（推荐）

推送代码到 `main` 分支后，[Build Android APK](.github/workflows/build-android-apk.yml) 工作流会自动构建 Debug APK。在仓库 **Actions** 页打开对应运行记录，从 **Artifacts** 下载 `listenpage-debug-apk`。

也可在 Actions 页手动点击 **Run workflow** 触发构建。

### 方式二：本地构建

**环境要求：** Node.js 22+、JDK 21、Android SDK（含 platform-tools、platforms;android-36、build-tools）

```bash
npm install
cp .env.example .env.local   # 可选：填入 Supabase 以启用云端同步

# 构建网页并同步到 Android 工程
npm run build:mobile

# 构建 Debug APK（输出：android/app/build/outputs/apk/debug/app-debug.apk）
npm run android:debug
```

将 APK 传到手机安装即可。首次安装若提示「未知来源」，请在系统设置中允许安装。

### 在 Android Studio 中打开

```bash
npm run build:mobile
npm run cap:open
```

用 Android Studio 连接真机或模拟器运行，或构建签名 Release APK 上架应用商店。

### 发布版签名（可选）

Release 包需自行配置签名密钥，在 `android/` 目录按 [Android 官方文档](https://developer.android.com/studio/publish/app-signing) 创建 `keystore` 并在 `app/build.gradle` 中配置 `signingConfigs`，然后执行：

```bash
npm run android:release
```

## iOS

同样基于 Capacitor，`ios/` 是标准 Xcode 工程。iOS 构建**必须在 macOS 上用 Xcode 完成**（苹果限制，无法在 Linux/Windows 上编译或签名）。已针对朗读场景做了后台播放配置（`UIBackgroundModes: audio` + `AVAudioSession` 设为 `.playback`），锁屏/切后台朗读不会中断。

### 方式一：有 Mac，没有付费 Apple Developer 账号（个人免费签名）

最简单可靠，推荐这种：

```bash
npm install
npm run build:ios      # 构建网页并同步到 iOS 工程
npm run cap:open:ios   # 或手动打开 ios/App/App.xcodeproj
```

在 Xcode 里用 USB 连接 iPhone，Signing & Capabilities 里用你的免费 Apple ID 登录（Personal Team），选中你的设备点 Run，会自动签名并安装到手机。

**限制：** 免费签名的 App 每 7 天过期，需要重新连接 Xcode 打开工程再跑一次 Run 才能续期；同一 Apple ID 免费账号能装的 App 数量也有上限。

### 方式二：没有 Mac

用不到 Xcode 也能装到自己手机上，思路是让 CI 出一个**未签名**的 IPA，再用第三方工具在你自己的电脑（Windows/Mac 均可）上用免费 Apple ID 重新签名安装：

1. 仓库里的 [Build iOS IPA](.github/workflows/build-ios-ipa.yml) 工作流会在 push 到 `main` 时自动跑（或在 Actions 页手动 **Run workflow**），产出 `listenpage-unsigned-ipa` 这个 Artifact（未签名 IPA，无法直接安装）。
2. 下载后，用 [Sideloadly](https://sideloadly.io/)（或 AltStore）+ 你的免费 Apple ID，把这个未签名 IPA 重新签名并通过 USB 安装到 iPhone。
3. 同样受限于免费签名 7 天过期，Sideloadly 支持定期重新签名刷新。

### 正式签名 / 上架 App Store

需要付费 Apple Developer 账号（$99/年），配置好证书、描述文件后，把 CI 里的 `CODE_SIGNING_ALLOWED=NO` 相关参数换成正式签名配置（或在 App Store Connect / TestFlight 走标准发布流程），这里不再展开。
