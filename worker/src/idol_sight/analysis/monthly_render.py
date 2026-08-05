"""월간 보고서 — 16:9 종합 단일판 렌더러 (v2.2, 2026-08-05).

디자인 스펙(타이포그래피·덱 구성 전문가 패널, 스펙 문서 참조):
- **16:9 페이지 체계**(v2.2, A4 가로에서 전환): .page 1280×720px 고정
  (@96dpi), mm 미사용, @page size:1280px 720px + break-after:page. 총
  5페이지(표지+본문 4) — 2열 병치(컬럼 폭 55/45 또는 50/50, 거터 24px)가
  기본 문법, viewBox 폭 = 컬럼 실폭(50/50→570, 55/45 우측→500 · 폰트 1:1,
  축소 스케일 금지). 세로 예산 638px(720−패딩) — 차트 높이는 예산 역산.
- **타이포**: 정수 px 스케일(표지46/키커11/블록헤더18/본문14/표13/캡션12 하한),
  8px 수직 리듬, 전역 tabular-nums. #9ca3af 텍스트 금지(장식 전용),
  ≤14px 회색 텍스트 하한 #6b7280. 판정 미달 색 #b45309(AA 통과).
- **그룹 컬러**: 대시보드 groups.ts 미러 — 면은 원색(학습 유지), 선·테두리는
  edge 변형(HSL L−22pp, 흰 종이 보정), 텍스트는 잉크 원칙(자사 강조만
  #1d6f6a). 비그룹 차원(연령·국가)에는 그룹색 금지.
- **넘침은 데이터 캡으로 차단**(CSS 클리핑은 최후 안전망), 결손은 동일 높이
  placeholder 로 페이지 붕괴 방지.
- 자립 HTML·이미지/base64 금지·print-color-adjust exact.
"""

from __future__ import annotations

import html as _html
import math
from typing import Any

from idol_sight.analysis.monthly_report import (
    KPI_LABELS,
    TIER_LABELS,
    fmt_num,
    mom_phrase,
)

INK = "#1f2933"
INK2 = "#52606d"          # 축·보조 라벨 (SVG 허용 4색 중 하나)
MUTED = "#6b7280"         # ≤14px 회색 텍스트 하한
KEY = "#75d7d1"           # 자사 — 면·마커 전용
KEY_EDGE = "#31aaa3"
KEY_DARK = "#1d6f6a"      # 자사 강조 텍스트(유일한 유색 텍스트 예외)
WARN_TEXT = "#b45309"     # 판정 미달(AA) — 그래픽용 주황은 #d97706 유지
WARN_GFX = "#d97706"
NEUTRAL_BAR = "#c3cbd1"   # 비그룹 차원 막대

# 대시보드 frontend/src/design/groups.ts 미러 — (면 fill, edge 변형).
# edge = HSL(h, s, max(L−22pp, 38%)) 사전 계산. 팔레트 변경 시 동반 갱신.
GROUP_COLORS: dict[str, tuple[str, str]] = {
    "plave": ("#ec4899", "#b11261"),
    "isedol": ("#22c55e", "#1da54f"),
    "stellive": ("#818cf8", "#172bf2"),
    "skinz": ("#f59e0b", "#ba7808"),
    "myrakl": ("#a855f7", "#700ad2"),
    "owis": ("#3b82f6", "#094cb9"),
    "miiwan": ("#75d7d1", "#31aaa3"),
    "bdawn": ("#ef4444", "#b30f0f"),
    "wegosix": ("#f97316", "#bd5005"),
    "uryael": ("#84cc16", "#71af13"),
    "hollin": ("#d946ef", "#a010b5"),
    "begritz": ("#0ea5e9", "#0b81b7"),
    "bthd": ("#78dd5f", "#3ea824"),
}
_FALLBACK = ("#c3cbd1", "#8b959d")

VERDICT_KO = {"below": "미달", "within": "밴드 내", "above": "상단 초과"}
VERDICT_COLOR = {"below": WARN_TEXT, "within": MUTED, "above": KEY_DARK}
QUAD_LABELS = {"strong": "진성 강세", "niche": "니치 충성",
               "ad_driven": "광고형", "low": "축적 단계"}

GROUP_NAMES = {"miiwan": "MiiWAN", "plave": "PLAVE", "isedol": "이세돌",
               "stellive": "스텔라이브", "skinz": "SKINZ", "myrakl": "MY:RAKL",
               "owis": "OWIS", "bdawn": "B:DAWN", "wegosix": "위고식스",
               "uryael": "UR:L", "hollin": "홀린", "begritz": "BEGRITZ",
               "bthd": "비더후드"}


def esc(s: Any) -> str:
    # 인사이트 등 저장 텍스트의 마크다운 잔재(**굵게**)는 평문화.
    return _html.escape(str(s).replace("**", ""))


def _name(key: str) -> str:
    return GROUP_NAMES.get(key, key.upper())


def _colors(key: str) -> tuple[str, str]:
    return GROUP_COLORS.get(key, _FALLBACK)


def _clip(s: str, n: int) -> str:
    return s if len(s) <= n else s[: n - 1] + "…"


