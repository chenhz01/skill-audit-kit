# skill-audit-kit

**Health check for an existing skill / rule library.**

Frameworks teach you how to *write* skills. Nothing checks the two hundred you already have. After a few months of agent use, every library accumulates the same decay:

- **Orphans** — skills nothing references and nothing uses (installed ≠ used)
- **Hubs** — load-bearing base skills whose breakage would cascade
- **Conflicts** — duplicate names or copy-pasted descriptions that confuse routing
- **Semantic near-duplicates** — two skills that do the same job without ever referencing each other (invisible to grep)
- **Coverage gaps** — folders that look like skills but have no `SKILL.md`

`skill-audit-kit` scans the folder, builds the reference graph, scores semantic similarity, and tells you the truth — as a terminal summary, JSON, and a dark-themed HTML report.

## Install

No dependencies. Node >= 18.

```bash
git clone https://github.com/chenhz01/skill-audit-kit.git
# or just copy bin/cli.js
```

## Usage

```bash
# terminal summary
node bin/cli.js ~/.my-agent/skills

# JSON + HTML report
node bin/cli.js ~/.my-agent/skills --json report.json --html report.html

# tune the semantic threshold (default 0.45) or disable semantic scoring
node bin/cli.js ~/.my-agent/skills --similarity 0.5
node bin/cli.js ~/.my-agent/skills --no-semantic
```

Exit codes: `0` healthy, `1` no skills found, `2` bad arguments.

## Example output (real run: 463-skill library)

```
skill-audit-kit — ~/.my-agent/skills
  skills: 463  edges: 1371
  orphans: 73  hubs: 112  conflicts: 24
  SKILL.md coverage: 463/469
  semantic near-duplicates (≥0.45): 6
  top similarity candidates:
    · recruitment-specialist ≈ support-recruitment-specialist (0.744)
    · hyperframes ≈ hyperframes-core (0.529)
    · copywriting ≈ marketing-cro (0.507)
  missing SKILL.md: 6 folders
```

`4.3s` for 463 skills / ~107k similarity pairs, single-threaded, zero dependencies.

The `demo/` folder is a miniature library (3 skills) that reproduces one orphan + one duplicate-description conflict — run it against `demo/` to see the report without touching your real library.

## How edges are detected

Skill B references skill A if B's `SKILL.md` mentions A's folder id or declared `name:` with word boundaries. That is deliberately simple and grep-level honest: it can miss dynamic references, but it never invents an edge. `--json` gives you the raw graph (`nodes`, `edges`) if you want to build fancier analysis on top.

## How semantic similarity works

Character-level and word-level tokenization (ASCII words + CJK bigrams) → TF-IDF weights → cosine similarity. The two signals are scored **separately** and the stronger one wins:

- **`description` signal** — cosine over `name + description`
- **`body` signal** — cosine over the document body (frontmatter stripped, first 1,200 chars)

Separate scoring matters: pooling everything into one vector is *not* a neutral choice, it dilutes the signal. With pooled vectors, two skills whose descriptions are byte-identical scored only **0.40** — below threshold, i.e. the exact case the feature exists to catch would have been missed. Split signals score the same pair at **0.83**. The report shows which signal fired (`basis` column), so you can tell a description-level duplicate from a body-level one.

**Calibration, stated honestly:** the default threshold `0.45` was tuned by running against a real 463-skill library, where `0.72` produced zero hits (a miscalibrated default is a dead feature) and `0.45` produced six pairs. Manual review found those pairs are a **mix**: genuine duplicates *and* legitimate family tools (`x` / `x-core`, a specialist and its sub-specialist). That is the honest character of the metric — it is a **candidate ranking for human review, not a verdict**. Because thresholds are corpus-specific, the tool **always prints the top-10 candidates** regardless of threshold, so you see the signal even if the cutoff is wrong for your library. It never deletes or merges anything.

## Known limits

- Similarity is O(n²) over pairs: ~4s at 460 skills, expect ~20s+ beyond ~1,500 skills (an inverted index is the known fix, not yet implemented).
- Similarity is lexical, not embedding-based: it misses paraphrase with no shared vocabulary. An optional embedding backend is the obvious next step; the current default stays offline and free on purpose.

## FAQ

**Why not hook into my agent framework's loader?**
Because the point is to audit the *stock* library — including skills your current framework never loads. A filesystem-level view works across frameworks.

**What counts as a hub?**
Inbound references ≥ 3. Those are your base skills: if you rename or break one, several skills silently degrade. The report names them so you can protect them.

## Collaboration / 合作

MIT, free to use. If you want your library audited at scale, this wired into your
own agent framework, or the similarity signal swapped for an embedding backend —
write to **hcac4735@agent.qq.com** with the subject `[skill-audit-kit]`, or open
an issue.

## License

MIT
