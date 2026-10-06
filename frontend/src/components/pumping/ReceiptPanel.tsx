/**
 * <ReceiptPanel> 泵站班末回执
 * 班末把泵送体积与时段报给调度端；水位确认落到位后回执才可用于对账。
 * 改口径重出：原版作废留档（不删除）、版本号递增，用过旧版的走水单退回待排。
 */
import { For, Show, createMemo, createSignal } from 'solid-js';
import { createStore } from 'solid-js/store';
import AppDialog from '../common/AppDialog';
import { usePumpStore } from '../../stores/pumpStore';
import { usePondStore } from '../../stores/pondStore';
import { SHIFT_OPTIONS } from '../../types/pumpBatch';
import type { PumpReceipt, PumpReceiptDraft, PumpReceiptReissueDraft } from '../../types/pumpReceipt';
import { today } from '../../utils/id';

const INPUT =
  'w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm outline-none focus:border-brine-500 focus:ring-1 focus:ring-brine-400';
const BTN_PRIMARY =
  'rounded-md bg-brine-600 px-3.5 py-1.5 text-sm font-medium text-white transition hover:bg-brine-700 disabled:opacity-50';
const BTN_GHOST =
  'rounded-md border border-slate-300 bg-white px-3.5 py-1.5 text-sm text-slate-700 transition hover:bg-slate-100';

function defaultTime(date: string, hours: number): string {
  return `${date}T${String(hours).padStart(2, '0')}:00`;
}

function emptyDraft(batchId: string, pondId: string, code: string): PumpReceiptDraft {
  return {
    code,
    batchId,
    pondId,
    volumeM3: 500,
    startTime: defaultTime(today(), 0),
    endTime: defaultTime(today(), 8),
    shift: '早班',
    levelAfterCm: 35,
    levelConfirmed: false,
  };
}

const RECEIPT_STYLE: Record<PumpReceipt['state'], string> = {
  生效: 'border-emerald-300 bg-emerald-50 text-emerald-700',
  已作废: 'border-rose-300 bg-rose-50 text-rose-700',
};

