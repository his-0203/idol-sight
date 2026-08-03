// frontend/src/components/FanActivityCard.tsx
//
// P2a 찐팬 활동량 카드 (MiiWAN 전용). FanLoyaltyCard 의 구조/색/막대 컨벤션
// 미러. 점수가 아니라 '현황 표시' — measured 라이브 코어(고유 챗터·재방문)와
// estimated 영상 참여(좋아요·댓글)를 서로 다른 참여 표면으로 병치한다.
// 신규 수집 0(기존 데이터 재가공). 추정 항목엔 '추정' 배지.

import { formatKSTMonthDayWeekday } from "../lib/datetime";

export interface FanActivityBroadcast {
  video_id: string;
  ended_at: string | null;
  unique_chatters: number;
  total_messages: number;
  msgs_per_chatter: number | null;
  peak_msgs_per_min: number | null;
  returning_rate: number | null;
}

export interface FanActivity {
  generated_at: string;
  window_days: number;
  broadcast_count: number;
  basis: "scored" | "low_confidence" | "insufficient";
  median_unique_chatters: number | null;
  median_msgs_per_chatter: number | null;
  median_returning_rate: number | null;
  median_peak_msgs_per_min: number | null;
  core_fan_count: number | null;
  core_fan_share: number | null;
  est_engaged_fans: number | null;
  est_active_core: number | null;
  view_through: number | null;
  like_rate: number | null;
  comment_rate: number | null;
  broadcasts: FanActivityBroadcast[];
}

/** 비율(0~1)을 소수 1자리 %로. null → "—". (FanLoyaltyCard.fmtPct 미러) */
export function fmtRate(rate: number | null | undefined): string {
  if (rate == null) return "—";
  return `${(rate * 100).toFixed(1)}%`;
}

/** 정수 카운트 표시(반올림 + 천 단위 구분). null → "—". */
export function fmtInt(n: number | null | undefined): string {
  if (n == null) return "—";
  return Math.round(n).toLocaleString();
}

/** 소수 1자리(챗터당 메시지 등). null → "—". */
export function fmtDecimal(n: number | null | undefined): string {
  if (n == null) return "—";
  return n.toFixed(1);
}

/** 막대 폭(0~100): set 의 max 대비 정규화. max<=0 가드. (FanLoyaltyCard 미러) */
export function barWidthPct(value: number, max: number): number {
  if (max <= 0) return 0;
  return (value / max) * 100;
}

function EstimateMark() {
  return (
    <span
      title="공개 외형 신호로 가늠한 추정치 — 인간 판단을 대체하지 않음"
      class="ml-1 rounded bg-zinc-800/60 px-1 py-[1px] text-[10px] text-zinc-500"
    >추정</span>
  );
}

function TierCell(
  { label, sub, value, estimated, tip }:
  { label: string; sub: string; value: string; estimated?: boolean; tip?: string },
) {
  return (
    <div class="rounded border border-zinc-800 bg-zinc-900/40 p-2" title={tip}>
      <div class="flex items-center text-hint text-zinc-500">
        {label}{estimated && <EstimateMark />}
      </div>
      <div class="text-lg font-bold tabular-nums text-zinc-100">{value}</div>
      <div class="text-[10px] text-zinc-500">{sub}</div>
    </div>
  );
}

