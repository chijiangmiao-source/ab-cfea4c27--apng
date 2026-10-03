// Browser-side review UI. It NEVER composites or unfilters anything:
// every displayed picture is a frozen snapshot produced server-side.
// Switching frames only swaps which pre-rendered data URL is shown.

const $ = (id) => document.getElementById(id);
const paste = $('paste');
const submitBtn = $('submit');
const clearBtn = $('clear');
const sizeLabel = $('size');
const errorBox = $('error');
const resultPanel = $('result-panel');
const conclusion = $('conclusion');
const framesWrap = $('frames');
const tabs = $('frame-tabs');
const regionImg = $('region-img');
const canvasImg = $('canvas-img');
const health = $('health');

let review = null; // last successful review result
let selectedFrame = 0;

const MAX_BYTES = 256 * 1024;

function fmtSize(n) {
  return `${n} / ${MAX_BYTES} 字节（${(n / 1024).toFixed(1)} KiB / 256 KiB）`;
}

paste.addEventListener('input', () => {
  sizeLabel.textContent = paste.value ? fmtSize(new Blob([paste.value]).size) : '';
});

function showError(err) {
  // Contract: on failure the draft input is retained, but all old success
  // evidence (records, canvases, summaries) is removed.
  clearEvidence({ keepDraft: true });
  errorBox.hidden = false;
  const off = err?.offset;
  errorBox.innerHTML = '';
  const p1 = document.createElement('p');
  p1.innerHTML = `复核未通过：<span class="code">${escapeHtml(err?.code || 'ERROR')}</span>`;
  const p2 = document.createElement('p');
  p2.textContent = err?.message || '未知错误';
  errorBox.appendChild(p1);
  errorBox.appendChild(p2);
  if (typeof off === 'number' && off >= 0) {
    const p3 = document.createElement('p');
    p3.innerHTML = `首个违约字节偏移：<span class="off">${off}</span>（输入已保留在草稿中，可直接修正后重提）`;
    errorBox.appendChild(p3);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function clearEvidence({ keepDraft }) {
  if (!keepDraft) {
    paste.value = '';
    sizeLabel.textContent = '';
  }
  errorBox.hidden = true;
  errorBox.innerHTML = '';
  resultPanel.hidden = true;
  conclusion.innerHTML = '';
  framesWrap.innerHTML = '';
  tabs.innerHTML = '';
  regionImg.removeAttribute('src');
  canvasImg.removeAttribute('src');
  review = null;
  selectedFrame = 0;
}

clearBtn.addEventListener('click', () => {
  // "清空后移除全部记录、画布和摘要"
  clearEvidence({ keepDraft: false });
  paste.focus();
});

function renderSummary(title, s) {
  return `<tr><td>${title}</td><td>
    <div class="digest">sha256 ${escapeHtml(s.sha256)}</div>
    <div class="meta">字节 ${s.bytes} · 非透明像素 ${s.pixels} · RGB 累加 ${s.rgbSum}</div>
  </td></tr>`;
}

function selectFrame(i) {
  if (!review) return;
  selectedFrame = i;
  const f = review.frames[i];
  // Only frozen snapshots are touched here.
  regionImg.src = f.decodedRegion.png;
  canvasImg.src = f.composedCanvas.png;
  [...tabs.querySelectorAll('button')].forEach((b, bi) => b.classList.toggle('sel', bi === i));
}

function renderResult(r) {
  review = r;
  errorBox.hidden = true;
  resultPanel.hidden = false;

  conclusion.classList.remove('bad');
  conclusion.innerHTML = `
    <div class="big">✅ 结构与像素复核通过</div>
    <div class="meta">
      画布 ${r.width}×${r.height} · 帧数 ${r.numFrames} · 循环 ${r.numPlays === 0 ? '无限' : r.numPlays}
      · 输入 ${r.inputBytes} 字节 · 输入 SHA-256 <code>${escapeHtml(r.inputSha256)}</code>
    </div>`;

  tabs.innerHTML = '';
  r.frames.forEach((f, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = `第 ${i + 1} 帧`;
    b.addEventListener('click', () => selectFrame(i));
    tabs.appendChild(b);
  });

  framesWrap.innerHTML = '';
  r.frames.forEach((f, i) => {
    const c = f.control;
    const card = document.createElement('div');
    card.className = 'frame-card';
    const chunks = f.dataChunks
      .map((d) => `<code>${d.type}@${d.offset}${d.seq === null || d.seq === undefined ? '' : `#${d.seq}`}</code>`)
      .join(' ');
    card.innerHTML = `
      <h4>帧 ${i + 1} / ${r.frames.length}</h4>
      <div class="chips">
        <span class="chip blend ${c.blend}">混合 ${c.blend} (blend_op=${c.blendOp})</span>
        <span class="chip ${c.dispose}">处置 ${c.dispose} (dispose_op=${c.disposeOp})</span>
        <span class="chip">延时 ${c.delayNum}/${c.delayDen === 0 ? 100 : c.delayDen} s ≈ ${c.delayMs} ms</span>
      </div>
      <table class="params">
        <tr><td>fcTL 流偏移</td><td><code>${c.fcTlOffset}</code></td></tr>
        <tr><td>fcTL 序号 sequence_number</td><td><code>${c.sequenceNumber}</code></td></tr>
        <tr><td>帧区域</td><td><code>${c.width}×${c.height} @ (${c.xOffset}, ${c.yOffset})</code></td></tr>
        <tr><td>承载数据块（流偏移 / 序号）</td><td>${chunks}</td></tr>
        ${renderSummary('解滤波像素摘要（帧区域）', f.decodedRegion.summary)}
        ${renderSummary('合成画布摘要（冻结快照）', f.composedCanvas.summary)}
      </table>`;
    framesWrap.appendChild(card);
  });

  selectFrame(0);
}

submitBtn.addEventListener('click', async () => {
  const b64 = paste.value.trim();
  if (!b64) {
    showError({ code: 'NO_INPUT', message: '请先粘贴 Base64 APNG 内容', offset: -1 });
    return;
  }
  submitBtn.disabled = true;
  submitBtn.textContent = '复核中…';
  try {
    const resp = await fetch('/api/review', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ base64: b64 }),
    });
    const data = await resp.json();
    if (!data.ok) {
      showError(data.error);
      return;
    }
    renderResult(data);
  } catch (e) {
    showError({ code: 'NETWORK', message: `请求失败：${e.message}`, offset: -1 });
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = '提交复核';
  }
});

async function pollHealth() {
  try {
    const resp = await fetch('/healthz', { cache: 'no-store' });
    if (!resp.ok) throw new Error();
    const j = await resp.json();
    health.textContent = `● /healthz 正常（uptime ${Math.round(j.uptime)}s）`;
    health.className = 'health ok';
  } catch {
    health.textContent = '● /healthz 不可达';
    health.className = 'health bad';
  }
}
pollHealth();
setInterval(pollHealth, 10000);
