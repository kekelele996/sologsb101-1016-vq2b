/**
 * 走水编排状态管理（Solid 原生能力）
 * 用 createStore 维护走水顺序与状态推进；出卤完成后回写池阶段与实际密度。
 * 状态推进与泵站联动：待排 → 已排 自动开立 / 复用泵送批次并重排档位；
 * 已排 → 走水中 必须先通过「池号 + 批次号」对账（泵站已收货且水位落到位）。
 */
import { createRoot, createSignal } from 'solid-js';
import { createStore } from 'solid-js/store';
import { liveQuery } from 'dexie';
import type { Schedule, ScheduleDraft, ScheduleState } from '../types/schedule';
import { SCHEDULE_STATE_FLOW } from '../types/schedule';
import {
  ROW_REVISION,
  advanceScheduleState,
  db,
  dispatchSchedule,
  initDatabase,
  putSchedule,
  recomputeSlots,
  removeSchedule,
  reorderSchedules,
} from '../utils/db';
import { reconcileSchedule } from '../utils/pump';
import { nowIso, uuid } from '../utils/id';
import { usePondStore } from './pondStore';
import { usePumpStore } from './pumpStore';

/** 走水编排筛选条件 */
export interface ScheduleFilters {
  keyword: string;
  seriesName: string | 'all';
  state: ScheduleState | 'all';
}

const EMPTY_FILTERS: ScheduleFilters = { keyword: '', seriesName: 'all', state: 'all' };

interface ScheduleState_ {
  rows: Schedule[];
  loading: boolean;
  error: string;
  lastMessage: string;
}

