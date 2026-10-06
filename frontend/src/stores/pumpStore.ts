/**
 * 泵站状态管理（Solid 原生能力）
 * 用 createStore 维护泵送批次与班末回执；断链策略为断点续泵，容量按回执实际泵送体积核销。
 */
import { createRoot } from 'solid-js';
import { createStore } from 'solid-js/store';
import { liveQuery } from 'dexie';
import type { PumpBatch, PumpBatchDraft, PumpReceipt, PumpReceiptDraft } from '../types/pump';
import {
  ROW_REVISION,
  breakBatch,
  db,
  initDatabase,
  issueReceipt,
  putPumpBatch,
  reissueReceipt,
  resumeBatch,
} from '../utils/db';
import { PUMP_DAILY_CAPACITY_M3, batchPumpedM3, dailyReceiptM3, validReceipts } from '../utils/pump';
import { nowIso, today, uuid } from '../utils/id';

interface PumpState {
  batches: PumpBatch[];
  receipts: PumpReceipt[];
  loading: boolean;
  error: string;
  lastMessage: string;
}

function createPumpStore() {
  const [state, setState] = createStore<PumpState>({
    batches: [],
    receipts: [],
    loading: true,
    error: '',
    lastMessage: '',
  });

  // 同 scheduleStore：建库放在 querier 外，保证 liveQuery 能采集到可观测性集合
  void initDatabase();

  liveQuery(async () => {
    const [batches, receipts] = await Promise.all([db.pumpBatches.toArray(), db.pumpReceipts.toArray()]);
    return { batches, receipts };
  }).subscribe({
    next: ({ batches, receipts }) => {
      setState({
        batches: [...batches].sort((a, b) => a.planDate.localeCompare(b.planDate) || a.batchNo.localeCompare(b.batchNo)),
        receipts: [...receipts].sort(
          (a, b) => a.shiftDate.localeCompare(b.shiftDate) || a.receiptNo.localeCompare(b.receiptNo) || a.version - b.version,
        ),
        loading: false,
        error: '',
      });
    },
    error: (err: unknown) => {
      setState({ loading: false, error: err instanceof Error ? err.message : '读取泵站数据失败' });
    },
  });

  function setMessage(message: string): void {
    setState('lastMessage', message);
  }

  /** 指定批次累计已泵体积（有效回执求和） */
  function pumpedOf(batchNo: string): number {
    return batchPumpedM3(batchNo, state.receipts);
  }

  /** 今日已被回执核销的容量（m³） */
  function todayReceiptM3(): number {
    return dailyReceiptM3(state.receipts, today());
  }

  /** 有效 / 作废回执张数 */
  function receiptCounts(): { valid: number; voided: number } {
    const valid = validReceipts(state.receipts).length;
    return { valid, voided: state.receipts.length - valid };
  }

  async function createBatch(draft: PumpBatchDraft, pondCode: string): Promise<void> {
    const sameDay = state.batches.filter((row) => row.planDate === draft.planDate).length;
    const batchNo = `PB-${draft.planDate.replace(/-/g, '')}-${String(sameDay + 1).padStart(2, '0')}`;
    const stamp = nowIso();
    await putPumpBatch({
      id: uuid('pumpbatch'),
      batchNo,
      pondId: draft.pondId,
      pondCode,
      planDate: draft.planDate,
      plannedM3: draft.plannedM3,
      state: '泵送中',
      breakNote: '',
      createdAt: stamp,
      updatedAt: stamp,
      revision: ROW_REVISION,
    });
    setState('lastMessage', `已开立泵送批次 ${batchNo}（${pondCode}，计划 ${draft.plannedM3} m³）`);
  }

  async function reportReceipt(batchId: string, draft: PumpReceiptDraft): Promise<void> {
    const receipt = await issueReceipt(batchId, draft);
    setState(
      'lastMessage',
      `班末回执 ${receipt.receiptNo} 已登记：${receipt.volumeM3} m³（${receipt.periodStart}–${receipt.periodEnd}），容量按 ${receipt.shiftDate} 班次核销`,
    );
  }

  async function markBroken(batchId: string, note: string): Promise<void> {
    await breakBatch(batchId, note);
    setState('lastMessage', '批次已标记断链：断点续泵 —— 批次号不变，已泵体积保留在回执链上，续泵从断点接着泵');
  }

  async function resume(batchId: string): Promise<void> {
    await resumeBatch(batchId);
    setState('lastMessage', '已从断点续泵：余量随续泵班次的回执核销容量');
  }

  async function reissue(receiptId: string, newVolumeM3: number, reason: string): Promise<void> {
    const result = await reissueReceipt(receiptId, newVolumeM3, reason);
    if (result === null) {
      setState('lastMessage', '该回执已作废或不存在，不能重出');
      return;
    }
    setState(
      'lastMessage',
      `回执已重出为第 ${result.receipt.version} 版（旧版作废留档），${result.affected} 张走水单退回待排并按新体积重算`,
    );
  }

  return {
    state,
    setMessage,
    pumpedOf,
    todayReceiptM3,
    receiptCounts,
    createBatch,
    reportReceipt,
    markBroken,
    resume,
    reissue,
    capacity: PUMP_DAILY_CAPACITY_M3,
  };
}

const store = createRoot(createPumpStore);

export function usePumpStore() {
  return store;
}
