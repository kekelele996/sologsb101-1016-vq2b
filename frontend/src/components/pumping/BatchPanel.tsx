/**
 * <BatchPanel> 泵送批次管理
 * 按批次开机：批次号、开机日期、班次、计划量；已泵量由生效回执分段累计（断点续泵）。
 */
import { For, Show, createSignal } from 'solid-js';
import { createStore } from 'solid-js/store';
import AppDialog from '../common/AppDialog';
import { usePumpStore } from '../../stores/pumpStore';
import { PUMP_BATCH_STATE_OPTIONS, SHIFT_OPTIONS, type PumpBatch, type PumpBatchDraft } from '../../types/pumpBatch';
import { today } from '../../utils/id';

const INPUT =
  'w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm outline-none focus:border-brine-500 focus:ring-1 focus:ring-brine-400';
const BTN_PRIMARY =
  'rounded-md bg-brine-600 px-3.5 py-1.5 text-sm font-medium text-white transition hover:bg-brine-700 disabled:opacity-50';
const BTN_GHOST =
  'rounded-md border border-slate-300 bg-white px-3.5 py-1.5 text-sm text-slate-700 transition hover:bg-slate-100';
const BTN_DANGER = 'rounded-md bg-rose-600 px-3.5 py-1.5 text-sm font-medium text-white transition hover:bg-rose-700';

function emptyDraft(code: string): PumpBatchDraft {
  return { code, startDate: today(), shift: '早班', plannedVolumeM3: 800, state: '在泵', note: '' };
}

