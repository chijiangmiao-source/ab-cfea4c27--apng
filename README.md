# 星载相机 APNG 帧处置 / 透明叠加复核台

浏览器内复核交付的动态图像（APNG），重点排查**错误帧处置或透明叠加导致的中间标定画面像素历史污染**：
即使末帧看起来正确，也逐帧核对 fcTL 控制参数、解滤波像素摘要与合成画布摘要。

- 纯原生 ESM，**零第三方运行时依赖**（解析、CRC、zlib、五种滤波、混合/处置、SHA-256 均自行实现）
- 全部解析在浏览器本地完成，Base64 输入不离开页面

## 接收边界

- 8 位 / RGBA（color type 6）/ 非交错 PNG
- 宽、高均 ≤ 128，至多 8 帧
- 粘贴文本 ≤ 256 KiB Base64（可带 `data:image/png;base64,` 前缀）

## 校验与处理语义

1. **结构校验**：PNG 签名、每个块的 CRC（块类型+数据）、IHDR 约束
2. **顺序与序号**：`acTL → 首帧 fcTL → IDAT*`，其后每帧 `fcTL → fdAT*`；`fcTL/fdAT` 的
   `sequence_number` 必须从 0 起严格连续；首帧必须覆盖整个画布；帧区域不得越界；
   `acTL.num_frames` 必须等于 fcTL 数量；图像数据块必须连续
3. **稳定定位**：任何违约都抛出带**首个原始字节偏移**的错误，多次解析结果一致；
   违约时保留输入文本、清除上一次成功结论
4. **逐帧处理**：每帧数据独立拼接、独立 zlib 解压（绝不跨帧复用流）
5. **解滤波**：严格实现 None / Sub / Up / Average / Paeth 五种 PNG 扫描行还原
6. **混合**：`source`（blend_op=0，连同 alpha 直接覆盖）与 `over`（blend_op=1，PNG alpha 合成）
7. **处置**（发生在该帧显示快照冻结之后）：
   - `none`：画布保留
   - `background`：帧区域恢复全透明
   - `previous`：整画布恢复为**该帧绘制前快照**
8. **冻结快照**：对外暴露的每帧画面都是绘制后、处置前的独立拷贝；帧切换只读冻结快照，
   外部修改不影响引擎状态

页面可查看：每帧 fcTL 参数（区域、延时、dispose/blend）、解滤波像素摘要
（字节数 / SHA-256 / 非零 Alpha 像素数 / Alpha 累加）、合成画布摘要，并在
"合成画布 / 解滤波原帧" 两种画面间切换；"清空草稿与结论"移除全部记录、画布与摘要。

## 本地运行

```bash
node server.js            # http://localhost:8080
npm test                  # 30 项引擎测试
npm run check             # 页面构建检查
npm run smoke             # HTTP 冒烟（自动启停本机 server）
npm run verify            # 三步验收，退出码报告结果
```

## Docker Compose

```bash
docker compose build
docker compose up -d web          # 宿主端口默认 8080，可用 HOST_PORT=9000 覆盖
curl http://localhost:8080/healthz

# 验收服务 verify：代码测试 → 页面构建检查 → 对 web 服务的页面与 /healthz HTTP 冒烟，
# 完成后退出，退出码 0 表示全部通过
docker compose run --rm verify
```

`docker-compose.yml` 中：

- `web`：对外页面服务，映射 `${HOST_PORT:-8080}:8080`，带 `/healthz` 健康检查
- `verify`：可执行验收服务，`depends_on: service_healthy`，对 `http://web:8080`
  做页面与 `/healthz` 冒烟后退出

## 目录

```
src/apng.js            共享引擎（浏览器/Node）
public/index.html      复核台页面
public/app.js          前端交互
public/sample.js       内置三帧示例（红半透明 over → 绿半透明 over+previous → 验证恢复）
server.js              零依赖静态服务 + /healthz
test/                  node:test 引擎测试与 APNG 手工构造夹具
scripts/verify.sh      验收编排（测试 → 构建检查 → HTTP 冒烟）
```
