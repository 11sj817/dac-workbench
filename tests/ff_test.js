/* Firefox 实跑测试（WebDriver / geckodriver）
 * 覆盖：首页渲染、载入数据、跑分析、切页签、浅色主题、四档分辨率、console 错误
 */
const http = require('http');
const fs = require('fs');
const { spawn } = require('child_process');

const GD = 'D:\\reverse\\_ff\\gd\\geckodriver.exe';
const FF = 'D:\\reverse\\_ff\\app\\firefox.exe';
const PORT = 4444;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function req(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({
      host: '127.0.0.1', port: PORT, path, method,
      headers: Object.assign(
        { 'Content-Type': 'application/json' },
        data ? { 'Content-Length': Buffer.byteLength(data) } : {}
      )
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, json: d ? JSON.parse(d) : {} }); }
        catch (e) { resolve({ status: res.statusCode, raw: d }); }
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

(async () => {
  // 启动 geckodriver
  const gd = spawn(GD, ['--port', String(PORT)], { stdio: 'ignore' });
  await sleep(2500);

  let sid = null;
  const out = [];
  try {
    const s = await req('POST', '/session', {
      capabilities: {
        alwaysMatch: {
          browserName: 'firefox',
          'moz:firefoxOptions': {
            binary: FF,
            args: ['-headless', '--width=1600', '--height=1000']
          }
        }
      }
    });
    if (!s.json || !s.json.value) throw new Error('session 创建失败: ' + JSON.stringify(s).slice(0, 300));
    sid = s.json.value.sessionId;
    out.push(['会话', 'OK', sid.slice(0, 8) + '…']);

    const ev = async (script) => {
      const r = await req('POST', `/session/${sid}/execute/sync`, { script, args: [] });
      if (r.json && r.json.value !== undefined) return r.json.value;
      throw new Error('execute 失败: ' + JSON.stringify(r).slice(0, 200));
    };
    const nav = async (url) => { await req('POST', `/session/${sid}/url`, { url }); };

    // 1. 首页
    await nav('http://127.0.0.1:8788/');
    await sleep(2500);
    out.push(['1 首页标题', await ev('return document.title'), '']);
    out.push(['1 左导航', await ev("var t=document.getElementById('tabs'); return getComputedStyle(t).position + '/' + getComputedStyle(t).flexDirection;"), '']);
    out.push(['1 Worker', await ev("return document.getElementById('statusbar') ? document.getElementById('statusbar').innerText.slice(-12) : '?';"), '']);

    // 2. 载入数据 + 跑分析
    await nav('http://127.0.0.1:8788/?auto=1');
    await sleep(16000);
    const status = await ev("var el=document.getElementById('status'); return el ? el.textContent : '?';");
    out.push(['2 分析状态', status, '']);
    const sum = await ev("var s=document.getElementById('summary'); return s ? s.innerText.slice(0,60) : '无摘要';");
    out.push(['2 摘要', sum.replace(/\n/g, ' '), '']);

    // 3. 证据表
    await ev("var b=[...document.querySelectorAll('#tabs button')].find(x=>x.dataset.tab==='report'); if(b)b.click();");
    await sleep(2000);
    const rep = await ev("var p=document.getElementById('pane'); return p ? p.innerText : '';");
    out.push(['3 报告含证据表', rep.includes('证据登记表') ? '是' : '否', '']);
    out.push(['3 证据表行数', (rep.match(/data\.rows|cluster\.k|strictCV\./g) || []).length + ' 处引用', '']);

    // 4. 各页签逐个打开，看是否报错
    const tabs = ['guide','profile','quality','corr','calib','scene','rules','net','bn','robust','boot','glm','ai','report'];
    let okTabs = 0, badTabs = [];
    for (const t of tabs) {
      const r = await ev(`var b=[...document.querySelectorAll('#tabs button')].find(x=>x.dataset.tab==='${t}'); if(b){b.click(); return 'clicked';} return 'missing';`);
      await sleep(700);
      const txt = await ev("var p=document.getElementById('pane'); return p ? p.innerText.length : 0;");
      if (r === 'clicked' && txt > 0) okTabs++; else badTabs.push(t + '(' + r + ',' + txt + ')');
    }
    out.push(['4 页签可用', okTabs + '/' + tabs.length, badTabs.join(' ') || '']);

    // 5. 浅色主题
    const theme = await ev("var b=document.getElementById('btnTheme'); if(!b) return 'no-btn'; b.click(); return document.body.classList.contains('light') ? 'light' : 'dark';");
    out.push(['5 主题切换', theme, '']);

    // 6. 四档分辨率下的横向溢出
    for (const [w, h] of [[1920,1080],[1440,900],[1366,768],[390,844]]) {
      await req('POST', `/session/${sid}/window/rect`, { width: w, height: h });
      await sleep(900);
      const ov = await ev("var de=document.documentElement; return (de.scrollWidth > de.clientWidth + 2) ? ('溢出 ' + de.scrollWidth + '>' + de.clientWidth) : '无溢出';");
      out.push([`6 ${w}×${h}`, ov, '']);
    }

    // 7. 截图
    const shot = await req('GET', `/session/${sid}/screenshot`);
    if (shot.json && shot.json.value) {
      fs.writeFileSync('D:\\reverse\\dac-reverse-research\\evidence\\ff_full.png',
        Buffer.from(shot.json.value, 'base64'));
      out.push(['7 截图', 'evidence/ff_full.png', '']);
    }

  } catch (e) {
    out.push(['错误', e.message, '']);
  } finally {
    if (sid) await req('DELETE', `/session/${sid}`).catch(() => {});
    gd.kill();
  }

  console.log('\n=========== FIREFOX 159 实跑 ===========');
  out.forEach(([a, b, c]) => console.log(`${String(a).padEnd(16)} ${String(b).padEnd(30)} ${c}`));
  console.log('=======================================\n');
})();
