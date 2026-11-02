# -*- coding: utf-8 -*-
"""前端升级 2/2：AI 助手（API 接入）+ 数字校验 + 本地降级。"""
from pathlib import Path

p = Path(r"D:\reverse\dac-reverse-research\workbench\ui.js")
s = p.read_text(encoding="utf-8")

s = s.replace("      case 'robust': return renderRobust();",
              "      case 'robust': return renderRobust();\n      case 'ai': return renderAI();")

anchor = "  /* ---------------- 渲染：报告 ---------------- */"
AI = r"""
  /* ---------------- AI 助手（可选 API 接入） ---------------- */
  const AI_KEY = 'dac-workbench-ai';
  const PROVIDERS = {
    deepseek: { name: 'DeepSeek', base: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
    openai: { name: 'OpenAI', base: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
    dashscope: { name: '通义千问', base: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
    custom: { name: '自定义', base: '', model: '' }
  };
  function aiCfg() {
    try { return JSON.parse(localStorage.getItem(AI_KEY) || '{}'); } catch (e) { return {}; }
  }
  function aiSave(c) { localStorage.setItem(AI_KEY, JSON.stringify(c)); }

  async function callLLM(messages) {
    const c = aiCfg();
    if (!c.key) throw new Error('还没填 API Key（在下面「接入设置」里填）');
    const base = (c.baseURL || PROVIDERS[c.provider || 'deepseek'].base).replace(/\/+$/, '');
    const model = c.model || PROVIDERS[c.provider || 'deepseek'].model;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 45000);
    try {
      const res = await fetch(base + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + c.key },
        body: JSON.stringify({ model, messages, temperature: 0.25, max_tokens: 1400 }),
        signal: ctrl.signal
      });
      if (!res.ok) {
        const t = await res.text();
        throw new Error('HTTP ' + res.status + '：' + t.slice(0, 220));
      }
      const j = await res.json();
      return (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
    } finally { clearTimeout(timer); }
  }

  /* 从结果里收集所有出现过的数字，用于校验模型有没有编数 */
  function collectNumbers(obj, set) {
    set = set || new Set();
    if (typeof obj === 'number' && isFinite(obj)) set.add(Math.abs(obj));
    else if (Array.isArray(obj)) obj.forEach(o => collectNumbers(o, set));
    else if (obj && typeof obj === 'object') Object.values(obj).forEach(o => collectNumbers(o, set));
    return set;
  }
  function auditNumbers(text, res) {
    const allow = [...collectNumbers(res)];
    const nums = (text.match(/\d+(?:\.\d+)?/g) || []).map(Number);
    const bad = [];
    nums.forEach(n => {
      if (n <= 4) return;                       // 等级/小整数放过
      const cands = [n, n / 100, n * 100];
      const hit = cands.some(x => allow.some(y => Math.abs(y - x) <= Math.max(0.02, Math.abs(y) * 0.02)));
      if (!hit) bad.push(n);
    });
    return [...new Set(bad)].slice(0, 6);
  }

  function renderAI() {
    const pane = $('#pane'), r = S.res, cfg = aiCfg();
    pane.innerHTML = '';
    if (!r) {
      pane.innerHTML = '<div class="muted">先跑一次分析，AI 才能基于真实结果给建议。</div>';
      return;
    }
    pane.appendChild(el('div', { class: 'muted', html:
      'AI 只做两件事：<b>推荐参数</b> 和 <b>写文字</b>。所有数字必须来自本地计算，模型编造的数字会被标红。' }));

    // 接入设置
    const box = el('div', { class: 'card', style: 'margin-top:12px;background:#0f1a24' });
    box.appendChild(el('h3', { text: '接入设置（存在浏览器本地，不上传）', style: 'margin-bottom:10px;font-size:12px' }));
    const grid = el('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:8px' });
    const selP = el('select', {});
    Object.entries(PROVIDERS).forEach(([k, v]) => {
      const o = el('option', { value: k, text: v.name });
      if ((cfg.provider || 'deepseek') === k) o.selected = true;
      selP.appendChild(o);
    });
    const inBase = el('input', { type: 'text', placeholder: 'Base URL', value: cfg.baseURL || PROVIDERS[cfg.provider || 'deepseek'].base });
    const inModel = el('input', { type: 'text', placeholder: 'model', value: cfg.model || PROVIDERS[cfg.provider || 'deepseek'].model });
    const inKey = el('input', { type: 'password', placeholder: 'sk-...', value: cfg.key || '' });
    selP.onchange = () => {
      const v = PROVIDERS[selP.value];
      inBase.value = v.base; inModel.value = v.model;
    };
    grid.appendChild(el('div', {}, [el('div', { class: 'muted', text: '服务商' }), selP]));
    grid.appendChild(el('div', {}, [el('div', { class: 'muted', text: '模型' }), inModel]));
    grid.appendChild(el('div', {}, [el('div', { class: 'muted', text: 'Base URL' }), inBase]));
    grid.appendChild(el('div', {}, [el('div', { class: 'muted', text: 'API Key' }), inKey]));
    box.appendChild(grid);
    const saveRow = el('div', { style: 'display:flex;gap:8px;margin-top:9px' });
    const bSave = el('button', { class: 'mini', text: '保存设置' });
    bSave.onclick = () => {
      aiSave({ provider: selP.value, baseURL: inBase.value.trim(), model: inModel.value.trim(), key: inKey.value.trim() });
      toast('已保存到本地浏览器');
    };
    const bClear = el('button', { class: 'ghost mini', text: '清除 Key' });
    bClear.onclick = () => { aiSave({}); toast('已清除'); renderAI(); };
    saveRow.appendChild(bSave); saveRow.appendChild(bClear);
    if (cfg.key) saveRow.appendChild(el('span', { class: 'chip', text: '已配置 · ' + (cfg.model || '') }));
    box.appendChild(saveRow);
    pane.appendChild(box);

    // 操作
    const acts = el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;margin:14px 0' });
    const out = el('div', { class: 'ai-msg', text: '点上面的按钮试试。没有 Key 也能用「本地模板」。' });
    const mk = (label, fn) => { const b = el('button', { class: 'mini', text: label }); b.onclick = () => fn(b, out); return b; };

    const brief = () => {
      const p2 = r.meta.params;
      return {
        target: r.meta.target, factors: r.meta.factors,
        rows: r.meta.rows, used: r.meta.usedRows,
        columns: r.profile.columns.map(c => ({ name: c.name, missing: c.missing, outliers: c.outliers || 0 })),
        params: p2,
        silhouette: r.scenarios.silhouette,
        cv: r.tree.cv ? { mean: r.tree.cv.mean, std: r.tree.cv.std } : null,
        accuracy: r.tree.accuracy,
        importances: r.tree.importances.slice(0, 5),
        rules: r.tree.rules.slice(0, 5).map(x => ({ if: x.conditions, then: x.then, n: x.support, conf: x.confidence })),
        sens: (r.sens || []).map(({ f, rows }) => ({ var: f, probs: rows.map(x => +(x.posterior[x.posterior.length - 1] * 100).toFixed(1)) }))
      };
    };

    // 1) 生成分析方案
    acts.appendChild(mk('🤖 让 AI 给参数建议', async (btn, out) => {
      btn.disabled = true; out.className = 'ai-msg'; out.textContent = '思考中…';
      try {
        const b = brief();
        const prompt = `你是一位管理学研究方法顾问。以下是用户数据的体检结果与当前分析参数：
${JSON.stringify(b, null, 1)}

请只输出 JSON，不要解释，格式：
{"target":"","factors":[""],"lowPct":25,"highPct":75,"levels":3,"k":3,"treeDepth":3,"netThreshold":0.2,"reason":"一句话说明为什么这样选"}
要求：factors 必须来自 columns；k 在 2-6；treeDepth 1-4；levels 2-4；netThreshold 0.1-0.5。`;
        const txt = await callLLM([{ role: 'user', content: prompt }]);
        const m = /\{[\s\S]*\}/.exec(txt);
        if (!m) throw new Error('模型没有返回 JSON：' + txt.slice(0, 200));
        const plan = JSON.parse(m[0]);
        out.className = 'ai-msg';
        out.textContent = '建议：' + JSON.stringify(plan, null, 2);
        const applyBtn = el('button', { class: 'mini', text: '应用这组参数并重跑' });
        applyBtn.style.marginTop = '10px';
        applyBtn.onclick = () => {
          if (plan.factors) {
            document.querySelectorAll('#factors input').forEach(i => { i.checked = plan.factors.includes(i.value); });
          }
          if (plan.target) $('#target').value = plan.target;
          if (plan.lowPct) { $('#low').value = plan.lowPct; $('#vLow').textContent = plan.lowPct + '%'; }
          if (plan.highPct) { $('#high').value = plan.highPct; $('#vHigh').textContent = plan.highPct + '%'; }
          if (plan.levels) { $('#levels').value = plan.levels; $('#vLevels').textContent = plan.levels; }
          if (plan.k) { $('#k').value = plan.k; $('#vK').textContent = plan.k; }
          if (plan.treeDepth) { $('#depth').value = plan.treeDepth; $('#vDepth').textContent = plan.treeDepth; }
          if (plan.netThreshold) { $('#net').value = Math.round(plan.netThreshold * 100); $('#vNet').textContent = plan.netThreshold.toFixed(2); }
          run();
          toast('已应用 AI 建议的参数');
        };
        out.appendChild(applyBtn);
      } catch (e) {
        out.className = 'ai-msg err';
        out.textContent = '调用失败：' + e.message + '\n\n（没有 Key 也可以点「本地模板」离线生成）';
      }
      btn.disabled = false;
    }));

    // 2) 解读结果
    acts.appendChild(mk('📝 让 AI 解读结果', async (btn, out) => {
      btn.disabled = true; out.className = 'ai-msg'; out.textContent = '写作中…';
      try {
        const b = brief();
        const prompt = `你是论文写作助手。下面是一次数据分析的真实结果（JSON）：
${JSON.stringify(b, null, 1)}

请用中文写 3 段：
1) 数据与分型：样本、情境划分、各情境特征；
2) 条件组合规则：挑 2 条最重要的规则，说明业务含义；
3) 机制与边界：哪个变量最关键（给出概率变化），并声明"相关不等于因果"。
要求：只能使用 JSON 里出现过的数字；不要编造变量名；语气客观。`;
        const txt = await callLLM([{ role: 'user', content: prompt }]);
        out.className = 'ai-msg';
        out.textContent = txt;
        const bad = auditNumbers(txt, r);
        const note = el('div', { class: 'hint', style: 'margin-top:8px' });
        note.innerHTML = bad.length
          ? `<b style="color:#f59e0b">数字校验未通过</b>：以下数字在计算结果里找不到对应值，请人工核对 → ${bad.join(', ')}`
          : '<b style="color:#34d399">数字校验通过</b>：文中所有数字都能在计算结果里找到来源。';
        out.appendChild(note);
      } catch (e) {
        out.className = 'ai-msg err';
        out.textContent = '调用失败：' + e.message;
      }
      btn.disabled = false;
    }));

    // 3) 本地模板（离线可用）
    acts.appendChild(mk('⚡ 本地模板（不联网）', (btn, out) => {
      const L = r.calibration.labels;
      const lv = r.calibration.target.levels - 1;
      const sc = r.scenarios;
      const top = sc.stats.filter(x => x.n > 0).slice().sort((a, b) => b.mean[r.meta.target] - a.mean[r.meta.target])[0];
      const rules = r.tree.rules.slice().sort((a, b) => b.support * b.confidence - a.support * a.confidence).slice(0, 2);
      const sens = (r.sens || []).map(({ f, rows }) => ({
        f, spread: Math.max(...rows.map(x => x.posterior[lv])) - Math.min(...rows.map(x => x.posterior[lv])),
        hi: rows[0].posterior[lv], lo: rows[rows.length - 1].posterior[lv]
      })).sort((a, b) => b.spread - a.spread)[0];
      const txt =
`【1. 数据与分型】
本次分析使用 ${r.meta.usedRows} 条有效样本，${r.meta.factors.length} 个条件变量，因变量为「${r.meta.target}」。
按 ${r.meta.params.lowPct}/${r.meta.params.highPct} 分位做云模型校准（${r.meta.params.levels} 级）后，KMeans 将其划分为 ${sc.k} 类情境，轮廓系数 ${(sc.silhouette || 0).toFixed(3)}。
其中「${top.name}」的 ${r.meta.target} 均值最高，为 ${top.mean[r.meta.target].toFixed(3)}。

【2. 条件组合规则】
决策树（深度 ${r.meta.params.treeDepth}，5 折交叉验证 ${r.tree.cv ? (r.tree.cv.mean * 100).toFixed(1) : '-'}%）给出 ${r.tree.rules.length} 条规则，其中支持度最高的是：
${rules.map(x => `IF ${x.conditions.join(' 且 ')} → ${r.meta.target} = ${x.then}（n=${x.support}，置信度 ${(x.confidence * 100).toFixed(1)}%）`).join('\n')}

【3. 机制与边界】
敏感度分析显示，${sens ? `「${sens.f}」对结果影响最大：固定为「${L[0]}」时 ${r.meta.target} 处于「${L[lv]}」的概率为 ${(sens.hi * 100).toFixed(1)}%，固定为「${L[L.length - 1]}」时降为 ${(sens.lo * 100).toFixed(1)}%，相差 ${(sens.spread * 100).toFixed(1)} 个百分点。` : '各变量影响差异不明显。'}
需要说明：上述结论基于观察数据的条件依赖，相关不等于因果；若要论证因果，需借助工具变量、双重差分或断点回归等识别策略。`;
      out.className = 'ai-msg';
      out.textContent = txt;
    }));

    pane.appendChild(acts);
    pane.appendChild(out);
    pane.appendChild(el('div', { class: 'hint', style: 'margin-top:12px', html:
      '<b>为什么不让 AI 直接算？</b>大模型会编数。这里的做法是：<b>计算交给确定性代码，文字交给模型</b>，' +
      '并对模型输出做<b>数字溯源校验</b>——每个数字必须能在结果里找到出处。' }));
  }

"""
assert anchor in s
s = s.replace(anchor, AI + anchor)
p.write_text(s, encoding="utf-8")
print("ui upgraded (2/2), len =", len(s))
print("  renderAI:", "function renderAI" in s)
print("  callLLM:", "async function callLLM" in s)
print("  auditNumbers:", "function auditNumbers" in s)
