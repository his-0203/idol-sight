"""월간 보고서 — 16:9 종합 단일판 렌더러 (v3, 2026-08-05).

디자인 스펙 v3 (웹 리서치 기반 재설계 — IBCS·컨설팅 덱·Few/Tufte·모던 KPI
대시보드 패턴 종합. 근거 세션 기록 2026-08-05):
- **액션 타이틀**: 페이지 제목 = 데이터에서 산출한 메시지 문장(22px/800).
  제목만 이어 읽어도 월간 스토리가 되게(수평 로직). 토픽은 키커로 강등.
- **KPI 스탯 카드**: 표 대신 카드 4장 — 라벨(12)→값(30/700, proportional)→
  델타 칩(▲▼, 방향×좋음)→판정 칩→불릿(목표 밴드)→스파크라인. 값:라벨
  크기비 ≥ 2.5:1 (프리어텐티브 위계).
- **틸 램프 역할 분담**: #75d7d1(면 전용)·#1d6f6a(텍스트·선·강조)·
  #e6f7f6(워시). 밝은 원색은 텍스트·얇은 선 금지(1.69:1). 상태색
  (#15803d/#dcfce7·#b91c1c/#fee2e2)은 판정·델타 전용, 페이지당 유채색 예산
  = 틸 램프 + 상태색 + 그룹색(정체성).
- **차트**: 세로 막대 ≤24px·데이터 엔드만 3px 라운드·캡 값 라벨(축 제거),
  선 2px round + 끝점 도트(흰 링) + 끝값 라벨, 수평 그리드만 hairline
  (#eef1f4 실선), 참조선(평균·목표·중앙값)만 점선. 마크 테두리는 그룹
  정체성 막대(밝은 원색 인쇄 정의용)에만 허용.
- **레이아웃**: 1280×720 고정, 카드(1px #e2e8f0, r10) 그리드 + 8pt 간격
  (4/8/12/16/24/32). 잉크 3단(#0f172a/#475569/#64748b). 타입 스케일 5단
  (22/15/30/13/11). 표·축 숫자만 tabular-nums.
- 넘침은 데이터 캡으로 차단, 결손은 placeholder, 자립 HTML·base64 금지·
  print-color-adjust exact, @page 1280px 720px(mm 미사용).
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

# ── 잉크·브랜드 토큰 ──────────────────────────────────────────────────
INK = "#0f172a"           # 제목·값
INK2 = "#475569"          # 본문
MUTED = "#64748b"         # 캡션·축 (AA 하한)
GRID = "#eef1f4"          # hairline 그리드
BORDER = "#e2e8f0"        # 카드 보더·밴드 존
REF = "#94a3b8"           # 참조선(점선) 전용 — 텍스트 금지

TEAL = "#75d7d1"          # 자사 — 넓은 면 전용
TEAL_DARK = "#1d6f6a"     # 자사 잉크 — 텍스트·선·강조 (대시보드 계승)
TEAL_MID = "#31aaa3"      # 굵은 마크·불릿 측정 바
TEAL_WASH = "#e6f7f6"     # 면적 워시·배경 틴트

GOOD_TX, GOOD_BG = "#15803d", "#dcfce7"   # 4.57:1
BAD_TX, BAD_BG = "#b91c1c", "#fee2e2"     # 5.30:1
WARN_TX, WARN_BG = "#b45309", "#fef3c7"
NEUT_TX, NEUT_BG = "#475569", "#f1f5f9"
NEUTRAL_BAR = "#cbd5e1"   # 비그룹 차원 막대(비강조)

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
_FALLBACK = ("#cbd5e1", "#8b959d")

VERDICT_KO = {"below": "미달", "within": "범위 내", "above": "초과 달성"}
VERDICT_CHIP = {"below": "bad", "within": "neut", "above": "good"}

# 원시 코드값 → 경영진용 한국어 (전문용어 금지 규칙, 볼트 업무 용어 사전)
REASON_KO = {"no_d0_baseline": "데뷔 시점 데이터 없음",
             "no_measured_d0_baseline": "데뷔 시점 실측 없음",
             "no_at_day_value": "비교 시점 데이터 없음",
             "empty_window": "데이터 없음"}
SEV_KO = {"critical": "긴급", "warn": "주의", "info": "참고"}
CONF_KO = {"confirmed": "확정", "estimated": "예상", "tentative": "미정",
           "rumor": "미확정"}

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


def _scale(vals: list[float], lo: float, hi: float,
           out_lo: float, out_hi: float) -> list[float]:
    span = (hi - lo) or 1.0
    return [out_lo + (v - lo) / span * (out_hi - out_lo) for v in vals]


def _nice_ticks(lo: float, hi: float, n: int = 4) -> list[float]:
    """축 눈금: 깔끔한 수 3~4개 (1/2/2.5/5 × 10^k 스텝)."""
    if hi <= lo:
        hi = lo + 1
    raw = (hi - lo) / max(n, 1)
    mag = 10 ** math.floor(math.log10(raw)) if raw > 0 else 1
    step = next((m * mag for m in (1, 2, 2.5, 5, 10) if raw <= m * mag), mag)
    ticks, v = [], math.ceil(lo / step) * step
    while v <= hi + step * 1e-6 and len(ticks) < 6:
        ticks.append(v)
        v += step
    return ticks


def _placeholder(msg: str, height: int = 160) -> str:
    return (f"<div class='ph' style='height:{height}px'><span>{esc(msg)}"
            "</span></div>")


def _delta_chip(cur: float | None, prev: float | None,
                up_good: bool = True) -> str:
    """MoM 델타 칩 — 방향(▲▼ 글리프 동반) × 좋음 여부로 색 결정."""
    if cur is None or not prev:
        return ""
    pct = (cur - prev) / prev * 100
    if abs(pct) < 0.05:
        return "<span class='chip neut'>— 0.0%</span>"
    arrow = "▲" if pct > 0 else "▼"
    kind = "good" if (pct > 0) == up_good else "bad"
    return f"<span class='chip {kind}'>{arrow} {abs(pct):.1f}%</span>"


def _chip(text: str, kind: str) -> str:
    return f"<span class='chip {kind}'>{esc(text)}</span>"


# ── SVG 컴포넌트 ─────────────────────────────────────────────────────
# 텍스트 규칙: fill ∈ {INK, INK2, MUTED, TEAL_DARK}, 최소 11 units.
# 값 라벨 600, 축 400. 참조선만 점선, 그리드는 실선 hairline.


def _hbar(x: float, y: float, w: float, h: float, fill: str,
          stroke: str | None = None, r: float = 3) -> str:
    """가로 막대 — 데이터 엔드(우측)만 라운드, 베이스라인은 직각."""
    w = max(w, 2)
    r = min(r, w / 2, h / 2)
    d = (f"M{x:.1f},{y:.1f} h{w - r:.1f} a{r},{r} 0 0 1 {r},{r} "
         f"v{h - 2 * r:.1f} a{r},{r} 0 0 1 -{r},{r} h-{w - r:.1f} z")
    s = f" stroke='{stroke}' stroke-width='1'" if stroke else ""
    return f"<path d='{d}' fill='{fill}'{s}/>"


def _vbar(x: float, y: float, w: float, h: float, fill: str,
          r: float = 3) -> str:
    """세로 막대 — 데이터 엔드(상단)만 라운드."""
    h = max(h, 2)
    r = min(r, w / 2, h / 2)
    d = (f"M{x:.1f},{y + h:.1f} v-{h - r:.1f} a{r},{r} 0 0 1 {r},-{r} "
         f"h{w - 2 * r:.1f} a{r},{r} 0 0 1 {r},{r} v{h - r:.1f} z")
    return f"<path d='{d}' fill='{fill}'/>"


def sparkline(vals: list[float], *, width=96, height=30) -> str:
    """카드 내 미니 추세 — 회색 선 + 마지막 점만 틸 강조. 축·라벨 없음."""
    if len(vals) < 3:
        return ""
    if len(vals) > 24:                       # 다운샘플 (마지막 값은 보존)
        step = (len(vals) - 1) / 23
        vals = [vals[round(i * step)] for i in range(24)]
    lo, hi = min(vals), max(vals)
    xs = _scale(list(range(len(vals))), 0, len(vals) - 1, 2, width - 5)
    ys = _scale(vals, lo, hi, height - 4, 4)
    pts = " ".join(f"{x:.1f},{y:.1f}" for x, y in zip(xs, ys, strict=True))
    return (f"<svg class='spark' viewBox='0 0 {width} {height}' "
            f"role='img'><polyline points='{pts}' fill='none' "
            f"stroke='{NEUTRAL_BAR}' stroke-width='1.5' "
            "stroke-linejoin='round' stroke-linecap='round'/>"
            f"<circle cx='{xs[-1]:.1f}' cy='{ys[-1]:.1f}' r='2.5' "
            f"fill='{TEAL_DARK}'/></svg>")


def bullet(actual: float | None, band: tuple[float, float] | None,
           *, width=250, height=8) -> str:
    """불릿 그래프 — 트랙 + 목표 밴드 존(회색) + 실측 측정 바(틸 다크)."""
    if actual is None or not band:
        return ""
    hi = max(actual, band[1]) * 1.06 or 1
    ax, b0, b1 = (v / hi * width for v in (actual, band[0], band[1]))
    parts = [f"<svg class='bullet' viewBox='0 0 {width} {height}' role='img'>",
             f"<rect x='0' y='0' width='{width}' height='{height}' rx='4' "
             f"fill='{NEUT_BG}'/>",
             f"<rect x='{b0:.1f}' y='0' width='{max(b1 - b0, 2):.1f}' "
             f"height='{height}' fill='{BORDER}'/>",
             _hbar(0, height / 2 - 2, ax, 4, TEAL_DARK, r=2),
             "</svg>"]
    return "".join(parts)


def svg_line(days: list[str], vals: list[float], *, width=610, height=300,
             band: tuple[float, float] | None = None,
             marks: list[tuple[str, str]] | None = None) -> str:
    """자사 시계열 — 수평 그리드+눈금, 워시 면, 2px 다크 선, 끝값 라벨."""
    if len(vals) < 2:
        return _placeholder("표시할 시계열이 부족합니다", height)
    pad_l, pad_r, top, bottom = 46, 58, 12, 20
    lo = min(vals + ([band[0]] if band else []))
    hi = max(vals + ([band[1]] if band else []))
    lo, hi = lo - (hi - lo) * 0.05, hi + (hi - lo) * 0.08
    xs = _scale(list(range(len(vals))), 0, len(vals) - 1, pad_l, width - pad_r)
    ys = _scale(vals, lo, hi, height - bottom, top)
    pts = " ".join(f"{x:.1f},{y:.1f}" for x, y in zip(xs, ys, strict=True))
    parts = [f"<svg viewBox='0 0 {width} {height}' role='img'>"]
    for t in _nice_ticks(lo, hi):                       # 그리드 + 눈금 숫자
        y = _scale([t], lo, hi, height - bottom, top)[0]
        parts.append(f"<line x1='{pad_l}' y1='{y:.1f}' x2='{width - pad_r}' "
                     f"y2='{y:.1f}' stroke='{GRID}' stroke-width='1'/>")
        parts.append(f"<text x='{pad_l - 6}' y='{y + 4:.1f}' font-size='11' "
                     f"fill='{MUTED}' text-anchor='end'>{fmt_num(t)}</text>")
    day_idx = {d: i for i, d in enumerate(days)}
    labeled = 0
    for d, label in (marks or []):                      # 이벤트 마커
        if d in day_idx:
            x = xs[day_idx[d]]
            parts.append(f"<line x1='{x:.1f}' y1='{top}' x2='{x:.1f}' "
                         f"y2='{height - bottom}' stroke='{NEUTRAL_BAR}' "
                         "stroke-dasharray='3 3'/>")
            if labeled < 3:
                parts.append(f"<text x='{x + 4:.1f}' y='{top + 10}' "
                             f"font-size='11' fill='{INK2}'>"
                             f"{esc(_clip(label, 8))}</text>")
                labeled += 1
    area = (f"{pad_l},{height - bottom} " + pts
            + f" {xs[-1]:.1f},{height - bottom}")
    parts.append(f"<polygon points='{area}' fill='{TEAL_WASH}'/>")
    if band:                                            # 목표 밴드 = 참조선 쌍
        for i, b in enumerate(band):
            y = _scale([b], lo, hi, height - bottom, top)[0]
            parts.append(f"<line x1='{pad_l}' y1='{y:.1f}' "
                         f"x2='{width - pad_r}' y2='{y:.1f}' "
                         f"stroke='{TEAL_MID}' stroke-dasharray='5 4'/>")
            if i == 1:
                parts.append(f"<text x='{width - pad_r}' y='{y - 5:.1f}' "
                             f"font-size='11' fill='{TEAL_DARK}' "
                             "text-anchor='end'>목표 "
                             f"{fmt_num(band[0])}~{fmt_num(band[1])}</text>")
    parts.append(f"<polyline points='{pts}' fill='none' "
                 f"stroke='{TEAL_DARK}' stroke-width='2' "
                 "stroke-linejoin='round' stroke-linecap='round'/>")
    parts.append(f"<circle cx='{xs[-1]:.1f}' cy='{ys[-1]:.1f}' r='4.5' "
                 f"fill='{TEAL_DARK}' stroke='#fff' stroke-width='2'/>")
    parts.append(f"<text x='{xs[-1] + 8:.1f}' y='{ys[-1] + 4:.1f}' "
                 f"font-size='12' font-weight='700' fill='{INK}'>"
                 f"{fmt_num(vals[-1])}</text>")
    for frac in (0.0, 1.0):                             # x축 첫·끝 날짜
        x = pad_l + frac * (width - pad_r - pad_l)
        anchor = "start" if frac == 0 else "end"
        parts.append(f"<text x='{x:.1f}' y='{height - 5}' font-size='11' "
                     f"fill='{MUTED}' text-anchor='{anchor}'>"
                     f"{esc(days[0 if frac == 0 else -1][5:])}</text>")
    parts.append("</svg>")
    return "".join(parts)


def svg_bars(labels: list[str], vals: list[float], *, width=500, height=170,
             hline: float | None = None, hline_label: str = "") -> str:
    """세로 막대 — ≤24px·라운드 캡·캡 값 라벨(축 없음)·평균 참조선."""
    if not vals:
        return _placeholder("표시할 데이터가 없습니다", height)
    pad, bottom, top = 8, 22, 18
    hi = max(vals + ([hline] if hline else [])) * 1.12 or 1
    n = len(vals)
    bw = min(24, (width - pad * 2) / n * 0.55)
    parts = [f"<svg viewBox='0 0 {width} {height}' role='img'>"]
    parts.append(f"<line x1='{pad}' y1='{height - bottom}' "
                 f"x2='{width - pad}' y2='{height - bottom}' "
                 f"stroke='{BORDER}' stroke-width='1'/>")
    for i, (lab, v) in enumerate(zip(labels, vals, strict=True)):
        x = pad + (i + 0.5) * (width - pad * 2) / n - bw / 2
        h = (v / hi) * (height - bottom - top)
        y = height - bottom - h
        parts.append(_vbar(x, y, bw, h, TEAL))
        parts.append(f"<text x='{x + bw / 2:.1f}' y='{y - 6:.1f}' "
                     f"font-size='11' font-weight='600' fill='{INK}' "
                     f"text-anchor='middle'>{fmt_num(v)}</text>")
        if n <= 12:
            parts.append(f"<text x='{x + bw / 2:.1f}' y='{height - 7}' "
                         f"font-size='11' fill='{MUTED}' "
                         f"text-anchor='middle'>{esc(lab)}</text>")
    if hline:
        y = height - bottom - (hline / hi) * (height - bottom - top)
        parts.append(f"<line x1='{pad}' y1='{y:.1f}' x2='{width - pad}' "
                     f"y2='{y:.1f}' stroke='{REF}' stroke-dasharray='4 3'/>"
                     f"<text x='{width - pad}' y='{y - 5:.1f}' "
                     f"font-size='11' font-weight='600' fill='{INK2}' "
                     f"text-anchor='end'>{esc(hline_label)}</text>")
    parts.append("</svg>")
    return "".join(parts)


def svg_hbars(rows: list[tuple[str, float, str | None]], *, width=560,
              log_scale=False, unit="", row_h=24, pad_l=104,
              boundaries: list[int] | None = None,
              boundary_labels: list[str] | None = None,
              highlight_max=False) -> str:
    """가로 막대. rows=[(라벨, 값, group_key|None)] — 그룹 원색+edge(정체성,
    밝은 원색의 인쇄 정의용), 비그룹은 중립 회색(+최대값만 틸 강조 옵션)."""
    if not rows:
        return _placeholder("표시할 데이터가 없습니다")
    height = len(rows) * row_h + 12
    vals = [max(v, 0) for _, v, _ in rows]
    tx = [math.log10(v + 1) for v in vals] if log_scale else vals
    hi = max(tx) or 1
    max_i = tx.index(max(tx)) if highlight_max else -1
    parts = [f"<svg viewBox='0 0 {width} {height}' role='img'>"]
    bset = set(boundaries or [])
    blabels = list(boundary_labels or [])
    bar_h = min(16, row_h - 8)
    for i, ((lab, v, gkey), t) in enumerate(zip(rows, tx, strict=True)):
        y = 6 + i * row_h
        if i in bset:
            parts.append(f"<line x1='0' y1='{y - 3}' x2='{width}' "
                         f"y2='{y - 3}' stroke='{REF}' "
                         "stroke-dasharray='4 3'/>")
        if blabels and (i in bset or i == 0):
            parts.append(f"<text x='{width - 4}' y='{y + 9}' font-size='11' "
                         f"fill='{MUTED}' text-anchor='end'>"
                         f"{esc(blabels.pop(0))}</text>")
        mine = gkey == "miiwan"
        if gkey:
            fill, edge = _colors(gkey)
        else:
            fill, edge = (TEAL_MID, None) if i == max_i \
                else (NEUTRAL_BAR, None)
        w = (t / hi) * (width - pad_l - 78)
        name_style = (f"font-weight='700' fill='{TEAL_DARK}'" if mine
                      else f"fill='{INK2}'")
        parts.append(f"<text x='{pad_l - 8}' y='{y + row_h / 2 + 4:.1f}' "
                     f"font-size='11' {name_style} text-anchor='end'>"
                     f"{esc(lab)}</text>")
        parts.append(_hbar(pad_l, y + (row_h - bar_h) / 2 - 1, w, bar_h,
                           fill, stroke=edge))
        parts.append(f"<text x='{pad_l + max(w, 2) + 7:.1f}' "
                     f"y='{y + row_h / 2 + 4:.1f}' font-size='11' "
                     f"font-weight='600' fill='{INK}'>{fmt_num(v)}{esc(unit)}"
                     "</text>")
    parts.append("</svg>")
    return "".join(parts)


def svg_scatter(points: list[dict], median_x: float, median_y: float,
                *, width=600, height=430) -> str:
    """인지도×코어 사분면 — 점 면=그룹 원색·테두리=edge, 그리디 라벨."""
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
             f"<rect x='{pad}' y='16' width='{width - 16 - pad}' "
             f"height='{height - 50}' fill='#fbfdfd'/>",
             f"<line x1='{mx:.1f}' y1='16' x2='{mx:.1f}' y2='{height - 34}' "
             f"stroke='{REF}' stroke-dasharray='4 3'/>",
             f"<line x1='{pad}' y1='{my:.1f}' x2='{width - 16}' "
             f"y2='{my:.1f}' stroke='{REF}' stroke-dasharray='4 3'/>"]
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
        parts.append(f"<circle cx='{x:.1f}' cy='{y:.1f}' r='{8 if mine else 6}'"
                     f" fill='{fill}' stroke='{edge}' stroke-width='1'/>")
    # 라벨 그리디 배치 — 오른쪽 우선, 경계 초과·겹침 시 왼쪽 플립 → 상하
    # 단계 강하. 자사 라벨을 먼저 배치해 최우선 자리 확보. 코너 캡션과
    # 점(원) 영역도 회피 대상(placed 시드).
    placed: list[tuple[float, float, float]] = list(corner_boxes)
    for p, x, y in pts3:
        r = 8 if p["group_key"] == "miiwan" else 6
        placed.append((x - r, x + r, y + 4))

    def _fits(x0: float, x1: float, ly: float) -> bool:
        return all(not (x0 < ox1 and ox0 < x1 and abs(ly - oy) < 12)
                   for ox0, ox1, oy in placed)

    for p, x, y in sorted(pts3, key=lambda t: t[0]["group_key"] != "miiwan"):
        gkey = p["group_key"]
        mine = gkey == "miiwan"
        r = 8 if mine else 6
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
        style = (f"font-weight='700' fill='{TEAL_DARK}'" if mine
                 else f"fill='{INK2}'")
        parts.append(f"<text x='{lx:.1f}' y='{ly:.1f}' font-size='11' {style} "
                     f"text-anchor='{anchor}'>{esc(text)}</text>")
    parts.append(f"<text x='{(pad + width - 16) / 2:.1f}' y='{height - 9}' "
                 f"font-size='11' fill='{MUTED}' text-anchor='middle'>"
                 "인지도 (0~100) →</text>")
    parts.append(f"<text x='14' y='{height / 2}' font-size='11' "
                 f"fill='{MUTED}' transform='rotate(-90 14 {height / 2})' "
                 "text-anchor='middle'>적극 팬 규모 →</text>")
    parts.append("</svg>")
    return "".join(parts)


# ── 페이지 프레임 ─────────────────────────────────────────────────────


def _page(kicker: str, title: str, n: int, total: int, month: str,
          generated: str, body: str, *, sub: str = "", cover=False) -> str:
    if cover:
        return f"<section class='page cover'>{body}</section>"
    footer = (f"<footer><span>MiiWAN 월간 리포트 {esc(month)} (내부용, "
              "idol-sight 자동 생성)</span>"
              f"<span>{n} / {total} (생성 {esc(generated[:10])})</span>"
              "</footer>")
    subline = f"<p class='psub'>{esc(sub)}</p>" if sub else ""
    head = (f"<div class='kicker'><span class='knum'>{n:02d}</span>"
            f"{esc(kicker)}</div>"
            f"<h1 class='ptitle'>{esc(title)}</h1>{subline}")
    return (f"<section class='page'>{head}{body}{footer}</section>")


def _card(title: str, body: str, *, sub: str = "",
          note: str | list[str] = "", grow=False, wash=False) -> str:
    """note: 문자열 하나 또는 줄 리스트 — 절 나열은 ·로 잇지 말고 줄로 쌓는다."""
    cls = "card" + (" grow" if grow else "") + (" wash" if wash else "")
    subs = f"<span class='csub'>{esc(sub)}</span>" if sub else ""
    lines = [note] if isinstance(note, str) else note
    noteh = "".join(f"<p class='note'>{esc(ln)}</p>" for ln in lines if ln)
    head = f"<div class='chead'><h2>{esc(title)}</h2>{subs}</div>" if title \
        else ""
    return f"<div class='{cls}'>{head}{body}{noteh}</div>"


def _kpi_card(label: str, j: dict, prev: float | None,
              spark_vals: list[float]) -> str:
    actual, band, verdict = j["actual"], j["band"], j["verdict"]
    chips = _delta_chip(actual, prev)
    if verdict:
        chips += _chip(VERDICT_KO[verdict], VERDICT_CHIP[verdict])
    chips = f"<div class='kchips'>{chips}</div>" if chips else ""
    spark = sparkline(spark_vals)
    cap = (f"목표 {fmt_num(band[0])}~{fmt_num(band[1])}" if band
           else "목표 미설정")
    return ("<div class='kcard'>"
            f"<div class='klabel'>{esc(label)}</div>"
            f"<div class='krow'><span class='kval'>{fmt_num(actual)}</span>"
            f"{spark}</div>{chips}"
            f"{bullet(actual, band)}"
            f"<div class='kcap'>{esc(cap)}</div>"
            f"<div class='kcap'>전월 {fmt_num(prev)}</div>"
            "</div>")


# ── 액션 타이틀 (메시지 문장) ────────────────────────────────────────


def _title_p3(wv: dict | None, wvp: dict | None) -> str:
    if not (wv and wvp and wv.get("members") and wvp.get("members")):
        return "팬 커뮤니티의 성장과 구성을 살펴봅니다"
    dm = (wv["members"] - wvp["members"]) / wvp["members"] * 100
    ds = ((wv["membership"] - wvp["membership"]) / wvp["membership"] * 100
          if wv.get("membership") and wvp.get("membership") else None)
    seg = f"위버스 가입 {dm:+.0f}%"
    if ds is not None:
        seg += f", 멤버십 {ds:+.0f}%"
    if dm > 0 and (ds or 0) >= 0:
        return f"{seg}로 커뮤니티 성장이 이어지고 있습니다"
    if dm < 0 and (ds or 0) <= 0:
        return f"{seg}로 커뮤니티 성장이 주춤해 원인 점검이 필요합니다"
    return f"{seg}로 가입과 멤버십 흐름이 엇갈렸습니다"


# ── 본체 ─────────────────────────────────────────────────────────────


def render_deck(d: dict, *, generated_at: str, **_legacy) -> str:
    """종합 단일판 · 16:9 5페이지 맵(디자인 스펙 v3).
    P1 표지 / P2 KPI 결과+자사 채널 / P3 커뮤니티·팬덤 / P4 시장 내 위치 /
    P5 비교·전망. 페이지 제목 = 자동 산출 메시지 문장(액션 타이틀)."""
    month = d["month"]
    m_label = f"{int(month[:4])}년 {int(month[5:7])}월"
    TOTAL = 4
    pages: list[str] = []

    # P1 표지
    pages.append(_page("", "", 0, TOTAL, month, generated_at, (
        "<div class='kicker'>idol-sight 내부용</div>"
        f"<h1>MiiWAN 월간 리포트</h1><p class='cover-sub'>{esc(m_label)}</p>"
        f"<p class='stamp'>생성 {esc(generated_at[:10])}<br>데이터 기준 "
        f"{esc(month)} 월말<br>시장 위치 좌표와 전환율은 생성 시점 값</p>"),
        cover=True))

    # ── P2 KPI 결과 + 자사 채널 ──────────────────────────────────────
    spark_src: dict[str, list[float]] = {
        "subscribers": [r["subs"] or 0 for r in d["subs_series"]],
        "avg_ccv": [b["avg"] for b in d["ccv"]["broadcasts"]],
        "weverse_members": [r["total_members"] or 0
                            for r in d["weverse_series"]],
        "weverse_membership": [r["digital_membership"] or 0
                               for r in d["weverse_series"]],
    }
    kpi_cards = "".join(
        _kpi_card(KPI_LABELS[k], d["kpi"]["judgments"][k],
                  d["kpi"]["prev"].get(k), spark_src.get(k, []))
        for k in KPI_LABELS)
    kpi_row = f"<div class='krow4'>{kpi_cards}</div>"

    bullets = []
    for ln in (d["tier_line"], d["cohort_line"], d["quadrant_move"],
               d["spike_note"]):
        if ln:
            bullets.append(ln)
    items = "".join(f"<li>{esc(_clip(b, 88))}</li>" for b in bullets[:3]) \
        or "<li>특이 사항 없음 (KPI 카드와 차트 참조)</li>"
    warn_html = ""
    if d["warnings"]:
        ws = d["warnings"][:2]
        extra = (f" (외 {len(d['warnings']) - 2}건)"
                 if len(d["warnings"]) > 2 else "")
        warn_html = ("<p class='warnline'>데이터 참고: "
                     + ", ".join(esc(w) for w in ws) + extra + "</p>")
    sum_card = _card("이달의 요약",
                     f"<ul class='blts'>{items}</ul>{warn_html}")

    ccv = d["ccv"]
    casts = ccv["broadcasts"]
    cast_note = ""
    if len(casts) > 10:  # 과밀 캡: 평균 상위 10회를 시간순으로
        top = sorted(casts, key=lambda b: -b["avg"])[:10]
        casts = sorted(top, key=lambda b: b["started"])
        cast_note = ", 평균 상위 10회만 표시"
    live_card = _card(
        "라이브 방송", svg_bars(
            [b["started"][5:] for b in casts], [b["avg"] for b in casts],
            width=463, height=144, hline=ccv["avg"],
            hline_label=f"월평균 {fmt_num(ccv['avg'])}"),
        sub="방송별 평균 동접 (명)",
        note=[f"관측 방송 {ccv['count']}회, 최고 동접 "
              f"{fmt_num(ccv['peak'])}명{cast_note}",
              "평균 동접 " + mom_phrase(ccv["avg"], d["ccv_prev"]["avg"])],
        grow=True)

    series = d["subs_series"]
    band = d["kpi"]["judgments"]["subscribers"]["band"]
    ev_marks = [(e["event_date"], e["title"])
                for e in d["events"] if e["event_date"].startswith(month)]
    subs_notes = []
    if d["subs_gain"] is not None:
        subs_notes.append(f"월간 순증 +{fmt_num(d['subs_gain'])}, 구독 "
                          + mom_phrase(d["kpi"]["actuals"]["subscribers"],
                                       d["kpi"]["prev"]["subscribers"]))
    if d["spike_note"]:
        subs_notes.append(_clip(d["spike_note"], 80))
    subs_card = _card(
        "구독자 성장", svg_line(
            [r["day"] for r in series], [r["subs"] or 0 for r in series],
            width=641, height=316, band=band, marks=ev_marks),
        sub="YouTube 구독자, 최근 3개월 일간 (명)", note=subs_notes,
        grow=True)

    p2_body = (kpi_row
               + "<div class='row fill'>"
               + f"<div class='col' style='flex:0 0 495px'>{sum_card}"
               + f"{live_card}</div>"
               + f"<div class='col grow'>{subs_card}</div></div>")
    pages.append(_page("이번 달 결과와 자사 채널", d["kpi"]["headline"],
                       1, TOTAL, month, generated_at, p2_body,
                       sub=f"4대 KPI의 {esc(m_label)} 실적을 목표 범위, "
                           "전월과 비교했습니다"))

    # ── P3 커뮤니티·팬덤 ─────────────────────────────────────────────
    wser = d["weverse_series"]
    wv, wvp = d["weverse"], d["weverse_prev"]
    wdays = [r["day"] for r in wser]
    wv_note = (f"{wv['day']} 기준입니다 (월말까지 기록이 없어 최신 값으로 표시)"
               if wv and wv.get("partial") else "")

    def _wv_card(title: str, key: str, cur: float | None,
                 prev: float | None) -> str:
        chart = (svg_line(wdays, [r[key] or 0 for r in wser],
                          width=552, height=158)
                 if wser else _placeholder("이 달 위버스 기록이 없습니다", 158))
        head_val = (f"<span class='inval'>{fmt_num(cur)}</span>"
                    + _delta_chip(cur, prev))
        return _card(title, f"<div class='inrow'>{head_val}</div>" + chart,
                     sub="일간 추이 (명)", note=wv_note, grow=True)

    left3 = (_wv_card("위버스 가입자", "total_members",
                      wv["members"] if wv else None,
                      wvp["members"] if wvp else None)
             + _wv_card("유료 멤버십", "digital_membership",
                        wv["membership"] if wv else None,
                        wvp["membership"] if wvp else None))

    loy = d.get("loyalty") or {}
    conv = loy.get("conversion_rate")
    conv_txt = f"{conv * 100:.1f}%" if conv is not None else "—"
    loy_win = loy.get("window_days") or 30
    tiles = ("<div class='row'>"
             "<div class='kcard'><div class='klabel'>시청전환율</div>"
             f"<div class='kval'>{conv_txt}</div>"
             f"<div class='kcap'>구독자 중 라이브를 보러 오는 비율 "
             f"(최근 {loy_win}일)</div></div>"
             "<div class='kcard'><div class='klabel'>월간 뉴스 증분</div>"
             "<div class='kval'>"
             f"{'+' + fmt_num(d['news_delta']) if d['news_delta'] is not None else '—'}"
             "</div><div class='kcap'>자사 집계 (건)</div></div></div>")
    demo = d["demographics"]
    agg: dict[str, float] = {}
    for r in demo:
        agg[r["age_group"]] = agg.get(r["age_group"], 0) + (r["viewer_pct"] or 0)
    demo_svg = (svg_hbars([(a.replace("age", ""), round(v, 1), None)
                           for a, v in sorted(agg.items())],
                          width=552, unit="%", pad_l=58, highlight_max=True)
                if agg else _placeholder("소유자 데이터 미연결", 140))
    ctry_svg = (svg_hbars([(c["country"],
                            round((c["watch_share"] or 0) * 100, 1), None)
                           for c in d["countries"][:5]],
                          width=552, unit="%", pad_l=58, highlight_max=True)
                if d["countries"] else _placeholder("소유자 데이터 미연결", 140))
    right3 = (tiles
              + _card("연령대별 시청 비중", demo_svg,
                      sub="시청 시간 % (자사 채널 실측)")
              + _card("국가별 시청 비중 (상위 5)", ctry_svg,
                      sub="시청 시간 % (자사 채널 실측)", grow=True))
    p3_body = ("<div class='row fill'>"
               f"<div class='col half'>{left3}</div>"
               f"<div class='col half'>{right3}</div></div>")
    pages.append(_page("커뮤니티와 팬덤", _title_p3(wv, wvp), 2, TOTAL, month,
                       generated_at, p3_body,
                       sub=f"{esc(m_label)} 위버스 커뮤니티 성장과 자사 채널 "
                           "시청자 구성입니다"))

    # ── P4 시장 내 위치 ──────────────────────────────────────────────
    concl = " ".join(x for x in [d["tier_line"], d["quadrant_move"]] if x)
    p4_title = concl or "시장에서 어디에 있고, 어느 방향으로 가고 있나"
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
        tier_html = svg_hbars(rows, width=516, log_scale=True, row_h=26,
                              boundaries=bounds, boundary_labels=blabels,
                              pad_l=92)
        tier_note = ["막대 길이는 팀 간 격차가 커서 압축(로그)해 표시했습니다",
                     "티어 경계는 규모가 약 3배 이상 벌어지는 지점입니다 "
                     "(색상은 대시보드와 동일)"]
    else:
        tier_html = _placeholder("시장 관심 규모 집계는 2026-08 시작, "
                                 "8월 보고서부터 표기", 300)
        tier_note = ""
    tier_card = _card("시장 관심 규모", tier_html,
                      sub="최근 90일 조회수 증가량 (K-POP 버추얼)",
                      note=tier_note, grow=True)
    quad = d["quadrant"]
    quad_card = _card(
        "인지도 × 적극 팬 사분면",
        (svg_scatter(quad["points"], quad["median_x"], quad["median_y"],
                     width=588, height=430)
         if quad else _placeholder("좌표 데이터 없음", 300)),
        sub="K-POP 버추얼 (보고서 생성 시점 기준)",
        note=["십자선은 시장의 중간 위치(중앙값)입니다",
              "적극 팬 규모는 최근 30일 영상 댓글 반응 기반 추정으로, "
              "대시보드 '시장 지도'와 같은 값입니다"],
        grow=True)
    p4_body = ("<div class='row fill'>"
               f"<div class='col' style='flex:0 0 548px'>{tier_card}</div>"
               f"<div class='col grow'>{quad_card}</div></div>")
    pages.append(_page("시장 내 위치", p4_title, 3, TOTAL, month,
                       generated_at, p4_body,
                       sub="시장 관심 규모와 인지도×팬 참여 좌표입니다 "
                           "(경쟁사 수치는 공개 데이터 기반 추정 포함)"))

    # ── P5 비교·전망 ─────────────────────────────────────────────────
    coh = d["cohort"]
    p5_title = d["cohort_line"] or "같은 시기 데뷔한 팀과 비교하고 다음 달을 준비합니다"
    if coh["rows"]:
        crows = coh["rows"][:6]
        hrows = [(_name(r["group"]), r["multiple"], r["group"])
                 for r in crows]
        coh_html = svg_hbars(hrows, width=552, unit="배", pad_l=92, row_h=26)
        coh_note = [f"각 팀이 데뷔 후 {coh['age_days']}일째 되는 시점에 "
                    f"구독자가 데뷔 시점의 몇 배가 됐는지 비교했습니다"
                    f"({int(month[5:7])}월 말 기준)",
                    "대시보드 화면과는 집계 시점이 달라 수치가 다를 수 "
                    "있습니다"]
        if coh["excluded"]:
            coh_note.append(f"비교 제외 {len(coh['excluded'])}팀: "
                            + _clip(", ".join(
                                f"{_name(e['group'])}"
                                f"({REASON_KO.get(e['reason'], '데이터 부족')})"
                                for e in coh["excluded"]), 80))
    else:
        coh_html = _placeholder("비교 가능한 팀 데이터가 없습니다", 140)
        coh_note = ""
    coh_card = _card("같은 시기 데뷔한 팀과 비교", coh_html,
                     sub="데뷔 시점 대비 구독자 성장 배수", note=coh_note)
    alerts = d["alerts"]
    if alerts:
        order = {"critical": 0, "warn": 1, "info": 2}
        chipk = {"critical": "bad", "warn": "warn", "info": "neut"}
        shown = sorted(alerts, key=lambda a: order.get(a["severity"], 9))[:4]
        risk = "<ul class='blts plain'>" + "".join(
            f"<li>{_chip(SEV_KO.get(a['severity'], '참고'), chipk.get(a['severity'], 'neut'))} "
            f"<b>{esc(a['fired_at'][5:10].replace('-', '/'))}</b> "
            f"{esc(_clip(a['title'], 46))}</li>"
            for a in shown)
        if len(alerts) > 4:
            risk += f"<li class='mut'>외 {len(alerts) - 4}건</li>"
        risk += "</ul>"
    else:
        risk = ("<p class='body-line'>이번 달 발생한 알림은 0건입니다. "
                "신원 노출, AI 도용, 논란 급증을 매일 자동 감시하고 "
                "있습니다.</p>")
    risk_card = _card("리스크 모니터", risk,
                      note=f"최근 14일 논란성 게시글 {fmt_num(d['controversy'])}건",
                      grow=True)
    ins = "".join(
        f"<li><b>{esc(_clip(i['title'], 38))}</b>"
        f"<span class='mut'> ({esc(i['week_start'][5:].replace('-', '/'))} "
        "주간 분석)</span><br>"
        f"{esc(_clip(i['ai_comment'], 76))}</li>"
        for i in d["insights"][:3]) or "<li>이번 달 선별된 메모 없음</li>"
    memo_card = _card("전략 메모", f"<ul class='blts'>{ins}</ul>",
                      note="주간 분석에서 자동 선별했으며, 검수 전 참고용입니다")
    next_events = [e for e in d["events"]
                   if not e["event_date"].startswith(month)][:6]
    ev_lines = "".join(
        f"<li><b>{esc(e['event_date'][5:].replace('-', '/'))}</b> "
        f"{esc(_clip(e['title'], 42))} "
        f"<span class='mut'>({esc(CONF_KO.get(e['confidence'], e['confidence']))})"
        "</span></li>"
        for e in next_events) or "<li>등록된 예정 일정 없음</li>"
    watch = [k for k, j in d["kpi"]["judgments"].items()
             if j["verdict"] == "below"]
    watch_txt = ("주시 포인트: " + ", ".join(KPI_LABELS[k] for k in watch)
                 if watch else "주시 포인트: 전 KPI가 목표 범위를 지키는지")
    next_card = _card("다음 달", f"<ul class='blts'>{ev_lines}</ul>"
                      + f"<p class='watch'>{esc(watch_txt)}</p>", grow=True)
    disclaimer = ("<p class='disclaim'>idol-sight가 자동 생성한 보고서입니다. "
                  "요약과 결론 문장은 데이터에서 자동으로 만들어지며, 경쟁사 "
                  "수치는 공개 데이터 기반 추정을 포함합니다. 계산 방식은 "
                  "대시보드 각 화면의 도움말을 참고하세요.</p>")
    p5_body = ("<div class='row fill'>"
               f"<div class='col half'>{coh_card}{risk_card}</div>"
               f"<div class='col half'>{memo_card}{next_card}"
               f"{disclaimer}</div></div>")
    pages.append(_page("비교와 전망", p5_title, 4, TOTAL, month, generated_at,
                       p5_body, sub="같은 시기 데뷔한 팀 비교, 리스크, "
                                    "전략 메모, 다음 달 일정입니다"))

    title = f"MiiWAN 월간 리포트 {esc(month)}"
    return f"""<!doctype html><html lang='ko'><head><meta charset='utf-8'>
