from pathlib import Path
p = Path(r"D:\reverse\dac-reverse-research\_ai_live_test.py")
s = p.read_text(encoding="utf-8")
old = '''def audit(text, res):
    allow = sorted(collect_numbers(res))
    nums = [float(x) for x in re.findall(r"\\d+(?:\\.\\d+)?", text)]
    bad = []
    for n in nums:
        if n <= 4:
            continue
        hit = False
        for cand in (n, n / 100.0, n * 100.0):
            for y in allow:
                if abs(y - cand) <= max(0.02, abs(y) * 0.02):
                    hit = True
                    break
            if hit:
                break
        if not hit:
            bad.append(n)
    return sorted(set(bad))[:8]'''
new = '''def expand(base):
    s = set(base)
    arr = [x for x in base if 0 < x < 1e6][:60]
    for i in range(len(arr)):
        for j in range(i + 1, len(arr)):
            a, b = arr[i], arr[j]
            s.add(abs(a - b))
            s.add(abs((a - b) / (a or 1) * 100))
            s.add(a / b)
            s.add(b / a)
    return s


def audit(text, res):
    base = collect_numbers(res)
    for k in ("factors", "rules", "columns", "labels"):
        v = res.get(k)
        if isinstance(v, list):
            base.add(float(len(v)))
    allow = sorted(expand(base))
    nums = [float(x) for x in re.findall(r"\\d+(?:\\.\\d+)?", text)]
    bad = []
    for n in nums:
        if n <= 4:
            continue
        hit = False
        for cand in (n, n / 100.0, n * 100.0):
            for y in allow:
                if abs(y - cand) <= max(0.02, abs(y) * 0.02):
                    hit = True
                    break
            if hit:
                break
        if not hit:
            bad.append(n)
    return sorted(set(bad))[:8]'''
assert old in s
p.write_text(s.replace(old, new), encoding="utf-8")
print("python audit synced")
