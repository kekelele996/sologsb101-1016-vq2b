/**
 * <ReconcilePanel> 走水对账
 * 排一批走水时两边按「池号 + 批次」对账：泵站段收到生效回执（收货）、
 * 调度端确认水位落到位，走水单才进「走水中」。
 */
import { For, Show, createSignal } from 'solid-js';
import AppDialog from '../common/AppDialog';
import { usePumpStore } from '../../stores/pumpStore';
import { usePondStore } from '../../stores/pondStore';
import type { PumpReceipt } from '../../types/pumpReceipt';
import type { Schedule } from '../../types/schedule';

const BTN_GHOST =
  'rounded-md border border-slate-300 bg-white px-3.5 py-1.5 text-sm text-slate-700 transition hover:bg-slate-100';

export default function ReconcilePanel() {
  const pump = usePumpStore();
  const ponds = usePondStore();
  const [target, setTarget] = createSignal<Schedule | null>(null);
  const [selectedReceipt, setSelectedReceipt] = createSignal<string>('');

  const pondLabel = (pondId: string): string => {
    const pond = ponds.state.ponds.find((item) => item.id === pondId);
    return pond === undefined ? '（池已删除）' : `${pond.code} · ${pond.seriesName}`;
  };

  const pending = () => pump.reconcileCandidates();
  const reconciled = () => pump.state.schedules.filter((row) => row.receiptId !== '');

  const openReconcile = (schedule: Schedule): void => {
    const options = pump.candidatesForSchedule(schedule);
    setTarget(schedule);
    setSelectedReceipt(options[0]?.id ?? '');
  };

  const confirm = async (): Promise<void> => {
    const schedule = target();
    if (schedule === null) return;
    if (selectedReceipt() === '') {
      pump.setMessage('该池暂时没有可对账的生效回执（需水位确认落到位）');
      return;
    }
    await pump.reconcile(schedule.id, selectedReceipt());
    setTarget(null);
  };

  const receiptOf = (schedule: Schedule): PumpReceipt | undefined =>
    pump.state.receipts.find((receipt) => receipt.id === schedule.receiptId);

  const fmtTime = (iso: string): string => (iso === '' ? '—' : iso.replace('T', ' ').slice(0, 16));

  return (
    <section class="rounded-xl border border-slate-200 bg-white p-4">
      <header class="mb-3">
        <h2 class="text-[15px] font-semibold text-slate-800">走水对账（池号 + 批次）</h2>
        <p class="mt-0.5 text-xs text-slate-500">
          泵站段收到生效回执、调度端确认水位落到位，对账通过走水单才进「走水中」；回执作废后自动退回「待排」。
        </p>
      </header>

      <div class="grid gap-4 lg:grid-cols-2">
        {/* 待对账 */}
        <div>
          <h3 class="mb-2 text-[13px] font-semibold text-slate-600">待对账（{pending().length}）</h3>
          <Show
            when={pending().length > 0}
            fallback={<p class="rounded-lg border border-dashed border-slate-200 px-3 py-5 text-center text-xs text-slate-400">没有待对账的走水单。</p>}
          >
            <ul class="space-y-2">
              <For each={pending()}>
                {(schedule) => {
                  const options = () => pump.candidatesForSchedule(schedule);
                  const assignment = () => pump.assignmentOf(schedule.id);
                  return (
                    <li class="rounded-lg border border-slate-200 px-3.5 py-3">
                      <div class="flex flex-wrap items-center justify-between gap-2">
                        <div>
                          <p class="text-sm font-medium text-slate-800">{pondLabel(schedule.pondId)}</p>
                          <p class="text-xs text-slate-500">
                            计划日 {schedule.planDate} · 计划量 <span class="tabular-nums">{schedule.volumeM3}</span> m³
                          </p>
                        </div>
                        <button
                          class="rounded-md border border-brine-300 bg-brine-50 px-2.5 py-1 text-xs text-brine-700 transition hover:bg-brine-100 disabled:opacity-50"
                          disabled={options().length === 0}
                          onClick={() => openReconcile(schedule)}
                        >
                          {options().length === 0 ? '无可用回执' : '选择回执对账'}
                        </button>
                      </div>
                      <p class="mt-1 text-[11px] text-slate-400">
                        同池号生效且水位到位回执 {options().length} 张
                        <Show when={assignment()?.queued}>
                          <span class="ml-2 rounded bg-amber-100 px-1 py-px text-amber-700">
                            容量排队至 {assignment()?.bucketDate}
                          </span>
                        </Show>
                        <Show when={assignment()?.infeasible}>
                          <span class="ml-2 rounded bg-rose-100 px-1 py-px text-rose-700">容量不足</span>
                        </Show>
                      </p>
                    </li>
                  );
                }}
              </For>
            </ul>
          </Show>
        </div>

        {/* 已对账 */}
        <div>
          <h3 class="mb-2 text-[13px] font-semibold text-slate-600">已对账（{reconciled().length}）</h3>
          <Show
            when={reconciled().length > 0}
            fallback={<p class="rounded-lg border border-dashed border-slate-200 px-3 py-5 text-center text-xs text-slate-400">还没有对账记录。</p>}
          >
            <ul class="space-y-2">
              <For each={reconciled()}>
                {(schedule) => {
                  const receipt = receiptOf(schedule);
                  const voided = receipt?.state === '已作废';
                  return (
                    <li class={`rounded-lg border px-3.5 py-3 ${voided ? 'border-rose-300 bg-rose-50/50' : 'border-emerald-200 bg-emerald-50/40'}`}>
                      <div class="flex flex-wrap items-center justify-between gap-2">
                        <div>
                          <p class="text-sm font-medium text-slate-800">{pondLabel(schedule.pondId)}</p>
                          <p class="text-xs text-slate-500">
                            批次 {schedule.batchCode} · {receipt?.code ?? '（回执缺失）'} V{schedule.receiptVersion}
                          </p>
                        </div>
                        <div class="text-right">
                          <p class="text-xs text-slate-600">
                            实测 <span class="tabular-nums font-medium">{receipt?.volumeM3 ?? '—'}</span> m³
                          </p>
                          <p class={`text-[11px] ${schedule.state === '走水中' ? 'text-amber-700' : 'text-emerald-700'}`}>
                            {schedule.state}
                          </p>
                        </div>
                      </div>
                      <div class="mt-1.5 flex items-center justify-between">
                        <span class="text-[11px] text-slate-400">对账时间 {fmtTime(schedule.reconciledAt)}</span>
                        <Show when={schedule.state !== '已出卤'}>
                          <button
                            class="text-[11px] text-slate-500 hover:underline"
                            onClick={() => void pump.unlink(schedule.id)}
                            title="解除对账，走水单退回待排"
                          >
                            解绑退回待排
                          </button>
                        </Show>
                      </div>
                      <Show when={voided}>
                        <p class="mt-1 text-[11px] text-rose-600">所用回执已被改口径重出，该单应退回待排按新体积重算。</p>
                      </Show>
                    </li>
                  );
                }}
              </For>
            </ul>
          </Show>
        </div>
      </div>

      {/* 选择回执对账 */}
      <AppDialog
        open={target() !== null}
        title={`走水对账 · ${target() === null ? '' : pondLabel(target()!.pondId)}`}
        width="max-w-xl"
        onClose={() => setTarget(null)}
        footer={
          <>
            <button class={BTN_GHOST} onClick={() => setTarget(null)}>
              取消
            </button>
            <button
              class="rounded-md bg-brine-600 px-3.5 py-1.5 text-sm font-medium text-white transition hover:bg-brine-700 disabled:opacity-50"
              disabled={selectedReceipt() === ''}
              onClick={() => void confirm()}
            >
              确认对账，进入走水中
            </button>
          </>
        }
      >
        <Show when={target() !== null} fallback={<span />}>
          <p class="mb-3 text-xs leading-relaxed text-slate-500">
            计划日 {(target() as Schedule).planDate} · 计划量 <span class="tabular-nums">{(target() as Schedule).volumeM3}</span> m³。
            下列回执均与该池「池号」一致且水位已落到位，请按「批次」核对后选择。
          </p>
          <ul class="space-y-2">
            <For each={pump.candidatesForSchedule(target() as Schedule)}>
              {(receipt) => {
                const check = () => pump.checkPair(target() as Schedule, receipt);
                return (
                  <li>
                    <label
                      class={`flex cursor-pointer items-start gap-3 rounded-lg border px-3.5 py-2.5 text-sm transition ${
                        selectedReceipt() === receipt.id ? 'border-brine-500 bg-brine-50 ring-1 ring-brine-400' : 'border-slate-200 hover:bg-slate-50'
                      }`}
                    >
                      <input
                        type="radio"
                        name="receipt-choice"
                        class="mt-1"
                        checked={selectedReceipt() === receipt.id}
                        onChange={() => setSelectedReceipt(receipt.id)}
                      />
                      <span class="flex-1">
                        <span class="flex flex-wrap items-center justify-between gap-2">
                          <span class="font-medium text-slate-800">
                            {receipt.code} <span class="text-xs font-normal text-slate-500">V{receipt.version}</span>
                          </span>
                          <span class="tabular-nums text-slate-700">{receipt.volumeM3} m³</span>
                        </span>
                        <span class="mt-0.5 block text-xs text-slate-500">
                          批次 {receipt.batchCode} · {receipt.shift} · 落位 {receipt.levelAfterCm} cm ·
                          泵运止 {receipt.endTime.replace('T', ' ').slice(0, 16)}
                        </span>
                        <Show when={!check().ok}>
                          <span class="mt-0.5 block text-[11px] text-rose-600">{check().reason}</span>
                        </Show>
                      </span>
                    </label>
                  </li>
                );
              }}
            </For>
          </ul>
          <Show when={pump.candidatesForSchedule(target() as Schedule).length === 0}>
            <p class="rounded-lg border border-dashed border-amber-300 bg-amber-50 px-3 py-3 text-center text-xs text-amber-700">
              没有同池号且水位落到位的生效回执：请先在泵站班末补录回执并确认水位。
            </p>
          </Show>
        </Show>
      </AppDialog>
    </section>
  );
}
