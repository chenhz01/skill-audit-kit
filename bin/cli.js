#!/usr/bin/env node
/**
 * skill-audit-kit — health check for an existing skill/rule library.
 *
 * Scans a directory of skills (each a folder containing SKILL.md),
 * builds a reference graph between skills, and reports:
 *   - orphans : skills nobody references (dead assets?)
 *   - hubs    : skills referenced by many (load-bearing base skills)
 *   - conflicts: duplicate names or near-duplicate descriptions
 *   - coverage: how many skill folders actually have SKILL.md
 *
 * Output: terminal summary + JSON report (+ optional dark-themed HTML).
 *
 * Usage:
 *   node bin/cli.js <skills-dir> [--html report.html] [--json report.json]
 *
 * Zero runtime dependencies. Node >= 18.
 */
'use strict';
const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const args = { dir: null, html: null, json: null, similarity: 0.45, semantic: true };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--html') args.html = argv[++i];
    else if (argv[i] === '--json') args.json = argv[++i];
    else if (argv[i] === '--similarity') args.similarity = parseFloat(argv[++i]);
    else if (argv[i] === '--no-semantic') args.semantic = false;
    else if (!args.dir) args.dir = argv[i];
  }
  return args;
}

/* ---------- semantic similarity (zero-dependency) ----------
 * Mixed-language tokenizer: ASCII words + CJK character bigrams.
 * Scoring: TF-IDF weights + cosine similarity.
 * This catches near-duplicate skills that never name-reference each other —
 * the case regex-based edge detection structurally cannot see.            */
function tokenize(text) {
  const tokens = [];
  const lower = String(text || '').toLowerCase();
  for (const m of lower.matchAll(/[a-z0-9][a-z0-9_-]+/g)) tokens.push(m[0]);
  const cjk = lower.match(/[\u4e00-\u9fff]/g) || [];
  for (let i = 0; i + 1 < cjk.length; i++) tokens.push(cjk[i] + cjk[i + 1]);
  return tokens;
}

function tfidfVectors(docs) {
  const df = new Map();
  const perDoc = docs.map((d) => {
    const tf = new Map();
    for (const t of tokenize(d.text)) tf.set(t, (tf.get(t) || 0) + 1);
    for (const t of tf.keys()) df.set(t, (df.get(t) || 0) + 1);
    return tf;
  });
  const N = docs.length || 1;
  return perDoc.map((tf) => {
    const vec = new Map();
    let norm = 0;
    for (const [t, f] of tf) {
      const idf = Math.log(1 + N / (df.get(t) || 1));
      const w = (1 + Math.log(f)) * idf;
      vec.set(t, w);
      norm += w * w;
    }
    norm = Math.sqrt(norm) || 1;
    for (const [t, w] of vec) vec.set(t, w / norm);
    return vec;
  });
}

function cosine(a, b) {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let dot = 0;
  for (const [t, w] of small) {
    const w2 = large.get(t);
    if (w2) dot += w * w2;
  }
  return dot;
}

function semanticScan(nodes, threshold) {
  // Score the two signals separately and take the stronger one. Mixing them
  // into a single vector dilutes the signal: two skills with byte-identical
  // descriptions scored only 0.40 when their (unrelated) bodies were pooled in.
  const heads = nodes.map((n) => ({ id: n.id, text: `${n.name} ${n.description}` }));
  const bodies = nodes.map((n) => ({
    id: n.id,
    text: n.text.replace(/^---[\s\S]*?---/, '').slice(0, 1200),
  }));
  const hv = tfidfVectors(heads);
  const bv = tfidfVectors(bodies);
  const scored = [];
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const h = cosine(hv[i], hv[j]);
      const b = cosine(bv[i], bv[j]);
      const score = Math.max(h, b);
      if (score <= 0) continue;
      scored.push({
        a: nodes[i].id,
        b: nodes[j].id,
        score: Number(score.toFixed(3)),
        basis: h >= b ? 'description' : 'body',
      });
    }
  }
  scored.sort((x, y) => y.score - x.score);
  return {
    threshold,
    // calibration note: default threshold is tuned on a 463-skill real library.
    // `top` is always emitted (all non-zero pairs, ranked) so users see the
    // closest candidates even when the library is healthy and below threshold.
    top: scored.slice(0, 10),
    pairs: scored.filter((p) => p.score >= threshold).slice(0, 50),
    missingDescription: nodes.filter((n) => !n.description).map((n) => n.id),
  };
}

