from pathlib import Path
p = Path(r"PROJDIR\dac-reverse-research\workbench\ui.js")
s = p.read_text(encoding="utf-8")
old = """  renderGuide();
  if (location.hash === '#demo' || new URLSearchParams(location.search).has('demo')) {
    setTimeout(() => { $('#btnSample').click(); }, 200);
  }"""
new = """  renderGuide();
  const Q = new URLSearchParams(location.search);
  if (Q.has('demo') || location.hash === '#demo' || Q.has('auto')) {
    setTimeout(() => $('#btnSample').click(), 150);
  }
  if (Q.has('auto')) {
    setTimeout(() => $('#next2').click(), 900);
    setTimeout(() => $('#next3').click(), 1700);
    setTimeout(() => $('#btnRun').click(), 2600);
    setTimeout(() => { const t = Q.get('tab'); if (t && S.res) setTab(t); }, 4200);
  }"""
assert old in s
s = s.replace(old, new)
p.write_text(s, encoding="utf-8")
print("auto-run patched")
