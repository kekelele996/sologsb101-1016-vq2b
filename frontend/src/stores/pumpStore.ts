/**
 * 泵站外输状态管理（Solid 原生能力）
 * 维护泵站参数（日容量上限 / 断链口径）、泵送批次、班末回执；
 * 与走水单按「池号 + 批次」对账；日容量按「断点续泵」口径算档位排队。
 */
import { createMemo, createRoot, createSignal } from 'solid-js';
import { createStore } from 'solid-js/store';
import { liveQuery } from 'dexie';
import type { PumpStation, PumpStationDraft } from '../types/pumpStation';
import { DEFAULT_DAILY_CAPACITY_M3, STATION_ID } from '../types/pumpStation';
import type { PumpBatch, PumpBatchDraft } from '../types/pumpBatch';
import type { PumpReceipt, PumpReceiptDraft, PumpReceiptReissueDraft } from '../types/pumpReceipt';
import type { Schedule } from '../types/schedule';
import {
  createReceipt as dbCreateReceipt,
  db,
  getStation,
  initDatabase,
  putBatch,
  reconcileSchedule as dbReconcile,
  reissueReceipt as dbReissue,
  removeBatch,
  unlinkScheduleReceipt,
  updateStation,
} from '../utils/db';
import {
  batchProgress,
  checkReconcile,
  eligibleReceipts,
  planCapacity,
  receiptVersionChain,
  toCapacityLines,
} from '../utils/pumping';
import { nowIso, today, uuid } from '../utils/id';

/** 回执列表筛选 */
export interface ReceiptFilters {
  batchId: string | 'all';
  state: PumpReceipt['state'] | 'all';
}

const EMPTY_RECEIPT_FILTERS: ReceiptFilters = { batchId: 'all', state: 'all' };

interface PumpState {
  ready: boolean;
  station: PumpStation;
  batches: PumpBatch[];
  receipts: PumpReceipt[];
  schedules: Schedule[];
  lastMessage: string;
  error: string;
}

function defaultStation(): PumpStation {
  const stamp = nowIso();
  return {
    id: STATION_ID,
    name: '盐田外输泵站',
    dailyCapacityM3: DEFAULT_DAILY_CAPACITY_M3,
    chainPolicy: '断点续泵',
    createdAt: stamp,
    updatedAt: stamp,
    revision: 3,
  };
}

/** 生成建议批次号：PB-YYYYMMDD-序号 */
export function suggestBatchCode(batches: PumpBatch[], date: string): string {
  const compact = date.replace(/-/g, '');
  const prefix = `PB-${compact}-`;
  const seq = batches
    .map((batch) => batch.code)
    .filter((code) => code.startsWith(prefix))
    .map((code) => Number(code.slice(prefix.length)))
    .filter((num) => Number.isFinite(num))
    .reduce((max, num) => Math.max(max, num), 0);
  return `${prefix}${String(seq + 1).padStart(2, '0')}`;
}

/** 生成建议回执单号：R-YYYYMMDD-序号 */
export function suggestReceiptCode(receipts: PumpReceipt[], date: string): string {
  const compact = date.replace(/-/g, '');
  const prefix = `R-${compact}-`;
  const seq = receipts
    .map((receipt) => receipt.code)
    .filter((code) => code.startsWith(prefix))
    .map((code) => Number(code.slice(prefix.length, prefix.length + 2)))
    .filter((num) => Number.isFinite(num))
    .reduce((max, num) => Math.max(max, num), 0);
  return `${prefix}${String(seq + 1).padStart(2, '0')}`;
}