<meta name='viewport' content='width=device-width,initial-scale=1'>
<title>{title}</title>
<style>
*{{box-sizing:border-box;margin:0;padding:0;print-color-adjust:exact;
   -webkit-print-color-adjust:exact}}
body{{font-family:'Pretendard','Apple SD Gothic Neo','Malgun Gothic',sans-serif;
     background:#eef1f3;color:{INK}}}
table,svg text,.num{{font-variant-numeric:tabular-nums}}
.page{{position:relative;width:1280px;aspect-ratio:1280/720;margin:22px auto;
      background:#fff;border-radius:4px;box-shadow:0 1px 5px rgba(0,0,0,.10);
      padding:30px 48px 40px;overflow:hidden;break-after:page;
      display:flex;flex-direction:column}}
.kicker{{font-size:11px;font-weight:700;letter-spacing:.07em;
        color:{TEAL_DARK};text-transform:uppercase}}
.knum{{display:inline-block;margin-right:10px;padding:1px 7px;
      border-radius:4px;background:{TEAL_WASH};color:{TEAL_DARK}}}
.ptitle{{font-size:22px;font-weight:800;line-height:1.3;
        letter-spacing:-0.02em;margin-top:6px}}
.psub{{font-size:12px;color:{MUTED};line-height:1.4;margin:4px 0 14px}}
.cover{{justify-content:center;border-left:12px solid {TEAL};
       padding-left:84px}}
.cover h1{{font-size:48px;font-weight:800;line-height:1.15;
          letter-spacing:-0.025em;margin-top:16px}}
.cover-sub{{font-size:22px;font-weight:700;letter-spacing:-0.01em;
           margin-top:12px;color:{TEAL_DARK}}}
.stamp{{margin-top:28px;color:{MUTED};font-size:12px;font-weight:500;
       line-height:1.5}}
.row{{display:flex;gap:16px;min-height:0}}
.row.fill{{flex:1}}
.row + .row,.krow4 + .row{{margin-top:16px}}
.col{{display:flex;flex-direction:column;gap:16px;min-width:0}}
.col.half{{flex:1}} .col.grow,.card.grow{{flex:1}}
.card{{border:1px solid {BORDER};border-radius:10px;padding:14px 16px;
      background:#fff;min-width:0}}
.card.wash{{background:#f8fafc}}
.chead{{display:flex;align-items:baseline;justify-content:space-between;
       gap:8px;margin-bottom:8px}}
.chead h2{{font-size:15px;font-weight:700;letter-spacing:-0.01em}}
.csub{{font-size:11px;color:{MUTED};text-align:right;flex:0 1 auto}}
.krow4{{display:flex;gap:12px}}
.krow4 .kcard{{flex:1}}
.kcard{{border:1px solid {BORDER};border-radius:10px;padding:12px 14px;
       background:#fff;min-width:0;flex:1}}
.klabel{{font-size:12px;font-weight:600;color:{MUTED};line-height:1.3}}
.krow{{display:flex;align-items:center;justify-content:space-between;
      gap:8px;margin-top:2px}}
.kval{{font-size:30px;font-weight:700;letter-spacing:-0.02em;
      line-height:1.15}}
.spark{{width:96px;height:30px;flex:none}}
.kchips{{display:flex;gap:6px;margin-top:6px}}
.chip{{font-size:11px;font-weight:600;padding:2px 8px;border-radius:999px;
      line-height:1.35;white-space:nowrap}}
.chip.good{{color:{GOOD_TX};background:{GOOD_BG}}}
.chip.bad{{color:{BAD_TX};background:{BAD_BG}}}
.chip.warn{{color:{WARN_TX};background:{WARN_BG}}}
.chip.neut{{color:{NEUT_TX};background:{NEUT_BG}}}
.bullet{{width:100%;height:8px;margin-top:8px;display:block}}
.kcap{{font-size:11px;color:{MUTED};margin-top:6px;line-height:1.35}}
.inrow{{display:flex;align-items:center;gap:8px;margin-bottom:4px}}
.inval{{font-size:22px;font-weight:700;letter-spacing:-0.02em}}
.blts{{list-style:none}}
.blts li{{padding:4px 0 4px 18px;position:relative;font-size:13px;
         line-height:1.5}}
.blts li::before{{content:'';position:absolute;left:2px;top:11px;width:6px;
                 height:6px;border-radius:50%;background:{TEAL_MID}}}
.blts.plain li{{padding-left:0}}
.blts.plain li::before{{display:none}}
.body-line{{font-size:13px;line-height:1.55}}
.mut{{color:{MUTED}}}
.note{{color:{MUTED};font-size:11px;line-height:1.45;margin-top:8px}}
.note + .note{{margin-top:2px}}
.warnline{{margin-top:8px;padding-top:8px;border-top:1px solid {BORDER};
          font-size:11px;line-height:1.45;color:{WARN_TX}}}
.watch{{margin-top:10px;padding:7px 10px;border-radius:8px;
       background:{TEAL_WASH};color:{TEAL_DARK};font-size:12px;
       font-weight:600;line-height:1.4}}
.ph{{display:flex;align-items:center;justify-content:center;
    border:1px dashed {NEUTRAL_BAR};border-radius:8px;color:{MUTED};
    font-size:12px}}
.disclaim{{color:{MUTED};font-size:11px;line-height:1.5;
          border-top:1px solid {BORDER};padding-top:8px}}
footer{{position:absolute;left:48px;right:48px;bottom:11px;display:flex;
       justify-content:space-between;font-size:11px;line-height:1.4;
       color:{MUTED};border-top:1px solid {BORDER};padding-top:7px}}
svg{{width:100%;height:auto;display:block}}
@page{{size:1280px 720px;margin:0}}
@media print{{body{{background:#fff}}.page{{box-shadow:none;margin:0 auto;
             border-radius:0}}}}
</style></head><body>
PAGES_SLOT
</body></html>""".replace("PAGES_SLOT", "".join(pages))
