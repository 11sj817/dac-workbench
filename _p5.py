from pathlib import Path
p = Path(r"D:\reverse\dac-reverse-research\workbench\core.js")
s = p.read_text(encoding="utf-8")

# 1) 树那行补交叉验证
old1 = "    L.push(`- 决策树：深度 ${meta.params.treeDepth}，训练精度 ${(tree.accuracy * 100).toFixed(1)}%，${tree.rules.length} 条规则`);"
new1 = ("    L.push(`- 决策树：深度 ${meta.params.treeDepth}，训练精度 ${(tree.accuracy * 100).toFixed(1)}%，${tree.rules.length} 条规则`\n"
        "      + (tree.cv ? `；5 折交叉验证 ${(tree.cv.mean * 100).toFixed(1)}% ± ${(tree.cv.std * 100).toFixed(1)}%` : ''));")
assert old1 in s
s = s.replace(old1, new1)

# 2) 情境表补自动命名
old2 = "    scenarios.stats.forEach(s => {\n      L.push(`| ${s.name} | ${s.n} | ` + meta.factors.map(f => s.mean[f].toFixed(2)).join(' | ') + ` | ${s.mean[meta.target].toFixed(3)} |`);\n    });"
new2 = ("    scenarios.stats.forEach((s, i) => {\n"
        "      const nm = (scenarios.names && scenarios.names[i]) ? scenarios.names[i].tag : '-';\n"
        "      L.push(`| ${s.name}（${nm}） | ${s.n} | ` + meta.factors.map(f => s.mean[f].toFixed(2)).join(' | ') + ` | ${s.mean[meta.target].toFixed(3)} |`);\n"
        "    });")
assert old2 in s
s = s.replace(old2, new2)

# 3) 新增第六节：贝叶斯网络
old3 = "    L.push('\\n> 网络边来自 Pearson 相关，代表关联而非因果。要做因果推断，需要工具变量 / DID / 断点回归等识别策略。');"
new3 = """    L.push('\\n> 网络边来自 Pearson 相关，代表关联而非因果。要做因果推断，需要工具变量 / DID / 断点回归等识别策略。');
    if (res.bn) {
      const Ls = calibration.labels;
      const lv = calibration.target.levels;
      L.push('');
      L.push('## 六、贝叶斯网络与敏感度分析');
      L.push('');
      L.push(`结构学习：爬山法 + BIC（父节点上限 2），共 ${res.bn.edges.length} 条有向边：`);
      L.push(res.bn.edges.map(e => `${e.from} → ${e.to}`).join('、') + '\\n');
      L.push(`| 变量 | 固定为「${Ls[0]}」 | 固定为「${Ls[1]}」 | 固定为「${Ls[2]}」 | 变化幅度 |`);
      L.push('|---|---|---|---|---|');
      (res.sens || []).forEach(({ f, rows }) => {
        const vals = rows.map(r => r.posterior[lv - 1]);
        const spread = Math.max(...vals) - Math.min(...vals);
        L.push(`| ${f} | ` + vals.map(v => (v * 100).toFixed(1) + '%').join(' | ') + ` | ${(spread * 100).toFixed(1)} pp |`);
      });
      L.push('');
      L.push(`> 表中数值为「${meta.target} = ${Ls[lv - 1]}」的条件概率。变化幅度越大，说明该变量越关键。`);
      L.push('> 结构方向来自数据评分，代表条件依赖，不等于因果。');
    }"""
assert old3 in s
s = s.replace(old3, new3)
p.write_text(s, encoding="utf-8")
print("report enhanced")
