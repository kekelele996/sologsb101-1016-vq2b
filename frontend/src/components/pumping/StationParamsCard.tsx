/**
 * <StationParamsCard> 泵站参数卡：单日泵送容量上限 + 断链处置口径
 * 断链口径固定为「断点续泵」：同批沿用、回执分段累计、容量只在开机日占一次。
 */
import { Show, createSignal } from 'solid-js';
import type { PumpStationDraft } from '../../types/pumpStation';
import { usePumpStore } from '../../stores/pumpStore';

const INPUT =
  'w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm outline-none focus:border-brine-500 focus:ring-1 focus:ring-brine-400';
const BTN_PRIMARY =
  'rounded-md bg-brine-600 px-3.5 py-1.5 text-sm font-medium text-white transition hover:bg-brine-700 disabled:opacity-50';

export default function StationParamsCard() {
  const store = usePumpStore();
  const [editing, setEditing] = createSignal(false);
  const [name, setName] = createSignal(store.state.station.name);
  const [capacity, setCapacity] = createSignal(store.state.station.dailyCapacityM3);

  const startEdit = (): void => {
    setName(store.state.station.name);
    setCapacity(store.state.station.dailyCapacityM3);
    setEditing(true);
  };

  const save = async (): Promise<void> => {
    const draft: PumpStationDraft = { name: name(), dailyCapacityM3: Number(capacity()) };
    if (!(draft.dailyCapacityM3 > 0)) {
      store.setMessage('日泵送容量上限必须大于 0');
      return;
    }
    await store.saveStation(draft);
    setEditing(false);
  };

  const usage = store.todayUsage();
  const usedPct = (): number =>
    usage.capacityM3 <= 0 ? 0 : Math.min(100, Math.round((usage.usedM3 / usage.capacityM3) * 1000) / 10);

  return (
    <section class="rounded-xl border border-slate-200 bg-white p-4">
      <header class="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 class="text-[15px] font-semibold text-slate-800">泵站参数与今日档位</h2>
        <Show when={!editing()} fallback={<span />}>
          <button class="text-xs text-brine-700 hover:underline" onClick={startEdit}>
            编辑参数
          </button>
        </Show>
      </header>

      <Show
        when={editing()}
        fallback={
          <div class="grid gap-4 md:grid-cols-[1fr_1.4fr]">
            <dl class="space-y-2 text-sm">
              <div class="flex gap-2">
                <dt class="w-28 shrink-0 text-slate-500">泵站名称</dt>
                <dd class="font-medium text-slate-800">{store.state.station.name}</dd>
              </div>
              <div class="flex gap-2">
                <dt class="w-28 shrink-0 text-slate-500">单日泵送容量</dt>
                <dd class="font-medium text-slate-800">
                  <span class="tabular-nums">{store.state.station.dailyCapacityM3}</span> m³/日
                </dd>
              </div>
              <div class="flex gap-2">
                <dt class="w-28 shrink-0 text-slate-500">断链处置口径</dt>
                <dd>
                  <span class="rounded border border-brine-300 bg-brine-50 px-2 py-0.5 text-xs text-brine-700">
                    {store.state.station.chainPolicy}
                  </span>
                </dd>
              </div>
            </dl>
            <div class="rounded-lg border border-slate-200 bg-slate-50/70 p-3">
              <div class="mb-1.5 flex items-baseline justify-between text-xs text-slate-500">
                <span>今日（{usage.date}）容量占用</span>
                <span class="tabular-nums">
                  <span class="font-semibold text-slate-800">{usage.usedM3}</span> / {usage.capacityM3} m³
                </span>
              </div>
              <div class="h-2.5 w-full overflow-hidden rounded-full bg-slate-200">
                <div
                  class={`h-full rounded-full ${usage.full ? 'bg-rose-500' : 'bg-brine-600'}`}
                  style={{ width: `${usedPct()}%` }}
                />
              </div>
              <p class="mt-2 text-xs leading-relaxed text-slate-500">
                剩余 <span class="tabular-nums font-medium text-slate-700">{usage.remainingM3}</span> m³；
                {usage.full ? '今日档位已满，新走水单排队到次日档位。' : '今日档位尚有余量。'}
                断链续泵沿用同一批次，容量不释放、不二次占用。
              </p>
            </div>
          </div>
        }
      >
        <div class="grid gap-3 sm:grid-cols-2">
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>泵站名称</span>
            <input class={INPUT} value={name()} onInput={(event) => setName(event.currentTarget.value)} />
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>单日泵送容量上限（m³/日）</span>
            <input
              type="number"
              min="1"
              step="50"
              class={INPUT}
              value={capacity()}
              onInput={(event) => setCapacity(Number(event.currentTarget.value))}
            />
          </label>
        </div>
        <p class="mt-3 rounded-md bg-slate-50 px-3 py-2 text-xs leading-relaxed text-slate-500">
          断链处置口径固定为「{store.state.station.chainPolicy}」：一批水没泵完断链时从断点续泵，沿用同一批次号；
          班末回执分段累计，容量口径跟随此选择 —— 容量只在开机日档位占一次。
        </p>
        <div class="mt-3 flex justify-end gap-2">
          <button class="rounded-md border border-slate-300 bg-white px-3.5 py-1.5 text-sm text-slate-700 hover:bg-slate-100" onClick={() => setEditing(false)}>
            取消
          </button>
          <button class={BTN_PRIMARY} onClick={() => void save()}>
            保存
          </button>
        </div>
      </Show>
    </section>
  );
}
