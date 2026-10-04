// 复核台前端：所有解析/合成逻辑均来自共享引擎 ../src/apng.js
import { reviewBase64, MAX_INPUT_BYTES, MAX_DIMENSION, MAX_FRAMES } from '../src/apng.js';
import { sampleBase64 } from './sample.js';

const $ = (id) => document.getElementById(id);
const srcEl = $('src');
const counterEl = $('counter');
const bannerEl = $('banner');
const resultEl = $('result');

let currentResult = null; // 仅保存最近一次成功复核结论
let activeFrame = 0;
let activeView = 'canvas'; // 'canvas' | 'reconstructed'

/* ------------------------------ 工具 ------------------------------ */

const DISPOSE_TAG = ['none', 'background', 'previous'];

function hex2(bytes) {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function putPixels(canvas, width, height, pixels) {
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(width, height);
  img.data.set(pixels.subarray(0, width * height * 4));
  ctx.putImageData(img, 0, 0);
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

/* ------------------------------ 渲染 ------------------------------ */

function showBanner(kind, html) {
  bannerEl.className = `banner ${kind}`;
  bannerEl.innerHTML = html;
}

function clearBanner() {
  bannerEl.className = 'banner';
  bannerEl.textContent = '';
}

function render() {
  if (!currentResult) {
    resultEl.innerHTML =
      '<div class="empty">尚无成功复核记录。提交合法 APNG 后在此查看逐帧控制参数、解滤波像素摘要、合成画布摘要，并可切换冻结画面。</div>';
    return;
  }
  const r = currentResult;
  const frame = r.frames[activeFrame];

  const tabs = r.frames
    .map((f, i) => `<button data-frame="${i}" class="${i === activeFrame ? 'active' : ''}">帧 ${i + 1}</button>`)
    .join('');

  resultEl.innerHTML = `
    <div class="overview">
      <div class="item"><div class="k">画布</div><div class="v">${r.width} × ${r.height}</div></div>
      <div class="item"><div class="k">帧数</div><div class="v">${r.numFrames} / ${MAX_FRAMES}</div></div>
      <div class="item"><div class="k">acTL num_plays</div><div class="v">${r.numPlays === 0 ? '0（无限循环）' : r.numPlays}</div></div>
    </div>
    <div class="frame-tabs" id="tabs">${tabs}</div>
    <div class="frame-grid">
      <div>
        <div class="canvas-wrap">
          <canvas id="display"></canvas>
          <div class="canvas-meta" id="canvas-meta"></div>
        </div>
        <div class="row">
          <button data-view="canvas" class="${activeView === 'canvas' ? 'active' : ''}">合成画布</button>
          <button data-view="reconstructed" class="${activeView === 'reconstructed' ? 'active' : ''}">解滤波原帧</button>
        </div>
      </div>
      <div>
        <div class="section-title">fcTL 控制参数（第 ${activeFrame + 1} 帧）</div>
        <table>
          <tr><th>sequence_number</th><td class="mono">${frame.sequenceNumber}</td></tr>
          <tr><th>帧区域</th><td class="mono">${frame.control.width} × ${frame.control.height} @ (${frame.control.xOffset}, ${frame.control.yOffset})</td></tr>
          <tr><th>延时</th><td class="mono">${frame.control.delayNumerator}/${frame.control.delayDenominator === 0 ? 100 : frame.control.delayDenominator} s （${frame.control.delaySeconds.toFixed(3)} s${frame.control.delayDenominator === 0 ? '，den=0 按 100 计' : ''}）</td></tr>
          <tr><th>dispose_op</th><td><span class="tag ${DISPOSE_TAG[frame.control.disposeOp]}">${frame.control.dispose}</span></td></tr>
          <tr><th>blend_op</th><td><span class="tag ${frame.control.blendOp === 1 ? 'over' : 'source'}">${frame.control.blend}</span></td></tr>
          <tr><th>图像数据块</th><td class="mono">${frame.dataKind} × ${frame.dataChunks}</td></tr>
        </table>

        <div class="section-title">解滤波像素摘要（仅该帧区域，合成前）</div>
        <table>
          <tr><th>字节数</th><td class="mono">${frame.reconstructed.bytes}</td></tr>
          <tr><th>SHA-256</th><td class="mono">${frame.reconstructed.sha256}</td></tr>
          <tr><th>非零 Alpha 像素</th><td class="mono">${frame.reconstructed.nonZeroAlphaPixels}</td></tr>
          <tr><th>Alpha 通道累加</th><td class="mono">${frame.reconstructed.alphaSum}</td></tr>
        </table>

        <div class="section-title">合成画布摘要（绘制后 / 处置前冻结快照）</div>
        <table>
          <tr><th>字节数</th><td class="mono">${frame.canvas.bytes}</td></tr>
          <tr><th>SHA-256</th><td class="mono">${frame.canvas.sha256}</td></tr>
          <tr><th>非零 Alpha 像素</th><td class="mono">${frame.canvas.nonZeroAlphaPixels}</td></tr>
          <tr><th>Alpha 通道累加</th><td class="mono">${frame.canvas.alphaSum}</td></tr>
        </table>
      </div>
    </div>
  `;

  // 画面只读取冻结快照
  const canvasEl = $('display');
  const metaEl = $('canvas-meta');
  if (activeView === 'canvas') {
    putPixels(canvasEl, r.width, r.height, frame.snapshot);
    metaEl.textContent = `合成画布冻结快照 ${r.width}×${r.height}（绘制后、处置前）`;
  } else {
    putPixels(canvasEl, frame.control.width, frame.control.height, frame.reconstructedPixels);
    metaEl.textContent = `第 ${activeFrame + 1} 帧解滤波原帧 ${frame.control.width}×${frame.control.height}`;
  }

  $('tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-frame]');
    if (!btn) return;
    activeFrame = Number(btn.dataset.frame);
    render();
  });
  resultEl.querySelectorAll('button[data-view]').forEach((btn) => {
    btn.addEventListener('click', () => {
      activeView = btn.dataset.view;
      render();
    });
  });
}

