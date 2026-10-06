/**
 * 泵站业务规则
 * - 日泵送容量上限与档位编排：容量满时后续走水单排队到次日档位
 * - 断链策略：断点续泵（批次号不变，已泵体积留在回执链上，续泵从断点接着泵）
 * - 容量口径：按「实际泵送体积」核销 —— 有效回执落在哪个班次日期就占哪天的容量；
 *   断链当班只核销已泵部分，余量随续泵班次核销（不采用作废重开：会整批重占容量）
 * - 对账：池号 + 批次号，有效回执累计体积 ≥ 计划量 且 最新水位 ≤ 目标水位
 */
import type { Observation } from '../types/observation';
import type { PumpReceipt } from '../types/pump';
import type { Schedule } from '../types/schedule';
import { addDays } from './id';

/** 泵站日泵送容量上限（m³/d） */
export const PUMP_DAILY_CAPACITY_M3 = 3000;

/** 有效回执（未作废） */
export function validReceipts(receipts: PumpReceipt[]): PumpReceipt[] {
  return receipts.filter((row) => row.state === '有效');
}

/** 指定批次累计已泵体积（m³）：全部有效回执求和 —— 断点续泵的断点体积由回执链承载 */
export function batchPumpedM3(batchNo: string, receipts: PumpReceipt[]): number {
  const total = validReceipts(receipts)
    .filter((row) => row.batchNo === batchNo)
    .reduce((acc, row) => acc + row.volumeM3, 0);
  return Math.round(total * 10) / 10;
}

/** 某班次日期已被回执核销的容量（m³）：容量按实际泵送体积核销 */
export function dailyReceiptM3(receipts: PumpReceipt[], shiftDate: string): number {
  const total = validReceipts(receipts)
    .filter((row) => row.shiftDate === shiftDate)
    .reduce((acc, row) => acc + row.volumeM3, 0);
  return Math.round(total * 10) / 10;
}

/** 走水对账结果 */
export interface ReconcileResult {
  ok: boolean;
  /** 泵站是否已收货：有效回执累计体积 ≥ 计划量 */
  receiptOk: boolean;
  /** 水位是否落到位：最新观测水位 ≤ 目标水位 */
  levelOk: boolean;
  /** 该批次有效回执累计体积（m³） */
  receiptVolumeM3: number;
  /** 最新观测水位（cm），无观测为 null */
  latestLevelCm: number | null;
  /** 未满足项的说明 */
  missing: string[];
}

/**
 * 走水对账：调度端与泵站按「池号 + 批次号」对账。
 * 泵站这段收了货（有效回执累计 ≥ 计划量）、水位也落到位（最新水位 ≤ 目标水位），
 * 走水单才允许从「已排」进入「走水中」。
 * @param pondObservations 该池的全部日观测（调用方按 pondId 过滤后传入）
 */
export function reconcileSchedule(
  schedule: Pick<Schedule, 'pumpBatchNo' | 'volumeM3' | 'targetLevelCm'>,
  pondCode: string,
  receipts: PumpReceipt[],
  pondObservations: Observation[],
): ReconcileResult {
  const receiptVolumeM3 =
    Math.round(
      validReceipts(receipts)
        .filter((row) => row.batchNo === schedule.pumpBatchNo && row.pondCode === pondCode)
        .reduce((acc, row) => acc + row.volumeM3, 0) * 10,
    ) / 10;
  const receiptOk = schedule.pumpBatchNo !== '' && receiptVolumeM3 >= schedule.volumeM3;

  const latest =
    pondObservations.length === 0
      ? null
      : pondObservations.reduce((acc, row) => (row.date > acc.date ? row : acc));
  const latestLevelCm = latest === null ? null : latest.levelCm;
  const levelOk = latestLevelCm !== null && latestLevelCm <= schedule.targetLevelCm;

  const missing: string[] = [];
  if (schedule.pumpBatchNo === '') missing.push('尚未开立泵送批次');
  else if (!receiptOk) missing.push(`泵站未收货：有效回执累计 ${receiptVolumeM3} m³，不足计划量 ${schedule.volumeM3} m³`);
  if (latestLevelCm === null) missing.push('该池还没有水位观测记录');
  else if (!levelOk) missing.push(`水位未落到位：最新 ${latestLevelCm} cm，高于目标 ${schedule.targetLevelCm} cm`);

  return { ok: receiptOk && levelOk, receiptOk, levelOk, receiptVolumeM3, latestLevelCm, missing };
}

/**
 * 档位编排：占用泵站容量的走水单（已排 / 走水中）按 orderIndex 依次装档，
 * 从各自的计划走水日期起，单日累计计划量超过容量上限时顺推到次日档位。
 * 单张超过日容量的大单独占一个空档日（界面会标超容）。返回 scheduleId → 档位日期。
 */
export function assignSlots(schedules: Schedule[]): Map<string, string> {
  const result = new Map<string, string>();
  const queued = schedules
    .filter((row) => row.state === '已排' || row.state === '走水中')
    .sort((a, b) => a.orderIndex - b.orderIndex || a.planDate.localeCompare(b.planDate));
  const usedByDate = new Map<string, number>();
  let cursor = '';
  queued.forEach((row) => {
    let day = row.planDate;
    if (cursor !== '' && day < cursor) day = cursor;
    let used = usedByDate.get(day) ?? 0;
    while (used > 0 && used + row.volumeM3 > PUMP_DAILY_CAPACITY_M3) {
      day = addDays(day, 1);
      used = usedByDate.get(day) ?? 0;
    }
    usedByDate.set(day, used + row.volumeM3);
    cursor = day;
    result.set(row.id, day);
  });
  return result;
}
