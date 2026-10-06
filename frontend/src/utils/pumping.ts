/**
 * 泵站对账与日泵送容量口径（纯函数）
 *
 * 对账规则：
 * 排一批走水时两边按「池号 + 批次」对账；泵站段收到生效回执、且调度端确认水位落到位，
 * 走水单才进「走水中」。回执改口径重出后，旧版作废，用过它的走水单退回「待排」按新体积重算。
 *
 * 容量口径（跟随断链策略 = 断点续泵）：
 * - 未对账的走水单按「计划量」在计划日档位预留容量；
 * - 已对账（走水中 / 已出卤）的单按回执实测体积占用计划日档位，断链续泵沿用同一批次、
 *   回执分段累计，容量不释放也不二次占用；
 * - 当日档位装不下的单顺延到次日档位（逐日找第一个装得下的档位）；
 * - 单条体积超过单日容量上限的单标记「容量不足」，需人工改量或改期。
 */
import type { Schedule, ScheduleState } from '../types/schedule';
import type { PumpReceipt } from '../types/pumpReceipt';
import type { PumpBatch } from '../types/pumpBatch';
import { addDays } from './id';

/** 对账不通过原因（空串表示通过） */
export type ReconcileCheck = { ok: boolean; reason: string };

/** 走水单能否用某张回执对账：池号一致、同批次、回执生效、水位确认落到位、单据尚未出卤 */
export function checkReconcile(schedule: Pick<Schedule, 'pondId' | 'state'>, receipt: PumpReceipt): ReconcileCheck {
  if (receipt.state !== '生效') return { ok: false, reason: '该回执已作废，不能再用于对账' };
  if (schedule.pondId !== receipt.pondId) return { ok: false, reason: '池号不一致，不能跨池对账' };
  if (!receipt.levelConfirmed) return { ok: false, reason: '水位尚未确认落到位，暂不能对账' };
  if (schedule.state === '已出卤') return { ok: false, reason: '该走水单已出卤，不能再对账' };
  if (schedule.state === '走水中') return { ok: false, reason: '该走水单已在走水中' };
  return { ok: true, reason: '' };
}

/** 找出某条待排 / 已排走水单可对账的全部生效回执（同池号、水位到位） */
export function eligibleReceipts(schedule: Pick<Schedule, 'pondId' | 'state'>, receipts: PumpReceipt[]): PumpReceipt[] {
  if (schedule.state === '走水中' || schedule.state === '已出卤') return [];
  return receipts
    .filter((receipt) => receipt.state === '生效' && receipt.levelConfirmed && receipt.pondId === schedule.pondId)
    .sort((a, b) => b.endTime.localeCompare(a.endTime));
}

/** 回执重出（作废）影响到的走水单：用过该版回执对账的单都要退回待排 */
export function receiptsVoidImpact(voidedReceiptIds: string[], schedules: Schedule[]): Schedule[] {
  const idSet = new Set(voidedReceiptIds);
  return schedules.filter((row) => idSet.has(row.receiptId));
}

/** 批次累计已泵量：生效回执体积之和（断点续泵 → 多张班末回执分段累计） */
export function batchPumpedVolume(batchId: string, receipts: PumpReceipt[]): number {
  const total = receipts
    .filter((receipt) => receipt.batchId === batchId && receipt.state === '生效')
    .reduce((acc, receipt) => acc + receipt.volumeM3, 0);
  return Math.round(total * 10) / 10;
}

/** 回执版本链：同一逻辑回执的初版与历次重出版本（按 version 升序） */
export function receiptVersionChain(receipt: PumpReceipt, receipts: PumpReceipt[]): PumpReceipt[] {
  const byId = new Map(receipts.map((item) => [item.id, item]));
  // 先找到初版：沿 reissuesId 回溯
  let cursor: PumpReceipt | undefined = receipt;
  while (cursor && cursor.reissuesId) {
    cursor = byId.get(cursor.reissuesId);
  }
  const root = cursor ?? receipt;
  // 再沿 supersededById 向下收集
  const chain: PumpReceipt[] = [root];
  let node: PumpReceipt | undefined = root;
  while (node && node.supersededById) {
    node = byId.get(node.supersededById);
    if (node) chain.push(node);
  }
  return chain.sort((a, b) => a.version - b.version);
}

/* ------------------------------- 日容量档位 ------------------------------- */

export interface CapacityLine {
  scheduleId: string
  planDate: string
  orderIndex: number
  state: ScheduleState
  /** 计划量（m³） */
  plannedVolumeM3: number
  /** 对账后按回执实测计的体积；未对账为 null */
  confirmedVolumeM3: number | null
}

export interface CapacityAssignment {
  scheduleId: string
  /** 计划日 */
  planDate: string
  /** 实际落入档位日（容量不够时顺延到次日 / 后日） */
  bucketDate: string
  /** 占用容量的体积 */
  volumeM3: number
  state: ScheduleState
  /** 是否被顺延到次日及以后 */
  queued: boolean
  /** 是否连单日容量都装不下（容量不足，需人工处理） */
  infeasible: boolean
}