def _text_w(s: str) -> float:
    """11px 기준 근사 폭 — CJK ≈ 11px, 라틴·숫자·기호 ≈ 7px."""
    return sum(11 if ord(c) > 0x2E80 else 7 for c in s)


# ── SVG 헬퍼 ──────────────────────────────────────────────────────────
# 텍스트 규칙: fill ∈ {INK, INK2, MUTED, KEY_DARK}, 최소 11 units,
# 데이터 라벨 weight 600 / 축 라벨 400. 막대 위에 얹지 않고 바깥 배치.


def _scale(vals: list[float], lo: float, hi: float,
           out_lo: float, out_hi: float) -> list[float]:
    span = (hi - lo) or 1.0
    return [out_lo + (v - lo) / span * (out_hi - out_lo) for v in vals]


def _placeholder(msg: str, height: int = 160) -> str:
    return (f"<div class='ph' style='height:{height}px'><span>{esc(msg)}"
            "</span></div>")


def svg_line(days: list[str], vals: list[float], *, width=640, height=230,
             band: tuple[float, float] | None = None,
             marks: list[tuple[str, str]] | None = None) -> str:
    """자사 시계열 — 선 stroke=KEY_EDGE, 면 fill=KEY 12%(브랜드 색감 유지)."""
    if len(vals) < 2:
        return _placeholder("표시할 시계열이 부족합니다", height)
    pad = 40
    lo = min(vals + ([band[0]] if band else []))
    hi = max(vals + ([band[1]] if band else []))
    lo, hi = lo - (hi - lo) * 0.06, hi + (hi - lo) * 0.08
    xs = _scale(list(range(len(vals))), 0, len(vals) - 1, pad, width - 10)
    ys = _scale(vals, lo, hi, height - 24, 10)
    pts = " ".join(f"{x:.1f},{y:.1f}" for x, y in zip(xs, ys, strict=True))
    area = (f"{pad},{height - 24} " + pts + f" {width - 10},{height - 24}")
    parts = [f"<svg viewBox='0 0 {width} {height}' role='img'>"]
    if band:
        by = _scale(list(band), lo, hi, height - 24, 10)
        parts.append(f"<rect x='{width - 64}' y='{min(by):.1f}' width='54' "
                     f"height='{abs(by[0] - by[1]):.1f}' fill='{KEY}' "
                     "opacity='0.15'/>")
        ly = min(by) - 5 if min(by) - 5 >= 14 else max(by) + 14
        parts.append(f"<text x='{width - 10}' y='{ly:.1f}' font-size='11' "
                     f"fill='{MUTED}' text-anchor='end'>목표 밴드</text>")
    day_idx = {d: i for i, d in enumerate(days)}
    labeled = 0
    for d, label in (marks or []):
        if d in day_idx:
            x = xs[day_idx[d]]
            parts.append(f"<line x1='{x:.1f}' y1='10' x2='{x:.1f}' "
                         f"y2='{height - 24}' stroke='#9aa4ad' "
                         "stroke-dasharray='3 3'/>")
            if labeled < 3:   # 라벨 3개 캡 — 초과분은 점선만
                parts.append(f"<text x='{x + 3:.1f}' y='20' font-size='11' "
                             f"fill='{INK2}'>{esc(_clip(label, 8))}</text>")
                labeled += 1
    parts.append(f"<polygon points='{area}' fill='{KEY}' opacity='0.12'/>")
    parts.append(f"<polyline points='{pts}' fill='none' stroke='{KEY_EDGE}' "
                 "stroke-width='2.5'/>")
    for frac in (0.0, 1.0):
        x = pad + frac * (width - 10 - pad)
        anchor = "start" if frac == 0 else "end"
        parts.append(f"<text x='{x:.1f}' y='{height - 7}' font-size='11' "
                     f"fill='{INK2}' text-anchor='{anchor}'>"
                     f"{esc(days[0 if frac == 0 else -1][5:])}</text>")
    parts.append(f"<text x='{pad}' y='18' font-size='11' font-weight='600' "
                 f"fill='{INK}'>{fmt_num(max(vals))}</text>")
    parts.append("</svg>")
    return "".join(parts)


