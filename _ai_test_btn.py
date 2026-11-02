# -*- coding: utf-8 -*-
"""给 AI 面板加「测试连接」+ 错误诊断 + 更多服务商预设。"""
from pathlib import Path

p = Path(r"D:\reverse\dac-reverse-research\workbench\ui.js")
s = p.read_text(encoding="utf-8")

# 1) 更多服务商
old_prov = """  const PROVIDERS = {
    deepseek: { name: 'DeepSeek', base: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
    openai: { name: 'OpenAI', base: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
    dashscope: { name: '通义千问', base: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
    custom: { name: '自定义', base: '', model: '' }
  };"""
new_prov = """  const PROVIDERS = {
    deepseek: { name: 'DeepSeek', base: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
    openai: { name: 'OpenAI', base: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
    dashscope: { name: '通义千问', base: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
    moonshot: { name: '月之暗面 Kimi', base: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
    zhipu: { name: '智谱 GLM', base: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
    siliconflow: { name: '硅基流动', base: 'https://api.siliconflow.cn/v1', model: 'Qwen/Qwen2.5-7B-Instruct' },
    relay: { name: '中转站（自定义）', base: '', model: '' },
    custom: { name: '自定义', base: '', model: '' }
  };

  function diagnose(e) {
    const m = String(e && e.message || e);
    if (/Failed to fetch|NetworkError|Load failed/i.test(m)) {
      return '浏览器直连被拦（CORS 或网络）。这个服务商可能不允许前端直调，换 DeepSeek 官方，或用支持 CORS 的中转站。';
    }
    if (/\b401\b/.test(m)) return 'Key 无效或已过期（401）。';
    if (/\b403\b/.test(m)) return 'Key 没有该模型权限，或地区受限（403）。';
    if (/\b404\b/.test(m)) return 'Base URL 或模型名不对（404）。检查是不是漏了 /v1。';
    if (/\b429\b/.test(m)) return '触发限流或余额不足（429）。';
    if (/\b5\d\d\b/.test(m)) return '服务端错误，稍后再试。';
    return '未知错误，看下面的原始信息。';
  }"""
assert old_prov in s
s = s.replace(old_prov, new_prov)

# 2) 在保存按钮旁加「测试连接」
old_btn = """    saveRow.appendChild(bSave); saveRow.appendChild(bClear);
    if (cfg.key) saveRow.appendChild(el('span', { class: 'chip', text: '已配置 · ' + (cfg.model || '') }));
    box.appendChild(saveRow);
    pane.appendChild(box);"""
new_btn = """    const bTest = el('button', { class: 'ghost mini', text: '测试连接' });
    const testOut = el('div', { class: 'hint', style: 'display:none' });
    bTest.onclick = async () => {
      bTest.disabled = true;
      bTest.textContent = '测试中…';
      testOut.style.display = '';
      testOut.innerHTML = '正在请求…';
      aiSave({ provider: selP.value, baseURL: inBase.value.trim(), model: inModel.value.trim(), key: inKey.value.trim() });
      const t0 = performance.now();
      try {
        const txt = await callLLM([{ role: 'user', content: '只回复两个字：可用' }]);
        const ms = Math.round(performance.now() - t0);
        testOut.style.borderColor = '#1f4a3c';
        testOut.innerHTML = `<b style="color:#34d399">连接成功</b> · 延迟 ${ms}ms · 模型 ${inModel.value || '(默认)'}<br>
          <span class="muted">返回：${(txt || '').slice(0, 60)}</span>`;
      } catch (e) {
        testOut.style.borderColor = '#5a2020';
        testOut.innerHTML = `<b style="color:#ef4444">连接失败</b><br>${diagnose(e)}<br>
          <span class="muted" style="word-break:break-all">${String(e.message).slice(0, 200)}</span>`;
      }
      bTest.disabled = false;
      bTest.textContent = '测试连接';
    };
    saveRow.appendChild(bSave); saveRow.appendChild(bTest); saveRow.appendChild(bClear);
    if (cfg.key) saveRow.appendChild(el('span', { class: 'chip', text: '已配置 · ' + (cfg.model || '') }));
    box.appendChild(saveRow);
    box.appendChild(testOut);
    pane.appendChild(box);"""
assert old_btn in s
s = s.replace(old_btn, new_btn)

p.write_text(s, encoding="utf-8")
print("ai test button added, len =", len(s))
