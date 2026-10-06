/**
 * <CapacityBoard> 日泵送容量档位板
 * 已对账单按回执实测体积锁定计划日；未对账单按计划量逐日找第一个装得下的档位，
 * 装不下的排队到次日档位，超过单日上限的单列「容量不足」。
 */
import { For, Show } from 'solid-js';
import { usePumpStore } from '../../stores/pumpStore';
import { usePondStore } from '../../stores/pondStore';

const STATE_TEXT: Record<string, string> = {
  待排: 'text-slate-500',
  已排: 'text-sky-700',
  走水中: 'text-amber-700',
  已出卤: 'text-emerald-700',
};

export default function CapacityBoard() {
  const pump = usePumpStore();
  const ponds = usePondStore();
  const plan = () => pump.capacityPlan();

  const pondLabel = (pondId: string): string => {
    const pond = ponds.state.ponds.find((item) => item.id === pondId);
    return pond === undefined ? '（池已删除）' : `${pond.code} · ${pond.seriesName}`;
  };

  return (
    <section class="rounded-xl border border-slate-200 bg-white p-4">
      <header class="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 class="text-[15px] font-semibold text-slate-800">日泵送容量档位</h2>
        <span class="text-xs text-slate-500">
          上限 <span class="tabular-nums font-medium text-slate-700">{plan().capacityM3}</span> m³/日 ·
          已对账按回执实测体积计，未对账按计划量计
        </span>
      </header>

      <div class="grid gap-3 lg:grid-cols-3">
        <For each={plan().days}>
          {(day) => {
            const pct = (): number =>
              day.capacityM3 <= 0 ? 0 : Math.min(100, Math.round((day.usedM3 / day.capacityM3) * 1000) / 10);
            const items = () => plan().assignments.filter((item) => item.bucketDate === day.date);
            return (
              <div class={`rounded-lg border p-3 ${day.full ? 'border-amber-300 bg-amber-50/50' : 'border-slate-200'}`}>
                <div class="mb-1.5 flex items-baseline justify-between">
                  <span class="text-sm font-semibold text-slate-800">{day.date}</span>
                  <span class={`text-xs tabular-nums ${day.full ? 'text-amber-700' : 'text-slate-500'}`}>
                    {day.usedM3} / {day.capacityM3} m³
                  </span>
                </div>
                <div class="mb-2 h-1.5 w-full overflow-hidden rounded-full bg-slate-200">
                  <div class={`h-full rounded-full ${day.full ? 'bg-amber-500' : 'bg-brine-600'}`} style={{ width: `${pct()}%` }} />
                </div>
                <ul class="space-y-1">
                  <For each={items()}>
                    {(item) => (
                      <li class="flex items-center justify-between gap-2 text-xs">
                        <span class="truncate text-slate-600">
                          {pondLabel(pump.state.schedules.find((row) => row.id === item.scheduleId)?.pondId ?? '')}
                          <Show when={item.queued}>
                            <span class="ml-1 rounded bg-amber-100 px-1 py-px text-[10px] text-amber-700">次日排队</span>
                          </Show>
                        </span>
                        <span class="flex shrink-0 items-baseline gap-1.5">
                          <span class="tabular-nums font-medium text-slate-800">{item.volumeM3}</span>
                          <span class={STATE_TEXT[item.state]}>{item.state}</span>
                        </span>
                      </li>
                    )}
                  </For>
                </ul>
              </div>
            );
          }}
        </For>
      </div>

      <Show when={plan().queued.length > 0 || plan().infeasible.length > 0}>
        <div class="mt-3 grid gap-3 md:grid-cols-2">
          <Show when={plan().queued.length > 0}>
            <div class="rounded-lg border border-amber-200 bg-amber-50/60 p-3">
              <p class="mb-1.5 text-[13px] font-semibold text-amber-800">排队到次日档位（{plan().queued.length} 单）</p>
              <ul class="space-y-1 text-xs text-amber-800">
                <For each={plan().queued}>
                  {(item) => (
                    <li class="flex items-center justify-between gap-2">
                      <span>
                        {pondLabel(pump.state.schedules.find((row) => row.id === item.scheduleId)?.pondId ?? '')} ·
                        计划日 {item.planDate}
                      </span>
                      <span class="tabular-nums">
                        {item.volumeM3} m³ → {item.bucketDate}
                      </span>
                    </li>
                  )}
                </For>
              </ul>
            </div>
          </Show>
          <Show when={plan().infeasible.length > 0}>
            <div class="rounded-lg border border-rose-200 bg-rose-50/60 p-3">
              <p class="mb-1.5 text-[13px] font-semibold text-rose-800">容量不足，需人工处理（{plan().infeasible.length} 单）</p>
              <ul class="space-y-1 text-xs text-rose-800">
                <For each={plan().infeasible}>
                  {(item) => (
                    <li class="flex items-center justify-between gap-2">
                      <span>
                        {pondLabel(pump.state.schedules.find((row) => row.id === item.scheduleId)?.pondId ?? '')} ·
                        {item.planDate}
                      </span>
                      <span class="tabular-nums">
                        {item.volumeM3} m³ ＞ 单日 {plan().capacityM3} m³
                      </span>
                    </li>
                  )}
                </For>
              </ul>
            </div>
          </Show>
        </div>
      </Show>
    </section>
  );
}
