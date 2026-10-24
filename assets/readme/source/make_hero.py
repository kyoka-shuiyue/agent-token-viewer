"""Generates ../hero.svg — the agents' readings converge into the share ring around today's total.
Numbers are the 1.4.1 acceptance scan (2026-10-17). Run: python make_hero.py"""
import math, os
W, H = 1200, 420
PAPER, INK, INK2, INK3, EMBER = '#FAF6EF', '#221D18', '#6E655B', '#877C6F', '#D9541F'
CJK = "'PingFang SC','Microsoft YaHei','Noto Sans SC',-apple-system,'Segoe UI',sans-serif"
SERIF = "Georgia,'Palatino Linotype','Songti SC',serif"
MONO = "ui-monospace,SFMono-Regular,Menlo,Consolas,monospace"
AG = [('DeepSeek Harness', 53.8, '#7E8A3F'), ('Codex', 27.9, '#3F8A78'), ('OpenCode', 14.4, '#B98A5A'),
      ('Claude Code', 3.7, '#C9573A'), ('Mirage', 0.2, '#D9541F'), ('ZCode', 0.0, '#5F86A0')]
CX, CY, R, SW = 1036, 206, 102, 24
C = 2 * math.pi * R
out = []
o = out.append
o(f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}" role="img" aria-labelledby="title desc">')
o('<title id="title">Token 查看器 · Agent Token Viewer</title>')
o('<desc id="desc">本机 10 类 AI 编程 Agent 的 Token 用量汇成一个总量：DeepSeek Harness、Codex、OpenCode、Claude Code、Mirage、ZCode 的读数沿曲线汇入占比环，环中心是今日总量 710M tokens。</desc>')
o(f'<rect x="0.5" y="0.5" width="{W-1}" height="{H-1}" rx="28" fill="{PAPER}" stroke="#E9E0D2"/>')
# title block
o(f'<g id="title-block" font-family="{CJK}">')
o(f'<text x="64" y="92" font-family="{MONO}" font-size="18" letter-spacing="2" fill="{EMBER}" font-weight="600">LOCAL-FIRST · READ-ONLY · 10 AGENTS</text>')
# folded-T icon (vector)
o('<g id="icon" transform="translate(64 122)">'
  '<defs><linearGradient id="ig" x1="0" y1="0" x2="0.6" y2="1"><stop offset="0" stop-color="#EC6B2D"/><stop offset="1" stop-color="#C8461A"/></linearGradient></defs>'
  '<rect width="76" height="76" rx="19" fill="url(#ig)"/>'
  '<rect x="14" y="15" width="48" height="15" rx="4" fill="#FBF6EE"/>'
  '<rect x="29.5" y="24" width="17" height="39" rx="4" fill="#FBF6EE"/>'
  '<path d="M46.5 30 L46.5 40.5 L36 37.2 Z" fill="#E3A33C"/>'
  '<path d="M36 37.2 L46.5 30 L52 30 L46.5 33.8 Z" fill="#EFE6D8"/></g>')
o(f'<text x="160" y="182" font-size="62" font-weight="700" fill="{INK}" letter-spacing="-1"><tspan font-family="{SERIF}" font-weight="400" letter-spacing="-2">Token</tspan> 查看器</text>')
o(f'<text x="64" y="252" font-size="27" fill="{INK}">本机所有 AI 编程 Agent 的 Token 用量，</text>')
o(f'<text x="64" y="292" font-size="27" fill="{INK}">汇成<tspan fill="{EMBER}" font-weight="700">一个数</tspan>，再拆给你看。</text>')
x = 64
for label in ['v1.4.1', 'Windows 桌面版', '本地网页版', 'MIT']:
    w = 18 + len(label.encode('gbk')) * 9.6
    o(f'<rect x="{x}" y="330" width="{w:.0f}" height="38" rx="19" fill="#FFFDF9" stroke="#E3D8C8"/>')
    o(f'<text x="{x + w/2:.0f}" y="355" font-size="18" fill="{INK2}" text-anchor="middle">{label}</text>')
    x += w + 10
o('</g>')
# proof: sources → ring
o('<g id="proof">')
for i, (name, pct, col) in enumerate(AG):
    y = 92 + i * 48                                          # text baseline of this source's row
    sx, sy = 860, y - 6
    ex, ey = CX - R - SW / 2 - 10, CY - 15 + i * 6          # every reading flows into one point beside the ring
    o(f'<path d="M{sx} {sy} C {sx+40} {sy}, {ex-40:.1f} {ey:.1f}, {ex:.1f} {ey:.1f}" fill="none" stroke="{col}" stroke-width="2.4" stroke-opacity="0.6" stroke-linecap="round"/>')
    o(f'<circle cx="{sx}" cy="{sy}" r="4" fill="{col}"/>')
    o(f'<circle cx="594" cy="{sy}" r="7" fill="{col}"/>')
    o(f'<text x="609" y="{y}" font-family="{CJK}" font-size="18" fill="{INK}">{name}</text>')
    o(f'<text x="850" y="{y}" font-family="{SERIF}" font-size="18" font-weight="700" fill="{INK2}" text-anchor="end">{pct:.1f}%</text>')
o(f'<circle cx="{CX}" cy="{CY}" r="{R}" fill="none" stroke="#EFE7DB" stroke-width="{SW}"/>')
acc = 0.0
for name, pct, col in AG:
    if pct <= 0:
        continue
    L = pct / 100 * C - (2 if pct > 2 else 0)
    o(f'<circle cx="{CX}" cy="{CY}" r="{R}" fill="none" stroke="{col}" stroke-width="{SW}" stroke-dasharray="{max(L,1.5):.2f} {C:.2f}" stroke-dashoffset="{-acc/100*C:.2f}" transform="rotate(-90 {CX} {CY})"/>')
    acc += pct
o(f'<text x="{CX}" y="{CY-34}" font-family="{CJK}" font-size="18" fill="{INK3}" text-anchor="middle">今天用了多少</text>')
o(f'<text x="{CX}" y="{CY+22}" font-family="{SERIF}" font-size="54" fill="{INK}" text-anchor="middle" letter-spacing="-2">710M</text>')
o(f'<text x="{CX}" y="{CY+46}" font-family="{SERIF}" font-size="16" font-weight="700" letter-spacing="3" fill="{INK3}" text-anchor="middle">TOKENS</text>')
o(f'<text x="{CX - 40}" y="372" font-family="{CJK}" font-size="16" fill="{INK3}" text-anchor="middle">真实读数 · 2026-10-17 本机扫描</text>')
o('</g></svg>')
open(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'hero.svg'), 'w', encoding='utf-8').write('\n'.join(out))
print('hero.svg written')
