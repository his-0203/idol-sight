"""월간 보고서 — 자립 HTML 덱 렌더러.

규칙(스펙 2026-08-04):
- 자립 HTML: 외부 스크립트/폰트/이미지 0, 차트는 수기 인라인 SVG.
  **base64 이미지 금지** — D1 REST 바디 한계(~1MB, d1.py) 때문에 넣는
  순간 저장이 깨진다.
- 인쇄 안전: print-color-adjust(+-webkit-) exact, mm 단위 재정의 금지,
  밝은 배경(인쇄 전제) — 소형 텍스트에 밝은 키컬러(#75d7d1) 금지.
- 판: internal(코어 11장+부록 A1·A2) / investor(코어만 + 게이트 G1~G8,
  DRAFT 워터마크 기본).
- 장 결론은 monthly_report 의 결정적 템플릿 문장만 — LLM 산문 없음.
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

KEY = "#75d7d1"          # MiiWAN — 면·마커 전용(소형 텍스트 금지)
KEY_DARK = "#1d6f6a"     # 텍스트 강조용 진한 변형
GRAY = "#9aa4ad"
WARN = "#d97706"         # 미달 주황 1색
INK = "#1f2933"

VERDICT_KO = {"below": "미달", "within": "밴드 내", "above": "상단 초과"}
VERDICT_COLOR = {"below": WARN, "within": "#6b7280", "above": KEY_DARK}

QUAD_LABELS = {"strong": "진성 강세", "niche": "니치 충성",
               "ad_driven": "광고형", "low": "축적 단계"}


def esc(s: Any) -> str:
    return _html.escape(str(s))


# ── SVG 헬퍼 (수기 — Sparkline.tsx 수준) ─────────────────────────────


def _scale(vals: list[float], lo: float, hi: float, out_lo: float,
           out_hi: float) -> list[float]:
    span = (hi - lo) or 1.0
    return [out_lo + (v - lo) / span * (out_hi - out_lo) for v in vals]


def svg_line(days: list[str], vals: list[float], *, width=640, height=180,
             color=KEY, band: tuple[float, float] | None = None,
             marks: list[tuple[str, str]] | None = None) -> str:
    """일별 선 그래프. band=(lo,hi)면 우측 끝 목표 밴드 음영, marks=[(day,label)]
    이벤트 세로 점선."""
    if len(vals) < 2:
        return "<p class='muted'>표시할 시계열이 부족합니다.</p>"
    pad = 34
    lo = min(vals + ([band[0]] if band else []))
    hi = max(vals + ([band[1]] if band else []))
    lo, hi = lo - (hi - lo) * 0.06, hi + (hi - lo) * 0.06
    xs = _scale(list(range(len(vals))), 0, len(vals) - 1, pad, width - 8)
    ys = _scale(vals, lo, hi, height - 22, 8)
    pts = " ".join(f"{x:.1f},{y:.1f}" for x, y in zip(xs, ys))
    parts = [f"<svg viewBox='0 0 {width} {height}' role='img'>"]
    if band:
        by = _scale(list(band), lo, hi, height - 22, 8)
        parts.append(
            f"<rect x='{width - 60}' y='{min(by):.1f}' width='52' "
            f"height='{abs(by[0] - by[1]):.1f}' fill='{KEY}' opacity='0.15'/>")
    day_idx = {d: i for i, d in enumerate(days)}
    for d, label in (marks or []):
        if d in day_idx:
            x = xs[day_idx[d]]
            parts.append(
                f"<line x1='{x:.1f}' y1='8' x2='{x:.1f}' y2='{height - 22}' "
                f"stroke='{GRAY}' stroke-dasharray='3 3'/>"
                f"<text x='{x + 3:.1f}' y='18' font-size='10' fill='{INK}'>"
                f"{esc(label)}</text>")
    parts.append(f"<polyline points='{pts}' fill='none' stroke='{color}' "
                 f"stroke-width='2.5'/>")
    for frac, v in ((0.0, vals[0]), (1.0, vals[-1])):
        x = pad + frac * (width - 8 - pad)
        anchor = "start" if frac == 0 else "end"
        parts.append(f"<text x='{x:.1f}' y='{height - 6}' font-size='11' "
                     f"fill='{INK}' text-anchor='{anchor}'>"
                     f"{esc(days[0 if frac == 0 else -1][5:])}</text>")
    parts.append(f"<text x='{pad}' y='16' font-size='11' fill='{INK}'>"
                 f"{fmt_num(max(vals))}</text>")
    parts.append("</svg>")
    return "".join(parts)


def svg_bars(labels: list[str], vals: list[float], *, width=640, height=170,
             color=KEY, hline: float | None = None,
             hline_label: str = "") -> str:
    if not vals:
        return "<p class='muted'>표시할 데이터가 없습니다.</p>"
    pad, bottom = 34, 24
    hi = max(vals + ([hline] if hline else [])) * 1.12 or 1
    n = len(vals)
    bw = min(42, (width - pad - 8) / n * 0.65)
    parts = [f"<svg viewBox='0 0 {width} {height}' role='img'>"]
    for i, (lab, v) in enumerate(zip(labels, vals)):
        x = pad + (i + 0.5) * (width - pad - 8) / n - bw / 2
        h = (v / hi) * (height - bottom - 10)
        y = height - bottom - h
        parts.append(f"<rect x='{x:.1f}' y='{y:.1f}' width='{bw:.1f}' "
                     f"height='{h:.1f}' fill='{color}' rx='2'/>")
        parts.append(f"<text x='{x + bw / 2:.1f}' y='{y - 4:.1f}' font-size='10' "
                     f"fill='{INK}' text-anchor='middle'>{fmt_num(v)}</text>")
        if n <= 12:
            parts.append(f"<text x='{x + bw / 2:.1f}' y='{height - 8}' "
                         f"font-size='10' fill='{INK}' text-anchor='middle'>"
                         f"{esc(lab)}</text>")
    if hline:
        y = height - bottom - (hline / hi) * (height - bottom - 10)
        parts.append(f"<line x1='{pad}' y1='{y:.1f}' x2='{width - 8}' "
                     f"y2='{y:.1f}' stroke='{GRAY}' stroke-dasharray='4 3'/>"
                     f"<text x='{width - 8}' y='{y - 4:.1f}' font-size='10' "
                     f"fill='{INK}' text-anchor='end'>{esc(hline_label)}</text>")
    parts.append("</svg>")
    return "".join(parts)


def svg_hbars(rows: list[tuple[str, float, bool]], *, width=640,
              log_scale=False, unit="", boundaries: list[int] | None = None,
              boundary_labels: list[str] | None = None) -> str:
    """가로 막대 사다리. rows=[(라벨, 값, 자사여부)], boundaries=행 인덱스
    앞에 긋는 구분선(티어 경계)."""
    if not rows:
        return "<p class='muted'>표시할 데이터가 없습니다.</p>"
    rh, pad_l = 26, 110
    height = len(rows) * rh + 12
    vals = [max(v, 0) for _, v, _ in rows]
    tx = [math.log10(v + 1) for v in vals] if log_scale else vals
    hi = max(tx) or 1
    parts = [f"<svg viewBox='0 0 {width} {height}' role='img'>"]
    bset = set(boundaries or [])
    blabels = list(boundary_labels or [])
    for i, ((lab, v, mine), t) in enumerate(zip(rows, tx)):
        y = 8 + i * rh
        if i in bset:
            parts.append(f"<line x1='0' y1='{y - 4}' x2='{width}' y2='{y - 4}' "
                         f"stroke='{GRAY}' stroke-dasharray='4 3'/>")
        if blabels and (i in bset or i == 0):
            parts.append(f"<text x='{width - 4}' y='{y + 8}' font-size='10' "
                         f"fill='{INK}' text-anchor='end'>{esc(blabels.pop(0))}"
                         "</text>")
        w = (t / hi) * (width - pad_l - 90)
        color = KEY if mine else "#c3cbd1"
        parts.append(f"<text x='{pad_l - 6}' y='{y + rh / 2 + 3:.1f}' "
                     f"font-size='11' fill='{INK}' text-anchor='end'>"
                     f"{esc(lab)}</text>")
        parts.append(f"<rect x='{pad_l}' y='{y + 4}' width='{max(w, 2):.1f}' "
                     f"height='{rh - 10}' fill='{color}' rx='2'/>")
        parts.append(f"<text x='{pad_l + max(w, 2) + 5:.1f}' "
                     f"y='{y + rh / 2 + 3:.1f}' font-size='10' fill='{INK}'>"
                     f"{fmt_num(v)}{esc(unit)}</text>")
    parts.append("</svg>")
    return "".join(parts)


def svg_scatter(points: list[dict], median_x: float, median_y: float,
                *, width=520, height=340) -> str:
    """인지도×코어 사분면. y 는 표시만 log1p."""
    if not points:
        return "<p class='muted'>좌표 데이터가 없습니다.</p>"
    pad = 40
    xs = [p["x"] for p in points]
    ys = [math.log1p(p["y"]) for p in points]
    lo_x, hi_x = min(xs + [median_x]) - 3, max(xs + [median_x]) + 3
    lo_y, hi_y = min(ys + [math.log1p(median_y)]) - 0.3, \
        max(ys + [math.log1p(median_y)]) + 0.3
    sx = _scale(xs, lo_x, hi_x, pad, width - 14)
    sy = _scale(ys, lo_y, hi_y, height - 30, 14)
    mx = _scale([median_x], lo_x, hi_x, pad, width - 14)[0]
    my = _scale([math.log1p(median_y)], lo_y, hi_y, height - 30, 14)[0]
    parts = [f"<svg viewBox='0 0 {width} {height}' role='img'>",
             f"<line x1='{mx:.1f}' y1='14' x2='{mx:.1f}' y2='{height - 30}' "
             f"stroke='{GRAY}' stroke-dasharray='4 3'/>",
             f"<line x1='{pad}' y1='{my:.1f}' x2='{width - 14}' y2='{my:.1f}' "
             f"stroke='{GRAY}' stroke-dasharray='4 3'/>"]
    for lab, ax, ay, anchor in (
            ("진성 강세", width - 16, 24, "end"),
            ("니치 충성", pad + 2, 24, "start"),
            ("광고형", width - 16, height - 36, "end"),
            ("축적 단계", pad + 2, height - 36, "start")):
        parts.append(f"<text x='{ax}' y='{ay}' font-size='10' fill='{GRAY}' "
                     f"text-anchor='{anchor}'>{lab}</text>")
    for p, x, y in zip(points, sx, sy):
        mine = p["group_key"] == "miiwan"
        r = 7 if mine else 4
        color = KEY if mine else "#c3cbd1"
        parts.append(f"<circle cx='{x:.1f}' cy='{y:.1f}' r='{r}' "
                     f"fill='{color}'/>")
        if mine:
            parts.append(f"<text x='{x + 9:.1f}' y='{y + 4:.1f}' font-size='11' "
                         f"font-weight='700' fill='{KEY_DARK}'>MiiWAN</text>")
    parts.append(f"<text x='{width / 2}' y='{height - 8}' font-size='10' "
                 f"fill='{INK}' text-anchor='middle'>인지도 (0~100) →</text>")
    parts.append(f"<text x='14' y='{height / 2}' font-size='10' fill='{INK}' "
                 f"transform='rotate(-90 14 {height / 2})' "
                 f"text-anchor='middle'>적극 코어 (log) →</text>")
    parts.append("</svg>")
    return "".join(parts)


# ── 섹션 빌더 ─────────────────────────────────────────────────────────


def _section(title: str, question: str, body: str,
             conclusion: str | None = None) -> str:
    concl = (f"<p class='concl'>{esc(conclusion)}</p>" if conclusion else "")
    return (f"<section class='slide'><h2>{esc(title)}</h2>"
            f"<p class='q'>{esc(question)}</p>{concl}{body}</section>")


def _kpi_table(d: dict, investor: bool) -> str:
    """1장 표. 투자사판(G7)은 밴드 수치 숨김 — 판정 색만."""
    rows = []
    for key in KPI_LABELS:
        j = d["kpi"]["judgments"][key]
        prev = d["kpi"]["prev"].get(key)
        band_cell = ("<td class='num muted'>비공개(내부 목표)</td>" if investor
                     else (f"<td class='num'>{fmt_num(j['band'][0])}~"
                           f"{fmt_num(j['band'][1])}</td>"
                           if j["band"] else "<td class='num'>—</td>"))
        v = j["verdict"]
        verdict_cell = (
            f"<td style='color:{VERDICT_COLOR[v]};font-weight:700'>"
            f"{VERDICT_KO[v]}</td>" if v else "<td class='muted'>—</td>")
        rows.append(
            f"<tr><td>{esc(j['label'])}</td>"
            f"<td class='num'>{fmt_num(j['actual'])}</td>"
            f"<td class='num muted'>{fmt_num(prev)}</td>"
            f"{band_cell}{verdict_cell}</tr>")
    return ("<table><thead><tr><th>KPI</th><th>실적</th><th>전월</th>"
            "<th>목표 밴드</th><th>판정</th></tr></thead><tbody>"
            + "".join(rows) + "</tbody></table>")


def render_deck(d: dict, *, edition: str, generated_at: str,
                draft: bool = True) -> str:
    """전체 덱 HTML. edition = 'internal' | 'investor'."""
    investor = edition == "investor"
    month = d["month"]
    m_label = f"{int(month[:4])}년 {int(month[5:7])}월"
    slides: list[str] = []

    # 1. 표지 — 타이틀만(덱 규칙).
    slides.append(
        "<section class='slide cover'>"
        f"<h1>MiiWAN 월간 리포트</h1><p class='cover-sub'>{esc(m_label)}</p>"
        f"<p class='stamp'>생성 {esc(generated_at[:10])} · 데이터 기준 "
        f"{esc(month)} 월말 스냅샷"
        + ("" if not investor else " · 투자사 공유판") + "</p></section>")

    # 2. 이달의 요약 (판정 신호등 + 자동 결론 불릿)
    bullets = [d["kpi"]["headline"]]
    for ln in (d["tier_line"], d["cohort_line"], d["quadrant_move"],
               d["spike_note"]):
        if ln:
            bullets.append(ln)
    if not investor and d["alerts"]:
        bullets.append(f"월내 리스크 알림 {len(d['alerts'])}건 — 부록 A1 참조")
    elif not investor:
        bullets.append("월내 리스크 알림 0건")
    body = "<ul class='bullets'>" + "".join(
        f"<li>{esc(b)}</li>" for b in bullets[:5]) + "</ul>"
    slides.append(_section("이달의 요약", "지난달을 다섯 줄로 말하면?", body))

    # 3. 핵심 지표 (KPI 표)
    slides.append(_section(
        "핵심 지표", "숫자가 어디로 움직였나?",
        _kpi_table(d, investor), d["kpi"]["headline"]))

    # 4. 구독자 성장 (일별 선 + 밴드 + 이벤트)
    series = d["subs_series"]
    days = [r["day"] for r in series]
    vals = [r["subs"] for r in series]
    band = d["kpi"]["judgments"]["subscribers"]["band"]
    ev_marks = [(e["event_date"], e["title"][:8])
                for e in d["events"]
                if e["event_date"].startswith(month)
                and (not investor or e["confidence"] == "high")]
    gain_txt = (f"월간 순증 +{fmt_num(d['subs_gain'])}"
                if d["subs_gain"] is not None else "")
    slides.append(_section(
        "구독자 성장", "무엇이 성장을 움직였나?",
        svg_line(days, vals, band=None if investor else band, marks=ev_marks)
        + (f"<p class='note'>{esc(d['spike_note'])}</p>" if d["spike_note"] else ""),
        f"{mom_phrase(d['kpi']['actuals']['subscribers'], d['kpi']['prev']['subscribers'])}"
        + (f" · {gain_txt}" if gain_txt else "")))

    # 5. 라이브 동접 (방송별 막대)
    ccv = d["ccv"]
    b_labels = [b["started"][5:] for b in ccv["broadcasts"]]
    b_vals = [b["avg"] for b in ccv["broadcasts"]]
    slides.append(_section(
        "라이브 방송", "방송 반응은 어땠나?",
        svg_bars(b_labels, b_vals, hline=ccv["avg"],
                 hline_label=f"월평균 {fmt_num(ccv['avg'])}")
        + f"<p class='note'>관측 방송 {ccv['count']}회 · 최고 동접 "
          f"{fmt_num(ccv['peak'])}명</p>",
        f"평균 동접 {mom_phrase(ccv['avg'], d['ccv_prev']['avg'])}"))

    # 6. 위버스 (가입/멤버십 스몰 멀티플)
    wser = d["weverse_series"]
    wv, wvp = d["weverse"], d["weverse_prev"]
    if wser:
        wdays = [r["day"] for r in wser]
        chart = ("<div class='duo'><div><h3>가입자</h3>"
                 + svg_line(wdays, [r["total_members"] or 0 for r in wser],
                            width=310, height=150)
                 + "</div><div><h3>유료 멤버십</h3>"
                 + svg_line(wdays, [r["digital_membership"] or 0 for r in wser],
                            width=310, height=150)
                 + "</div></div>")
    else:
        chart = "<p class='muted'>이 달 위버스 기록이 없습니다.</p>"
    wv_note = (f"<p class='note'>{esc(wv['day'])} 기준(월말 행 부재)</p>"
               if wv and wv.get("partial") else "")
    slides.append(_section(
        "위버스 커뮤니티", "팬 커뮤니티는 커지고 있나?", chart + wv_note,
        (f"가입 {mom_phrase(wv['members'] if wv else None, wvp['members'] if wvp else None)}"
         f" · 멤버십 {mom_phrase(wv['membership'] if wv else None, wvp['membership'] if wvp else None)}")))

    # 7. 동시기 성과 (성장배수 가로 막대 + 순위 표)
    coh = d["cohort"]
    if coh["rows"]:
        hrows = [(("MiiWAN" if r["group"] == "miiwan" else r["group"].upper()),
                  r["multiple"], r["group"] == "miiwan") for r in coh["rows"]]
        excl = ("<p class='note'>제외: " + ", ".join(
            f"{e['group']}({e['reason']})" for e in coh["excluded"]) + "</p>"
            if coh["excluded"] else "")
        body = (f"<p class='note'>데뷔일 정렬 D+{coh['age_days']}일 시점 구독 "
                "성장배수(D0 대비) · 실측 스냅샷 기준</p>"
                + svg_hbars(hrows, unit="x") + excl)
    else:
        body = "<p class='muted'>코호트 비교 가능 데이터가 없습니다.</p>"
    slides.append(_section("동시기 성과", "같은 성장 단계 대비 빠른가?",
                           body, d["cohort_line"]))

    # 8. 시장 내 위치 (티어 사다리 + 사분면)
    tier = d["tier"]
    tier_body = ""
    if tier and tier.get("kpop_rows"):
        rows = []
        bounds, blabels, prev_t = [], [], None
        for i, r in enumerate(tier["kpop_rows"]):
            t = r.get("tier")
            if t != prev_t:
                if i > 0:
                    bounds.append(i)
                blabels.append(TIER_LABELS.get(t, f"T{t}") if t else "")
                prev_t = t
            rows.append((r["group_key"].upper() if r["group_key"] != "miiwan"
                         else "MiiWAN", r.get("view_flow_90d") or 0,
                         r["group_key"] == "miiwan"))
        tier_body += ("<h3>관심 규모 — 최근 90일 조회 증분 (K-POP 버추얼)</h3>"
                      + svg_hbars(rows, log_scale=True, boundaries=bounds,
                                  boundary_labels=blabels)
                      + "<p class='note'>막대 길이는 log 스케일 · 티어 경계 = "
                        "규모 격차 0.5데케이드(≈3.2배) 이상</p>")
    quad = d["quadrant"]
    if quad:
        tier_body += ("<h3>인지도 × 적극 코어 사분면</h3>"
                      + svg_scatter(quad["points"], quad["median_x"],
                                    quad["median_y"]))
    concl = " ".join(x for x in [d["tier_line"], d["quadrant_move"]] if x) or None
    slides.append(_section("시장 내 위치", "시장 어디에 있고 어느 방향인가?",
                           tier_body or "<p class='muted'>데이터 없음</p>", concl))

    # 9. 팬덤 질 + 오디언스
    org = d["org_score"]
    tiles = (f"<div class='tiles'>"
             f"<div class='tile'><div class='tv'>{fmt_num(org) if org is not None else '—'}"
             f"</div><div class='tl'>자연 유입 점수 (0~100 · 생성 시점 기준)</div></div>"
             f"<div class='tile'><div class='tv'>+{fmt_num(d['news_delta']) if d['news_delta'] is not None else '—'}"
             f"</div><div class='tl'>월간 뉴스 증분 (자사 집계)</div></div>"
             f"</div>")
    demo = d["demographics"]
    demo_body = ""
    if demo:
        agg: dict[str, float] = {}
        for r in demo:
            agg[r["age_group"]] = agg.get(r["age_group"], 0) + (r["viewer_pct"] or 0)
        rows = [(a.replace("age", ""), v, False)
                for a, v in sorted(agg.items())]
        demo_body = "<h3>연령대별 시청 비중</h3>" + svg_hbars(rows, unit="%")
    ctry_body = ""
    if d["countries"]:
        rows = [(c["country"], round((c["watch_share"] or 0) * 100, 1), False)
                for c in d["countries"][:5]]
        ctry_body = "<h3>국가별 시청 비중 (상위 5)</h3>" + svg_hbars(rows, unit="%")
    slides.append(_section("팬덤의 질과 구성", "성장이 건강하고, 누가 팬인가?",
                           tiles + demo_body + ctry_body))

    # 10. 다음 달
    next_events = [e for e in d["events"]
                   if not e["event_date"].startswith(month)]
    if investor:
        shown = [e for e in next_events if e["confidence"] == "high"]
        masked = len(next_events) - len(shown)
        ev_lines = [f"<li>{esc(e['event_date'])} — {esc(e['title'])}</li>"
                    for e in shown]
        if masked:
            ev_lines.append(f"<li>비공개 예정 이벤트 {masked}건(일자·내용 미정)</li>")
    else:
        ev_lines = [f"<li>{esc(e['event_date'])} — {esc(e['title'])} "
                    f"<span class='muted'>({esc(e['confidence'])})</span></li>"
                    for e in next_events]
    nb = "".join(ev_lines) or "<li>등록된 예정 이벤트 없음</li>"
    watch = [k for k, j in d["kpi"]["judgments"].items()
             if j["verdict"] == "below"]
    watch_txt = ("주시 포인트: " + " · ".join(KPI_LABELS[k] for k in watch)
                 if watch else "주시 포인트: 전 KPI 밴드 내 유지 여부")
    slides.append(_section("다음 달", "다음 달 무엇을 보나?",
                           f"<ul class='bullets'>{nb}</ul>", watch_txt))

    # 부록 (내부판 전용)
    if not investor:
        if d["alerts"]:
            al = "".join(
                f"<li>{esc(a['fired_at'][:10])} [{esc(a['severity'])}] "
                f"{esc(a['title'])}</li>" for a in d["alerts"])
        else:
            al = "<li>월내 발생 알림 0건</li>"
        slides.append(_section(
            "A1. 위기 모니터 (내부)", "지난달 리스크는 무엇이었고 어떻게 닫혔나?",
            f"<ul class='bullets'>{al}</ul>"
            + f"<p class='note'>월말 논란 글 지표: {fmt_num(d['controversy'])}건"
              " (14일 창)</p>"))
        ins = "".join(
            f"<li><b>{esc(i['title'])}</b> — {esc(i['ai_comment'])} "
            f"<span class='muted'>(주 {esc(i['week_start'])})</span></li>"
            for i in d["insights"]) or "<li>큐레이션 대상 인사이트 없음</li>"
        slides.append(_section(
            "A2. 전략 메모 (내부 · 자동 선별·검수 전)",
            "참고할 해석은?", f"<ul class='bullets'>{ins}</ul>"))

    warn_html = ""
    if d["warnings"]:
        warn_html = ("<div class='warnbox'>데이터 참고: "
                     + " / ".join(esc(w) for w in d["warnings"]) + "</div>")

    draft_css = (".slide::after{content:'DRAFT — 검수 후 사용';position:absolute;"
                 "top:45%;left:8%;font-size:52px;color:rgba(217,119,6,.13);"
                 "font-weight:800;transform:rotate(-18deg);pointer-events:none}"
                 if investor and draft else "")

    title = f"MiiWAN 월간 리포트 {esc(month)}" + (" (투자사판)" if investor else "")
    return f"""<!doctype html><html lang='ko'><head><meta charset='utf-8'>
