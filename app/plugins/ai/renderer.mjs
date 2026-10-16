const L = window.CanvasI18n;
// Built-in optional AI assistant. The core owns lifecycle and the UI extension points.
export async function activate(ctx) {
  const $ = selector => document.querySelector(selector);
  const { esc, html2text, renderMarkdown, toast, codeOf, parseTime, fmtCountdown } = ctx.utils;
  const api = Object.fromEntries([
    ['aiPresets', 'ai-presets'], ['aiConfigLoad', 'ai-config-load'],
    ['aiConfigSave', 'ai-config-save'], ['aiTest', 'ai-test'], ['aiProbe', 'ai-probe'],
    ['aiChat', 'ai-chat'], ['analyzeCourse', 'analyze-course'],
    ['cancelAnalysis', 'cancel-analysis'], ['loadAnalysis', 'load-analysis'],
  ].map(([name, method]) => [name, (...args) => ctx.api.invoke(method, ...args)]));
  let courses = [], filesBy = {}, selectedCourse = 'all', currentDetail = null;
  let aiPresets = {}, analysisProgress = {}, detailGeneration = 0;
  const syncContext = () => {
    ({ courses, filesBy, selectedCourse, currentDetail } = ctx.data.snapshot());
  };
  const currentRequest = (request, detail) => ctx.isActive() && request === detailGeneration
    && currentDetail?.cid === detail.cid && currentDetail?.a.id === detail.a.id;
  ctx.ui.addStylesheet(new URL('./style.css', import.meta.url).href);
  const view = document.createElement('div');
  view.innerHTML = ANALYSIS_CONTENT;
  ctx.ui.registerBoard({ id: 'analysis', title: L.t('课程结构分析'), content: view.firstElementChild });
  ctx.ui.addDetailAction({ id: 'detail-interpret', label: L.t('✨ AI 解读'), className: 'primary', onClick: interpretCurrent });
  ctx.ui.addDetailAction({ id: 'detail-plan-btn', label: L.t('📋 生成作业方案'), className: 'primary', onClick: generatePlan });
  ctx.ui.addDetailPanel({ id: 'detail-interpretation', className: 'detail-translation hidden' });
  ctx.ui.addDetailPanel({ id: 'detail-plan', className: 'detail-translation plan hidden' });
  const config = document.createElement('div');
  config.className = 'plugin-config-fields';
  config.innerHTML = SETTINGS_CONTENT;
  ctx.ui.addSettingsSection(L.t('AI 助手设置'), config);
  ctx.ui.registerAnnouncementAction({ id: 'ai-summary', label: L.t('✨ AI 摘要'), className: 'primary',
    onClick: ({ cid, ann, bodyElement, button }) => summarizeAnnouncement(cid, ann, bodyElement, button) });
  ctx.lifecycle.onDetail(() => {
    syncContext(); ++detailGeneration; hideInterpretation(); hidePlan();
  });
  ctx.lifecycle.onRender(() => { syncContext(); return renderAnalysis(); });
  ctx.lifecycle.onSettingsOpen(() => configureSettings());
  ctx.api.on('analysis-progress', p => {
    const prev = analysisProgress[p.courseId] || {};
    analysisProgress[p.courseId] = { ...prev, ...p, running: p.stage !== 'done' && p.stage !== 'error' };
    syncContext();
    if (selectedCourse === p.courseId) return renderAnalysis();
  });

function hideInterpretation() {
  const box = $('#detail-interpretation');
  box.classList.add('hidden');
  box.textContent = '';
  const btn = $('#detail-interpret');
  btn.disabled = false;
  btn.textContent = L.t('✨ AI 解读');
}

function hidePlan() {
  const box = $('#detail-plan');
  box.classList.add('hidden');
  box.innerHTML = '';
  const btn = $('#detail-plan-btn');
  btn.disabled = false;
  btn.textContent = L.t('📋 生成作业方案');
}

async function interpretCurrent() {
  if (!currentDetail) return;
  const request = detailGeneration, detail = currentDetail;
  const btn = $('#detail-interpret');
  const { a } = detail;
  const text = html2text(a.description || '');
  if (!text) { toast(L.t('这项作业没有说明文字,无法解读')); return; }
  btn.disabled = true;
  btn.textContent = L.t('解读中…');
  try {
    const out = await api.aiChat({
      system: L.t('你是课程助教,帮学生快速理解作业。用简体中文输出,严格按以下结构,不要输出其他内容:\n【题目】一两句话说明这是什么作业\n【你要做什么】分点列出具体任务\n【注意】截止时间/字数或格式要求/提交方式/评分标准(说明里有的才写,没有就写"说明中未提及")'),
      user: L.html`作业名:${a.name}\n截止:${a.due_at || L.t('无')}\n满分:${a.points ?? '?'}\n\n作业说明:\n${text.slice(0, 10000)}`,
    });
    if (!currentRequest(request, detail)) return;
    const box = $('#detail-interpretation');
    box.innerHTML = renderMarkdown(out);
    box.classList.remove('hidden');
    btn.textContent = L.t('重新解读');
  } catch (e) {
    if (!currentRequest(request, detail)) return;
    toast(L.t('解读失败:') + e.message);
    btn.textContent = L.t('✨ AI 解读');
  } finally {
    if (currentRequest(request, detail) && btn.isConnected) btn.disabled = false;
  }
}

// ---------- 生成作业方案 ----------

async function generatePlan() {
  if (!currentDetail) return;
  const request = detailGeneration, detail = currentDetail;
  const btn = $('#detail-plan-btn');
  const { cid, a } = detail;
  const text = html2text(a.description || '');
  const due = parseTime(a.due_at);
  const left = due && due > new Date() ? fmtCountdown(due) : L.t('无截止或已过期');
  btn.disabled = true;
  btn.textContent = L.t('方案生成中…');
  const box = $('#detail-plan');
  box.classList.remove('hidden');
  box.innerHTML = L.t('<i class="note-muted">AI 正在制定方案(可能需要十几秒)…</i>');
  try {
    let courseContext = '';
    try {
      const saved = await api.loadAnalysis(cid);
      if (saved && saved.report) courseContext = L.t('\n\n【课程背景(此前的课程结构分析报告节选)】\n') + saved.report.slice(0, 3000);
    } catch (e) { /* 无分析报告也不影响 */ }
    const out = await api.aiChat({
      system: [
        L.t('你是资深助教,帮学生制定完成这份作业的可执行计划。基于作业说明输出;说明里没有的信息不要编造,可以给通用建议并注明"请以老师要求为准"。用简体中文 markdown,严格按以下标题分节:'),
        L.t('【🎯 作业目标】这个作业要产出什么、考察什么能力,一两句'),
        L.t('【📋 步骤计划】按顺序分解要做的事,每步一行,标注预计耗时'),
        L.t('【⏱ 时间安排】结合剩余时间给出到截止前的日程建议(今天做什么、之后每天做什么)'),
        L.t('【✅ 提交前自查】格式、命名、附件、字数等提交前检查项'),
        L.t('【⚠️ 风险提示】最容易丢分的点,以及什么情况应尽早问老师/助教'),
      ].join('\n'),
      user: L.html`课程:${codeOf(cid)}\n作业名:${a.name}\n截止:${a.due_at || L.t('无')}(距今 ${left})\n满分:${a.points ?? '?'}\n\n作业说明:\n${(text || L.t('(作业没有说明文字,请按作业名推断大概任务,并在开头提醒学生先确认具体要求)')).slice(0, 12000)}${courseContext}`,
    });
    if (!currentRequest(request, detail)) return;
    box.innerHTML = renderMarkdown(out);
    btn.textContent = L.t('重新生成');
  } catch (e) {
    if (!currentRequest(request, detail)) return;
    box.innerHTML = L.html`<i class="note-bad">生成失败:${esc(e.message)}</i>`;
    btn.textContent = L.t('📋 生成作业方案');
  } finally {
    if (currentRequest(request, detail) && btn.isConnected) btn.disabled = false;
  }
}

// ---------- 导学报告(结构化渲染:格式固定,与模型/课程无关) ----------

function renderGuide(s) {
  const RISK = { '低': ['low', L.t('😀 低')], '中': ['mid', L.t('⚠️ 中')], '高': ['high', L.t('❗ 高')] };
  const [riskCls, riskTxt] = RISK[s.risk && s.risk.level] || RISK[L.t('中')];
  const rows = (s.gradingRows || []).map(r =>
    `<tr><td>${esc(r.name)}</td><td>${esc(r.points)}</td><td>${esc(r.weight)}</td><td>${esc(r.due)}</td></tr>`).join('');
  const dates = (s.dates || []).map(d => `<li><span>${esc(d.item)}</span><span class="g-due">${esc(d.due)}</span></li>`).join('')
    || L.t('<li><span>未来两周没有待截止作业</span></li>');
  const res = (s.resources || []).map(r => `<li><span>${esc(r.name)}</span><span class="g-due">${esc(r.when)}</span></li>`).join('')
    || L.t('<li><span>无特别推荐</span></li>');
  const tips = (s.tips || []).map(t => `<li>${esc(t)}</li>`).join('');
  return L.html`<div class="guide-report">
    <h1 class="g-title">【${esc(s.code || '')} 导学报告】</h1>
    <div class="g-risk ${riskCls}">挂科风险:${riskTxt}</div>
    <table class="g-table">
      <thead><tr><th>名称</th><th>满分</th><th>占比</th><th>截止时间</th></tr></thead>
      <tbody>${rows || L.t('<tr><td colspan="4">未从材料中解析出评分构成,建议向老师确认</td></tr>')}</tbody>
    </table>
    ${s.gradingNote ? `<p class="g-note">${esc(s.gradingNote)}</p>` : ''}
    <h2 class="g-h2">【一句话总结如何通过课程】</h2>
    <p class="g-oneliner">${esc(s.oneLiner || '')}</p>
    <details class="g-details">
      <summary>展开详细攻略</summary>
      <div class="g-guide-body">
        <h3 class="g-h3">【挂科风险与应对】</h3>
        <p>${esc((s.risk && s.risk.reason) || '')}</p>
        <h3 class="g-h3">【关键日期】</h3>
        <ul class="g-list">${dates}</ul>
        <h3 class="g-h3">【推荐资源】</h3>
        <ul class="g-list">${res}</ul>
        <h3 class="g-h3">【学习建议】</h3>
        <ul class="g-list">${tips || L.t('<li>无</li>')}</ul>
      </div>
    </details>
  </div>`;
}

async function summarizeAnnouncement(cid, ann, bodyEl, button) {
  const text = html2text(ann.message || '');
  if (!text) { toast(L.t('公告没有正文,无法摘要')); return; }
  const box = document.createElement('div');
  box.className = 'detail-translation ann-summary';
  box.textContent = L.t('AI 摘要生成中…');
  ctx.ui.trackElement(box);
  bodyEl.after(box);
  button.disabled = true;
  try {
    const out = await api.aiChat({
      system: L.t('你是课程助教。用简体中文 3 条以内要点总结这条课程公告:老师要求学生做什么、有什么截止时间或注意点。只输出要点。'),
      user: L.html`课程:${codeOf(cid)}\n公告标题:${ann.title}\n发布时间:${ann.posted_at || '?'}\n\n公告正文:\n${text.slice(0, 8000)}`,
    });
    if (ctx.isActive() && box.isConnected) box.innerHTML = renderMarkdown(out);
  } catch (e) {
    if (ctx.isActive() && box.isConnected) box.textContent = L.t('摘要失败:') + e.message;
  } finally {
    if (ctx.isActive() && button.isConnected) button.disabled = false;
  }
}

const STAGE_LABEL = {
  web: L.t('① 🌐 抓取课程资料'), select: L.t('② 🧠 AI 筛选材料'), download: L.t('③ ⬇ 下载课件'),
  extract: L.t('④ 📝 提取文本'), ai: L.t('⑤ 🤖 AI 逐份摘要'), final: L.t('⑥ 📊 生成报告'),
  done: L.t('✔ 完成'), error: L.t('✖ 失败'),
};

let analysisRenderRequest = 0;

async function renderAnalysis() {
  if (!ctx.isActive()) return;
  const request = ++analysisRenderRequest;
  if (selectedCourse === 'all') {
    $('#analysis-course-name').textContent = '';
    $('#analysis-cost-hint').textContent = L.t('请在左侧选择一门具体课程');
    $('#analysis-start').classList.add('hidden');
    $('#analysis-cancel').classList.add('hidden');
    $('#analysis-progress').classList.add('hidden');
    $('#analysis-result').innerHTML = '';
    return;
  }
  const cid = selectedCourse;
  const p = analysisProgress[cid];
  const running = !!(p && p.running);
  const startBtn = $('#analysis-start');
  startBtn.classList.remove('hidden');
  startBtn.disabled = running;
  startBtn.textContent = running ? L.t('分析中…') : L.t('▶ 开始分析');
  $('#analysis-cancel').classList.toggle('hidden', !running);
  const course = courses.find(c => c.id === cid);
  $('#analysis-course-name').textContent = course ? course.name : codeOf(cid);

  const docs = ((filesBy[cid] || {}).files || []).filter(f => /\.(pdf|pptx|docx)$/i.test(f.filename));
  $('#analysis-cost-hint').textContent = running ? '' : L.html`手动启动 · 预计处理 ${docs.length} 份课件 + 作业/大纲数据,将消耗你的 API 额度`;

  const progBox = $('#analysis-progress');
  if (p) {
    progBox.classList.remove('hidden');
    const total = p.total || 1;
    const pct = Math.max(0, Math.min(100, Math.round(((p.current || 0) / total) * 100)));
    progBox.innerHTML =
      `<div class="prog-line">${STAGE_LABEL[p.stage] || esc(p.stage)}${p.total ? ` ${Math.min(p.current || 0, p.total)}/${p.total}` : ''}</div>` +
      `<div class="prog-detail">${esc(p.detail || '')}</div>` +
      (p.stage === 'done' || p.stage === 'error' ? '' : `<div class="prog-bar"><div class="prog-fill" style="width:${pct}%"></div></div>`);
  } else {
    progBox.classList.add('hidden');
  }

  const resultBox = $('#analysis-result');
  if (resultBox.dataset.course !== String(cid)) {
    resultBox.dataset.course = cid;
    resultBox.innerHTML = L.t('<div class="empty" role="status">正在读取课程报告…</div>');
  }
  const saved = await api.loadAnalysis(cid);
  if (!ctx.isActive() || request !== analysisRenderRequest || cid !== selectedCourse) return;
  if (saved) {
    const t = new Date(saved.generatedAt);
    const pad = n => String(n).padStart(2, '0');
    const meta = L.html`<div class="analysis-meta">上次分析:${pad(t.getMonth() + 1)}-${pad(t.getDate())} ${pad(t.getHours())}:${pad(t.getMinutes())}(点「开始分析」可重新生成)</div>`;
    resultBox.innerHTML = meta +
      (saved.structured ? renderGuide(saved.structured) : `<div class="analysis-report">${renderMarkdown(saved.report)}</div>`);
    $('#board-meta-analysis').textContent = running ? L.t('分析中') : L.html`${pad(t.getMonth() + 1)}-${pad(t.getDate())} 生成`;
  } else {
    resultBox.innerHTML = running ? '' : L.t('<div class="empty"><strong>还没有导学报告</strong><p>点「开始分析」，AI 会读完课件和大纲，整理出评分构成、关键日期和学习建议。</p></div>');
    $('#board-meta-analysis').textContent = running ? L.t('分析中') : L.t('未分析');
  }
}

async function startAnalysis() {
  if (selectedCourse === 'all') return;
  const cid = selectedCourse;
  analysisProgress[cid] = { stage: 'web', detail: L.t('准备中…'), running: true, current: 0, total: 1 };
  void renderAnalysis().catch(error => { if (ctx.isActive()) toast(L.t('读取报告失败:') + error.message); });
  try {
    await api.analyzeCourse(cid);
    if (!ctx.isActive()) return;
  } catch (e) {
    if (!ctx.isActive()) return;
    analysisProgress[cid] = { stage: 'error', detail: e.message, running: false };
    void renderAnalysis().catch(error => { if (ctx.isActive()) toast(L.t('读取报告失败:') + error.message); });
    toast(L.t('分析失败:') + e.message);
    return;
  }
  analysisProgress[cid] = { ...(analysisProgress[cid] || {}), running: false };
  void renderAnalysis().catch(error => { if (ctx.isActive()) toast(L.t('读取报告失败:') + error.message); });
}

function providerKey() { return $('#ai-provider').value; }

let settingsProfiles = {};       // provider -> {baseUrl, model, apiKey},各服务商独立保存
let currentProfileKey = null;    // 表单当前显示的是哪个服务商的档案

// 把表单里当前的内容暂存到它所属服务商的档案。
// 注意不能用下拉框当前值做 key:change 触发时下拉框已经是新服务商,而表单里还是旧服务商的内容
function stashCurrentProfile() {
  const key = currentProfileKey || providerKey();
  settingsProfiles[key] = {
    baseUrl: $('#ai-baseurl').value.trim(),
    model: $('#ai-model').value.trim(),
    apiKey: $('#ai-key').value.trim(),
  };
}

function applyProviderUI(key) {
  const p = aiPresets[key] || {};
  const prof = settingsProfiles[key] || {};
  // 预设服务商:接口地址和模型都自动带,用户只填 Key
  $('#ai-baseurl-row').classList.toggle('hidden', key !== 'custom');
  $('#ai-baseurl').value = prof.baseUrl || p.baseUrl || '';
  $('#ai-model').value = key === 'custom' ? (prof.model || '') : (p.model || '');
  $('#ai-model').readOnly = key !== 'custom';
  $('#ai-model').placeholder = key === 'custom' ? L.t('模型名(OpenAI 兼容)') : L.t('预设服务商仅支持此模型,不可更改');
  $('#ai-key').value = prof.apiKey || '';
  const link = $('#ai-key-link');
  if (p.keyUrl) {
    link.classList.remove('hidden');
    link.textContent = L.html`↗ 前往 ${p.label} 控制台获取 / 购买 API Key`;
  } else {
    link.classList.add('hidden');
  }
  currentProfileKey = key;
  const raw = aiCfgRaw || {};
  const sameModel = raw.provider === key && (!raw.thinkingModel || raw.thinkingModel === $('#ai-model').value)
    && (!raw.thinkingBaseUrl || raw.thinkingBaseUrl === $('#ai-baseurl').value);
  thinkingLevels = sameModel && Array.isArray(raw.thinkingLevels) && raw.thinkingLevels.length
    ? raw.thinkingLevels.slice() : DEFAULT_LEVELS.slice();
  probedFor = sameModel && raw.thinkingModel ? effortIdentity(collectCfg()) : null;
}

// 测试连接用:当前表单的生效配置(思考档位取顶栏滑块)
function collectCfg() {
  return {
    provider: providerKey(),
    baseUrl: $('#ai-baseurl').value.trim(),
    model: $('#ai-model').value.trim(),
    apiKey: $('#ai-key').value.trim(),
    effort: currentEffort(),
  };
}

// ---------- 设置内:AI 状态 + 思考档位三选(快速/均衡/深度) ----------

const DEFAULT_LEVELS = ['disabled', 'low', 'high', 'max']; // 探测失败时的兜底档位
let thinkingLevels = DEFAULT_LEVELS.slice();
let aiCfgRaw = null;      // ai_config.json 原始内容
let probedFor = null;

function effortIdentity(cfg) {
  return JSON.stringify([cfg.provider, cfg.baseUrl, cfg.model]);
}

function effectiveEffort(raw) {
  return (raw && raw.effort) || ((raw && raw.thinkingMode) === 'fast' ? 'disabled' : 'high');
}

function currentEffort() {
  const i = thinkingLevels.indexOf(effectiveEffort(aiCfgRaw));
  return i >= 0 ? thinkingLevels[i] : thinkingLevels[thinkingLevels.length - 1];
}

// 档位归为三档:快速=关思考 / 均衡=低中档 / 深度=高档
function effortClass(level) {
  if (level === 'disabled') return 'fast';
  if (['minimal', 'low', 'medium'].includes(level)) return 'balanced';
  return 'deep';
}

function classToLevel(cls) {
  if (cls === 'fast') return thinkingLevels.includes('disabled') ? 'disabled' : null;
  const pool = cls === 'balanced' ? ['medium', 'low', 'minimal'] : ['max', 'high'];
  return pool.find(l => thinkingLevels.includes(l)) || null;
}

function refreshAiStatus() {
  const raw = aiCfgRaw || {};
  const provider = providerKey() || raw.provider || 'custom';
  const preset = aiPresets[provider] || {};
  const model = $('#ai-model').value || preset.model || L.t('未填模型');
  const hasKey = !!$('#ai-key').value.trim();

  $('#ai-status-model').textContent = hasKey ? L.html`🤖 当前模型:${model}` : L.t('🎁 内测免费额度已开启(无需填 Key 即可使用 AI 功能)');

  const seg = $('#effort-seg');
  seg.classList.toggle('hidden', !hasKey || provider === 'custom');
  if (hasKey && provider !== 'custom') {
    const cur = effortClass(effectiveEffort(raw));
    seg.querySelectorAll('button').forEach(btn => {
      const cls = btn.dataset.effort;
      btn.classList.toggle('active', cls === cur);
      btn.disabled = !classToLevel(cls); // 模型不支持的档位(如不可关思考)置灰
    });
  }
}

// 探测结果只保留在当前设置草稿,统一保存时再提交。
async function probeEfforts(cfg) {
  try {
    const p = await api.aiProbe(cfg || null);
    if (ctx.isActive() && effortIdentity(cfg) === effortIdentity(collectCfg())
        && p && p.ok && Array.isArray(p.levels) && p.levels.length) {
      thinkingLevels = p.levels;
      probedFor = effortIdentity(cfg);
      refreshAiStatus();
      return true;
    }
  } catch (e) { /* 探测失败用兜底档位 */ }
  return false;
}

async function testAi() {
  const btn = $('#ai-test-btn');
  btn.disabled = true;
  btn.textContent = L.t('测试中…');
  try {
    const cfg = collectCfg();
    const r = await api.aiTest(cfg);
    if (!ctx.isActive()) return;
    toast(L.t('连接成功,模型回复:') + r.slice(0, 40));
    await probeEfforts(cfg);
  } catch (e) {
    if (ctx.isActive()) toast(L.t('测试失败:') + e.message);
  } finally {
    if (ctx.isActive() && btn.isConnected) { btn.disabled = false; btn.textContent = L.t('测试连接'); }
  }
}


  async function configureSettings() {
    const raw = await api.aiConfigLoad();
    if (!ctx.isActive()) return;
    aiCfgRaw = raw || {};
    settingsProfiles = structuredClone(raw?.profiles || {});
    const cur = raw?.provider && aiPresets[raw.provider] ? raw.provider : Object.keys(aiPresets)[0];
    $('#ai-provider').value = cur;
    applyProviderUI(cur);
    refreshAiStatus();
  }
  aiPresets = await api.aiPresets();
  if (!ctx.isActive()) return;
  for (const [key, preset] of Object.entries(aiPresets)) {
    const option = document.createElement('option'); option.value = key; option.textContent = preset.label;
    $('#ai-provider').append(option);
  }
  await configureSettings();
  if (!ctx.isActive()) return;
  $('#ai-provider').onchange = () => { stashCurrentProfile(); applyProviderUI(providerKey()); refreshAiStatus(); };
  for (const field of ['#ai-model', '#ai-key', '#ai-baseurl']) $(field).oninput = refreshAiStatus;
  $('#ai-key-link').onclick = () => {
    const preset = aiPresets[providerKey()]; if (preset?.keyUrl) ctx.api.openUrl(preset.keyUrl);
  };
  $('#ai-test-btn').onclick = testAi;
  ctx.lifecycle.onSettingsSave(async () => {
    stashCurrentProfile();
    const cfg = collectCfg();
    const next = { ...(aiCfgRaw || {}), provider: cfg.provider, effort: cfg.effort, profiles: structuredClone(settingsProfiles) };
    if (probedFor === effortIdentity(cfg)) {
      next.thinkingLevels = thinkingLevels.slice(); next.thinkingModel = cfg.model;
      next.thinkingProvider = cfg.provider; next.thinkingBaseUrl = cfg.baseUrl;
    } else if (next.thinkingModel && (next.thinkingModel !== cfg.model || next.provider !== aiCfgRaw?.provider)) {
      delete next.thinkingLevels; delete next.thinkingModel; delete next.thinkingProvider; delete next.thinkingBaseUrl;
    }
    await api.aiConfigSave(next);
    if (ctx.isActive()) { aiCfgRaw = next; refreshAiStatus(); }
  });
  $('#analysis-start').onclick = startAnalysis;
  $('#analysis-cancel').onclick = async () => {
    if (selectedCourse !== 'all') {
      try { await api.cancelAnalysis(selectedCourse); if (ctx.isActive()) toast(L.t('已请求取消,稍候…')); }
      catch (error) { if (ctx.isActive()) toast(L.t('取消失败:') + error.message); }
    }
  };
  for (const button of document.querySelectorAll('#effort-seg button')) {
    button.onclick = () => {
      const level = classToLevel(button.dataset.effort); if (!level) return;
      aiCfgRaw = { ...(aiCfgRaw || {}), effort: level }; refreshAiStatus();
    };
  }
  syncContext();
  hideInterpretation(); hidePlan();
  void renderAnalysis().catch(error => { if (ctx.isActive()) toast(L.t('读取报告失败:') + error.message); });
  return () => { ++analysisRenderRequest; ++detailGeneration; };
}