export interface CapacityDay {
  date: string
  /** 已占用（含固定占用与排队落位） */
  usedM3: number
  capacityM3: number
  remainingM3: number
  full: boolean
}

export interface CapacityPlan {
  capacityM3: number
  days: CapacityDay[]
  assignments: CapacityAssignment[]
  /** 排队到次日及以后档位的单 */
  queued: CapacityAssignment[]
  /** 容量不足无法安排的单 */
  infeasible: CapacityAssignment[]
}

/** 从走水单 + 回执构造容量计算输入行 */
export function toCapacityLines(schedules: Schedule[], receipts: PumpReceipt[]): CapacityLine[] {
  const receiptById = new Map(receipts.map((receipt) => [receipt.id, receipt]));
  return schedules.map((row) => {
    const receipt = row.receiptId !== '' ? receiptById.get(row.receiptId) : undefined;
    const confirmed =
      receipt !== undefined && receipt.state === '生效' && (row.state === '走水中' || row.state === '已出卤')
        ? receipt.volumeM3
        : null;
    return {
      scheduleId: row.id,
      planDate: row.planDate,
      orderIndex: row.orderIndex,
      state: row.state,
      plannedVolumeM3: row.volumeM3,
      confirmedVolumeM3: confirmed,
    };
  });
}

/**
 * 计算日泵送容量分配。
 * 固定占用：走水中 / 已出卤的单按实测（回执）体积锁在计划日档位；
 * 排队落位：待排 / 已排的单按计划日、排序序号依次找第一个装得下的档位。
 */
export function planCapacity(lines: CapacityLine[], capacityM3: number): CapacityPlan {
  const used = new Map<string, number>();
  const touch = (date: string): number => used.get(date) ?? 0;

  const fixed = lines.filter((line) => line.state === '走水中' || line.state === '已出卤');
  const pending = lines
    .filter((line) => line.state === '待排' || line.state === '已排')
    .sort((a, b) => a.planDate.localeCompare(b.planDate) || a.orderIndex - b.orderIndex);

  for (const line of fixed) {
    const volume = line.confirmedVolumeM3 ?? line.plannedVolumeM3;
    used.set(line.planDate, touch(line.planDate) + volume);
  }

  const assignments: CapacityAssignment[] = fixed.map((line) => ({
    scheduleId: line.scheduleId,
    planDate: line.planDate,
    bucketDate: line.planDate,
    volumeM3: Math.round((line.confirmedVolumeM3 ?? line.plannedVolumeM3) * 10) / 10,
    state: line.state,
    queued: false,
    infeasible: false,
  }));

  for (const line of pending) {
    const volume = line.plannedVolumeM3;
    if (volume > capacityM3) {
      assignments.push({
        scheduleId: line.scheduleId,
        planDate: line.planDate,
        bucketDate: line.planDate,
        volumeM3: volume,
        state: line.state,
        queued: false,
        infeasible: true,
      });
      continue;
    }
    let bucket = line.planDate;
    for (let offset = 0; offset < 366; offset += 1) {
      const candidate = addDays(line.planDate, offset);
      if (touch(candidate) + volume <= capacityM3) {
        bucket = candidate;
        break;
      }
      bucket = addDays(line.planDate, offset + 1);
    }
    used.set(bucket, touch(bucket) + volume);
    assignments.push({
      scheduleId: line.scheduleId,
      planDate: line.planDate,
      bucketDate: bucket,
      volumeM3: volume,
      state: line.state,
      queued: bucket !== line.planDate,
      infeasible: false,
    });
  }

  const dates = Array.from(used.keys()).sort((a, b) => a.localeCompare(b));
  const days: CapacityDay[] = dates.map((date) => {
    const usedM3 = Math.round((used.get(date) ?? 0) * 10) / 10;
    return {
      date,
      usedM3,
      capacityM3,
      remainingM3: Math.round((capacityM3 - usedM3) * 10) / 10,
      full: usedM3 >= capacityM3,
    };
  });

  return {
    capacityM3,
    days,
    assignments: assignments.sort((a, b) => a.bucketDate.localeCompare(b.bucketDate)),
    queued: assignments.filter((item) => item.queued),
    infeasible: assignments.filter((item) => item.infeasible),
  };
}

/** 批次进度（已泵 / 计划） */
export interface BatchProgress {
  pumpedM3: number
  plannedM3: number
  pct: number
  done: boolean
}

export function batchProgress(batch: PumpBatch, receipts: PumpReceipt[]): BatchProgress {
  const pumpedM3 = batchPumpedVolume(batch.id, receipts);
  const plannedM3 = batch.plannedVolumeM3;
  const pct = plannedM3 <= 0 ? 0 : Math.min(100, Math.round((pumpedM3 / plannedM3) * 1000) / 10);
  return { pumpedM3, plannedM3, pct, done: pumpedM3 >= plannedM3 && plannedM3 > 0 };
}