/* ------------------------------ 动作 ------------------------------ */

function updateCounter() {
  const len = srcEl.value.length;
  counterEl.textContent = `${len} / ${MAX_INPUT_BYTES} 字节`;
  counterEl.classList.toggle('over', len > MAX_INPUT_BYTES);
}

async function submitReview() {
  const text = srcEl.value;
  try {
    const result = await reviewBase64(text);
    currentResult = result; // 仅成功才覆盖旧结论
    activeFrame = 0;
    activeView = 'canvas';
    showBanner(
      'ok',
      `复核通过：${result.width}×${result.height}，共 ${result.numFrames} 帧；签名、CRC、acTL/fcTL/IDAT/fdAT 顺序与序号均有效。`,
    );
    render();
  } catch (e) {
    // 违约：保留输入文本，清除上一次成功证据
    currentResult = null;
    render();
    if (e && typeof e.offset === 'number') {
      showBanner(
        'error',
        `${esc(e.message)}\n<span class="offset">首个违约原始字节偏移：${e.offset}（0x${e.offset.toString(16).toUpperCase().padStart(4, '0')}）</span>`,
      );
    } else {
      showBanner('error', esc(e?.message || String(e)));
    }
  }
}

function clearAll() {
  srcEl.value = '';
  currentResult = null;
  activeFrame = 0;
  activeView = 'canvas';
  updateCounter();
  clearBanner();
  render();
}

srcEl.addEventListener('input', updateCounter);
$('btn-review').addEventListener('click', submitReview);
$('btn-clear').addEventListener('click', clearAll);
$('btn-sample').addEventListener('click', () => {
  srcEl.value = sampleBase64;
  updateCounter();
  submitReview();
});

srcEl.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') submitReview();
});

updateCounter();
render();

// 暴露给构建检查脚本做静态自检
if (typeof window !== 'undefined') {
  window.__apngReviewVersion = '1.0.0';
  void hex2;
}
