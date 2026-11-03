# AI Reader

参照 Neat Reader 做的桌面电子书阅读器，界面使用 apple-minimal 设计语言，并新增两项功能：

- **多级文件夹分类（类似 Zotero）**：文件夹可以无限嵌套；一本书可以同时放在多个文件夹里；拖拽图书到文件夹即可归类，拖拽文件夹可以排序或嵌套；可选“在文件夹中显示子文件夹的书”。导入整个文件夹时会按原目录结构自动建好文件夹。
- **AI 辅助阅读**：填入自己的 API Key 后，选中文字即可“AI 解释 / 翻译”，也可以一键总结本章、讲解本页、列关键概念、出思考题，或自由提问。AI 会自动附带当前章节或当前页的原文作为上下文。回答可以保存到笔记。

## 功能一览

| 模块 | 功能 |
| --- | --- |
| 格式 | EPUB、PDF、TXT（自动识别 UTF-8 / GBK，自动分章）、MOBI、AZW3、FB2、CBZ |
| 书库 | 封面 / 列表视图，按最近阅读、添加时间、书名、作者、进度排序，搜索，收藏，阅读状态，格式分类，多选批量操作，拖入文件导入，自动解析书名、作者、封面 |
| 阅读 | 分页 / 滚动、单栏 / 双栏，字体、字号、行距、段距、边距、版心宽度，五种背景（白、米黄、护眼、浅灰、夜间），PDF 适应页面 / 宽度 |
| 标注 | 五色高亮、下划线、笔记、书签，笔记面板按颜色筛选，导出 Markdown |
| 其他 | 目录、全文搜索、进度条跳转、朗读（系统语音）、全屏、深色模式、老板键（默认 Alt+Q）、双击文件用本程序打开 |

## AI 服务

在“设置 → AI 助手”中选择服务商并填入 API Key：

- **Anthropic Claude**（默认模型 `claude-opus-5-5`），通过官方 SDK 调用；
- **OpenAI 兼容接口**：OpenAI、DeepSeek、通义千问、Kimi、智谱、硅基流动、OpenRouter 或自定义地址。

Key 只保存在本机的应用数据目录中。

## 运行

```bash
npm install
npm run dev      # 开发模式（Vite 热更新 + Electron）
npm start        # 构建后运行
npm run dist     # 打包 Windows 安装程序 → release/AI-Reader-Setup-<版本>.exe
```

## 发布与自动更新

已安装的程序启动 5 秒后会检查 GitHub Releases，发现新版本就在后台下载，下载完成后右下角提示“重启更新”；不点的话，下次退出时也会自动安装。“设置 → 关于”里可以手动检查更新或关闭自动检查。

改完代码、提交后，一条命令发布新版本：

```bash
npm run release -- patch   # 1.1.0 → 1.1.1，自动提交、打 tag、推送、打包并上传到 GitHub Releases
```

也可以用 `minor`、`major` 或具体版本号（如 `1.2.0`）。发布需要先用 `gh auth login` 登录 GitHub，发布说明取自上个版本以来的提交标题。仓库需保持公开，客户端才能匿名读取 Releases。上传内容包括安装包、`.blockmap`（增量下载用）和 `latest.yml`（客户端靠它判断最新版本），缺了 `latest.yml` 客户端就检测不到更新。

应用图标由 `scripts/make-icon.ps1` 生成到 `build/icon.png`。

数据保存在 `%APPDATA%/AI Reader/library/`（图书副本、封面、笔记、AI 对话），卸载程序不会删除这些数据。

## 结构

```
electron/      主进程：书库存储、导入、自定义协议、AI 调用、自动更新
src/library/   书库界面：侧栏文件夹树、网格 / 列表、右键菜单、拖拽
src/reader/    阅读器：翻页、标注、目录、搜索、排版、朗读、AI 面板
src/lib/       foliate-js 加载、TXT 分章、弹层组件
public/foliate-js/  渲染引擎 foliate-js（MIT），含少量兼容性修改（标注 “AI Reader”）
```
