/**
 * /pumps 泵站批次与回执对账
 * 泵送批次开机 / 断链续泵 / 班末回执登记与改口径重出；走水单按「池号 + 批次号」对账，
 * 日容量满时后续走水单排队到次日档位；升级补不出批次号的走水单在底部单列。
 * 消费模型：PumpBatch、PumpReceipt、Schedule、Observation；复用 <StatBadge>、<EmptyPanel>、<AppDialog>、<FilterBar>
 */
import { For, Show, createMemo, createSignal, onMount } from 'solid-js';
import { createStore } from 'solid-js/store';
import AppDialog from '../components/common/AppDialog';
import EmptyPanel from '../components/common/EmptyPanel';
import FilterBar from '../components/common/FilterBar';
import StatBadge from '../components/common/StatBadge';
import { usePondStore } from '../stores/pondStore';
import { usePumpStore } from '../stores/pumpStore';
import { useScheduleStore } from '../stores/scheduleStore';
import {
  PUMP_BATCH_STATE_OPTIONS,
  type PumpBatch,
  type PumpBatchDraft,
  type PumpBatchState,
  type PumpReceipt,
  type PumpReceiptDraft,
} from '../types/pump';
import type { Schedule } from '../types/schedule';
import { PUMP_DAILY_CAPACITY_M3, reconcileSchedule } from '../utils/pump';
import { today } from '../utils/id';

const INPUT =
  'w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm outline-none focus:border-brine-500 focus:ring-1 focus:ring-brine-400';
const BTN_PRIMARY =
  'rounded-md bg-brine-600 px-3.5 py-1.5 text-sm font-medium text-white transition hover:bg-brine-700 disabled:opacity-50';
const BTN_GHOST =
  'rounded-md border border-slate-300 bg-white px-3.5 py-1.5 text-sm text-slate-700 transition hover:bg-slate-100';
const BTN_SMALL =
  'rounded-md border border-brine-300 bg-brine-50 px-2.5 py-1 text-xs text-brine-700 transition hover:bg-brine-100 disabled:opacity-50';

const BATCH_STATE_STYLE: Record<PumpBatchState, string> = {
  泵送中: 'border-sky-300 bg-sky-50 text-sky-700',
  断链待续: 'border-rose-300 bg-rose-50 text-rose-700',
  已完批: 'border-emerald-300 bg-emerald-50 text-emerald-700',
  已作废: 'border-slate-300 bg-slate-100 text-slate-500',
};