const ANALYSIS_CONTENT = L.t("            <div id=\"analysis-view\">\n              <div class=\"analysis-toolbar\">\n                <span id=\"analysis-course-name\"></span>\n                <button id=\"analysis-cancel\" class=\"hidden\">取消</button>\n                <button id=\"analysis-start\" class=\"primary\">▶ 开始分析</button>\n                <span id=\"analysis-cost-hint\" class=\"synced\"></span>\n              </div>\n              <div id=\"analysis-progress\" class=\"hidden\"></div>\n              <div id=\"analysis-result\"></div>\n            </div>\n");
const SETTINGS_CONTENT = L.t("      <div class=\"ai-status\">\n        <span id=\"ai-status-model\">🤖 未配置模型</span>\n        <div id=\"effort-seg\" class=\"seg hidden\" title=\"AI 思考档位:影响所有 AI 功能的速度与深度\">\n          <button data-effort=\"fast\">⚡ 快速</button>\n          <button data-effort=\"balanced\">⚖️ 均衡</button>\n          <button data-effort=\"deep\">🎯 深度</button>\n        </div>\n      </div>\n      <label>AI 服务商\n        <select id=\"ai-provider\"></select>\n      </label>\n      <label id=\"ai-baseurl-row\">API 地址(Base URL)<input id=\"ai-baseurl\" placeholder=\"https://.../v1\"></label>\n      <label>模型(预设服务商仅支持指定多模态模型)\n        <input id=\"ai-model\" placeholder=\"选择预设后自动填入\">\n      </label>\n      <label>API Key<input id=\"ai-key\" type=\"password\" placeholder=\"sk-...\"></label>\n      <button id=\"ai-key-link\" class=\"linklike hidden\">↗ 前往官网获取 / 购买 API Key</button>\n      <p class=\"hint\">预设服务商只需填 API Key,模型与接口地址自动配置。Key 只存本地,不会上传。</p>\n<div class=\"modal-actions\">\n  <button id=\"ai-test-btn\">测试连接</button>\n</div>");
