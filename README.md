# 星载相机动态图像 APNG 复核台

零依赖（仅 Node.js 内置模块）的 APNG 严格复核服务。审查员在浏览器粘贴不超过
256 KiB 的 Base64 APNG 后提交，可查看：

- 每帧 `fcTL` 控制参数（帧区域、偏移、延时、blend_op、dispose_op、流偏移与序号）；
- 解滤波后帧区域像素摘要（SHA-256、字节数、非透明像素数、RGB 累加）与画面；
- 合成画布摘要与**冻结快照**画面（帧切换只读取服务端预渲染快照，浏览器不做任何合成）；
- 一键清空草稿与全部结论（记录、画布、摘要一并移除）。

## 验收口径

仅接受 **8 位 RGBA（color type 6）、非交错、宽高 ≤ 128、至多 8 帧**的 PNG/APNG。
解析时核对：

1. PNG 签名（逐字节，报告首个不符字节偏移）；
2. 每个块的 CRC-32（type+data）；
3. `IHDR / acTL / fcTL / IDAT / fdAT / IEND` 的合法性、出现位置与先后顺序；
4. `fcTL`/`fdAT` 序号必须从 0 起在统一序号空间内连续递增（跳号即拒）；
5. zlib 封装（CMF/FLG/FCHECK/FDICT）、DEFLATE 流完整性（含尾部冗余字节检测）与
   Adler-32；
6. 解压长度与帧区域扫描行长度一致；
7. 五种 PNG 行滤波（None/Sub/Up/Average/Paeth）逐行还原，非法滤波字节即拒。

任何违约都**保留输入草稿**、指出**首个违约字节偏移**并**清除旧成功证据**。

合成严格按 PNG/APNG 规范执行：

- 混合：`source`（整像素替换，含 alpha）与 `over`（带 alpha 的公式合成）；
- 处置：`none`（保留）、`background`（帧区域清为全透明）、`previous`
  （恢复该帧绘制前的快照）；
- 每帧显示内容在处置执行前冻结，后续帧可验证 previous 是否真正恢复背景。

## 本地运行（无需 npm install）

```bash
node src/server/server.mjs        # 默认 0.0.0.0:8080，可用 PORT/HOST 覆盖
# 或
npm start
```

## 验收命令

```bash
npm run verify
```

依次执行：`node --test` 代码测试 → `scripts/build.mjs` 页面构建检查 →
`scripts/smoke.mjs` 对页面与 `/healthz` 的 HTTP 冒烟；完成后以退出码报告结果
（0 通过，非 0 失败）。

## Docker Compose

```bash
docker compose up -d web                              # 宿主端口默认 8080
HOST_PORT=18080 docker compose up -d web              # 自定义宿主端口
curl -s http://127.0.0.1:${HOST_PORT:-8080}/healthz   # 健康检查

docker compose run --rm verify                        # 一次性验收服务
echo $?                                               # 验收退出码
```

`verify` 服务等待 `web` 健康后，在容器网络内对 `http://web:8080` 运行代码测试、
页面构建检查以及页面与 `/healthz` 的 HTTP 冒烟，随后退出并用容器退出码报告结果。

## 目录

```
src/core/      CRC32、Base64、APNG 解析/解滤波/合成、PNG 重编码
src/server/    零依赖 HTTP 服务（/、/healthz、/api/review）
web/           复核页面（构建时拷贝到 dist/）
scripts/      build.mjs（构建检查）、smoke.mjs（HTTP 冒烟）
tests/         node:test 测试与 APNG 构造/变异工具
```