<meta name='viewport' content='width=device-width,initial-scale=1'>
<title>{title}</title>
<style>
*{{box-sizing:border-box;margin:0;padding:0;print-color-adjust:exact;
   -webkit-print-color-adjust:exact}}
body{{font-family:'Pretendard','Apple SD Gothic Neo','Malgun Gothic',sans-serif;
     background:#eef1f3;color:{INK};line-height:1.55}}
.slide{{position:relative;background:#fff;max-width:860px;margin:20px auto;
       padding:44px 52px;border-radius:6px;box-shadow:0 1px 4px rgba(0,0,0,.08);
       page-break-after:always;overflow:hidden}}
.cover{{display:flex;flex-direction:column;justify-content:center;
       min-height:420px;border-top:8px solid {KEY}}}
.cover h1{{font-size:40px;letter-spacing:-0.5px}}
.cover-sub{{font-size:22px;margin-top:10px;color:{KEY_DARK};font-weight:700}}
.stamp{{margin-top:26px;color:#6b7280;font-size:13px}}
h2{{font-size:22px;margin-bottom:2px}}
h3{{font-size:14px;margin:16px 0 6px;color:#374151}}
.q{{color:#6b7280;font-size:13px;margin-bottom:12px}}
.concl{{background:#f0faf9;border-left:4px solid {KEY};padding:8px 12px;
       font-weight:600;font-size:14px;margin-bottom:14px}}
table{{width:100%;border-collapse:collapse;font-size:14px}}
th,td{{padding:8px 10px;border-bottom:1px solid #e5e7eb;text-align:left}}
th{{color:#6b7280;font-weight:600;font-size:12px}}
.num{{text-align:right;font-variant-numeric:tabular-nums}}
.muted{{color:#9ca3af}}
.bullets{{list-style:none}}
.bullets li{{padding:6px 0 6px 18px;position:relative;font-size:14.5px}}
.bullets li::before{{content:'';position:absolute;left:2px;top:13px;width:7px;
                    height:7px;border-radius:50%;background:{KEY}}}
.note{{color:#6b7280;font-size:12px;margin-top:6px}}
.duo{{display:flex;gap:18px;flex-wrap:wrap}}
.tiles{{display:flex;gap:14px;margin-bottom:10px;flex-wrap:wrap}}
.tile{{border:1px solid #e5e7eb;border-radius:6px;padding:14px 18px;min-width:190px}}
.tv{{font-size:26px;font-weight:800}}
.tl{{font-size:11.5px;color:#6b7280;margin-top:2px}}
.warnbox{{max-width:860px;margin:0 auto 20px;padding:10px 16px;font-size:12.5px;
         background:#fff7ed;border:1px solid #fdba74;border-radius:6px;color:#9a3412}}
svg{{width:100%;height:auto;display:block}}
{draft_css}
@media print{{body{{background:#fff}}.slide{{box-shadow:none;margin:0 auto}}}}
</style></head><body>
{''.join(slides)}
{warn_html}
<p style='text-align:center;color:#9ca3af;font-size:11px;margin:14px 0 30px'>
idol-sight 자동 생성 · 산식·방법론은 대시보드 각 화면 도움말 참조 ·
경쟁사 수치는 공개 신호 기반 추정 포함</p>
</body></html>"""