function createScheduleStore() {
  const [state, setState] = createStore<ScheduleState_>({
    rows: [],
    loading: true,
    error: '',
    lastMessage: '',
  });
  const [filters, setFilters] = createSignal<ScheduleFilters>({ ...EMPTY_FILTERS });
  const [draggingId, setDraggingId] = createSignal<string | null>(null);

  // 同 observationStore：建库必须放在 querier 外，否则 liveQuery 采集不到可观测性集合，
  // 数据库变更后不会重查 —— 走水计划条数与拖拽后的顺序都不会原地刷新。
  void initDatabase();

  liveQuery(async () => {
    return db.schedules.toArray();
  }).subscribe({
    next: (list) => {
      setState('rows', [...list].sort((a, b) => a.orderIndex - b.orderIndex || a.planDate.localeCompare(b.planDate)));
      setState('loading', false);
      setState('error', '');
    },
    error: (err: unknown) => {
      setState({ loading: false, error: err instanceof Error ? err.message : '读取走水编排失败' });
    },
  });

  function patchFilters(patch: Partial<ScheduleFilters>): void {
    setFilters({ ...filters(), ...patch });
  }

  function resetFilters(): void {
    setFilters({ ...EMPTY_FILTERS });
  }

  function setMessage(message: string): void {
    setState('lastMessage', message);
  }

  async function createSchedule(draft: ScheduleDraft): Promise<Schedule> {
    const stamp = nowIso();
    const row: Schedule = {
      id: uuid('schedule'),
      pondId: draft.pondId,
      planDate: draft.planDate,
      targetDensity: draft.targetDensity,
      volumeM3: draft.volumeM3,
      operator: draft.operator.trim(),
      state: draft.state,
      orderIndex: draft.orderIndex,
      // 批次号在标记已排时自动开立；档位先按计划日期，进已排后由容量编排重算
      pumpBatchNo: '',
      slotDate: draft.planDate,
      targetLevelCm: draft.targetLevelCm,
      createdAt: stamp,
      updatedAt: stamp,
      revision: ROW_REVISION,
    };
    await putSchedule(row);
    await recomputeSlots();
    setState('lastMessage', `已新建走水计划：${row.planDate}`);
    return row;
  }

  async function updateSchedule(scheduleId: string, draft: ScheduleDraft): Promise<void> {
    const existing = state.rows.find((row) => row.id === scheduleId);
    if (existing === undefined) return;
    await putSchedule({
      ...existing,
      pondId: draft.pondId,
      planDate: draft.planDate,
      targetDensity: draft.targetDensity,
      volumeM3: draft.volumeM3,
      operator: draft.operator.trim(),
      state: draft.state,
      orderIndex: draft.orderIndex,
      targetLevelCm: draft.targetLevelCm,
    });
    await recomputeSlots();
    setState('lastMessage', '走水计划已更新');
  }

  async function deleteSchedule(scheduleId: string): Promise<void> {
    await removeSchedule(scheduleId);
    await recomputeSlots();
    setState('lastMessage', '走水计划已删除');
  }

  async function advance(scheduleId: string): Promise<ScheduleState | null> {
    const existing = state.rows.find((row) => row.id === scheduleId);
    if (existing === undefined) return null;
    const index = SCHEDULE_STATE_FLOW.indexOf(existing.state);
    if (index < 0 || index >= SCHEDULE_STATE_FLOW.length - 1) return null;
    const next = SCHEDULE_STATE_FLOW[index + 1];
    const pondStore = usePondStore();

    // 待排 → 已排：开立 / 复用泵送批次，并按日容量重排档位
    if (next === '已排') {
      const result = await dispatchSchedule(scheduleId);
      if (result === null) {
        setState('lastMessage', '标记已排失败：蒸发池不存在');
        return null;
      }
      setState(
        'lastMessage',
        result.slotDate > existing.planDate
          ? `已排：泵送批次 ${result.batchNo}；当日容量已满，排队到 ${result.slotDate} 档位`
          : `已排：泵送批次 ${result.batchNo}，泵站档位 ${result.slotDate}`,
      );
      return next;
    }

    // 已排 → 走水中：按池号 + 批次号对账，泵站已收货且水位落到位才放行
    if (next === '走水中') {
      const pond = pondStore.state.ponds.find((item) => item.id === existing.pondId);
      const pumpStore = usePumpStore();
      const pondObs = pondStore.state.observations.filter((item) => item.pondId === existing.pondId);
      const result = reconcileSchedule(existing, pond?.code ?? '', pumpStore.state.receipts, pondObs);
      if (!result.ok) {
        setState('lastMessage', `对账未通过，不能进入走水中：${result.missing.join('；')}`);
        return null;
      }
      await advanceScheduleState(scheduleId, next, 0);
      setState(
        'lastMessage',
        `对账通过（回执累计 ${result.receiptVolumeM3} m³，水位 ${result.latestLevelCm ?? '—'} cm 已落位），已进入走水中`,
      );
      return next;
    }

    const stat = pondStore.statOf(existing.pondId);
    const actualDensity = stat.currentDensity > 0 ? stat.currentDensity : existing.targetDensity;
    await advanceScheduleState(scheduleId, next, actualDensity);
    await pondStore.refreshCounts();
    setState('lastMessage', `已出卤：池阶段已推进，实际密度回写为 ${actualDensity} g/cm³`);
    return next;
  }

  /** 拖拽排序：把 fromId 移动到 toId 之前 */
  async function moveBefore(fromId: string, toId: string): Promise<void> {
    if (fromId === toId) return;
    const list = [...state.rows].sort((a, b) => a.orderIndex - b.orderIndex);
    const fromIndex = list.findIndex((row) => row.id === fromId);
    const toIndex = list.findIndex((row) => row.id === toId);
    if (fromIndex < 0 || toIndex < 0) return;
    const [moved] = list.splice(fromIndex, 1);
    list.splice(toIndex, 0, moved);
    await reorderSchedules(list.map((row) => row.id));
    setState('lastMessage', `已调整走水顺序：${moved.planDate} 移动到第 ${toIndex + 1} 位`);
  }

  async function moveToIndex(id: string, targetIndex: number): Promise<void> {
    const list = [...state.rows].sort((a, b) => a.orderIndex - b.orderIndex);
    const fromIndex = list.findIndex((row) => row.id === id);
    if (fromIndex < 0) return;
    const [moved] = list.splice(fromIndex, 1);
    const index = Math.max(0, Math.min(list.length, targetIndex));
    list.splice(index, 0, moved);
    await reorderSchedules(list.map((row) => row.id));
    setState('lastMessage', `已把 ${moved.planDate} 调整到第 ${index + 1} 位`);
  }

  return {
    state,
    filters,
    patchFilters,
    resetFilters,
    draggingId,
    setDraggingId,
    setMessage,
    createSchedule,
    updateSchedule,
    deleteSchedule,
    advance,
    moveBefore,
    moveToIndex,
  };
}

const store = createRoot(createScheduleStore);

export function useScheduleStore() {
  return store;
}