export function FanActivityCard({ activity }: { activity: FanActivity }) {
  const {
    basis, window_days, broadcast_count, broadcasts,
    median_unique_chatters, est_engaged_fans, est_active_core,
    core_fan_count, core_fan_share,
    view_through, like_rate, comment_rate,
  } = activity;

  // 추이 ladder: 최신이 위. API 는 오래된→최신 이라 reverse. 막대는 방송별
  // 고유 챗터(단골 코어) 규모를 set max 대비로 정규화.
  const rows = [...broadcasts].reverse();
  const maxChatters = rows.reduce((m, b) => Math.max(m, b.unique_chatters), 0);

  return (
    <section class="rounded-lg border border-zinc-800 p-3">
      {/* 제목은 부모 섹션 헤더("찐팬 활동")가 소유 — 여기 h3를 또 두면
          같은 문장이 두 줄 연속으로 반복된다. 기간 메타만 남긴다. */}
      <div class="mb-1 flex items-baseline justify-end">
        <span class="text-hint text-zinc-500">최근 {window_days}일 · 방송 {broadcast_count}회</span>
      </div>

      {basis === "insufficient" ? (
        <div class="text-data text-zinc-500">라이브 데이터 축적 중</div>
      ) : (
        <>
          {/* 3층위 — 참여 강도별 병치(엄격한 포함관계 아님, 서로 다른 표면) */}
          <div class="grid grid-cols-3 gap-2">
            <TierCell
              label="추정 관여 팬" sub="좋아요 반응" estimated
              value={fmtInt(est_engaged_fans)}
              tip="영상에 좋아요로 반응한 추정 팬 수 — 좋아요는 영상당 1인 1회라 고유 인원 근사"
            />
            <TierCell
              label="측정 라이브 단골" sub="고유 챗터(중앙값)"
              value={fmtInt(median_unique_chatters)}
              tip="라이브 채팅에 실제로 글을 남긴 고유 인원 — 실측값"
            />
            <TierCell
              label="추정 적극 참여 단골" sub="댓글" estimated
              value={fmtInt(est_active_core)}
              tip="영상 댓글 수 — 1인 다회 가능하므로 적극 참여의 상한 추정"
            />
          </div>

          {/* 코어팬 비율 헤드라인 */}
          {core_fan_share != null && (
            <div class="mt-2 flex flex-wrap items-baseline gap-x-2 text-data text-zinc-400">
              <span>코어팬</span>
              <span class="font-semibold text-teal-300">{fmtInt(core_fan_count)}명</span>
              <span>· 윈도우 챗터의</span>
              <span class="font-semibold text-teal-300">{fmtRate(core_fan_share)}</span>
              <span class="text-hint text-zinc-500">(2회 이상 방송에 다시 온 단골)</span>
            </div>
          )}

          {/* 영상 참여율 — 추정(estimated) 보조 라인 */}
          {(like_rate != null || view_through != null) && (
            <div class="mt-1 flex flex-wrap items-center gap-x-3 text-hint text-zinc-500">
              <span class="flex items-center">영상 참여율<EstimateMark /></span>
              <span>좋아요율 {fmtRate(like_rate)}</span>
              <span>댓글율 {fmtRate(comment_rate)}</span>
              <span title="구독자 중 실제로 영상을 본 추정 비율">시청 전환 {fmtRate(view_through)}</span>
            </div>
          )}

          {/* 방송별 추이 — 날짜·고유 챗터(막대)·챗터당 메시지·분당 피크·재방문 */}
          {rows.length > 0 && (
            <div class="mt-3 border-t border-zinc-800/70 pt-2.5">
              <div class="mb-1.5 flex justify-between text-hint text-zinc-400">
                <span>방송별 단골 코어 (고유 챗터)</span>
                <span>고유 챗터 수</span>
              </div>
              {rows.map((b, i) => {
                const latest = i === 0;
                return (
                  <div
                    key={b.video_id}
                    class={`rounded px-1 py-1 ${latest ? "bg-teal-500/10" : ""}`}
                  >
                    <div class="grid grid-cols-[56px_1fr_auto] items-center gap-2.5">
                      <span class="text-hint tabular-nums text-zinc-400">
                        {formatKSTMonthDayWeekday(b.ended_at)}
                      </span>
                      <div class="relative h-3.5">
                        <div
                          class={`absolute left-0 top-0 h-full rounded-sm ${
                            latest ? "bg-teal-500/45" : "bg-teal-500/25"
                          }`}
                          style={`width:${barWidthPct(b.unique_chatters, maxChatters)}%`}
                        />
                      </div>
                      <span class={`min-w-[56px] text-right text-data tabular-nums ${
                        latest ? "font-semibold text-teal-300" : "text-zinc-200"
                      }`}>
                        {fmtInt(b.unique_chatters)}명
                      </span>
                    </div>
                    <div class="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 pl-[56px] text-hint text-zinc-500">
                      <span title="챗터 1인당 평균 메시지 수 — 코어 밀도">
                        챗터당 {fmtDecimal(b.msgs_per_chatter)}개
                      </span>
                      <span title="분당 최고 채팅량 — 방송 중 가장 뜨거웠던 순간">
                        분당 피크 {fmtInt(b.peak_msgs_per_min)}
                      </span>
                      <span title="이번 방송에 다시 온 단골 비율 (직전 방송 대비)">
                        재방문 {fmtRate(b.returning_rate)}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}

      {basis === "low_confidence" && (
        <div class="mt-1 text-hint text-amber-500/80">단발 방송 기준 — 재방문·코어팬 미산정</div>
      )}

      <div class="mt-2 text-hint text-zinc-500">
        '측정'은 라이브 채팅 실측(고유 챗터·재방문), '추정'은 영상 좋아요·댓글로
        가늠한 근사치 — 서로 다른 참여 표면이라 단순 비교는 금물. 점수 아님(현황 표시).
      </div>
    </section>
  );
}
