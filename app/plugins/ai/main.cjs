const path = require('node:path');
const fs = require('node:fs');
const { AsyncLocalStorage } = require('node:async_hooks');

// Built-in optional capability. Core services are injected by the plugin host;
// existing configuration and reports remain in the original user data folder.
function activate(ctx) {
  const { downloadFile, sanitizeName, withSessionWindow, executeWithTimeout } = ctx.services.canvas;
  const { dataDir: DATA_DIR, filesDir: FILES_DIR } = ctx.services.storage;
  const { track } = ctx.services.diagnostics;
  const documents = ctx.services.documents;
  const AI_CONFIG_PATH = path.join(DATA_DIR, 'ai_config.json');
  let stopped = false;
  const pendingRequests = new Map();
  const analysisScope = new AsyncLocalStorage();

  function requireActive() {
    if (stopped) throw new Error('AI 助手插件已停用');
  }

  function requireRequestActive() {
    requireActive();
    const courseId = analysisScope.getStore();
    if (courseId != null && analysisAbort[courseId]) throw new Error('已取消');
  }

  async function requestJson(url, options) {
    requireRequestActive();
    const controller = new AbortController();
    pendingRequests.set(controller, analysisScope.getStore());
    const timeout = setTimeout(() => {
      controller.abort(new Error('模型请求超时（120 秒），请稍后重试'));
    }, 120 * 1000);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      const payload = await response.json().catch(() => ({}));
      if (controller.signal.aborted) throw controller.signal.reason;
      requireRequestActive();
      return { response, payload };
    } catch (error) {
      if (controller.signal.aborted) throw controller.signal.reason;
      throw error;
    } finally {
      clearTimeout(timeout);
      pendingRequests.delete(controller);
    }
  }

  ctx.effect(() => {
    stopped = true;
    for (const controller of pendingRequests.keys()) controller.abort();
    for (const courseId of Object.keys(analysisRunning)) analysisAbort[courseId] = true;
    analysisScope.disable();
  });

  const AI_PRESETS = {
    glm: { label: 'GLM (智谱)', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-5.3-flash', keyUrl: 'https://open.bigmodel.cn/' },
    deepseek: { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-v4-flash-vision-exp', keyUrl: 'https://platform.deepseek.com/api_keys' },
    custom: { label: '自定义 (OpenAI 兼容)', baseUrl: '', model: '' },
  };

  // ---------- AI ----------

  // 配置结构:{ provider, thinkingMode, profiles: { glm:{baseUrl,model,apiKey}, deepseek:{...}, custom:{...} } }
  // 每个服务商各存一份 Key,切换服务商不丢配置;旧版单配置文件自动迁移
  function readAiConfigFile() {
    let raw = null;
    try { raw = JSON.parse(fs.readFileSync(AI_CONFIG_PATH, 'utf-8')); } catch { return null; }
    if (!raw || typeof raw !== 'object') return null;
    if (!raw.profiles) {
      const key = raw.provider && AI_PRESETS[raw.provider] ? raw.provider : 'custom';
      raw = {
        provider: raw.provider || key,
        thinkingMode: raw.thinkingMode || 'thinking',
        profiles: { [key]: { baseUrl: raw.baseUrl || '', model: raw.model || '', apiKey: raw.apiKey || '' } },
      };
    }
    if (!raw.thinkingMode) raw.thinkingMode = 'thinking';
    return raw;
  }

  // aiChat 用:解析出当前服务商的生效配置(预设模型锁定,档案里的旧模型名不生效)
  // 内测期内置免费额度(DeepSeek 提供)。仅当用户未配置自己的 Key 时生效,
  // 用户配置优先。Key 以编码形式存放,渲染层与日志均不出现明文。
  const BETA_AI = Object.freeze({
    provider: 'beta',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-v4-flash-vision-exp',
    keyEncoded: 'c2stMmUzY2FkM2I3ZDY4NDg4ZjliMzk0MTY3ODAxZmRlOTc=',
  });

  function betaAiConfig() {
    return {
      provider: BETA_AI.provider,
      effort: 'disabled',
      thinkingLevels: null,
      baseUrl: BETA_AI.baseUrl,
      model: BETA_AI.model,
      apiKey: Buffer.from(BETA_AI.keyEncoded, 'base64').toString('utf-8'),
    };
  }

  function loadAiConfig() {
    const raw = readAiConfigFile();
    const key = raw && raw.provider && AI_PRESETS[raw.provider] ? raw.provider : (raw ? 'custom' : null);
    const prof = (raw && raw.profiles && raw.profiles[key]) || {};
    if (!raw || !prof.apiKey) {
      // 未配置自己的 Key → 内测免费额度兜底
      return betaAiConfig();
    }
    const preset = AI_PRESETS[key] || {};
    // effort 是思考档位(disabled/low/.../max);旧版 thinkingMode 配置自动迁移
    const effort = raw.effort || (raw.thinkingMode === 'fast' ? 'disabled' : 'high');
    return {
      provider: key,
      effort,
      thinkingLevels: raw.thinkingLevels || null,
      baseUrl: prof.baseUrl || preset.baseUrl || '',
      model: key === 'custom' ? (prof.model || '') : (preset.model || prof.model || ''),
      apiKey: prof.apiKey || '',
    };
  }

  async function aiChat(cfg, messages) {
    requireActive();
    if (!cfg || !cfg.apiKey || !cfg.baseUrl || !cfg.model) {
      throw new Error('请先在设置中填写 AI API 配置');
    }
    const t0 = Date.now();
    // 只记服务商/模型/耗时/成败与错误码,不记对话内容
    const traceAi = (ok, extra) => track('ai-call', {
      ok, ms: Date.now() - t0, provider: cfg.provider || 'custom',
      model: cfg.model, effort: cfg.effort || '-', ...(extra || {}),
    });
    const base = cfg.baseUrl.replace(/\/+$/, '');
    const body = { model: cfg.model, messages, temperature: 0.2 };
    // 顶栏「快速↔质量」滑块控制思考档位:disabled=关闭思考,其余档位走 reasoning_effort
    if (cfg.provider === 'glm' || cfg.provider === 'deepseek') {
      if (cfg.effort === 'disabled') {
        body.thinking = { type: 'disabled' };
      } else {
        body.thinking = { type: 'enabled' };
        body.reasoning_effort = cfg.effort || 'high';
      }
    }
    let r, j;
    try {
      ({ response: r, payload: j } = await requestJson(`${base}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.apiKey },
        body: JSON.stringify(body),
      }));
    } catch (e) {
      traceAi(false, { err: 'network' });
      throw e;
    }
    if (!r.ok) {
      const msg = (j.error && j.error.message) || `HTTP ${r.status}`;
      traceAi(false, { http: r.status });
      if (cfg.effort === 'disabled' && /think|reason|思考/i.test(msg)) {
        throw new Error(`当前模型不支持关闭思考:请把顶栏「快速↔质量」滑块往右拉。原始错误:${msg}`);
      }
      throw new Error(msg);
    }
    const content = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
    if (!content) { traceAi(false, { http: r.status }); throw new Error('AI 返回为空'); }
    traceAi(true, {});
    return content;
  }

  function fmtBytesMain(n) {
    if (n == null) return '?';
    if (n < 1048576) return Math.round(n / 1024) + 'KB';
    return (n / 1048576).toFixed(1) + 'MB';
  }

  // ---------- 课程结构分析(手动启动,分阶段报告进度) ----------

  const analysisAbort = {};   // cid -> true 表示请求取消
  const analysisRunning = {};

  function sendProgress(courseId, stage, detail, current, total) {
    if (!stopped) ctx.emit('analysis-progress', { courseId, stage, detail, current, total });
  }

  // 通过会话窗口抓取大纲 + 课程页面文本
  async function fetchCourseText(courseId) {
    return withSessionWindow(async (win) => executeWithTimeout(win, `(async () => {
      const strip = (h) => {
        const d = document.createElement('div');
        d.innerHTML = h || '';
        return d.textContent.replace(/\\s+/g, ' ').trim();
      };
      let syllabus = '';
      try {
        const c = await (await fetch('/api/v1/courses/${courseId}?include[]=syllabus_body', { credentials: 'include' })).json();
        syllabus = strip(c.syllabus_body || '').slice(0, 8000);
      } catch (e) {}
      const pages = [];
      try {
        const list = await (await fetch('/api/v1/courses/${courseId}/pages?per_page=50', { credentials: 'include' })).json();
        for (const p of list.slice(0, 15)) {
          try {
            const d = await (await fetch('/api/v1/courses/${courseId}/pages/' + p.url, { credentials: 'include' })).json();
            const t = strip(d.body || '');
            if (t.length > 50) pages.push(p.title + ':' + t.slice(0, 2500));
          } catch (e) {}
        }
      } catch (e) {}
      return { syllabus, pages };
    })()`, 60 * 1000, '抓取课程页面'));
  }

  // 从 PDF / PPTX / DOCX 提取文本(超长截断)
  // pdf-parse 依赖的 @napi-rs/canvas(36MB)只为渲染图片提供 DOMMatrix,
  // 我们只提取文字,用几行桩类替代它,安装包因此小于 100MB 可单文件分发
  let pdfStubsReady = false;
  function ensurePdfStubs() {
    if (pdfStubsReady) return;
    pdfStubsReady = true;
    const previous = new Map(['DOMMatrix', 'ImageData', 'Path2D'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
    if (!globalThis.DOMMatrix) {
      globalThis.DOMMatrix = class {
        constructor() { this.a = 1; this.b = 0; this.c = 0; this.d = 1; this.e = 0; this.f = 0; }
        multiplySelf() { return this; } preMultiplySelf() { return this; } translateSelf() { return this; }
        scaleSelf() { return this; } rotateSelf() { return this; } invertSelf() { return this; }
        setTransform() { return this; } get is2D() { return true; }
      };
    }
    if (!globalThis.ImageData) {
      globalThis.ImageData = class { constructor(w, h) { this.width = w; this.height = h; this.data = new Uint8ClampedArray(w * h * 4); } };
    }
    if (!globalThis.Path2D) globalThis.Path2D = class {};
    for (const [name, descriptor] of previous) {
      const stub = globalThis[name];
      if (descriptor && descriptor.value === stub) continue;
      ctx.effect(() => {
        if (globalThis[name] !== stub) return;
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else delete globalThis[name];
      });
    }
  }

  async function extractText(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    const buf = fs.readFileSync(filePath);
    if (ext === '.pdf') {
      // pdf-parse v2:导出 PDFParse 类,不是函数
      ensurePdfStubs();
      const PDFParse = documents.loadPdfParser();
      const parser = new PDFParse({ data: buf });
      try {
        const r = await parser.getText();
        return (r.text || '').replace(/\s+/g, ' ').slice(0, 9000);
      } finally {
        await parser.destroy?.();
      }
    }
    if (ext === '.pptx' || ext === '.docx') {
      const JSZip = documents.loadZip();
      const zip = await JSZip.loadAsync(buf);
      const names = Object.keys(zip.files);
      const targets = ext === '.pptx'
        ? names.filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n))
            .sort((a, b) => parseInt(a.match(/\d+/)[0]) - parseInt(b.match(/\d+/)[0]))
        : names.filter(n => n === 'word/document.xml');
      let out = '';
      for (const n of targets) {
        const xml = await zip.file(n).async('string');
        out += xml.replace(/<[^>]+>/g, ' ');
      }
      return out.replace(/\s+/g, ' ').slice(0, 9000);
    }
    return ''; // mp4 等无文本
  }

  // 把结构化数据拼成固定格式的 markdown(标题层级/表格/折叠块全部由程序决定,AI 只提供内容)
  function composeGuideMarkdown(code, s) {
    const table = [
      '| 名称 | 满分 | 占比 | 截止时间 |',
      '| --- | --- | --- | --- |',
      ...(s.gradingRows.length ? s.gradingRows : [{ name: '未从材料中解析出评分构成', points: '—', weight: '—', due: '—' }])
        .map(r => `| ${r.name} | ${r.points} | ${r.weight} | ${r.due} |`),
    ].join('\n');
    return [
      `# 【${code} 导学报告】`, '',
      table, '',
      s.gradingNote || '', '',
      '## 【一句话总结如何通过课程】', '',
      s.oneLiner || '(生成失败)', '',
      '<details>', '<summary>▸ 展开详细攻略</summary>', '',
      '### 【挂科风险与应对】', '',
      `风险等级:${s.risk.level}。${s.risk.reason}`, '',
      '### 【关键日期】', '',
      s.dates.length ? s.dates.map(d => `- ${d.item}(${d.due})`).join('\n') : '- 未来两周没有待截止作业', '',
      '### 【推荐资源】', '',
      s.resources.length ? s.resources.map(r => `- ${r.name}:${r.when}`).join('\n') : '- 无特别推荐', '',
      '### 【学习建议】', '',
      s.tips.length ? s.tips.map(t => `- ${t}`).join('\n') : '- 无', '',
      '</details>',
    ].join('\n');
  }

  async function runAnalysis(courseId) {
    requireActive();
    if (analysisRunning[courseId]) throw new Error('该课程正在分析中');
    analysisRunning[courseId] = true;
    const t0 = Date.now();
    const traceA = (ok, extra) => track('analysis', { ok, ms: Date.now() - t0, ...(extra || {}) });
    delete analysisAbort[courseId];
    try {
      const courses = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'courses.json'), 'utf-8'));
      const course = courses.find(c => c.id === courseId);
      if (!course) throw new Error('找不到课程,请先同步');
      const code = course.code.split(' ')[0];
      const filesData = JSON.parse(fs.readFileSync(path.join(DATA_DIR, `course_${courseId}_files.json`), 'utf-8'));
      const assignments = JSON.parse(fs.readFileSync(path.join(DATA_DIR, `course_${courseId}_assignments.json`), 'utf-8'));
      const allFiles = filesData.files || [];
      const readable = f => /\.(pdf|pptx?|docx?)$/i.test(f.filename);
      let selected = allFiles.filter(readable);
      let skipped = allFiles.filter(f => !readable(f))
        .map(f => ({ name: f.filename, reason: (f.type || '').includes('video') ? '视频,不下载' : '模型不可读取(' + ((f.type || '') || '未知类型').split('/').pop() + ')' }));

      // 1. 网页资料(大纲+页面)
      sendProgress(courseId, 'web', '抓取课程大纲与页面…', 0, 1);
      let web = { syllabus: '', pages: [] };
      try {
        web = await fetchCourseText(courseId);
      } catch (e) {
        sendProgress(courseId, 'web', '网页资料抓取失败(继续用本地数据):' + e.message, 1, 1);
      }
      if (stopped || analysisAbort[courseId]) throw new Error(stopped ? 'AI 助手插件已停用' : '已取消');

      // 2. AI 筛选:决定下载/分析哪些材料
      sendProgress(courseId, 'select', 'AI 正在筛选值得分析的材料…', 0, 1);
      try {
        const raw = await aiChat(loadAiConfig(), [
          { role: 'system', content: [
            '你是材料筛选助手。根据课程文件清单,决定哪些值得下载并做课程结构分析。返回严格 JSON:',
            '{"download":["文件名"],"skip":[{"name":"文件名","reason":"中文原因"}]}',
            '规则:download 只能选文本类文档(pdf/ppt/pptx/doc/docx);视频/音频/图片/压缩包必须 skip(视频的原因里写清主题,便于后续推荐);文件名明显与课程结构无关的(个人作业提交件、临时文件等)skip;第一讲/导论/Lecture 1/课程介绍类讲义通常包含课程结构和评分信息,应选中;宁缺毋滥,优先大纲、讲义、评分说明。只输出 JSON。',
          ].join('\n') },
          { role: 'user', content: `课程:${course.name}\n文件清单:\n${allFiles.map(f => `- ${f.filename} | ${f.type || '?'} | ${fmtBytesMain(f.size)}`).join('\n')}` },
        ]);
        const m = raw.match(/\{[\s\S]*\}/);
        if (m) {
          const plan = JSON.parse(m[0]);
          const wanted = new Set(plan.download || []);
          selected = allFiles.filter(f => wanted.has(f.filename) && readable(f));
          const skipMap = new Map(skipped.map(s => [s.name, s]));
          for (const s of (plan.skip || [])) if (s && s.name) skipMap.set(s.name, { name: s.name, reason: s.reason || 'AI 判断与课程结构无关' });
          for (const f of allFiles) {
            if (!wanted.has(f.filename) && readable(f) && !selected.includes(f)) {
              skipMap.set(f.filename, { name: f.filename, reason: skipMap.get(f.filename)?.reason || 'AI 未选中' });
            }
          }
          skipped = [...skipMap.values()];
        }
        sendProgress(courseId, 'select', `筛选完成:分析 ${selected.length} 个,跳过 ${skipped.length} 个`, 1, 1);
      } catch (e) {
        sendProgress(courseId, 'select', 'AI 筛选失败,退回默认规则(全部文档):' + e.message, 1, 1);
      }
      if (stopped || analysisAbort[courseId]) throw new Error(stopped ? 'AI 助手插件已停用' : '已取消');

      // 3. 下载缺失的课件
      let newly = 0;
      for (let i = 0; i < selected.length; i++) {
        if (stopped || analysisAbort[courseId]) throw new Error(stopped ? 'AI 助手插件已停用' : '已取消');
        const f = selected[i];
        const fp = path.join(FILES_DIR, sanitizeName(code), sanitizeName(f.filename));
        sendProgress(courseId, 'download', f.filename, i + 1, selected.length);
        if (!fs.existsSync(fp)) {
          try {
            await downloadFile({ courseId, fileId: f.id, courseCode: code, filename: f.filename });
            newly++;
          } catch (e) {
            sendProgress(courseId, 'download', `${f.filename} 跳过(${String(e.message).slice(0, 40)})`, i + 1, selected.length);
          }
        }
      }

      // 4. 提取文本
      const materials = [];
      for (let i = 0; i < selected.length; i++) {
        if (stopped || analysisAbort[courseId]) throw new Error(stopped ? 'AI 助手插件已停用' : '已取消');
        const f = selected[i];
        sendProgress(courseId, 'extract', f.filename, i + 1, selected.length);
        const fp = path.join(FILES_DIR, sanitizeName(code), sanitizeName(f.filename));
        if (!fs.existsSync(fp)) continue;
        const text = await extractText(fp).catch(() => '');
        if (text && text.length > 100) materials.push({ name: f.filename, text });
      }

      // 4. AI 逐份摘要
      const cfg = loadAiConfig();
      const summaries = [];
      for (let i = 0; i < materials.length; i++) {
        if (stopped || analysisAbort[courseId]) throw new Error(stopped ? 'AI 助手插件已停用' : '已取消');
        sendProgress(courseId, 'ai', materials[i].name, i + 1, materials.length);
        try {
          summaries.push(await aiChat(cfg, [
            { role: 'system', content: '用简体中文 3-5 条要点总结这份课件的核心内容,每条一行,开头一句概括主题。只输出要点,不要客套。' },
            { role: 'user', content: '文件名:' + materials[i].name + '\n内容节选:\n' + materials[i].text.slice(0, 8000) },
          ]));
        } catch (e) {
          summaries.push('(摘要失败:' + e.message + ')');
        }
      }

      if (stopped || analysisAbort[courseId]) throw new Error(stopped ? 'AI 助手插件已停用' : '已取消');

      // 5. 汇总报告:AI 只填内容(严格 JSON),格式由程序固定拼装,保证不同模型/课程输出一致
      sendProgress(courseId, 'final', '生成结构分析报告…', 1, 1);
      const now = new Date();
      const lines = assignments.filter(a => a.published).map(a => {
        const st = a.sub && a.sub.state === 'graded'
          ? `已评分 ${a.sub.score}/${a.points}`
          : (a.sub && a.sub.submitted_at ? '已提交' : (a.due_at && new Date(a.due_at) < now ? '!!过期未交' : '未提交'));
        return `- ${a.name} | 满分 ${a.points ?? '?'} | 截止 ${(a.due_at || '无').slice(0, 10)} | ${st}`;
      }).join('\n');
      const summaryBlock = materials.map((m, i) => `### ${m.name}\n${summaries[i]}`).join('\n\n').slice(0, 20000);
      const userPayload = [
        `课程:${course.name}`, `今天:${now.toISOString().slice(0, 10)}`,
        '', '【作业清单】', lines,
        '', '【课程大纲节选】', web.syllabus || '(未抓取到,请从其他材料推断)',
        '', '【课程页面】', (web.pages.join('\n') || '(未抓取到,请从其他材料推断)').slice(0, 6000),
        '', '【课件摘要】', summaryBlock || '(无,请从作业与页面推断)',
        '', '【未纳入分析的材料及原因】', skipped.map(s => `- ${s.name}(${s.reason})`).join('\n') || '(无)',
      ].join('\n');

      const jsonSys = [
        '你是这门课的助教。基于给定材料生成"导学报告"的内容,只输出一个 JSON 对象,不要 markdown 代码块、不要多余文字。字段定义:',
        'gradingRows: 评分构成数组,每项 {"name":"项目名(用原文)","points":"满分","weight":"占总分比例如 20%,材料没有就推断并加(推断)后缀,实在没有写—","due":"截止时间如 09-30 或 每周"},按分值从大到小排',
        'gradingNote: 一句话说明打分逻辑/最需要注意的规则(≤80字)',
        'oneLiner: 一句话总结如何通过这门课(≤60字,具体可执行,直接说怎么做)',
        'risk: {"level":"低|中|高","reason":"具体理由,引用作业名和数字(≤120字)"}',
        'resources: 未纳入分析的材料(尤其视频)中对学习重要的,数组 [{"name":"名称","when":"适合什么时候看,≤30字"}]',
        'tips: 最多 4 条可执行建议的数组,每条 ≤60 字',
        '所有文本简体中文、纯文本,不要用 markdown 符号(**、#、表格线等)。材料为空不代表课程没有这项信息,应结合作业/课件推断;不确定的标注"建议向老师确认"。',
      ].join('\n');

      let structured = null;
      let finalReport = '';
      try {
        const raw = await aiChat(cfg, [{ role: 'system', content: jsonSys }, { role: 'user', content: userPayload }]);
        const m = raw.match(/\{[\s\S]*\}/);
        if (!m) throw new Error('AI 未返回 JSON');
        const j = JSON.parse(m[0]);
        structured = {
          gradingRows: (Array.isArray(j.gradingRows) ? j.gradingRows : []).map(r => ({
            name: String(r.name || '—'), points: String(r.points ?? '—'),
            weight: String(r.weight ?? '—'), due: String(r.due || '—'),
          })),
          gradingNote: String(j.gradingNote || ''),
          oneLiner: String(j.oneLiner || ''),
          risk: {
            level: ['低', '中', '高'].includes(j.risk && j.risk.level) ? j.risk.level : '中',
            reason: String((j.risk && j.risk.reason) || ''),
          },
          resources: (Array.isArray(j.resources) ? j.resources : [])
            .map(r => ({ name: String(r.name || ''), when: String(r.when || '') })).filter(r => r.name),
          tips: (Array.isArray(j.tips) ? j.tips : []).map(t => String(t)).slice(0, 4),
        };
      } catch (e) {
        sendProgress(courseId, 'final', '结构化解析失败,退回自由格式:' + e.message, 1, 1);
      }

      // 关键日期是确定性数据,本地计算,不交给 AI
      const in14 = assignments
        .filter(a => a.published && a.due_at && !(a.sub && (a.sub.state === 'graded' || a.sub.state === 'submitted' || a.sub.submitted_at)))
        .filter(a => new Date(a.due_at) > now && new Date(a.due_at) - now <= 14 * 864e5)
        .sort((a, b) => (a.due_at < b.due_at ? -1 : 1))
        .slice(0, 8)
        .map(a => ({ item: a.name, due: a.due_at.slice(5, 10).replace('-', '/') }));

      if (structured) {
        structured.code = code;
        structured.dates = in14;
        finalReport = composeGuideMarkdown(code, structured);
      } else {
        finalReport = await aiChat(cfg, [
          { role: 'system', content: '你是这门课的助教,基于给定材料用简体中文写一份导学报告,markdown 格式,包含:评分构成表格、一句话总结如何通过、挂科风险、近期关键日期、推荐资源、学习建议。' },
          { role: 'user', content: userPayload },
        ]);
      }
      if (stopped || analysisAbort[courseId]) throw new Error(stopped ? 'AI 助手插件已停用' : '已取消');
      fs.writeFileSync(
        path.join(DATA_DIR, `analysis_${courseId}.json`),
        JSON.stringify({ courseId, code: course.code, generatedAt: now.toISOString(), structured, report: finalReport }, null, 2), 'utf-8');
      sendProgress(courseId, 'done', `完成:新下载 ${newly} 个,分析 ${materials.length} 份课件`);
      traceA(true, { materials: materials.length, pages: web.pages.length });
      return { report: finalReport };
    } catch (e) {
      traceA(false, { err: String(e.message).slice(0, 80) });
      throw e;
    } finally {
      analysisRunning[courseId] = false;
    }
  }

  const EFFORT_ORDER = ['disabled', 'minimal', 'low', 'medium', 'high', 'max'];
  const methods = {
    'ai-presets': () => AI_PRESETS,
    'ai-config-load': () => readAiConfigFile(),
    'ai-config-save': (cfg) => {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(AI_CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf-8');
      return true;
    },
    'ai-test': (cfg) => aiChat(cfg, [{ role: 'user', content: '只回复两个字母:OK' }]),
    'ai-probe': async (cfgArg) => {
      const cfg = cfgArg || loadAiConfig();
      if (!cfg || !cfg.apiKey || !cfg.baseUrl) return { ok: false, reason: '未配置 API Key' };
      try {
        const { response: r, payload: j } = await requestJson(`${cfg.baseUrl.replace(/\/+$/, '')}/models`, {
          headers: { Authorization: 'Bearer ' + cfg.apiKey },
        });
        if (!r.ok) return { ok: false, reason: `HTTP ${r.status}` };
        const list = Array.isArray(j) ? j : (j.data || j.models || []);
        const entry = list.find(m => (m.id || m.name || m.model) === cfg.model) || {};
        const found = new Set();
        const scan = (v) => {
          if (typeof v === 'string' && EFFORT_ORDER.includes(v)) found.add(v);
          else if (Array.isArray(v)) v.forEach(scan);
          else if (v && typeof v === 'object') Object.values(v).forEach(scan);
        };
        scan(entry);
        const levels = EFFORT_ORDER.filter(l => found.has(l));
        return { ok: true, levels: levels.length ? levels : null, model: cfg.model };
      } catch (e) {
        return { ok: false, reason: e.message };
      }
    },
    'ai-chat': ({ system, user }) => aiChat(loadAiConfig(), [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ]),
    'load-analysis': (courseId) => {
      const file = path.join(DATA_DIR, `analysis_${courseId}.json`);
      return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf-8')) : null;
    },
    'analyze-course': (courseId) => analysisScope.run(courseId, () => runAnalysis(courseId)),
    'cancel-analysis': (courseId) => {
      if (analysisRunning[courseId]) analysisAbort[courseId] = true;
      for (const [controller, owner] of pendingRequests) {
        if (owner != null && String(owner) === String(courseId)) controller.abort(new Error('已取消'));
      }
      return true;
    },
  };
  return {
    methods: Object.fromEntries(Object.entries(methods).map(([name, method]) => [name, (...args) => { requireActive(); return method(...args); }])),
    isBusy: () => pendingRequests.size > 0 || Object.values(analysisRunning).some(Boolean),
  };
}

module.exports = { activate };