function createPumpStore() {
  const [state, setState] = createStore<PumpState>({
    ready: false,
    station: defaultStation(),
    batches: [],
    receipts: [],
    schedules: [],
    lastMessage: '',
    error: '',
  });
  const [receiptFilters, setReceiptFilters] = createSignal<ReceiptFilters>({ ...EMPTY_RECEIPT_FILTERS });
  let subscribed = false;

  async function loadAll(): Promise<void> {
    await initDatabase();
    const station = await getStation();
    setState('station', station);
    if (!subscribed) {
      subscribed = true;
      liveQuery(async () => {
        const [stations, batches, receipts, schedules] = await Promise.all([
          db.pumpStations.toArray(),
          db.pumpBatches.toArray(),
          db.pumpReceipts.toArray(),
          db.schedules.toArray(),
        ]);
        return { stations, batches, receipts, schedules };
      }).subscribe({
        next: ({ stations, batches, receipts, schedules }) => {
          const stationRow = stations[0];
          setState({
            station: stationRow ?? defaultStation(),
            batches: [...batches].sort(
              (a, b) => b.startDate.localeCompare(a.startDate) || a.code.localeCompare(b.code),
            ),
            receipts: [...receipts].sort((a, b) => b.endTime.localeCompare(a.endTime) || a.code.localeCompare(b.code)),
            schedules: [...schedules].sort((a, b) => a.orderIndex - b.orderIndex),
            ready: true,
            error: '',
          });
        },
        error: (err: unknown) => {
          setState({ error: err instanceof Error ? err.message : '读取泵站数据失败' });
        },
      });
    }
  }

  function setMessage(message: string): void {
    setState('lastMessage', message);
  }

  function patchReceiptFilters(patch: Partial<ReceiptFilters>): void {
    setReceiptFilters({ ...receiptFilters(), ...patch });
  }

  function resetReceiptFilters(): void {
    setReceiptFilters({ ...EMPTY_RECEIPT_FILTERS });
  }

  /* -------------------------------- 参数 -------------------------------- */

  async function saveStation(draft: PumpStationDraft): Promise<void> {
    const row = await updateStation(draft);
    setState('station', row);
    setState('lastMessage', `泵站参数已更新：日容量上限 ${row.dailyCapacityM3} m³，断链口径「${row.chainPolicy}」`);
  }

  /* -------------------------------- 批次 -------------------------------- */

  function batchById(id: string): PumpBatch | undefined {
    return state.batches.find((batch) => batch.id === id);
  }

  function progressOf(batchId: string) {
    return batchProgress(
      state.batches.find((batch) => batch.id === batchId) ?? {
        id: batchId,
        code: '',
        startDate: today(),
        shift: '早班',
        plannedVolumeM3: 0,
        pumpedVolumeM3: 0,
        state: '在泵' as const,
        note: '',
        createdAt: '',
        updatedAt: '',
        revision: 3,
      },
      state.receipts,
    );
  }

  async function createBatch(draft: PumpBatchDraft): Promise<PumpBatch> {
    const stamp = nowIso();
    const row: PumpBatch = {
      id: uuid('batch'),
      code: draft.code.trim(),
      startDate: draft.startDate,
      shift: draft.shift,
      plannedVolumeM3: draft.plannedVolumeM3,
      pumpedVolumeM3: 0,
      state: draft.state,
      note: draft.note.trim(),
      createdAt: stamp,
      updatedAt: stamp,
      revision: 3,
    };
    await putBatch(row);
    setState('lastMessage', `已开机批次 ${row.code}，计划泵送 ${row.plannedVolumeM3} m³`);
    return row;
  }

  async function updateBatch(id: string, draft: PumpBatchDraft): Promise<void> {
    const existing = batchById(id);
    if (existing === undefined) return;
    await putBatch({
      ...existing,
      code: draft.code.trim() || existing.code,
      startDate: draft.startDate,
      shift: draft.shift,
      plannedVolumeM3: draft.plannedVolumeM3,
      state: draft.state,
      note: draft.note.trim(),
    });
    setState('lastMessage', `批次 ${draft.code} 已更新`);
  }

  async function deleteBatch(id: string): Promise<number> {
    const receiptCount = state.receipts.filter((receipt) => receipt.batchId === id).length;
    await removeBatch(id);
    setState('lastMessage', `批次已删除，关联的 ${receiptCount} 张回执一并清理，对账走水单已退回待排`);
    return receiptCount;
  }

  /* -------------------------------- 回执 -------------------------------- */

  function receiptsOfBatch(batchId: string): PumpReceipt[] {
    return state.receipts
      .filter((receipt) => receipt.batchId === batchId)
      .sort((a, b) => b.endTime.localeCompare(a.endTime) || a.version - b.version);
  }

  function chainOf(receiptId: string): PumpReceipt[] {
    const receipt = state.receipts.find((item) => item.id === receiptId);
    return receipt === undefined ? [] : receiptVersionChain(receipt, state.receipts);
  }

  async function addReceipt(draft: PumpReceiptDraft): Promise<PumpReceipt> {
    const receipt = await dbCreateReceipt(draft);
    setState(
      'lastMessage',
      receipt.levelConfirmed
        ? `回执 ${receipt.code} 已补录（${receipt.volumeM3} m³，水位已确认落到位），可去对账`
        : `回执 ${receipt.code} 已补录（${receipt.volumeM3} m³），水位尚未确认落到位`,
    );
    return receipt;
  }

  async function reissue(id: string, draft: PumpReceiptReissueDraft): Promise<number> {
    const result = await dbReissue(id, draft);
    setState(
      'lastMessage',
      `回执已改口径重出为 ${result.newReceipt.code}（V${result.newReceipt.version}，${result.newReceipt.volumeM3} m³），原回执作废留档；${result.affectedScheduleIds.length} 张走水单已退回待排按新体积重算`,
    );
    return result.affectedScheduleIds.length;
  }

  /* -------------------------------- 对账 -------------------------------- */

  /** 待对账走水单（待排 / 已排） */
  const reconcileCandidates = createMemo<Schedule[]>(() =>
    state.schedules
      .filter((row) => row.state === '待排' || row.state === '已排')
      .sort((a, b) => a.planDate.localeCompare(b.planDate) || a.orderIndex - b.orderIndex),
  );

  /** 某张走水单可对的生效回执（同池号、水位到位） */
  function candidatesForSchedule(schedule: Schedule): PumpReceipt[] {
    return eligibleReceipts(schedule, state.receipts);
  }

  function checkPair(schedule: Schedule, receipt: PumpReceipt): { ok: boolean; reason: string } {
    return checkReconcile(schedule, receipt);
  }

  async function reconcile(scheduleId: string, receiptId: string): Promise<void> {
    const row = await dbReconcile(scheduleId, receiptId);
    setState('lastMessage', `对账通过：池号 + 批次匹配、水位落到位，走水单进入「走水中」（批次 ${row.batchCode}）`);
  }

  async function unlink(scheduleId: string): Promise<void> {
    await unlinkScheduleReceipt(scheduleId);
    setState('lastMessage', '已解除对账，走水单退回「待排」');
  }

  /* -------------------------------- 容量 -------------------------------- */

  /** 按「断点续泵」口径计算的日容量档位方案 */
  const capacityPlan = createMemo(() =>
    planCapacity(toCapacityLines(state.schedules, state.receipts), state.station.dailyCapacityM3),
  );

  const assignmentById = createMemo(() => {
    const map = new Map(capacityPlan().assignments.map((item) => [item.scheduleId, item]));
    return map;
  });

  function assignmentOf(scheduleId: string) {
    return assignmentById().get(scheduleId);
  }

  /** 今日档位占用（取不到今日时给空档位） */
  const todayUsage = createMemo(() => {
    const date = today();
    return (
      capacityPlan().days.find((day) => day.date === date) ?? {
        date,
        usedM3: 0,
        capacityM3: state.station.dailyCapacityM3,
        remainingM3: state.station.dailyCapacityM3,
        full: false,
      }
    );
  });

  return {
    state,
    loadAll,
    setMessage,
    receiptFilters,
    patchReceiptFilters,
    resetReceiptFilters,
    saveStation,
    batchById,
    progressOf,
    createBatch,
    updateBatch,
    deleteBatch,
    receiptsOfBatch,
    chainOf,
    addReceipt,
    reissue,
    reconcileCandidates,
    candidatesForSchedule,
    checkPair,
    reconcile,
    unlink,
    capacityPlan,
    assignmentOf,
    todayUsage,
    suggestBatchCode: (date: string) => suggestBatchCode(state.batches, date),
    suggestReceiptCode: (date: string) => suggestReceiptCode(state.receipts, date),
  };
}

const store = createRoot(createPumpStore);

export function usePumpStore() {
  return store;
}