export default function PumpStation() {
  const pondStore = usePondStore();
  const scheduleStore = useScheduleStore();
  const pumpStore = usePumpStore();

  const [keyword, setKeyword] = createSignal('');
  const [stateFilter, setStateFilter] = createSignal<PumpBatchState | 'all'>('all');
  const [createOpen, setCreateOpen] = createSignal(false);
  const [receiptFor, setReceiptFor] = createSignal<PumpBatch | null>(null);
  const [breakFor, setBreakFor] = createSignal<PumpBatch | null>(null);
  const [reissueFor, setReissueFor] = createSignal<PumpReceipt | null>(null);

  const [batchDraft, setBatchDraft] = createStore<PumpBatchDraft>({ pondId: '', planDate: today(), plannedM3: 1000 });
  const [receiptDraft, setReceiptDraft] = createStore<PumpReceiptDraft>({
    volumeM3: 0,
    periodStart: '08:00',
    periodEnd: '12:00',
    shiftDate: today(),
  });
  const [breakNote, setBreakNote] = createSignal('');
  const [reissueVolume, setReissueVolume] = createSignal(0);
  const [reissueReason, setReissueReason] = createSignal('');

  onMount(() => {
    void pondStore.loadAll();
  });

  const pondOf = (pondId: string) => pondStore.state.ponds.find((pond) => pond.id === pondId) ?? null;

  const filteredBatches = createMemo<PumpBatch[]>(() => {
    const kw = keyword().trim().toLowerCase();
    return pumpStore.state.batches.filter((batch) => {
      if (stateFilter() !== 'all' && batch.state !== stateFilter()) return false;
      if (kw === '') return true;
      return batch.batchNo.toLowerCase().includes(kw) || batch.pondCode.toLowerCase().includes(kw);
    });
  });

  const stats = createMemo(() => {
    const counts = pumpStore.receiptCounts();
    const todayUsed = pumpStore.todayReceiptM3();
    return {
      batches: pumpStore.state.batches.length,
      broken: pumpStore.state.batches.filter((row) => row.state === '断链待续').length,
      valid: counts.valid,
      voided: counts.voided,
      todayUsed,
      todayPct: Math.round((todayUsed / PUMP_DAILY_CAPACITY_M3) * 1000) / 10,
    };
  });

  /** 走水对账面板：已排走水单逐张核对回执与水位 */
  const pendingChecks = createMemo(() =>
    scheduleStore.state.rows
      .filter((row) => row.state === '已排')
      .map((row) => {
        const pond = pondOf(row.pondId);
        const pondObs = pondStore.state.observations.filter((item) => item.pondId === row.pondId);
        return {
          schedule: row,
          pondCode: pond?.code ?? '（池已删除）',
          result: reconcileSchedule(row, pond?.code ?? '', pumpStore.state.receipts, pondObs),
        };
      })
      .sort((a, b) => a.schedule.slotDate.localeCompare(b.schedule.slotDate)),
  );

  /** 档位队列：已排 / 走水中按档位日期分组，直观看到容量排队 */
  const slotGroups = createMemo(() => {
    const map = new Map<string, { date: string; rows: Schedule[]; total: number }>();
    scheduleStore.state.rows
      .filter((row) => row.state === '已排' || row.state === '走水中')
      .forEach((row) => {
        const hit = map.get(row.slotDate);
        if (hit === undefined) map.set(row.slotDate, { date: row.slotDate, rows: [row], total: row.volumeM3 });
        else {
          hit.rows.push(row);
          hit.total += row.volumeM3;
        }
      });
    return [...map.values()].sort((a, b) => a.date.localeCompare(b.date));
  });

  /** 升级遗留：按池号补不出批次号的走水单，单列处理 */
  const unmatched = createMemo(() =>
    scheduleStore.state.rows.filter((row) => row.pumpBatchNo === '' && row.state !== '待排'),
  );

  const openReceiptDialog = (batch: PumpBatch): void => {
    const remaining = Math.max(0, Math.round((batch.plannedM3 - pumpStore.pumpedOf(batch.batchNo)) * 10) / 10);
    setReceiptDraft({ volumeM3: remaining, periodStart: '08:00', periodEnd: '12:00', shiftDate: today() });
    setReceiptFor(batch);
  };

  const submitBatch = async (): Promise<void> => {
    const pond = pondOf(batchDraft.pondId);
    if (pond === null) {
      pumpStore.setMessage('请选择蒸发池');
      return;
    }
    await pumpStore.createBatch({ ...batchDraft }, pond.code);
    setCreateOpen(false);
  };

  const submitReceipt = async (): Promise<void> => {
    const batch = receiptFor();
    if (batch === null) return;
    if (receiptDraft.volumeM3 <= 0) {
      pumpStore.setMessage('回执体积必须大于 0');
      return;
    }
    await pumpStore.reportReceipt(batch.id, { ...receiptDraft });
    setReceiptFor(null);
  };

  const submitBreak = async (): Promise<void> => {
    const batch = breakFor();
    if (batch === null) return;
    await pumpStore.markBroken(batch.id, breakNote().trim() || '泵组故障，当班泵送中断');
    setBreakFor(null);
    setBreakNote('');
  };

  const submitReissue = async (): Promise<void> => {
    const receipt = reissueFor();
    if (receipt === null) return;
    if (reissueVolume() <= 0) {
      pumpStore.setMessage('新体积必须大于 0');
      return;
    }
    await pumpStore.reissue(receipt.id, reissueVolume(), reissueReason().trim() || '泵站改口径，班末体积重出');
    setReissueFor(null);
  };

  return (
    <div class="space-y-3.5">
      <div class="flex flex-wrap gap-3">
        <StatBadge label="日泵送容量" value={PUMP_DAILY_CAPACITY_M3} suffix="m³/d" tone="primary" />
        <StatBadge
          label="今日回执核销"
          value={stats().todayUsed}
          suffix="m³"
          percent={stats().todayPct}
          tone={stats().todayPct >= 100 ? 'danger' : 'info'}
          hint="容量口径：按班末回执的实际泵送体积核销；断链当班只占已泵部分，余量随续泵班次核销"
        />
        <StatBadge label="泵送批次" value={stats().batches} suffix="批" tone="default" />
        <StatBadge label="断链待续" value={stats().broken} suffix="批" tone={stats().broken > 0 ? 'danger' : 'default'} />
        <StatBadge label="有效回执" value={stats().valid} suffix="张" tone="success" />
        <StatBadge label="作废留档" value={stats().voided} suffix="张" tone="warning" hint="改口径重出的旧版回执，前后两版都留档可查" />
      </div>

      <div class="rounded-lg border border-sky-200 bg-sky-50 px-3.5 py-2 text-xs leading-relaxed text-sky-800">
        断链策略：<strong>断点续泵</strong> —— 批次号不变、已泵体积留在回执链上，续泵从断点接着泵；
        容量按班末回执的实际泵送体积核销，断链当班只占已泵部分，余量随续泵班次核销。
        走水单与泵站按「池号 + 批次号」对账：泵站已收货（有效回执累计 ≥ 计划量）且水位落到位，走水单才进「走水中」。
      </div>

      <Show when={pumpStore.state.lastMessage !== ''}>
        <div class="rounded-lg border border-brine-200 bg-brine-50 px-3.5 py-2 text-sm text-brine-800">
          {pumpStore.state.lastMessage}
        </div>
      </Show>

      {/* ---------------- 泵送批次 ---------------- */}
      <section class="rounded-xl border border-slate-200 bg-white p-4">
        <header class="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 class="text-[15px] font-semibold text-slate-800">泵送批次</h2>
          <button type="button" class={BTN_PRIMARY} onClick={() => setCreateOpen(true)} disabled={pondStore.state.ponds.length === 0}>
            + 开立泵送批次
          </button>
        </header>

        <FilterBar
          keyword={keyword()}
          onKeyword={setKeyword}
          fields={[{ key: 'state', label: '批次状态', options: [...PUMP_BATCH_STATE_OPTIONS] }]}
          values={{ state: stateFilter() }}
          onChange={(key, value) => {
            if (key === 'state') setStateFilter(value as PumpBatchState | 'all');
          }}
          onReset={() => {
            setKeyword('');
            setStateFilter('all');
          }}
          resultText={`命中 ${filteredBatches().length} / ${pumpStore.state.batches.length} 批`}
        />

        <Show when={pumpStore.state.batches.length === 0}>
          <EmptyPanel
            title="还没有泵送批次"
            description="泵站按批次开机：先开立批次，班末登记回执；走水单标记已排时也会自动开立对应批次。"
            actionText="开立第一个批次"
            onAction={() => setCreateOpen(true)}
          />
        </Show>

        <Show when={pumpStore.state.batches.length > 0}>
          <ul class="space-y-2">
            <For each={filteredBatches()}>
              {(batch) => {
                const pumped = (): number => pumpStore.pumpedOf(batch.batchNo);
                const pct = (): number =>
                  batch.plannedM3 <= 0 ? 0 : Math.min(100, Math.round((pumped() / batch.plannedM3) * 1000) / 10);
                return (
                  <li class="flex flex-wrap items-center gap-3 rounded-lg border border-slate-200 bg-white px-3.5 py-3">
                    <div class="min-w-[200px] flex-1">
                      <p class="text-sm font-medium text-slate-800">
                        {batch.batchNo} <span class="ml-1 text-xs font-normal text-slate-500">{batch.pondCode}</span>
                      </p>
                      <p class="text-xs text-slate-500">
                        计划日期 {batch.planDate} · 计划量 {batch.plannedM3} m³ · 已泵 {pumped()} m³
                      </p>
                      <Show when={batch.state === '断链待续' && batch.breakNote !== ''}>
                        <p class="mt-0.5 text-xs text-rose-600">断链：{batch.breakNote}</p>
                      </Show>
                    </div>
                    <div class="flex w-40 flex-col gap-1">
                      <div class="h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
                        <div class="h-full rounded-full bg-brine-600" style={{ width: `${pct()}%` }} />
                      </div>
                      <span class="text-right text-[11px] tabular-nums text-slate-500">{pct()}%</span>
                    </div>
                    <span class={`rounded border px-2 py-0.5 text-[11px] ${BATCH_STATE_STYLE[batch.state]}`}>{batch.state}</span>
                    <div class="flex flex-wrap items-center gap-2">
                      <Show when={batch.state === '泵送中' || batch.state === '断链待续'}>
                        <button class={BTN_SMALL} onClick={() => openReceiptDialog(batch)}>
                          班末回执
                        </button>
                      </Show>
                      <Show when={batch.state === '泵送中'}>
                        <button
                          class="rounded-md border border-rose-300 bg-rose-50 px-2.5 py-1 text-xs text-rose-700 transition hover:bg-rose-100"
                          onClick={() => {
                            setBreakNote('');
                            setBreakFor(batch);
                          }}
                        >
                          断链
                        </button>
                      </Show>
                      <Show when={batch.state === '断链待续'}>
                        <button class={BTN_SMALL} onClick={() => void pumpStore.resume(batch.id)}>
                          续泵
                        </button>
                      </Show>
                    </div>
                  </li>
                );
              }}
            </For>
          </ul>
        </Show>
      </section>

      {/* ---------------- 走水对账与档位队列 ---------------- */}
      <section class="rounded-xl border border-slate-200 bg-white p-4">
        <h2 class="mb-3 text-[15px] font-semibold text-slate-800">走水对账（池号 + 批次号）</h2>
        <Show
          when={pendingChecks().length > 0}
          fallback={<p class="text-sm text-slate-500">当前没有「已排」状态、等待对账的走水单。</p>}
        >
          <ul class="space-y-2">
            <For each={pendingChecks()}>
              {(item) => (
                <li class="flex flex-wrap items-center gap-3 rounded-lg border border-slate-200 px-3.5 py-2.5 text-xs">
                  <span class="font-medium text-slate-800">{item.pondCode}</span>
                  <span class="text-slate-500">
                    批次 {item.schedule.pumpBatchNo === '' ? '未开立' : item.schedule.pumpBatchNo} · 档位 {item.schedule.slotDate}
                  </span>
                  <span class={item.result.receiptOk ? 'text-emerald-600' : 'text-rose-600'}>
                    回执 {item.result.receiptVolumeM3}/{item.schedule.volumeM3} m³ {item.result.receiptOk ? '✓ 已收货' : '✗'}
                  </span>
                  <span class={item.result.levelOk ? 'text-emerald-600' : 'text-rose-600'}>
                    水位 {item.result.latestLevelCm ?? '—'}/{item.schedule.targetLevelCm} cm {item.result.levelOk ? '✓ 已落位' : '✗'}
                  </span>
                  <span class="ml-auto text-slate-500">
                    {item.result.ok ? '对账通过，可到「走水编排」开始走水' : item.result.missing.join('；')}
                  </span>
                </li>
              )}
            </For>
          </ul>
        </Show>

        <h3 class="mb-2 mt-4 text-[13px] font-semibold text-slate-700">泵站档位队列（日容量 {PUMP_DAILY_CAPACITY_M3} m³）</h3>
        <Show
          when={slotGroups().length > 0}
          fallback={<p class="text-sm text-slate-500">暂无占用泵站容量的走水单。</p>}
        >
          <div class="flex flex-wrap gap-2">
            <For each={slotGroups()}>
              {(group) => {
                const over = (): boolean => group.total > PUMP_DAILY_CAPACITY_M3;
                return (
                  <div
                    class={`rounded-lg border px-3 py-2 text-xs ${
                      over() ? 'border-rose-300 bg-rose-50' : 'border-slate-200 bg-slate-50'
                    }`}
                  >
                    <p class={`font-semibold ${over() ? 'text-rose-700' : 'text-slate-700'}`}>
                      {group.date} · {Math.round(group.total * 10) / 10} / {PUMP_DAILY_CAPACITY_M3} m³
                      {over() ? '（超容）' : ''}
                    </p>
                    <p class="mt-0.5 text-slate-500">
                      {group.rows
                        .map((row) => `${pondOf(row.pondId)?.code ?? '？'} ${row.volumeM3}m³（${row.state}）`)
                        .join('、')}
                    </p>
                  </div>
                );
              }}
            </For>
          </div>
        </Show>
      </section>

      {/* ---------------- 回执台账 ---------------- */}
      <section class="rounded-xl border border-slate-200 bg-white p-4">
        <h2 class="mb-3 text-[15px] font-semibold text-slate-800">班末回执台账（作废留档，前后两版都可查）</h2>
        <Show
          when={pumpStore.state.receipts.length > 0}
          fallback={<EmptyPanel title="还没有回执" description="批次开机后，班末在批次列表点「班末回执」登记泵送体积与时段。" />}
        >
          <div class="overflow-x-auto">
            <table class="w-full min-w-[1080px] border-collapse text-sm">
              <thead>
                <tr class="border-b border-slate-200 bg-slate-50 text-left text-xs text-slate-500">
                  <th class="px-3 py-2">回执编号</th>
                  <th class="px-3 py-2">版次</th>
                  <th class="px-3 py-2">池号</th>
                  <th class="px-3 py-2">批次号</th>
                  <th class="px-3 py-2 text-right">体积（m³）</th>
                  <th class="px-3 py-2">泵送时段</th>
                  <th class="px-3 py-2">班次日期</th>
                  <th class="px-3 py-2">状态</th>
                  <th class="px-3 py-2">操作</th>
                </tr>
              </thead>
              <tbody>
                <For each={pumpStore.state.receipts}>
                  {(receipt) => (
                    <tr class={`border-b border-slate-100 ${receipt.state === '已作废' ? 'text-slate-400' : ''}`}>
                      <td class="px-3 py-2.5 font-medium">{receipt.receiptNo}</td>
                      <td class="px-3 py-2.5 tabular-nums">V{receipt.version}</td>
                      <td class="px-3 py-2.5">{receipt.pondCode}</td>
                      <td class="px-3 py-2.5">{receipt.batchNo}</td>
                      <td class="px-3 py-2.5 text-right tabular-nums">{receipt.volumeM3}</td>
                      <td class="px-3 py-2.5 tabular-nums">
                        {receipt.periodStart}–{receipt.periodEnd}
                      </td>
                      <td class="px-3 py-2.5">{receipt.shiftDate}</td>
                      <td class="px-3 py-2.5">
                        <Show
                          when={receipt.state === '有效'}
                          fallback={
                            <span class="rounded border border-slate-300 bg-slate-100 px-2 py-0.5 text-[11px]" title={receipt.voidReason}>
                              已作废{receipt.voidReason === '' ? '' : `：${receipt.voidReason}`}
                            </span>
                          }
                        >
                          <span class="rounded border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-[11px] text-emerald-700">有效</span>
                        </Show>
                      </td>
                      <td class="px-3 py-2.5">
                        <Show when={receipt.state === '有效'}>
                          <button
                            class="text-xs text-brine-700 hover:underline"
                            onClick={() => {
                              setReissueVolume(receipt.volumeM3);
                              setReissueReason('');
                              setReissueFor(receipt);
                            }}
                          >
                            改口径重出
                          </button>
                        </Show>
                      </td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </div>
        </Show>
      </section>

      {/* ---------------- 升级遗留：补不出批次号的走水单单列 ---------------- */}
      <Show when={unmatched().length > 0}>
        <section class="rounded-xl border border-amber-200 bg-amber-50/60 p-4">
          <h2 class="mb-2 text-[15px] font-semibold text-amber-800">未补批次的走水单（升级时按池号补不出来，单列）</h2>
          <ul class="space-y-1.5 text-xs text-amber-900">
            <For each={unmatched()}>
              {(row) => (
                <li class="rounded border border-amber-200 bg-white px-3 py-2">
                  {pondOf(row.pondId)?.code ?? '（池已删除）'} · 计划 {row.planDate} · {row.volumeM3} m³ · 状态 {row.state}
                  —— 原池号已不存在，请删除该单或重建蒸发池后重排。
                </li>
              )}
            </For>
          </ul>
        </section>
      </Show>

      {/* ---------------- 开立批次 ---------------- */}
      <AppDialog
        open={createOpen()}
        title="开立泵送批次"
        onClose={() => setCreateOpen(false)}
        footer={
          <>
            <button class={BTN_GHOST} onClick={() => setCreateOpen(false)}>
              取消
            </button>
            <button class={BTN_PRIMARY} onClick={() => void submitBatch()}>
              开立
            </button>
          </>
        }
      >
        <div class="grid gap-3 sm:grid-cols-2">
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>蒸发池</span>
            <select class={INPUT} value={batchDraft.pondId} onChange={(event) => setBatchDraft('pondId', event.currentTarget.value)}>
              <option value="">请选择</option>
              <For each={pondStore.state.ponds}>
                {(pond) => (
                  <option value={pond.id}>
                    {pond.code} · {pond.seriesName}
                  </option>
                )}
              </For>
            </select>
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>计划泵送日期</span>
            <input type="date" class={INPUT} value={batchDraft.planDate} onInput={(event) => setBatchDraft('planDate', event.currentTarget.value)} />
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>计划泵送量（m³）</span>
            <input
              type="number"
              step="10"
              class={INPUT}
              value={batchDraft.plannedM3}
              onInput={(event) => setBatchDraft('plannedM3', Number(event.currentTarget.value))}
            />
          </label>
        </div>
        <p class="mt-3 rounded-md bg-slate-50 px-3 py-2 text-xs leading-relaxed text-slate-500">
          批次号按「PB-日期-序号」自动生成；走水单标记已排时若同池同日已有批次会自动复用。
        </p>
      </AppDialog>

      {/* ---------------- 班末回执 ---------------- */}
      <AppDialog
        open={receiptFor() !== null}
        title={`班末回执 · ${receiptFor()?.batchNo ?? ''}`}
        onClose={() => setReceiptFor(null)}
        footer={
          <>
            <button class={BTN_GHOST} onClick={() => setReceiptFor(null)}>
              取消
            </button>
            <button class={BTN_PRIMARY} onClick={() => void submitReceipt()}>
              登记回执
            </button>
          </>
        }
      >
        <p class="mb-3 text-xs text-slate-500">
          {receiptFor()?.pondCode} · 计划 {receiptFor()?.plannedM3} m³ · 已泵 {pumpStore.pumpedOf(receiptFor()?.batchNo ?? '')} m³
          （断链批次当班也照实回执已泵体积，余量等续泵班次再报）
        </p>
        <div class="grid gap-3 sm:grid-cols-2">
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>本班泵送体积（m³）</span>
            <input
              type="number"
              step="10"
              class={INPUT}
              value={receiptDraft.volumeM3}
              onInput={(event) => setReceiptDraft('volumeM3', Number(event.currentTarget.value))}
            />
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>班次日期</span>
            <input type="date" class={INPUT} value={receiptDraft.shiftDate} onInput={(event) => setReceiptDraft('shiftDate', event.currentTarget.value)} />
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>泵送开始</span>
            <input type="time" class={INPUT} value={receiptDraft.periodStart} onInput={(event) => setReceiptDraft('periodStart', event.currentTarget.value)} />
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>泵送结束</span>
            <input type="time" class={INPUT} value={receiptDraft.periodEnd} onInput={(event) => setReceiptDraft('periodEnd', event.currentTarget.value)} />
          </label>
        </div>
      </AppDialog>

      {/* ---------------- 断链 ---------------- */}
      <AppDialog
        open={breakFor() !== null}
        title={`标记断链 · ${breakFor()?.batchNo ?? ''}`}
        width="max-w-lg"
        onClose={() => setBreakFor(null)}
        footer={
          <>
            <button class={BTN_GHOST} onClick={() => setBreakFor(null)}>
              取消
            </button>
            <button class={BTN_PRIMARY} onClick={() => void submitBreak()}>
              确认断链
            </button>
          </>
        }
      >
        <p class="mb-3 text-xs leading-relaxed text-slate-500">
          采用断点续泵：批次号不变，已泵体积保留在回执链上，恢复后从断点接着泵；不作废重开（那会整批重占容量）。
        </p>
        <label class="flex flex-col gap-1 text-[13px] text-slate-600">
          <span>断链原因</span>
          <textarea
            class={INPUT}
            rows="3"
            value={breakNote()}
            onInput={(event) => setBreakNote(event.currentTarget.value)}
            placeholder="如：泵组变频器故障，当班泵送中断"
          />
        </label>
      </AppDialog>

      {/* ---------------- 改口径重出 ---------------- */}
      <AppDialog
        open={reissueFor() !== null}
        title={`改口径重出 · ${reissueFor()?.receiptNo ?? ''}（当前 V${reissueFor()?.version ?? 1}）`}
        width="max-w-lg"
        onClose={() => setReissueFor(null)}
        footer={
          <>
            <button class={BTN_GHOST} onClick={() => setReissueFor(null)}>
              取消
            </button>
            <button class={BTN_PRIMARY} onClick={() => void submitReissue()}>
              作废旧版并重出
            </button>
          </>
        }
      >
        <p class="mb-3 text-xs leading-relaxed text-slate-500">
          旧版回执作废留档，新版版次 +1；用过旧版的走水单（走水中）退回「待排」并按新体积重算计划量，前后两版都可查。
        </p>
        <div class="grid gap-3">
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>新口径体积（m³）</span>
            <input
              type="number"
              step="10"
              class={INPUT}
              value={reissueVolume()}
              onInput={(event) => setReissueVolume(Number(event.currentTarget.value))}
            />
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>作废原因</span>
            <input
              class={INPUT}
              value={reissueReason()}
              onInput={(event) => setReissueReason(event.currentTarget.value)}
              placeholder="如：流量计改口径（DN200→DN250）"
            />
          </label>
        </div>
      </AppDialog>
    </div>
  );
}