def svg_bars(labels: list[str], vals: list[float], *, width=640, height=200,
             fill=KEY, edge=KEY_EDGE, hline: float | None = None,
             hline_label: str = "") -> str:
    if not vals:
        return _placeholder("표시할 데이터가 없습니다", height)
    pad, bottom = 40, 26
    hi = max(vals + ([hline] if hline else [])) * 1.14 or 1
    n = len(vals)
    bw = min(44, (width - pad - 10) / n * 0.62)
    parts = [f"<svg viewBox='0 0 {width} {height}' role='img'>"]
    for i, (lab, v) in enumerate(zip(labels, vals, strict=True)):
        x = pad + (i + 0.5) * (width - pad - 10) / n - bw / 2
        h = (v / hi) * (height - bottom - 14)
        y = height - bottom - h
        parts.append(f"<rect x='{x:.1f}' y='{y:.1f}' width='{bw:.1f}' "
                     f"height='{h:.1f}' fill='{fill}' stroke='{edge}' "
                     "stroke-width='1' rx='2'/>")
        parts.append(f"<text x='{x + bw / 2:.1f}' y='{y - 5:.1f}' "
                     f"font-size='11' font-weight='600' fill='{INK}' "
                     f"text-anchor='middle'>{fmt_num(v)}</text>")
        if n <= 12:
            parts.append(f"<text x='{x + bw / 2:.1f}' y='{height - 9}' "
                         f"font-size='11' fill='{INK2}' text-anchor='middle'>"
                         f"{esc(lab)}</text>")
    if hline:
        y = height - bottom - (hline / hi) * (height - bottom - 14)
        parts.append(f"<line x1='{pad}' y1='{y:.1f}' x2='{width - 10}' "
                     f"y2='{y:.1f}' stroke='#9aa4ad' stroke-dasharray='4 3'/>"
                     f"<text x='{width - 10}' y='{y - 5:.1f}' font-size='11' "
                     f"font-weight='600' fill='{INK2}' text-anchor='end'>"
                     f"{esc(hline_label)}</text>")
    parts.append("</svg>")
    return "".join(parts)


def svg_hbars(rows: list[tuple[str, float, str | None]], *, width=640,
              log_scale=False, unit="", row_h=26, pad_l=110,
              boundaries: list[int] | None = None,
              boundary_labels: list[str] | None = None) -> str:
    """가로 막대. rows=[(라벨, 값, group_key|None)] — group_key 있으면 그룹
    원색 면+edge 테두리, None 이면 중립 회색(비그룹 차원)."""
    if not rows:
        return _placeholder("표시할 데이터가 없습니다")
    height = len(rows) * row_h + 14
    vals = [max(v, 0) for _, v, _ in rows]
    tx = [math.log10(v + 1) for v in vals] if log_scale else vals
    hi = max(tx) or 1
    parts = [f"<svg viewBox='0 0 {width} {height}' role='img'>"]
    bset = set(boundaries or [])
    blabels = list(boundary_labels or [])
    for i, ((lab, v, gkey), t) in enumerate(zip(rows, tx, strict=True)):
        y = 8 + i * row_h
        if i in bset:
            parts.append(f"<line x1='0' y1='{y - 4}' x2='{width}' y2='{y - 4}' "
                         "stroke='#9aa4ad' stroke-dasharray='4 3'/>")
        if blabels and (i in bset or i == 0):
            parts.append(f"<text x='{width - 4}' y='{y + 9}' font-size='11' "
                         f"fill='{MUTED}' text-anchor='end'>"
                         f"{esc(blabels.pop(0))}</text>")
        fill, edge = _colors(gkey) if gkey else (NEUTRAL_BAR, "#8b959d")
        mine = gkey == "miiwan"
        w = (t / hi) * (width - pad_l - 92)
        name_style = (f"font-weight='700' fill='{KEY_DARK}'" if mine
                      else f"fill='{INK}'")
        parts.append(f"<text x='{pad_l - 6}' y='{y + row_h / 2 + 4:.1f}' "
                     f"font-size='11' {name_style} text-anchor='end'>"
                     f"{esc(lab)}</text>")
        parts.append(f"<rect x='{pad_l}' y='{y + 4}' width='{max(w, 2):.1f}' "
                     f"height='{row_h - 10}' fill='{fill}' stroke='{edge}' "
                     f"stroke-width='{1.5 if mine else 1}' rx='2'/>")
        parts.append(f"<text x='{pad_l + max(w, 2) + 6:.1f}' "
                     f"y='{y + row_h / 2 + 4:.1f}' font-size='11' "
                     f"font-weight='600' fill='{INK}'>{fmt_num(v)}{esc(unit)}"
                     "</text>")
    parts.append("</svg>")
    return "".join(parts)


