# 听页 ListenPage

上传 EPUB 电子书，通过 MiniMax Token Plan API 进行语音朗读，支持断点续读与本地书库记忆。

## 功能

- 上传 / 拖放 EPUB，解析章节与正文
- 书籍保存在浏览器 IndexedDB（刷新不丢失）
- 配置 MiniMax Token Plan API Key、节点、语音与语速
- 按段落朗读，高亮当前段落
- 点击高亮段落可暂停 / 继续；点击其他段落从此处开始朗读
- 使用 HTMLAudioElement + Media Session，浏览器退至后台仍可继续播放
- 自动保存阅读进度，下次从断点续听

## 在线访问

部署在 GitHub Pages 后访问：

`https://<你的用户名>.github.io/epub-tts-reader/`

## 本地开发

```bash
npm install
npm run dev
```

打开 [http://localhost:3000](http://localhost:3000)，先在「配置 API / 语音」中填入 MiniMax Subscription Key，再上传 EPUB。

## API 说明

- 默认使用国内节点 `https://api.minimaxi.com`
- 也可切换国际节点 `https://api.minimax.io`
- Token Plan 的 Subscription Key 与按量计费 API Key 不同，请在控制台 Billing → Token Plan 获取
- 国内账号如控制台要求 GroupId，可在设置中填写
- 浏览器直连 MiniMax（GitHub Pages 静态托管，无服务端）

## 技术栈

Next.js（静态导出） · IndexedDB · JSZip EPUB 解析 · MiniMax T2A (`/v1/t2a_v2`)