export default function BatchPanel() {
  const store = usePumpStore();
  const [dialogOpen, setDialogOpen] = createSignal(false);
  const [editingId, setEditingId] = createSignal<string | null>(null);
  const [deleting, setDeleting] = createSignal<PumpBatch | null>(null);
  const [draft, setDraft] = createStore<PumpBatchDraft>(emptyDraft(''));

  const openCreate = (): void => {
    setEditingId(null);
    setDraft(emptyDraft(store.suggestBatchCode(today())));
    setDialogOpen(true);
  };

  const openEdit = (batch: PumpBatch): void => {
    setEditingId(batch.id);
    setDraft({
      code: batch.code,
      startDate: batch.startDate,
      shift: batch.shift,
      plannedVolumeM3: batch.plannedVolumeM3,
      state: batch.state,
      note: batch.note,
    });
    setDialogOpen(true);
  };

  const submit = async (): Promise<void> => {
    if (draft.code.trim() === '') {
      store.setMessage('批次号不能为空');
      return;
    }
    if (!(draft.plannedVolumeM3 > 0)) {
      store.setMessage('计划泵送量必须大于 0');
      return;
    }
    if (editingId() === null) {
      await store.createBatch({ ...draft });
    } else {
      await store.updateBatch(editingId() as string, { ...draft });
    }
    setDialogOpen(false);
  };

  const confirmDelete = async (): Promise<void> => {
    const batch = deleting();
    if (batch === null) return;
    await store.deleteBatch(batch.id);
    setDeleting(null);
  };

  return (
    <section class="rounded-xl border border-slate-200 bg-white p-4">
      <header class="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 class="text-[15px] font-semibold text-slate-800">泵送批次（按批次开机）</h2>
        <button class={BTN_PRIMARY} onClick={openCreate}>
          + 批次开机
        </button>
      </header>

      <Show
        when={store.state.batches.length > 0}
        fallback={<p class="rounded-lg border border-dashed border-slate-200 px-4 py-6 text-center text-sm text-slate-400">还没有泵送批次，点击「批次开机」建立第一个批次。</p>}
      >
        <div class="overflow-x-auto">
          <table class="w-full min-w-[760px] border-collapse text-sm">
            <thead>
              <tr class="border-b border-slate-200 bg-slate-50 text-left text-xs text-slate-500">
                <th class="px-3 py-2">批次号</th>
                <th class="px-3 py-2">开机日 / 班次</th>
                <th class="px-3 py-2 text-right">计划量</th>
                <th class="px-3 py-2 text-right">已泵（回执累计）</th>
                <th class="px-3 py-2 w-40">进度</th>
                <th class="px-3 py-2">状态</th>
                <th class="px-3 py-2">备注</th>
                <th class="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              <For each={store.state.batches}>
                {(batch) => {
                  const progress = () => store.progressOf(batch.id);
                  const receiptCount = () => store.receiptsOfBatch(batch.id).length;
                  return (
                    <tr class="border-b border-slate-100 align-middle hover:bg-slate-50/60">
                      <td class="px-3 py-2.5 font-medium text-slate-800">{batch.code}</td>
                      <td class="px-3 py-2.5 text-xs text-slate-600">
                        {batch.startDate} · {batch.shift}
                      </td>
                      <td class="px-3 py-2.5 text-right tabular-nums">{batch.plannedVolumeM3}</td>
                      <td class="px-3 py-2.5 text-right tabular-nums text-brine-700">
                        {progress().pumpedM3}
                        <span class="ml-1 text-[11px] font-normal text-slate-400">{receiptCount()} 张回执</span>
                      </td>
                      <td class="px-3 py-2.5">
                        <div class="flex items-center gap-2">
                          <div class="h-1.5 w-24 overflow-hidden rounded-full bg-slate-100">
                            <div
                              class={`h-full rounded-full ${progress().done ? 'bg-emerald-500' : 'bg-brine-600'}`}
                              style={{ width: `${progress().pct}%` }}
                            />
                          </div>
                          <span class="w-11 text-right text-xs tabular-nums text-slate-500">{progress().pct}%</span>
                        </div>
                      </td>
                      <td class="px-3 py-2.5">
                        <span
                          class={`rounded border px-2 py-0.5 text-[11px] ${
                            batch.state === '已完结'
                              ? 'border-emerald-300 bg-emerald-50 text-emerald-700'
                              : 'border-amber-300 bg-amber-50 text-amber-700'
                          }`}
                        >
                          {batch.state}
                        </span>
                      </td>
                      <td class="max-w-[220px] truncate px-3 py-2.5 text-xs text-slate-500" title={batch.note}>
                        {batch.note === '' ? '—' : batch.note}
                      </td>
                      <td class="px-3 py-2.5 text-right">
                        <button class="mr-2 text-xs text-brine-700 hover:underline" onClick={() => openEdit(batch)}>
                          编辑
                        </button>
                        <button class="text-xs text-rose-600 hover:underline" onClick={() => setDeleting(batch)}>
                          删除
                        </button>
                      </td>
                    </tr>
                  );
                }}
              </For>
            </tbody>
          </table>
        </div>
      </Show>

      <AppDialog
        open={dialogOpen()}
        title={editingId() === null ? '批次开机' : '编辑泵送批次'}
        onClose={() => setDialogOpen(false)}
        footer={
          <>
            <button class={BTN_GHOST} onClick={() => setDialogOpen(false)}>
              取消
            </button>
            <button class={BTN_PRIMARY} onClick={() => void submit()}>
              保存
            </button>
          </>
        }
      >
        <div class="grid gap-3 sm:grid-cols-2">
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>批次号</span>
            <input class={INPUT} value={draft.code} onInput={(event) => setDraft('code', event.currentTarget.value)} />
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>开机日期</span>
            <input type="date" class={INPUT} value={draft.startDate} onInput={(event) => setDraft('startDate', event.currentTarget.value)} />
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>班次</span>
            <select class={INPUT} value={draft.shift} onChange={(event) => setDraft('shift', event.currentTarget.value)}>
              <For each={[...SHIFT_OPTIONS]}>{(shift) => <option value={shift}>{shift}</option>}</For>
            </select>
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>计划泵送量（m³）</span>
            <input
              type="number"
              min="1"
              step="50"
              class={INPUT}
              value={draft.plannedVolumeM3}
              onInput={(event) => setDraft('plannedVolumeM3', Number(event.currentTarget.value))}
            />
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>状态</span>
            <select class={INPUT} value={draft.state} onChange={(event) => setDraft('state', event.currentTarget.value as PumpBatch['state'])}>
              <For each={[...PUMP_BATCH_STATE_OPTIONS]}>{(state) => <option value={state}>{state}</option>}</For>
            </select>
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600 sm:col-span-2">
            <span>备注（断链经过等）</span>
            <input class={INPUT} value={draft.note} onInput={(event) => setDraft('note', event.currentTarget.value)} placeholder="如：夜班断电断链，按断点续泵口径中班接着泵" />
          </label>
        </div>
      </AppDialog>

      <AppDialog
        open={deleting() !== null}
        title="确认删除泵送批次？"
        width="max-w-lg"
        onClose={() => setDeleting(null)}
        footer={
          <>
            <button class={BTN_GHOST} onClick={() => setDeleting(null)}>
              取消
            </button>
            <button class={BTN_DANGER} onClick={() => void confirmDelete()}>
              确认删除
            </button>
          </>
        }
      >
        <p class="text-sm leading-relaxed text-slate-600">
          将删除批次「{deleting()?.code}」及其全部班末回执；用过这些回执对账的走水单会退回「待排」。
          断点续泵口径下请谨慎删除在泵批次。
        </p>
      </AppDialog>
    </section>
  );
}
