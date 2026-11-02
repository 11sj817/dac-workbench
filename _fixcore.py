from pathlib import Path
p = Path(r"D:\reverse\dac-reverse-research\workbench\core.js")
s = p.read_text(encoding="utf-8")
s = s.replace(
  "    parseCSV, parseXLSX, profile, corrMatrix, calibrate,",
  "    parseCSV, parseXLSX, profile, corrMatrix, calibrate, pearson, robustScale,")
p.write_text(s, encoding="utf-8")
print("exported pearson:", "pearson, robustScale," in s)