/** Extract YAML-ish frontmatter (name:, description:) from markdown text. */
function parseFrontmatter(text) {
  const fm = { name: null, description: null };
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const head = m ? m[1] : text.slice(0, 2000);
  const name = head.match(/^name\s*:\s*(.+)$/m);
  const desc = head.match(/^description\s*:\s*(.+)$/m);
  if (name) fm.name = name[1].trim().replace(/^["']|["']$/g, '');
  if (desc) fm.description = desc[1].trim().replace(/^["']|["']$/g, '');
  return fm;
}

// Discover skill folders: "dir/SKILL.md" (fallback: "root/SKILL.md").
function discoverSkills(root) {
  const skills = [];
  const rootSkill = path.join(root, 'SKILL.md');
  if (fs.existsSync(rootSkill)) {
    skills.push({ name: path.basename(root), dir: root, skillMd: rootSkill });
  }
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const skillMd = path.join(root, entry.name, 'SKILL.md');
    if (fs.existsSync(skillMd)) {
      skills.push({ name: entry.name, dir: path.join(root, entry.name), skillMd });
    }
  }
  return skills;
}

function audit(root, opts = {}) {
  const skills = discoverSkills(root);
  const missingSkillMd = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (!skills.some((s) => s.dir === path.join(root, entry.name))) {
      missingSkillMd.push(entry.name);
    }
  }

  // Load contents and resolve effective names.
  const nodes = skills.map((s) => {
    const text = fs.readFileSync(s.skillMd, 'utf8');
    const fm = parseFrontmatter(text);
    return {
      id: s.name,
      name: fm.name || s.name,
      description: fm.description || '',
      dir: s.dir,
      text,
    };
  });

  // Build edges: skill A references skill B's folder id OR declared name.
  const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const idPatterns = [];
  for (const n of nodes) {
    const tokens = new Set([n.id, n.name].filter(Boolean));
    for (const t of tokens) {
      idPatterns.push({ id: n.id, token: t, re: new RegExp(`(?:^|[^\\w-])${escRe(t)}(?:[^\\w-]|$)`) });
    }
  }
  const edges = [];
  for (const a of nodes) {
    for (const p of idPatterns) {
      if (p.id === a.id) continue;
      const hits = (a.text.match(new RegExp(p.re.source, 'g')) || []).length;
      if (hits > 0) edges.push({ from: a.id, to: p.id, via: p.token, refs: hits });
    }
  }
  const inDeg = Object.fromEntries(nodes.map((n) => [n.id, 0]));
  for (const e of edges) inDeg[e.to] += 1;
  const outDeg = Object.fromEntries(nodes.map((n) => [n.id, 0]));
  for (const e of edges) outDeg[e.from] += 1;

  const orphans = nodes.filter((n) => inDeg[n.id] === 0).map((n) => n.id);
  const hubs = nodes
    .filter((n) => inDeg[n.id] >= 3)
    .sort((a, b) => inDeg[b.id] - inDeg[a.id])
    .map((n) => ({ id: n.id, inbound: inDeg[n.id]}));

  // Conflicts: duplicate effective names / duplicate description prefixes.
  const byName = {};
  for (const n of nodes) (byName[n.name] = byName[n.name] || []).push(n.id);
  const dupNames = Object.entries(byName)
    .filter(([, v]) => v.length > 1)
    .map(([k, v]) => ({ name: k, ids: v }));
  const descSeen = {};
  const dupDescriptions = [];
  for (const n of nodes) {
    const key = (n.description || '').slice(0, 60).toLowerCase();
    if (!key) continue;
    if (descSeen[key]) dupDescriptions.push({ ids: [descSeen[key], n.id], prefix: key });
    else descSeen[key] = n.id;
  }

  return {
    version: '1.1.0',
    generatedAt: new Date().toISOString(),
    root: path.resolve(root),
    coverage: { withSkillMd: nodes.length, totalDirs: nodes.length + missingSkillMd.length },
    stats: {
      nodes: nodes.length,
      edges: edges.length,
      orphans: orphans.length,
      hubs: hubs.length,
      conflicts: dupNames.length + dupDescriptions.length,
      semanticPairs: opts.semantic === false ? null : undefined,
    },
    nodes: nodes.map((n) => ({ id: n.id, name: n.name, description: n.description, inbound: inDeg[n.id], outbound: outDeg[n.id] })),
    edges,
    orphans,
    hubs,
    conflicts: { duplicateNames: dupNames, duplicateDescriptions: dupDescriptions },
    missingSkillMd,
  };
}

/* ---------- HTML report (dark theme) ---------- */
function toHtml(r) {
  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const rows = (arr, f) => arr.map(f).join('') || '<tr><td colspan="3">—</td></tr>';
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>skill-audit-kit report</title>
<style>body{background:#0b0e14;color:#dde3ee;font-family:Inter,'PingFang SC',sans-serif;padding:32px;max-width:960px;margin:auto}
h1{font-size:20px;color:#f5c451}h2{font-size:15px;color:#8b96ad;margin:26px 0 8px}
table{width:100%;border-collapse:collapse;font-size:13px}th,td{border:1px solid #253048;padding:7px 10px;text-align:left}
th{background:#1c2338;color:#8b96ad}.kpi{display:inline-block;background:#161c2c;border:1px solid #253048;border-radius:8px;padding:10px 16px;margin:4px}
.kpi b{color:#4f8cff;font-size:18px}.tag-o{color:#ff6b6b}.tag-h{color:#4ade80}.tag-c{color:#f5c451}</style></head><body>
<h1>skill-audit-kit · library health report</h1>
<p style="color:#8b96ad">${esc(r.root)} · ${esc(r.generatedAt)}</p>
<div>
<span class="kpi"><b>${r.stats.nodes}</b> skills</span>
<span class="kpi"><b>${r.stats.edges}</b> edges</span>
<span class="kpi"><b class="tag-o">${r.stats.orphans}</b> orphans</span>
<span class="kpi"><b class="tag-h">${r.stats.hubs}</b> hubs</span>
<span class="kpi"><b class="tag-c">${r.stats.conflicts}</b> conflicts</span>
<span class="kpi"><b>${r.coverage.withSkillMd}/${r.coverage.totalDirs}</b> SKILL.md coverage</span>
</div>
<h2>Orphans (inbound = 0)</h2><table><tr><th>#</th><th>id</th></tr>${rows(
    r.orphans, (id, i) => `<tr><td>${i + 1}</td><td>${esc(id)}</td></tr>`)}
</table>
<h2>Hubs (inbound ≥ 3)</h2><table><tr><th>id</th><th>inbound</th></tr>${rows(
    r.hubs, (h) => `<tr><td>${esc(h.id)}</td><td>${h.inbound}</td></tr>`)}
</table>
<h2>Conflicts</h2><table><tr><th>type</th><th>detail</th></tr>${rows(
    r.conflicts.duplicateNames, (c) => `<tr><td>duplicate name</td><td>${esc(c.name)} → ${esc(c.ids.join(', '))}</td></tr>`) +
    rows(r.conflicts.duplicateDescriptions, (c) => `<tr><td>duplicate description</td><td>${esc(c.ids.join(', '))} · "${esc(c.prefix)}…"</td></tr>`)}
</table>
<h2>Graph edges</h2><table><tr><th>from</th><th>→</th><th>refs</th></tr>${rows(
    r.edges, (e) => `<tr><td>${esc(e.from)}</td><td>${esc(e.to)}</td><td>${e.refs}</td></tr>`)}
</table>
${r.semantic ? `<h2>Semantic near-duplicates (≥ ${r.semantic.threshold}, TF-IDF cosine)</h2>
<p style="color:#8b96ad;font-size:12px">Signals scored separately (name+description, and body); the stronger one wins.
These are <b>candidates for human review</b>, not verdicts — family tools
(e.g. <code>x</code> / <code>x-core</code>) legitimately score high.</p>
<table><tr><th>a</th><th>b</th><th>similarity</th><th>basis</th></tr>${rows(
    r.semantic.pairs, (p) => `<tr><td>${esc(p.a)}</td><td>${esc(p.b)}</td><td>${p.score}</td><td>${esc(p.basis || '')}</td></tr>`)}
</table>
<h2>Closest candidates (Top ${r.semantic.top.length}, regardless of threshold)</h2>
<table><tr><th>a</th><th>b</th><th>similarity</th></tr>${rows(
    r.semantic.top, (p) => `<tr><td>${esc(p.a)}</td><td>${esc(p.b)}</td><td>${p.score}</td></tr>`)}
</table>
<h2>Missing description (${r.semantic.missingDescription.length})</h2>
<p style="color:#8b96ad;font-size:12px">${esc(r.semantic.missingDescription.slice(0, 60).join(', ')) || '—'}</p>` : ''}
</body></html>`;
}

/* ---------- main ---------- */
const args = parseArgs(process.argv.slice(2));
if (!args.dir) {
  console.error('Usage: node bin/cli.js <skills-dir> [--html report.html] [--json report.json]');
  process.exit(2);
}
const report = audit(args.dir, { semantic: args.semantic });
if (args.semantic) {
  report.semantic = semanticScan(
    discoverSkills(args.dir).map((s) => {
      const text = fs.readFileSync(s.skillMd, 'utf8');
      const fm = parseFrontmatter(text);
      return { id: s.name, name: fm.name || s.name, description: fm.description || '', text };
    }),
    args.similarity
  );
  report.stats.semanticPairs = report.semantic.pairs.length;
}

// Terminal summary
console.log(`skill-audit-kit — ${report.root}`);
console.log(`  skills: ${report.stats.nodes}  edges: ${report.stats.edges}`);
console.log(`  orphans: ${report.stats.orphans}  hubs: ${report.stats.hubs}  conflicts: ${report.stats.conflicts}`);
console.log(`  SKILL.md coverage: ${report.coverage.withSkillMd}/${report.coverage.totalDirs}`);
if (report.semantic) {
  console.log(`  semantic near-duplicates (≥${report.semantic.threshold}): ${report.semantic.pairs.length}`);
  console.log(`  top similarity candidates:`);
  for (const p of report.semantic.top.slice(0, 5)) {
    console.log(`    · ${p.a} ≈ ${p.b} (${p.score})`);
  }
  console.log(`  missing description: ${report.semantic.missingDescription.length}`);
}
if (report.orphans.length) console.log(`  orphans: ${report.orphans.slice(0, 20).join(', ')}${report.orphans.length > 20 ? ` …(+${report.orphans.length - 20})` : ''}`);
if (report.missingSkillMd.length) console.log(`  missing SKILL.md: ${report.missingSkillMd.slice(0, 10).join(', ')}`);

if (args.json) fs.writeFileSync(args.json, JSON.stringify(report, null, 2));
if (args.html) fs.writeFileSync(args.html, toHtml(report));
if (report.stats.nodes === 0) process.exit(1);