def svg_scatter(points: list[dict], median_x: float, median_y: float,
                *, width=620, height=420) -> str:
    """인지도×코어 사분면 — 점 면=그룹 원색·테두리=edge, 전 그룹 라벨."""
    if not points:
        return _placeholder("좌표 데이터가 없습니다", height)
    pad = 46
    xs = [p["x"] for p in points]
    ys = [math.log1p(p["y"]) for p in points]
    lo_x, hi_x = min(xs + [median_x]) - 3, max(xs + [median_x]) + 3
    lo_y = min(ys + [math.log1p(median_y)]) - 0.3
    hi_y = max(ys + [math.log1p(median_y)]) + 0.3
    sx = _scale(xs, lo_x, hi_x, pad, width - 16)
    sy = _scale(ys, lo_y, hi_y, height - 34, 16)
    mx = _scale([median_x], lo_x, hi_x, pad, width - 16)[0]
    my = _scale([math.log1p(median_y)], lo_y, hi_y, height - 34, 16)[0]
    parts = [f"<svg viewBox='0 0 {width} {height}' role='img'>",
             f"<line x1='{mx:.1f}' y1='16' x2='{mx:.1f}' y2='{height - 34}' "
             "stroke='#9aa4ad' stroke-dasharray='4 3'/>",
             f"<line x1='{pad}' y1='{my:.1f}' x2='{width - 16}' "
             f"y2='{my:.1f}' stroke='#9aa4ad' stroke-dasharray='4 3'/>"]
    # 하단 캡션은 축 캡션과 같은 행(height−9) — 플롯 영역과 분리돼 점·라벨
    # 충돌이 원천 차단된다(좌하단 과밀 시 라벨 슬롯 확보).
    corner_boxes: list[tuple[float, float, float]] = []
    for lab, ax, ay, anchor in (
            ("진성 강세", width - 18, 28, "end"),
            ("니치 충성", pad + 2, 28, "start"),
            ("광고형", width - 18, height - 9, "end"),
            ("축적 단계", pad + 2, height - 9, "start")):
        parts.append(f"<text x='{ax}' y='{ay}' font-size='11' fill='{MUTED}' "
                     f"text-anchor='{anchor}'>{lab}</text>")
        w = _text_w(lab)
        corner_boxes.append((ax - w, ax, ay) if anchor == "end"
                            else (ax, ax + w, ay))
    pts3 = [(p, x, y) for p, x, y in zip(points, sx, sy, strict=True)]
    for p, x, y in pts3:
        mine = p["group_key"] == "miiwan"
        fill, edge = _colors(p["group_key"])
        parts.append(f"<circle cx='{x:.1f}' cy='{y:.1f}' r='{7 if mine else 5}'"
                     f" fill='{fill}' stroke='{edge}' stroke-width='1'/>")
    # 라벨 그리디 배치 — 오른쪽 우선, 경계 초과·겹침 시 왼쪽 플립 → 상하
    # 단계 강하. 자사 라벨을 먼저 배치해 최우선 자리 확보. 코너 캡션과
    # 점(원) 영역도 회피 대상(placed 시드).
    placed: list[tuple[float, float, float]] = list(corner_boxes)
    for p, x, y in pts3:
        r = 7 if p["group_key"] == "miiwan" else 5
        placed.append((x - r, x + r, y + 4))

    def _fits(x0: float, x1: float, ly: float) -> bool:
        return all(not (x0 < ox1 and ox0 < x1 and abs(ly - oy) < 12)
                   for ox0, ox1, oy in placed)

    for p, x, y in sorted(pts3, key=lambda t: t[0]["group_key"] != "miiwan"):
        gkey = p["group_key"]
        mine = gkey == "miiwan"
        r = 7 if mine else 5
        text = "MiiWAN" if mine else _name(gkey)
        w = _text_w(text)
        cands = []
        for dy in (0, 13, -13, 26):
            ly = y + 4 + dy
            if not (14 <= ly <= height - 26):
                continue
            for side in ("r", "l"):
                x0 = x + r + 4 if side == "r" else x - r - 4 - w
                if x0 < 2 or x0 + w > width - 2:
                    continue
                cands.append((x0, x0 + w, ly, side))
        if not cands:
            cands = [(x + r + 4, x + r + 4 + w, y + 4, "r")]
        x0, x1, ly, side = next((c for c in cands if _fits(*c[:3])), cands[0])
        placed.append((x0, x1, ly))
        lx, anchor = (x0, "start") if side == "r" else (x1, "end")
        style = (f"font-weight='700' fill='{KEY_DARK}'" if mine
                 else f"fill='{INK}'")
        parts.append(f"<text x='{lx:.1f}' y='{ly:.1f}' font-size='11' {style} "
                     f"text-anchor='{anchor}'>{esc(text)}</text>")
    parts.append(f"<text x='{width / 2}' y='{height - 9}' font-size='11' "
                 f"fill='{INK2}' text-anchor='middle'>인지도 (0~100) →</text>")
    parts.append(f"<text x='16' y='{height / 2}' font-size='11' fill='{INK2}' "
                 f"transform='rotate(-90 16 {height / 2})' "
                 "text-anchor='middle'>적극 코어 (log) →</text>")
    parts.append("</svg>")
    return "".join(parts)


# ── 페이지 프레임 ─────────────────────────────────────────────────────


def _page(kicker: str, n: int, total: int, month: str, generated: str,
          body: str, *, cover=False) -> str:
    if cover:
        return f"<section class='page cover'>{body}</section>"
    footer = (f"<footer><span>MiiWAN 월간 리포트 · {esc(month)} · 내부용</span>"
              f"<span>{n} / {total} · 생성 {esc(generated[:10])}</span></footer>")
    return (f"<section class='page'><div class='kicker'>"
            f"{n:02d} · {esc(kicker)}</div>{body}{footer}</section>")


def _block(title: str, q: str | None, body: str,
           conclusion: str | None = None) -> str:
    qh = f"<p class='q'>{esc(q)}</p>" if q else ""
    concl = f"<p class='concl'>{esc(conclusion)}</p>" if conclusion else ""
    return (f"<div class='block'><h2>{esc(title)}</h2>{qh}{concl}{body}</div>")


