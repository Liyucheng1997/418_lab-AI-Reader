# 发现

- 当前 AI 生成推荐列表，Google Books/Open Library 补封面，Gutendex 查询公版 EPUB，主进程下载导入。
- EAPI 研究文档：https://github.com/baroxyton/zlibrary-eapi-documentation 和 https://github.com/heartleo/zlib/blob/main/docs/eapi.md 。均为非官方接入，地址、认证可能变化。
- 会话使用 remix_userid/remix_userkey；检索 POST /eapi/book/search；下载链接 GET /eapi/book/{id}/{hash}/file。
- 不写死镜像，不保存账号密码；由用户配置 HTTPS 地址，会话凭据通过 Electron safeStorage 加密保存。
- Electron 45 的 net.fetch 在 credentials: omit 时仍会发送显式 Cookie 请求头，已用仅监听 127.0.0.1 的测试服务器确认；跨域下载与重定向不附带会话头。