export default function ReceiptPanel() {
  const store = usePumpStore();
  const ponds = usePondStore();

  const [createOpen, setCreateOpen] = createSignal(false);
  const [reissueTarget, setReissueTarget] = createSignal<PumpReceipt | null>(null);
  const [chainTarget, setChainTarget] = createSignal<PumpReceipt | null>(null);
  const [draft, setDraft] = createStore<PumpReceiptDraft>(emptyDraft('', '', ''));
  const [reissueDraft, setReissueDraft] = createStore<PumpReceiptReissueDraft>({
    volumeM3: 0,
    startTime: '',
    endTime: '',
    levelAfterCm: 0,
    levelConfirmed: true,
    voidReason: '',
  });

  const pondLabel = (pondId: string): string => {
    const pond = ponds.state.ponds.find((item) => item.id === pondId);
    return pond === undefined ? '（池已删除）' : `${pond.code} · ${pond.seriesName}`;
  };

  const filtered = createMemo<PumpReceipt[]>(() => {
    const current = store.receiptFilters();
    return store.state.receipts.filter((receipt) => {
      if (current.batchId !== 'all' && receipt.batchId !== current.batchId) return false;
      if (current.state !== 'all' && receipt.state !== current.state) return false;
      return true;
    });
  });

  const openCreate = (): void => {
    const batch = store.state.batches.find((item) => item.state === '在泵') ?? store.state.batches[0];
    const pondId = ponds.state.ponds[0]?.id ?? '';
    setDraft(emptyDraft(batch?.id ?? '', pondId, store.suggestReceiptCode(today())));
    setCreateOpen(true);
  };

  const submitCreate = async (): Promise<void> => {
    if (draft.batchId === '') {
      store.setMessage('请先建立泵送批次，再补录回执');
      return;
    }
    if (draft.pondId === '') {
      store.setMessage('请选择收货蒸发池（对账键：池号）');
      return;
    }
    if (!(draft.volumeM3 > 0)) {
      store.setMessage('泵送体积必须大于 0');
      return;
    }
    await store.addReceipt({ ...draft, code: draft.code.trim() });
    setCreateOpen(false);
  };

  const openReissue = (receipt: PumpReceipt): void => {
    setReissueTarget(receipt);
    setReissueDraft({
      volumeM3: receipt.volumeM3,
      startTime: receipt.startTime.slice(0, 16),
      endTime: receipt.endTime.slice(0, 16),
      levelAfterCm: receipt.levelAfterCm,
      levelConfirmed: receipt.levelConfirmed,
      voidReason: '',
    });
  };

  const submitReissue = async (): Promise<void> => {
    const target = reissueTarget();
    if (target === null) return;
    if (!(reissueDraft.volumeM3 > 0)) {
      store.setMessage('新回执体积必须大于 0');
      return;
    }
    await store.reissue(target.id, {
      ...reissueDraft,
      startTime: reissueDraft.startTime.length === 16 ? `${reissueDraft.startTime}:00` : reissueDraft.startTime,
      endTime: reissueDraft.endTime.length === 16 ? `${reissueDraft.endTime}:00` : reissueDraft.endTime,
    });
    setReissueTarget(null);
  };

  const fmtTime = (iso: string): string => iso.replace('T', ' ').slice(0, 16);

  return (
    <section class="rounded-xl border border-slate-200 bg-white p-4">
      <header class="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 class="text-[15px] font-semibold text-slate-800">泵站班末回执</h2>
          <p class="mt-0.5 text-xs text-slate-500">班末报泵送体积与时段；调度端确认水位落到位后才能按池号 + 批次对账。</p>
        </div>
        <button class={BTN_PRIMARY} onClick={openCreate} disabled={store.state.batches.length === 0 || ponds.state.ponds.length === 0}>
          + 班末补录回执
        </button>
      </header>

      <div class="mb-3 flex flex-wrap items-center gap-3 rounded-lg border border-slate-200 bg-slate-50/70 px-3.5 py-2.5 text-[13px]">
        <label class="flex items-center gap-1.5 text-slate-600">
          批次
          <select
            class="rounded-md border border-slate-300 bg-white px-2 py-1 text-sm"
            value={store.receiptFilters().batchId}
            onChange={(event) => store.patchReceiptFilters({ batchId: event.currentTarget.value })}
          >
            <option value="all">全部批次</option>
            <For each={store.state.batches}>
              {(batch) => <option value={batch.id}>{batch.code}</option>}
            </For>
          </select>
        </label>
        <label class="flex items-center gap-1.5 text-slate-600">
          状态
          <select
            class="rounded-md border border-slate-300 bg-white px-2 py-1 text-sm"
            value={store.receiptFilters().state}
            onChange={(event) =>
              store.patchReceiptFilters({ state: event.currentTarget.value as PumpReceipt['state'] | 'all' })
            }
          >
            <option value="all">全部</option>
            <option value="生效">生效</option>
            <option value="已作废">已作废</option>
          </select>
        </label>
        <button
          class="rounded-md border border-slate-300 bg-white px-3 py-1 text-sm text-slate-700 hover:bg-slate-100"
          onClick={() => store.resetReceiptFilters()}
        >
          重置
        </button>
        <span class="rounded-full bg-brine-50 px-2.5 py-0.5 text-xs text-brine-700">命中 {filtered().length} 张</span>
      </div>

      <Show
        when={filtered().length > 0}
        fallback={<p class="rounded-lg border border-dashed border-slate-200 px-4 py-6 text-center text-sm text-slate-400">当前筛选下没有回执。</p>}
      >
        <ul class="space-y-2">
          <For each={filtered()}>
            {(receipt) => (
              <li class="flex flex-wrap items-center gap-3 rounded-lg border border-slate-200 px-3.5 py-3">
                <div class="min-w-[180px] flex-1">
                  <p class="text-sm font-medium text-slate-800">
                    {receipt.code}
                    <span class="ml-2 rounded bg-slate-100 px-1.5 py-0.5 text-[11px] font-normal text-slate-500">V{receipt.version}</span>
                  </p>
                  <p class="text-xs text-slate-500">
                    {pondLabel(receipt.pondId)} · 批次 {receipt.batchCode} · {receipt.shift}
                  </p>
                </div>
                <div class="text-xs text-slate-600">
                  <p>
                    泵送量 <span class="tabular-nums font-medium text-slate-800">{receipt.volumeM3}</span> m³
                  </p>
                  <p class="text-slate-400">
                    {fmtTime(receipt.startTime)} – {fmtTime(receipt.endTime)}
                  </p>
                </div>
                <div class="text-xs text-slate-600">
                  <p>
                    落位水位 <span class="tabular-nums">{receipt.levelAfterCm}</span> cm
                  </p>
                  <p>
                    {receipt.levelConfirmed ? (
                      <span class="text-emerald-700">✓ 水位已落到位</span>
                    ) : (
                      <span class="text-amber-700">水位待确认</span>
                    )}
                  </p>
                </div>
                <span class={`rounded border px-2 py-0.5 text-[11px] ${RECEIPT_STYLE[receipt.state]}`}>{receipt.state}</span>
                <div class="flex items-center gap-2">
                  <Show when={receipt.state === '生效' || receipt.supersededById !== '' || receipt.reissuesId !== ''}>
                    <button class="text-xs text-slate-600 hover:underline" onClick={() => setChainTarget(receipt)}>
                      版本链
                    </button>
                  </Show>
                  <Show when={receipt.state === '生效'}>
                    <button class="text-xs text-amber-700 hover:underline" onClick={() => openReissue(receipt)}>
                      改口径重出
                    </button>
                  </Show>
                  <Show when={receipt.state === '已作废'}>
                    <span class="max-w-[220px] truncate text-[11px] text-rose-500" title={receipt.voidReason}>
                      {receipt.voidReason}
                    </span>
                  </Show>
                </div>
              </li>
            )}
          </For>
        </ul>
      </Show>

      {/* 班末补录回执 */}
      <AppDialog
        open={createOpen()}
        title="班末补录回执"
        onClose={() => setCreateOpen(false)}
        footer={
          <>
            <button class={BTN_GHOST} onClick={() => setCreateOpen(false)}>
              取消
            </button>
            <button class={BTN_PRIMARY} onClick={() => void submitCreate()}>
              补录
            </button>
          </>
        }
      >
        <div class="grid gap-3 sm:grid-cols-2">
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>回执单号</span>
            <input class={INPUT} value={draft.code} onInput={(event) => setDraft('code', event.currentTarget.value)} />
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>泵送批次</span>
            <select class={INPUT} value={draft.batchId} onChange={(event) => setDraft('batchId', event.currentTarget.value)}>
              <option value="">请选择</option>
              <For each={store.state.batches}>
                {(batch) => <option value={batch.id}>{batch.code}（{batch.startDate}）</option>}
              </For>
            </select>
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>收货蒸发池（池号）</span>
            <select class={INPUT} value={draft.pondId} onChange={(event) => setDraft('pondId', event.currentTarget.value)}>
              <option value="">请选择</option>
              <For each={ponds.state.ponds}>
                {(pond) => (
                  <option value={pond.id}>
                    {pond.code} · {pond.seriesName}
                  </option>
                )}
              </For>
            </select>
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>班次</span>
            <select class={INPUT} value={draft.shift} onChange={(event) => setDraft('shift', event.currentTarget.value)}>
              <For each={[...SHIFT_OPTIONS]}>{(shift) => <option value={shift}>{shift}</option>}</For>
            </select>
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>班末泵送体积（m³）</span>
            <input
              type="number"
              min="1"
              step="10"
              class={INPUT}
              value={draft.volumeM3}
              onInput={(event) => setDraft('volumeM3', Number(event.currentTarget.value))}
            />
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>落位水位（cm）</span>
            <input
              type="number"
              min="0"
              step="1"
              class={INPUT}
              value={draft.levelAfterCm}
              onInput={(event) => setDraft('levelAfterCm', Number(event.currentTarget.value))}
            />
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>泵运起</span>
            <input
              type="datetime-local"
              class={INPUT}
              value={draft.startTime.slice(0, 16)}
              onInput={(event) => setDraft('startTime', event.currentTarget.value)}
            />
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>泵运止</span>
            <input
              type="datetime-local"
              class={INPUT}
              value={draft.endTime.slice(0, 16)}
              onInput={(event) => setDraft('endTime', event.currentTarget.value)}
            />
          </label>
          <label class="flex items-center gap-2 text-[13px] text-slate-600 sm:col-span-2">
            <input
              type="checkbox"
              checked={draft.levelConfirmed}
              onChange={(event) => setDraft('levelConfirmed', event.currentTarget.checked)}
            />
            调度端已确认水位落到位（勾选后该回执才能参与对账）
          </label>
        </div>
      </AppDialog>

      {/* 改口径重出 */}
      <AppDialog
        open={reissueTarget() !== null}
        title={`改口径重出回执 · ${reissueTarget()?.code ?? ''}`}
        width="max-w-lg"
        onClose={() => setReissueTarget(null)}
        footer={
          <>
            <button class={BTN_GHOST} onClick={() => setReissueTarget(null)}>
              取消
            </button>
            <button class={BTN_PRIMARY} onClick={() => void submitReissue()}>
              重出并作废原版
            </button>
          </>
        }
      >
        <p class="mb-3 rounded-md bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-800">
          原回执（V{reissueTarget()?.version}，{reissueTarget()?.volumeM3} m³）将置为「已作废」并永久留档；
          新版本号为 V{(reissueTarget()?.version ?? 1) + 1}，用过原版对账的走水单全部退回「待排」，按新体积重新对账。
        </p>
        <div class="grid gap-3 sm:grid-cols-2">
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>新泵送体积（m³）</span>
            <input
              type="number"
              step="10"
              class={INPUT}
              value={reissueDraft.volumeM3}
              onInput={(event) => setReissueDraft('volumeM3', Number(event.currentTarget.value))}
            />
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>新落位水位（cm）</span>
            <input
              type="number"
              step="1"
              class={INPUT}
              value={reissueDraft.levelAfterCm}
              onInput={(event) => setReissueDraft('levelAfterCm', Number(event.currentTarget.value))}
            />
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>泵运起</span>
            <input
              type="datetime-local"
              class={INPUT}
              value={reissueDraft.startTime}
              onInput={(event) => setReissueDraft('startTime', event.currentTarget.value)}
            />
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>泵运止</span>
            <input
              type="datetime-local"
              class={INPUT}
              value={reissueDraft.endTime}
              onInput={(event) => setReissueDraft('endTime', event.currentTarget.value)}
            />
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600 sm:col-span-2">
            <span>改口径 / 作废原因</span>
            <input
              class={INPUT}
              value={reissueDraft.voidReason}
              onInput={(event) => setReissueDraft('voidReason', event.currentTarget.value)}
              placeholder="如：流量计口径由班初读数改为班末罐量复核"
            />
          </label>
          <label class="flex items-center gap-2 text-[13px] text-slate-600 sm:col-span-2">
            <input
              type="checkbox"
              checked={reissueDraft.levelConfirmed}
              onChange={(event) => setReissueDraft('levelConfirmed', event.currentTarget.checked)}
            />
            新版回执水位已确认落到位
          </label>
        </div>
      </AppDialog>

      {/* 版本链 */}
      <AppDialog
        open={chainTarget() !== null}
        title={`回执版本链 · ${chainTarget()?.code.replace(/-V\d+$/, '') ?? ''}`}
        width="max-w-lg"
        onClose={() => setChainTarget(null)}
        footer={<button class={BTN_GHOST} onClick={() => setChainTarget(null)}>关闭</button>}
      >
        <ul class="space-y-2">
          <For each={chainTarget() === null ? [] : store.chainOf((chainTarget() as PumpReceipt).id)}>
            {(item) => (
              <li class={`rounded-lg border px-3.5 py-2.5 text-sm ${item.state === '已作废' ? 'border-rose-200 bg-rose-50/60' : 'border-emerald-200 bg-emerald-50/60'}`}>
                <div class="flex flex-wrap items-center justify-between gap-2">
                  <span class="font-medium text-slate-800">
                    {item.code} <span class="text-xs text-slate-500">V{item.version}</span>
                  </span>
                  <span class={`rounded border px-2 py-0.5 text-[11px] ${RECEIPT_STYLE[item.state]}`}>{item.state}</span>
                </div>
                <p class="mt-1 text-xs text-slate-600">
                  <span class="tabular-nums">{item.volumeM3}</span> m³ · 落位 {item.levelAfterCm} cm ·{' '}
                  {item.levelConfirmed ? '水位到位' : '水位待确认'} · {fmtTime(item.endTime)}
                </p>
                <Show when={item.voidReason !== ''}>
                  <p class="mt-1 text-[11px] text-rose-600">作废原因：{item.voidReason}</p>
                </Show>
              </li>
            )}
          </For>
        </ul>
        <p class="mt-3 text-xs text-slate-500">前后两版都永久留档可查，不做物理删除。</p>
      </AppDialog>
    </section>
  );
}
