# 违规记录管理系统 · Cloudflare Pages（+ Functions + KV）版

左栏登记违规记录，右栏账号名单。强制登录、账号只能由管理员建、未登录进不来。
静态页由 Pages 托管，`/api/*` 由 Pages Functions 处理，数据存在 KV 里的一个 JSON key。

```
违规记录管理系统-PF/
├─ public/                        静态页（Pages 直接托管）
│  ├─ index.html
│  ├─ styles.css
│  └─ app.js
├─ functions/
│  └─ api/
│     └─ [[path]].js              /api/* 全部请求由它处理（登录、权限、记录、账号）
├─ wrangler.toml                  Pages 项目配置 + KV 绑定
├─ package.json                   三个 npm 脚本
└─ README.md
```

关键：`functions/` 目录的名字和位置不能改，Pages 靠它把 `/api/[[path]]` 自动映射成函数路由。`public/` 里的三个文件跟以前一模一样，没有任何改动。

---

## 部署（4 步）

需要：这台电脑有 Node（`node -v` 有输出）、一个 Cloudflare 账号。

```powershell
cd "C:\Users\WUYUE\Doubao\chats\2026-11-13\new-chat\违规记录管理系统-PF"

# 1. 登录（弹浏览器，点 Allow）
npx wrangler@latest login

# 2. 建 KV 命名空间，记下输出里的 id
npx wrangler@latest kv namespace create DB

# 3. 把 id 填进 wrangler.toml 的 REPLACE_WITH_KV_ID，然后设置签名密钥
npx wrangler@latest pages secret put TOKEN_SECRET --project-name=violation-records

# 4. 部署（首次会问生产分支，填 main 回车）
npx wrangler@latest pages deploy public --project-name=violation-records --branch=main
```

成功后会打印：

```
https://violation-records.pages.dev
```

打开 → `admin / admin123` → 立刻点右上角「修改密码」。页面上不会显示任何初始凭据。

> 第 3 步如果提示项目不存在，先把第 4 步跑一遍（首次 deploy 会创建项目），再回来设密钥。

本地先试跑：`npx wrangler@latest pages dev public`，访问 http://localhost:8788，KV 是本地模拟的，不碰线上数据。

---

## 关于你之前截图那个页面

那一页（`qfserver` + 框架预设「没有」+ 构建输出目录 `/`）是**纯静态 Pages**，填完只会得到一个没有后端的站点——登录校验、账号管理全都没有，数据会退回浏览器本地存储，也就是 A 方案。

想让 Pages 带后端，必须让 `functions/` 目录一起上传。而网页「直接上传」不接受 functions 目录，只有两条路：

- 用 `wrangler pages deploy`（上面这 4 步，最省事）
- 把代码推到一个 GitHub 仓库，在 Pages 里连 Git（多一步，适合以后想自动部署）

`qfserver` 这个项目名可以留着不用，新项目叫 `violation-records`，两者不冲突。

---

## 和 Workers 版有什么不同

| | Workers 版 | Pages 版（本目录） |
|---|---|---|
| 静态页 | `[assets]` 绑定 | Pages 原生托管 |
| 后端入口 | `export default { fetch }` | `export async function onRequest` |
| 路由 | Worker 自己判断 `/api/` | Pages 用 `[[path]]` 文件名做全捕获 |
| 部署命令 | `wrangler deploy` | `wrangler pages deploy public` |
| 能力 | 完全相同 | 完全相同（同一套业务代码） |
| KV 语义 | 一样 | 一样 |

功能、字段、权限规则一致：普通账号可登记；编辑/删除记录、建号/停用/重置密码/删号仅管理员，且都在服务端校验。

---

## 已验证的 28 项

我把这个 `[[path]].js` 在 Node 里用真实 `Request`/`Response`/`crypto` 直接调用 `onRequest` 跑了一遍，全通过：

未登录 401 · 伪造 token 401 · admin 登录 · 错误密码 401 · 缺「处理结果」400 · 新增/编辑记录 · `createdBy` 正确 · 建号 201 · 重名 409 · 普通账号建号/删记录/改记录/删账号全 403 · 普通账号可登记 · 改密码后旧 token 立即失效 401 · 停用后登录 403 · 不能删自己 400 · 未知接口 404。

---

## 三个限制（和 Workers 版一样）

1. **KV 写入非原子**：两人同一秒提交会覆盖（后写赢）。五六个人日常用碰不上；要严格就换 D1。
2. **KV 免费额度**：每天 1000 次写、10 万次读。每天登记 1000 条以内没问题。
3. **大陆访问 `*.pages.dev` 慢**：晚高峰可能几秒响应。要稳就绑自己的域名 + 备案，或者继续用 110.42.57.130 那台。

---

## 备份 / 恢复

```powershell
# 备份
npx wrangler@latest kv key get db --binding=DB --remote > backup-2026-11-13.json

# 恢复（会覆盖当前全部数据）
npx wrangler@latest kv key put db --binding=DB --remote --path backup-2026-11-13.json
```

如果 `--binding=DB` 报错，换成 `--namespace-id=<你的KV id>`。

---

## 常见问题

| 现象 | 处理 |
|---|---|
| 打开网址显示 404 / 页面打不开 | `pages_build_output_dir` 和 `pages deploy public` 的目录要一致，且 `public/index.html` 存在 |
| 页面能开，登录报 500 / 「未配置 TOKEN_SECRET」 | 密钥没设：`npx wrangler@latest pages secret put TOKEN_SECRET --project-name=violation-records` |
| 登录返回 500，日志写 `KV namespace not found` | `wrangler.toml` 的 `REPLACE_WITH_KV_ID` 没替换，或 id 填错 |
| `/api/login` 返回 404 而不是 401 | `functions` 目录没被上传：确认是在项目根目录执行 `pages deploy public`，而不是在 `public` 里执行 |
| 改完代码重新部署没生效 | Pages 有缓存，等 30 秒；或加 `--commit-dirty=true` 重新 deploy |
| 忘了 admin 密码 | 删 KV 的 `db` key 会重新播种（清空全部数据，先备份）：`npx wrangler@latest kv key delete db --binding=DB --remote` |
