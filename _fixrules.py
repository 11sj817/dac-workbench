from pathlib import Path
p = Path(r"PROJDIR\dac-reverse-research\workbench\core.js")
s = p.read_text(encoding="utf-8")

old_rules = '''  function collectRules(node, featureNames, labels, conds, out) {
    out = out || [];
    conds = conds || [];
    if (node.f === undefined) {
      const idx = node.counts.indexOf(Math.max(...node.counts));
      out.push({
        conditions: conds.slice(), then: labels[idx],
        support: node.n, confidence: node.counts[idx] / node.n,
        distribution: node.counts.slice()
      });
      return out;
    }
    const name = featureNames[node.f];
    collectRules(node.left, featureNames, labels, conds.concat([`${name} ≤ ${fmtThreshold(node.t)}`]), out);
    collectRules(node.right, featureNames, labels, conds.concat([`${name} > ${fmtThreshold(node.t)}`]), out);
    return out;
  }

  function fmtThreshold(t) {
    const k = Math.floor(t + 1e-9);
    return `${k} 级`;
  }'''

new_rules = '''  function condDesc(name, t, labels, left) {
    const k = Math.max(0, Math.min(labels.length - 1, Math.floor(t + 1e-9)));
    const arr = left ? labels.slice(0, k + 1) : labels.slice(k + 1);
    const use = arr.length ? arr : [left ? labels[0] : labels[labels.length - 1]];
    if (use.length === 1) return `${name} = ${use[0]}`;
    return `${name} 属于 ${use[0]}~${use[use.length - 1]}`;
  }

  function collectRules(node, featureNames, labels, conds, out) {
    out = out || [];
    conds = conds || [];
    if (node.f === undefined) {
      const idx = node.counts.indexOf(Math.max(...node.counts));
      out.push({
        conditions: conds.slice(), then: labels[idx],
        support: node.n, confidence: node.counts[idx] / node.n,
        distribution: node.counts.slice()
      });
      return out;
    }
    const name = featureNames[node.f];
    collectRules(node.left, featureNames, labels, conds.concat([condDesc(name, node.t, labels, true)]), out);
    collectRules(node.right, featureNames, labels, conds.concat([condDesc(name, node.t, labels, false)]), out);
    return out;
  }'''

assert old_rules in s
s = s.replace(old_rules, new_rules)
p.write_text(s, encoding="utf-8")
print("rules humanized:", "condDesc" in s)