def _kpi_table(d: dict) -> str:
    rows = []
    for key in KPI_LABELS:
        j = d["kpi"]["judgments"][key]
        prev = d["kpi"]["prev"].get(key)
        band_cell = (f"<td class='num'>{fmt_num(j['band'][0])}~"
                     f"{fmt_num(j['band'][1])}</td>"
                     if j["band"] else "<td class='num muted'>—</td>")
        v = j["verdict"]
        verdict_cell = (
            f"<td style='color:{VERDICT_COLOR[v]};font-weight:700'>"
            f"{VERDICT_KO[v]}</td>" if v else "<td class='muted'>—</td>")
        rows.append(f"<tr><td>{esc(j['label'])}</td>"
                    f"<td class='num'>{fmt_num(j['actual'])}</td>"
                    f"<td class='num muted'>{fmt_num(prev)}</td>"
                    f"{band_cell}{verdict_cell}</tr>")
    return ("<table><thead><tr><th>KPI</th><th class='num'>실적</th>"
            "<th class='num'>전월</th><th class='num'>목표 밴드</th>"
            "<th>판정</th></tr></thead><tbody>"
            + "".join(rows) + "</tbody></table>")


# ── 본체 ─────────────────────────────────────────────────────────────


def render_deck(d: dict, *, generated_at: str, **_legacy) -> str:
    """종합 단일판 · 16:9 5페이지 맵(디자인 패널 v2.2 스펙).
    P1 표지 / P2 결과+자사 채널 / P3 커뮤니티·팬덤 / P4 시장 내 위치 /
    P5 비교·전망(리스크·전략 메모 흡수)."""
    month = d["month"]
    m_label = f"{int(month[:4])}년 {int(month[5:7])}월"
    TOTAL = 4
    pages: list[str] = []

    def cols(left: str, right: str, ratio: str = "50") -> str:
        return (f"<div class='cols r{ratio}'><div class='colL'>{left}</div>"
                f"<div class='colR'>{right}</div></div>")

    # P1 표지 — 16:9: 좌측 정렬 대형 타이틀 + 좌변 키컬러 보더 + 브랜드 키커.
    pages.append(_page("", 0, TOTAL, month, generated_at, (
        "<div class='kicker'>idol-sight · 내부용</div>"
        f"<h1>MiiWAN 월간 리포트</h1><p class='cover-sub'>{esc(m_label)}</p>"
        f"<p class='stamp'>생성 {esc(generated_at[:10])} · 데이터 기준 "
        f"{esc(month)} 월말 스냅샷 · 좌표·전환율은 생성 시점 기준</p>"),
        cover=True))

    # ── P2 이번 달 결과 + 자사 채널 (좌 55 / 우 45) ─────────────────
    bullets = [d["kpi"]["headline"]]
    for ln in (d["tier_line"], d["cohort_line"], d["quadrant_move"],
               d["spike_note"]):
        if ln:
            bullets.append(ln)
    summary = "<ul class='bullets'>" + "".join(
        f"<li>{esc(_clip(b, 90))}</li>" for b in bullets[:5]) + "</ul>"
    warn_html = ""
    if d["warnings"]:
        ws = d["warnings"][:2]
        extra = f" / 외 {len(d['warnings']) - 2}건" if len(d["warnings"]) > 2 else ""
        warn_html = ("<div class='warnbox'>데이터 참고: "
                     + " / ".join(esc(w) for w in ws) + extra + "</div>")
    left2 = (_block("이달의 요약", "지난달을 다섯 줄로 말하면?", summary)
             + _block("핵심 지표", None, _kpi_table(d), d["kpi"]["headline"])
             + warn_html)

    series = d["subs_series"]
    band = d["kpi"]["judgments"]["subscribers"]["band"]
    ev_marks = [(e["event_date"], e["title"])
                for e in d["events"] if e["event_date"].startswith(month)]
    gain_txt = (f" · 월간 순증 +{fmt_num(d['subs_gain'])}"
                if d["subs_gain"] is not None else "")
    subs_block = _block(
        "구독자 성장", None,
        svg_line([r["day"] for r in series], [r["subs"] for r in series],
                 width=500, height=205, band=band, marks=ev_marks)
        + (f"<p class='note'>{esc(_clip(d['spike_note'], 80))}</p>"
           if d["spike_note"] else ""),
        mom_phrase(d["kpi"]["actuals"]["subscribers"],
                   d["kpi"]["prev"]["subscribers"]) + gain_txt)
    ccv = d["ccv"]
    casts = ccv["broadcasts"]
    cast_note = ""
    if len(casts) > 10:  # 과밀 캡: 500폭 기준 — 평균 상위 10회 시간순
        top = sorted(casts, key=lambda b: -b["avg"])[:10]
        casts = sorted(top, key=lambda b: b["started"])
        cast_note = f" · 상위 10회 표시 (총 {ccv['count']}회)"
    live_block = _block(
        "라이브 방송", None,
        svg_bars([b["started"][5:] for b in casts], [b["avg"] for b in casts],
                 width=500, height=180, hline=ccv["avg"],
                 hline_label=f"월평균 {fmt_num(ccv['avg'])}")
        + f"<p class='note'>관측 방송 {ccv['count']}회 · 최고 동접 "
          f"{fmt_num(ccv['peak'])}명{cast_note}</p>",
        f"평균 동접 {mom_phrase(ccv['avg'], d['ccv_prev']['avg'])}")
    pages.append(_page("이번 달 결과 · 자사 채널", 1, TOTAL, month,
                       generated_at, cols(left2, subs_block + live_block, "55")))

    # ── P3 커뮤니티·팬덤 (좌 50 / 우 50) ────────────────────────────
    wser = d["weverse_series"]
    wv, wvp = d["weverse"], d["weverse_prev"]
    if wser:
        wdays = [r["day"] for r in wser]
        wv_chart = ("<h3>가입자</h3>"
                    + svg_line(wdays, [r["total_members"] or 0 for r in wser],
                               width=570, height=170)
                    + "<h3>유료 멤버십</h3>"
                    + svg_line(wdays,
                               [r["digital_membership"] or 0 for r in wser],
                               width=570, height=170))
    else:
        wv_chart = (_placeholder("이 달 위버스 기록이 없습니다", 170)
                    + _placeholder("이 달 위버스 기록이 없습니다", 170))
    wv_note = (f"<p class='note'>{esc(wv['day'])} 기준(월말 행 부재)</p>"
               if wv and wv.get("partial") else "")
    left3 = _block(
        "위버스 커뮤니티", "팬 커뮤니티는 커지고 있나?", wv_chart + wv_note,
        "가입 " + mom_phrase(wv["members"] if wv else None,
                           wvp["members"] if wvp else None)
        + " · 멤버십 " + mom_phrase(wv["membership"] if wv else None,
                                wvp["membership"] if wvp else None))

    loy = d.get("loyalty") or {}
    conv = loy.get("conversion_rate")
    conv_txt = f"{conv * 100:.1f}%" if conv is not None else "—"
    loy_win = loy.get("window_days") or 56
    tiles = ("<div class='tiles'>"
             f"<div class='tile'><div class='tv'>{conv_txt}</div>"
             f"<div class='tl'>시청전환율 — 라이브 동접÷구독 · 최근 {loy_win}일 "
             "· 생성 시점 기준(대시보드 동일 값)</div></div>"
             f"<div class='tile'><div class='tv'>"
             f"{'+' + fmt_num(d['news_delta']) if d['news_delta'] is not None else '—'}"
             "</div><div class='tl'>월간 뉴스 증분 (자사 집계)</div></div></div>")
    demo = d["demographics"]
    agg: dict[str, float] = {}
    for r in demo:
        agg[r["age_group"]] = agg.get(r["age_group"], 0) + (r["viewer_pct"] or 0)
    demo_svg = (svg_hbars([(a.replace("age", ""), round(v, 1), None)
                           for a, v in sorted(agg.items())],
                          width=570, unit="%", pad_l=64)
                if agg else _placeholder("소유자 데이터 미연결", 140))
    ctry_svg = (svg_hbars([(c["country"], round((c["watch_share"] or 0) * 100, 1),
                            None) for c in d["countries"][:5]],
                          width=570, unit="%", pad_l=64)
                if d["countries"] else _placeholder("소유자 데이터 미연결", 140))
    right3 = _block("팬덤의 질과 구성", "성장이 건강하고, 누가 팬인가?",
                    tiles + "<h3>연령대별 시청 비중</h3>" + demo_svg
                    + "<h3>국가별 시청 비중 (상위 5)</h3>" + ctry_svg
                    + "<p class='note'>자사 채널 실측(소유자 데이터) · 전체 "
                      "시청 시간 대비 %</p>")
    pages.append(_page("커뮤니티·팬덤", 2, TOTAL, month, generated_at,
                       cols(left3, right3)))

    # ── P4 시장 내 위치 (전폭 배너 + 좌 티어 / 우 사분면) ───────────
    concl = " ".join(x for x in [d["tier_line"], d["quadrant_move"]] if x)
    banner = f"<p class='concl'>{esc(concl)}</p>" if concl else ""
    tier = d["tier"]
    kpop_rows = (tier or {}).get("kpop_rows") or []
    has_flow = any((r.get("view_flow_90d") or 0) > 0 for r in kpop_rows)
    if has_flow:
        rows, bounds, blabels, prev_t = [], [], [], None
        for i, r in enumerate(kpop_rows[:13]):
            t = r.get("tier")
            if t != prev_t:
                if i > 0:
                    bounds.append(i)
                blabels.append(TIER_LABELS.get(t, f"T{t}") if t else "")
                prev_t = t
            rows.append((_name(r["group_key"]), r.get("view_flow_90d") or 0,
                         r["group_key"]))
        tier_html = ("<h3>관심 규모 — 최근 90일 조회 증분 (K-POP 버추얼)</h3>"
                     + svg_hbars(rows, width=570, log_scale=True,
                                 boundaries=bounds, boundary_labels=blabels,
                                 pad_l=92)
                     + "<p class='note'>막대 길이 log 스케일 · 티어 경계 = "
                       "규모 격차 0.5데케이드(≈3.2배) 이상 · 대시보드 동일 "
                       "그룹 색</p>")
    else:
        tier_html = ("<h3>관심 규모 티어</h3>"
                     + _placeholder("관심 규모 티어는 2026-08 신설 — "
                                    "8월 보고서부터 표기", 120))
    quad = d["quadrant"]
    quad_html = ("<h3>인지도 × 적극 코어 사분면 (K-POP 버추얼)</h3>"
                 + (svg_scatter(quad["points"], quad["median_x"],
                                quad["median_y"], width=570, height=420)
                    if quad else _placeholder("좌표 데이터 없음", 300))
                 + "<p class='note'>십자선 = 카테고리 중앙값 · 적극 코어 = "
                   "최근 30일 댓글 상위 5편 중앙값(추정) · 좌표는 생성 시점 "
                   "기준(산식 v2) — 대시보드 시장 지도와 동일 값</p>")
    pages.append(_page("시장 내 위치", 3, TOTAL, month, generated_at,
                       f"<h2>시장 어디에 있고 어느 방향인가?</h2>{banner}"
                       + cols(tier_html, quad_html)))

    # ── P5 비교·전망 (좌: 동시기+리스크 / 우: 메모+다음 달+면책) ────
    coh = d["cohort"]
    if coh["rows"]:
        crows = coh["rows"][:6]
        hrows = [(_name(r["group"]), r["multiple"], r["group"]) for r in crows]
        excl = ""
        if coh["excluded"]:
            excl = (f"<p class='note'>제외 {len(coh['excluded'])}팀 — "
                    + _clip(", ".join(
                        f"{_name(e['group'])}({e['reason']})"
                        for e in coh["excluded"]), 80) + "</p>")
        coh_html = (f"<p class='note'>데뷔일 정렬 D+{coh['age_days']}일"
                    "(보고 월말) 시점 구독 성장배수(D0 대비) · 대시보드 동시기 "
                    "화면은 '오늘' 기준이라 시점이 다를 수 있음</p>"
                    + svg_hbars(hrows, width=570, unit="x", pad_l=92) + excl)
    else:
        coh_html = _placeholder("코호트 비교 가능 데이터가 없습니다", 140)
    coh_block = _block("동시기 성과", "같은 성장 단계 대비 빠른가?",
                       coh_html, d["cohort_line"])
    alerts = d["alerts"]
    if alerts:
        order = {"critical": 0, "warn": 1, "info": 2}
        shown = sorted(alerts, key=lambda a: order.get(a["severity"], 9))[:4]
        risk = "<ul class='bullets'>" + "".join(
            f"<li>{esc(a['fired_at'][:10])} [{esc(a['severity'])}] "
            f"{esc(_clip(a['title'], 55))}</li>" for a in shown)
        if len(alerts) > 4:
            risk += f"<li class='muted'>외 {len(alerts) - 4}건</li>"
        risk += "</ul>"
    else:
        risk = ("<p class='body-line'>월내 발생 알림 0건 — 본체 노출·AI 도용·"
                "논란 급증 매일 자동 감시.</p>")
    risk += (f"<p class='note'>월말 논란 글 지표 {fmt_num(d['controversy'])}건"
             " (14일 창)</p>")
    left5 = coh_block + _block("리스크 모니터", None, risk)

    ins = "".join(
        f"<li><b>{esc(_clip(i['title'], 40))}</b> — "
        f"{esc(_clip(i['ai_comment'], 80))} "
        f"<span class='muted'>(주 {esc(i['week_start'])})</span></li>"
        for i in d["insights"][:3]) or "<li>큐레이션 대상 인사이트 없음</li>"
    memo_block = _block("전략 메모", None,
                        f"<ul class='bullets'>{ins}</ul>"
                        "<p class='note'>주간 분석에서 자동 선별 · 검수 전 "
                        "참고용</p>")
    next_events = [e for e in d["events"]
                   if not e["event_date"].startswith(month)][:6]
    ev_lines = "".join(
        f"<li>{esc(e['event_date'])} — {esc(_clip(e['title'], 45))} "
        f"<span class='muted'>({esc(e['confidence'])})</span></li>"
        for e in next_events) or "<li>등록된 예정 이벤트 없음</li>"
    watch = [k for k, j in d["kpi"]["judgments"].items()
             if j["verdict"] == "below"]
    watch_txt = ("주시 포인트: " + " · ".join(KPI_LABELS[k] for k in watch)
                 if watch else "주시 포인트: 전 KPI 밴드 내 유지 여부")
    next_block = _block("다음 달", None,
                        f"<ul class='bullets'>{ev_lines}</ul>", watch_txt)
    disclaimer = ("<p class='disclaim'>idol-sight 자동 생성 보고서 · 결론 "
                  "문장은 규칙 기반 자동 산출 · 경쟁사 수치는 공개 신호 기반 "
                  "추정 포함 · 산식·방법론은 대시보드 각 화면 도움말 참조</p>")
    pages.append(_page("비교·전망", 4, TOTAL, month, generated_at,
                       cols(left5, memo_block + next_block + disclaimer)))

    title = f"MiiWAN 월간 리포트 {esc(month)}"
    return f"""<!doctype html><html lang='ko'><head><meta charset='utf-8'>
<meta name='viewport' content='width=device-width,initial-scale=1'>
<title>{title}</title>
<style>
*{{box-sizing:border-box;margin:0;padding:0;print-color-adjust:exact;
   -webkit-print-color-adjust:exact}}
body{{font-family:'Pretendard','Apple SD Gothic Neo','Malgun Gothic',sans-serif;
     background:#e6eaed;color:{INK};font-variant-numeric:tabular-nums}}
.page{{position:relative;width:1280px;aspect-ratio:1280/720;margin:22px auto;
      background:#fff;border-radius:4px;box-shadow:0 1px 5px rgba(0,0,0,.10);
      padding:38px 58px 44px;overflow:hidden;break-after:page}}
.kicker{{font-size:11px;font-weight:700;letter-spacing:.06em;color:{KEY_DARK};
        margin-bottom:12px;text-transform:uppercase}}
.cover{{display:flex;flex-direction:column;justify-content:center;
       border-left:12px solid {KEY};padding-left:84px}}
.cover h1{{font-size:46px;font-weight:800;line-height:1.15;
          letter-spacing:-0.025em}}
.cover .kicker{{margin-bottom:18px}}
.cover-sub{{font-size:20px;font-weight:700;line-height:1.3;
           letter-spacing:-0.01em;margin-top:12px;color:{KEY_DARK}}}
.stamp{{margin-top:28px;color:{MUTED};font-size:12px;font-weight:500;
       line-height:1.5}}
.cols{{display:flex;gap:24px}}
.cols.r55 .colL{{flex:0 0 55%}} .cols.r55 .colR{{flex:1}}
.cols.r50 .colL,.cols.r50 .colR{{flex:1;min-width:0}}
.block{{margin-bottom:20px}}
h2{{font-size:18px;font-weight:800;line-height:1.25;letter-spacing:-0.02em}}
h2 + .q{{margin-top:4px}}
h3{{font-size:15px;font-weight:700;line-height:1.4;letter-spacing:-0.01em;
   color:#374151;margin:18px 0 8px}}
.q{{color:{MUTED};font-size:12px;line-height:1.5;margin-bottom:12px}}
.concl{{background:#f0faf9;border-left:4px solid {KEY};padding:8px 12px;
       font-weight:700;font-size:14px;line-height:1.5;margin:10px 0 14px}}
.body-line{{font-size:14px;line-height:1.6}}
table{{width:100%;border-collapse:collapse;font-size:13px}}
th{{padding:6px 10px;border-bottom:2px solid #374151;color:{MUTED};
   font-weight:700;font-size:11px;letter-spacing:.02em;text-align:left;
   line-height:1.3}}
td{{padding:9px 10px;border-bottom:1px solid #e5e7eb;line-height:1.45}}
th.num,td.num{{text-align:right}}
tbody tr:last-child td{{border-bottom:none}}
.muted{{color:{MUTED}}}
.bullets{{list-style:none}}
.bullets li{{padding:4px 0 4px 20px;position:relative;font-size:14px;
            line-height:1.55}}
.bullets li::before{{content:'';position:absolute;left:2px;top:12px;width:6px;
                    height:6px;border-radius:50%;background:{KEY_EDGE}}}
.note{{color:{MUTED};font-size:12px;line-height:1.5;margin-top:6px}}
.tiles{{display:flex;gap:14px;margin-bottom:12px;flex-wrap:wrap}}
.tile{{border:1px solid #e5e7eb;border-radius:6px;padding:12px 16px;
      min-width:180px;flex:1}}
.tv{{font-size:26px;font-weight:800;line-height:1.1;letter-spacing:-0.02em}}
.tl{{font-size:12px;color:{MUTED};margin-top:4px;line-height:1.45}}
.warnbox{{padding:8px 12px;font-size:12px;line-height:1.5;background:#fff7ed;
         border:1px solid {WARN_GFX};border-radius:6px;color:#9a3412}}
.ph{{display:flex;align-items:center;justify-content:center;
    border:1px dashed #cbd2d9;border-radius:6px;color:{MUTED};font-size:12px}}
.disclaim{{margin-top:14px;color:{MUTED};font-size:11px;line-height:1.5;
          border-top:1px solid #e5e7eb;padding-top:8px}}
footer{{position:absolute;left:58px;right:58px;bottom:12px;display:flex;
       justify-content:space-between;font-size:11px;line-height:1.5;
       color:{MUTED};border-top:1px solid #e5e7eb;padding-top:7px}}
svg{{width:100%;height:auto;display:block}}
@page{{size:1280px 720px;margin:0}}
@media print{{body{{background:#fff}}.page{{box-shadow:none;margin:0 auto;
             border-radius:0}}}}
</style></head><body>
{{''.join(pages)}}
</body></html>""".replace("{''.join(pages)}", "".join(pages))
