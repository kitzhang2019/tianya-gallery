# 天涯画廊（阿可 / Cloady 版）

零依赖 Node 展示站，跑在 Cloady（阿可）免费档上，替代免费主机 PHP 版。
免费主机那版被人机验证拦住自动推送，这版没有那道验证。

## 接口（与 PHP 版一致，管理站只改地址域名即可）

- `GET /` 画廊页：瀑布流，点图看大图、完整提示词、种子、保存原图
- `GET /images/<文件>` 原图
- `GET /api/health` 健康检查
- `POST /upload.php`（另有别名 `/upload`）multipart：
  字段 `key` / `image` / `prompt` / `model` / `seed` / `width` / `height` / `created_at`，
  成功返回 `{"ok":true,"id":"...","url":"images/..."}`。
  只接受 PNG / JPG / WebP，单张上限 10MB，画廊最多保留 200 条。

## 环境变量（Cloady 控制台里设，不要写进仓库）

- `PORT`：Cloady 自动注入
- `DATA_DIR`：持久卷挂载点，如 `/data`（不设则用应用内 `./data`，重部署会丢图）
- `SHOWCASE_KEY`：推送密钥，Secret 类型。管理站推送设置里填同一个值。

## 本地运行

```sh
SHOWCASE_KEY=test-key DATA_DIR=./data node server.js
# 再开一个终端：
# curl http://localhost:3000/api/health
```
