/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据库名：gbbrinepond
 * - v1：建立全部表与 pondId+date 复合索引
 * - v2：新增 evapMm 字段并写入升级迁移逻辑，旧记录自动补齐默认值
 * - v3：新增泵站泵送批次 pumpBatches 与班末回执 pumpReceipts；走水单补泵送批次号 /
 *       档位日期 / 目标水位，旧走水单按池号补批次号，补不出来的留空由界面单列
 * 纯前端应用：不依赖任何后端服务或外部接口。
 */
import Dexie, { type Table } from 'dexie';
import type { Pond } from '../types/pond';
import type { Gate } from '../types/gate';
import type { Observation } from '../types/observation';
import type { Assay } from '../types/assay';
import type { Schedule, ScheduleState } from '../types/schedule';
import type { PumpBatch, PumpReceipt, PumpReceiptDraft } from '../types/pump';
import { estimateEvapMm } from './brine';
import { assignSlots, batchPumpedM3 } from './pump';
import { nowIso, uuid } from './id';
import { seedDatabase } from './seed';

/** 数据库名 */
export const DB_NAME = 'gbbrinepond';

/** 当前数据结构版本号（每次调整字段结构必须 +1 并补迁移） */
export const DB_SCHEMA_VERSION = 3;

/** 数据行结构修订号 */
export const ROW_REVISION = 3;

class BrinePondDatabase extends Dexie {
  ponds!: Table<Pond, string>;
  gates!: Table<Gate, string>;
  observations!: Table<Observation, string>;
  assays!: Table<Assay, string>;
  schedules!: Table<Schedule, string>;
  pumpBatches!: Table<PumpBatch, string>;
  pumpReceipts!: Table<PumpReceipt, string>;

  constructor() {
    super(DB_NAME);

    // ---------- v1：建立全部表与 pondId+date 复合索引 ----------
    this.version(1).stores({
      ponds: 'id, code, seriesName, stage, status, createdAt',
      gates: 'id, fromPondId, toPondId, state',
      observations: 'id, pondId, date, [pondId+date], densityGcm3',
      assays: 'id, pondId, date, [pondId+date], verdict',
      schedules: 'id, pondId, planDate, state, orderIndex',
    });

    // ---------- v2：新增 evapMm 字段，并为旧记录补齐默认值 ----------
    this.version(2)
      .stores({
        ponds: 'id, code, seriesName, stage, status, createdAt, updatedAt',
        gates: 'id, fromPondId, toPondId, state, openingPct',
        observations: 'id, pondId, date, [pondId+date], densityGcm3, evapMm',
        assays: 'id, pondId, date, [pondId+date], verdict, verdictManual',
        schedules: 'id, pondId, planDate, state, orderIndex',
      })
      .upgrade(async (tx) => {
        // 迁移 1：补齐 revision / createdAt / updatedAt
        const tables = [
          tx.table('ponds'),
          tx.table('gates'),
          tx.table('observations'),
          tx.table('assays'),
          tx.table('schedules'),
        ];
        for (const table of tables) {
          await table.toCollection().modify((row: Record<string, unknown>) => {
            row.revision = ROW_REVISION;
            if (typeof row.createdAt !== 'string') row.createdAt = nowIso();
            if (typeof row.updatedAt !== 'string') row.updatedAt = row.createdAt;
          });
        }
        // 迁移 2：卤水观测新增 evapMm，旧记录按密度/温度/水位/风力经验公式补齐
        await tx.table('observations').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.evapMm === 'number' && Number.isFinite(row.evapMm)) return;
          row.evapMm = estimateEvapMm(
            typeof row.densityGcm3 === 'number' ? row.densityGcm3 : 1.02,
            typeof row.tempC === 'number' ? row.tempC : 25,
            typeof row.levelCm === 'number' ? row.levelCm : 40,
            typeof row.windLevel === 'number' ? row.windLevel : 2,
          );
        });
        // 迁移 3：化验记录补齐人工覆盖标记
        await tx.table('assays').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.verdictManual !== 'boolean') row.verdictManual = false;
        });
        // 迁移 4：走水编排补齐排序序号（按计划日期兜底生成）
        await tx.table('schedules').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.orderIndex !== 'number') {
            const date = typeof row.planDate === 'string' ? row.planDate : '2026-01-01';
            row.orderIndex = Number(date.replace(/-/g, '')) || 1;
          }
        });
      });

    // ---------- v3：泵站批次与班末回执；走水单补泵送批次号 ----------
    this.version(DB_SCHEMA_VERSION)
      .stores({
        ponds: 'id, code, seriesName, stage, status, createdAt, updatedAt',
        gates: 'id, fromPondId, toPondId, state, openingPct',
        observations: 'id, pondId, date, [pondId+date], densityGcm3, evapMm',
        assays: 'id, pondId, date, [pondId+date], verdict, verdictManual',
        schedules: 'id, pondId, planDate, state, orderIndex, pumpBatchNo, slotDate',
        pumpBatches: 'id, batchNo, pondId, planDate, state',
        pumpReceipts: 'id, receiptNo, batchId, batchNo, pondId, shiftDate, state',
      })
      .upgrade(async (tx) => {
        const stamp = nowIso();
        const ponds = (await tx.table('ponds').toArray()) as Pond[];
        const pondById = new Map(ponds.map((pond) => [pond.id, pond]));
        const observations = (await tx.table('observations').toArray()) as Observation[];
        // 每池最近观测水位：旧走水单的目标水位缺省值（无观测用有效水深兜底）
        const latestLevel = new Map<string, { date: string; levelCm: number }>();
        observations.forEach((row) => {
          const hit = latestLevel.get(row.pondId);
          if (hit === undefined || row.date > hit.date) {
            latestLevel.set(row.pondId, { date: row.date, levelCm: row.levelCm });
          }
        });

        // 迁移 1：旧走水单没写泵送批次，按池号 + 计划日期补批次号；
        // 池已删除补不出来的留空串，由泵站对账页单列
        const schedulesTable = tx.table('schedules');
        const rows = (await schedulesTable.toArray()) as Array<Record<string, unknown>>;
        const STATE_RANK: Record<string, number> = { 待排: 0, 已排: 1, 走水中: 2, 已出卤: 3 };
        const batchNoByKey = new Map<string, string>();
        const migrationBatches = new Map<
          string,
          { pondId: string; pondCode: string; planDate: string; plannedM3: number; rank: number }
        >();
        for (const row of rows) {
          row.revision = ROW_REVISION;
          row.updatedAt = stamp;
          if (typeof row.slotDate !== 'string' || row.slotDate === '') row.slotDate = row.planDate;
          if (typeof row.targetLevelCm !== 'number' || !Number.isFinite(row.targetLevelCm)) {
            const pond = pondById.get(String(row.pondId));
            row.targetLevelCm = latestLevel.get(String(row.pondId))?.levelCm ?? pond?.depthCm ?? 0;
          }
          if (typeof row.pumpBatchNo !== 'string') {
            const pond = pondById.get(String(row.pondId));
            if (pond === undefined) {
              row.pumpBatchNo = '';
            } else {
              const key = `${String(row.pondId)}|${String(row.planDate)}`;
              let batchNo = batchNoByKey.get(key);
              if (batchNo === undefined) {
                batchNo = `PB-MIG-${pond.code}-${String(row.planDate).replace(/-/g, '')}`;
                batchNoByKey.set(key, batchNo);
              }
              row.pumpBatchNo = batchNo;
              // 已排 / 走水中 / 已出卤的旧单补建迁移批次；待排单只补批次号，首次排产时才建批次
              const rank = STATE_RANK[String(row.state)] ?? 0;
              if (rank >= 1) {
                const hit = migrationBatches.get(batchNo);
                if (hit === undefined) {
                  migrationBatches.set(batchNo, {
                    pondId: pond.id,
                    pondCode: pond.code,
                    planDate: String(row.planDate),
                    plannedM3: Number(row.volumeM3) || 0,
                    rank,
                  });
                } else {
                  hit.plannedM3 += Number(row.volumeM3) || 0;
                  hit.rank = Math.max(hit.rank, rank);
                }
              }
            }
          }
          await schedulesTable.put(row);
        }

        // 迁移 2：补建迁移批次行（同池同日多张走水单共享一个批次）
        const batchesTable = tx.table('pumpBatches');
        for (const [batchNo, info] of migrationBatches) {
          await batchesTable.put({
            id: uuid('pumpbatch'),
            batchNo,
            pondId: info.pondId,
            pondCode: info.pondCode,
            planDate: info.planDate,
            plannedM3: Math.round(info.plannedM3 * 10) / 10,
            state: info.rank >= 3 ? '已完批' : '泵送中',
            breakNote: '',
            createdAt: stamp,
            updatedAt: stamp,
            revision: ROW_REVISION,
          });
        }
      });
  }
}

export const db = new BrinePondDatabase();

/* ------------------------------ 初始化与播种 ------------------------------ */

let initPromise: Promise<void> | null = null;

/**
 * 打开数据库并在首屏自动播种演示数据（幂等：仅当主表为空时播种）。
 * 多次调用共用同一个 Promise，避免并发重复播种。
 */
export function initDatabase(): Promise<void> {
  if (initPromise === null) {
    initPromise = (async (): Promise<void> => {
      await db.open();
      // 首屏自动播种演示数据：仅当主表为空时执行（幂等）
      if ((await db.ponds.count()) === 0) {
        await seedDatabase();
      }
    })();
  }
  return initPromise;
}

/* -------------------------------- 蒸发池 -------------------------------- */

export async function listPonds(): Promise<Pond[]> {
  const rows = await db.ponds.toArray();
  return rows.sort((a, b) => a.seriesName.localeCompare(b.seriesName, 'zh-Hans-CN') || a.code.localeCompare(b.code));
}

export async function putPond(row: Pond): Promise<void> {
  await db.ponds.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION });
}

/** 删除蒸发池，并级联清理相关闸门、观测、化验、走水计划与泵站批次 / 回执 */
export async function removePond(id: string): Promise<void> {
  await db.transaction(
    'rw',
    [db.ponds, db.gates, db.observations, db.assays, db.schedules, db.pumpBatches, db.pumpReceipts],
    async () => {
      const gates = await db.gates.toArray();
      const related = gates.filter((gate) => gate.fromPondId === id || gate.toPondId === id).map((gate) => gate.id);
      if (related.length > 0) await db.gates.bulkDelete(related);
      await db.observations.where('pondId').equals(id).delete();
      await db.assays.where('pondId').equals(id).delete();
      await db.schedules.where('pondId').equals(id).delete();
      const batchIds = (await db.pumpBatches.where('pondId').equals(id).toArray()).map((row) => row.id);
      if (batchIds.length > 0) {
        await db.pumpReceipts.where('batchId').anyOf(batchIds).delete();
        await db.pumpBatches.bulkDelete(batchIds);
      }
      await db.pumpReceipts.where('pondId').equals(id).delete();
      await db.ponds.delete(id);
    },
  );
}

/* -------------------------------- 闸门 -------------------------------- */

export async function listGates(): Promise<Gate[]> {
  return db.gates.toArray();
}

export async function putGate(row: Gate): Promise<void> {
  await db.gates.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION });
}

/** 就地调整开度：同步推导闸门状态 */
export async function updateGateOpening(id: string, openingPct: number, state: Gate['state']): Promise<void> {
  await db.gates.update(id, { openingPct, state, updatedAt: nowIso() });
}

export async function removeGate(id: string): Promise<void> {
  await db.gates.delete(id);
}

/* ------------------------------ 卤水日观测 ------------------------------ */

export async function listObservations(): Promise<Observation[]> {
  const rows = await db.observations.toArray();
  return rows.sort((a, b) => a.date.localeCompare(b.date));
}

export async function listObservationsByPond(pondId: string): Promise<Observation[]> {
  const rows = await db.observations.where('pondId').equals(pondId).toArray();
  return rows.sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * 写入卤水日观测：同池同日仅保留一条（存在即覆盖原记录）。
 * evapMm 若未显式给出，则按经验公式自动估算。
 */
export async function upsertObservation(row: Observation): Promise<Observation> {
  const evapMm =
    Number.isFinite(row.evapMm) && row.evapMm > 0
      ? row.evapMm
      : estimateEvapMm(row.densityGcm3, row.tempC, row.levelCm, row.windLevel);
  const existing = await db.observations.where('[pondId+date]').equals([row.pondId, row.date]).first();
  const next: Observation = {
    ...row,
    id: existing === undefined ? row.id : existing.id,
    evapMm,
    createdAt: existing === undefined ? row.createdAt : existing.createdAt,
    updatedAt: nowIso(),
    revision: ROW_REVISION,
  };
  await db.observations.put(next);
  return next;
}

export async function removeObservation(id: string): Promise<void> {
  await db.observations.delete(id);
}

/* ------------------------------ 离子组分分析 ------------------------------ */

export async function listAssays(): Promise<Assay[]> {
  const rows = await db.assays.toArray();
  return rows.sort((a, b) => a.date.localeCompare(b.date));
}

export async function listAssaysByPond(pondId: string): Promise<Assay[]> {
  const rows = await db.assays.where('pondId').equals(pondId).toArray();
  return rows.sort((a, b) => a.date.localeCompare(b.date));
}

export async function putAssay(row: Assay): Promise<void> {
  await db.assays.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION });
}

export async function removeAssay(id: string): Promise<void> {
  await db.assays.delete(id);
}

/* ------------------------------ 走水编排 ------------------------------ */

export async function listSchedules(): Promise<Schedule[]> {
  const rows = await db.schedules.toArray();
  return rows.sort((a, b) => a.orderIndex - b.orderIndex || a.planDate.localeCompare(b.planDate));
}

export async function putSchedule(row: Schedule): Promise<void> {
  await db.schedules.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION });
}

export async function removeSchedule(id: string): Promise<void> {
  await db.schedules.delete(id);
}

/** 按给定 id 顺序重写排序序号（拖拽排序后调用） */
export async function reorderSchedules(orderedIds: string[]): Promise<void> {
  await db.transaction('rw', db.schedules, async () => {
    for (let index = 0; index < orderedIds.length; index += 1) {
      await db.schedules.update(orderedIds[index], { orderIndex: index + 1, updatedAt: nowIso() });
    }
  });
  await recomputeSlots();
}

/**
 * 重排泵站档位：已排 / 走水中的走水单按顺序装档，日容量满时后续单排队到次日档位。
 * 走水单新建 / 改量 / 状态流转后都要调用。
 */
export async function recomputeSlots(): Promise<void> {
  const schedules = await db.schedules.toArray();
  const slots = assignSlots(schedules);
  await db.transaction('rw', db.schedules, async () => {
    for (const row of schedules) {
      const slot = slots.get(row.id) ?? row.planDate;
      if (slot !== row.slotDate) {
        await db.schedules.update(row.id, { slotDate: slot, updatedAt: nowIso() });
      }
    }
  });
}

/**
 * 标记已排：确保泵送批次存在（没有则按池号 + 计划日期开立或复用），随后重排档位。
 * 升级迁移只补了批次号、未建批次行的旧单，首次排产时按号补建批次。
 */
export async function dispatchSchedule(scheduleId: string): Promise<{ batchNo: string; slotDate: string } | null> {
  const batchNo = await db.transaction('rw', [db.schedules, db.pumpBatches, db.ponds], async () => {
    const schedule = await db.schedules.get(scheduleId);
    if (!schedule) return null;
    const pond = await db.ponds.get(schedule.pondId);
    if (!pond) return null;
    const stamp = nowIso();
    let next = schedule.pumpBatchNo;
    if (next !== '') {
      const existing = await db.pumpBatches.where('batchNo').equals(next).first();
      if (existing === undefined) {
        await db.pumpBatches.put({
          id: uuid('pumpbatch'),
          batchNo: next,
          pondId: pond.id,
          pondCode: pond.code,
          planDate: schedule.planDate,
          plannedM3: schedule.volumeM3,
          state: '泵送中',
          breakNote: '',
          createdAt: stamp,
          updatedAt: stamp,
          revision: ROW_REVISION,
        });
      }
    } else {
      const siblings = await db.pumpBatches.where('pondId').equals(pond.id).toArray();
      const reuse = siblings.find((row) => row.planDate === schedule.planDate && row.state !== '已作废');
      if (reuse !== undefined) {
        next = reuse.batchNo;
      } else {
        const sameDay = await db.pumpBatches.where('planDate').equals(schedule.planDate).count();
        next = `PB-${schedule.planDate.replace(/-/g, '')}-${String(sameDay + 1).padStart(2, '0')}`;
        await db.pumpBatches.put({
          id: uuid('pumpbatch'),
          batchNo: next,
          pondId: pond.id,
          pondCode: pond.code,
          planDate: schedule.planDate,
          plannedM3: schedule.volumeM3,
          state: '泵送中',
          breakNote: '',
          createdAt: stamp,
          updatedAt: stamp,
          revision: ROW_REVISION,
        });
      }
    }
    await db.schedules.update(scheduleId, { state: '已排', pumpBatchNo: next, updatedAt: stamp });
    return next;
  });
  if (batchNo === null) return null;
  await recomputeSlots();
  const row = await db.schedules.get(scheduleId);
  return row === undefined ? null : { batchNo, slotDate: row.slotDate };
}

/**
 * 出卤完成回写：把蒸发池推进到下一阶段，并把最新一次观测的密度对齐到实际密度。
 */
export async function applyDischarge(scheduleId: string, actualDensity: number): Promise<void> {
  await db.transaction('rw', db.ponds, db.schedules, db.observations, async () => {
    const schedule = await db.schedules.get(scheduleId);
    if (!schedule) return;
    await db.schedules.update(scheduleId, { state: '已出卤', updatedAt: nowIso() });
    const pond = await db.ponds.get(schedule.pondId);
    if (!pond) return;
    const nextStage: Pond['stage'] = pond.stage === '钠盐' ? '钾盐' : pond.stage === '钾盐' ? '锂盐' : '锂盐';
    await db.ponds.update(pond.id, { stage: nextStage, updatedAt: nowIso() });
    const list = await db.observations.where('pondId').equals(pond.id).toArray();
    if (list.length === 0) return;
    const latest = list.reduce((acc, item) => (item.date > acc.date ? item : acc));
    const density = actualDensity > 0 ? actualDensity : latest.densityGcm3;
    await db.observations.update(latest.id, {
      densityGcm3: density,
      evapMm: estimateEvapMm(density, latest.tempC, latest.levelCm, latest.windLevel),
      updatedAt: nowIso(),
    });
  });
}

/** 推进走水状态（已排 → 走水中 的对账校验在 store 层完成；待排 → 已排 走 dispatchSchedule） */
export async function advanceScheduleState(scheduleId: string, next: ScheduleState, actualDensity: number): Promise<void> {
  if (next === '已出卤') {
    await applyDischarge(scheduleId, actualDensity);
  } else {
    await db.schedules.update(scheduleId, { state: next, updatedAt: nowIso() });
  }
  await recomputeSlots();
}

/* ------------------------------ 泵站批次与回执 ------------------------------ */

export async function listPumpBatches(): Promise<PumpBatch[]> {
  const rows = await db.pumpBatches.toArray();
  return rows.sort((a, b) => a.planDate.localeCompare(b.planDate) || a.batchNo.localeCompare(b.batchNo));
}

export async function putPumpBatch(row: PumpBatch): Promise<void> {
  await db.pumpBatches.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION });
}

export async function listPumpReceipts(): Promise<PumpReceipt[]> {
  const rows = await db.pumpReceipts.toArray();
  return rows.sort((a, b) => a.shiftDate.localeCompare(b.shiftDate) || a.receiptNo.localeCompare(b.receiptNo));
}

/**
 * 班末回执：登记当班泵送体积与时段（首版版次为 1）。
 * 累计有效回执达到批次计划量后，批次自动完批；断链批次当班也照实回执（断点续泵）。
 */
export async function issueReceipt(batchId: string, draft: PumpReceiptDraft): Promise<PumpReceipt> {
  return db.transaction('rw', [db.pumpBatches, db.pumpReceipts], async () => {
    const batch = await db.pumpBatches.get(batchId);
    if (!batch) throw new Error('泵送批次不存在');
    const stamp = nowIso();
    const base = `RC-${batch.batchNo}-${draft.shiftDate.replace(/-/g, '')}`;
    let receiptNo = base;
    let seq = 2;
    while ((await db.pumpReceipts.where('receiptNo').equals(receiptNo).count()) > 0) {
      receiptNo = `${base}-${seq}`;
      seq += 1;
    }
    const receipt: PumpReceipt = {
      id: uuid('receipt'),
      receiptNo,
      batchId: batch.id,
      batchNo: batch.batchNo,
      pondId: batch.pondId,
      pondCode: batch.pondCode,
      volumeM3: draft.volumeM3,
      periodStart: draft.periodStart,
      periodEnd: draft.periodEnd,
      shiftDate: draft.shiftDate,
      version: 1,
      state: '有效',
      supersedesId: null,
      voidReason: '',
      createdAt: stamp,
      updatedAt: stamp,
      revision: ROW_REVISION,
    };
    await db.pumpReceipts.put(receipt);
    const pumped = batchPumpedM3(batch.batchNo, [...(await db.pumpReceipts.where('batchId').equals(batchId).toArray())]);
    if (pumped >= batch.plannedM3 && batch.state !== '已完批') {
      await db.pumpBatches.update(batchId, { state: '已完批', updatedAt: stamp });
    }
    return receipt;
  });
}

/** 断链：批次中断等待续泵。断点续泵策略 —— 批次号不变，已泵体积保留在回执链上 */
export async function breakBatch(batchId: string, note: string): Promise<void> {
  await db.pumpBatches.update(batchId, { state: '断链待续', breakNote: note, updatedAt: nowIso() });
}

/** 续泵：从断点接着泵，余量随续泵班次核销容量 */
export async function resumeBatch(batchId: string): Promise<void> {
  await db.pumpBatches.update(batchId, { state: '泵送中', breakNote: '', updatedAt: nowIso() });
}

export interface ReissueResult {
  receipt: PumpReceipt;
  /** 被退回待排的走水单张数 */
  affected: number;
}

/**
 * 改口径重出回执：作废旧版（留档可查）、以新体积出具新版（版次 +1，指回被作废版）；
 * 用过旧版的走水单（走水中）退回「待排」并按新体积重算计划量，随后重排档位。
 */
export async function reissueReceipt(oldReceiptId: string, newVolumeM3: number, reason: string): Promise<ReissueResult | null> {
  const result = await db.transaction('rw', [db.pumpReceipts, db.schedules, db.pumpBatches], async () => {
    const old = await db.pumpReceipts.get(oldReceiptId);
    if (!old || old.state !== '有效') return null;
    const stamp = nowIso();
    await db.pumpReceipts.update(old.id, { state: '已作废', voidReason: reason, updatedAt: stamp });
    const receipt: PumpReceipt = {
      ...old,
      id: uuid('receipt'),
      volumeM3: newVolumeM3,
      version: old.version + 1,
      state: '有效',
      supersedesId: old.id,
      voidReason: '',
      createdAt: stamp,
      updatedAt: stamp,
      revision: ROW_REVISION,
    };
    await db.pumpReceipts.put(receipt);
    // 用过旧版回执的走水单退回待排、按新体积重算（已出卤的不再回退）
    const affected = await db.schedules.where('pumpBatchNo').equals(old.batchNo).toArray();
    let count = 0;
    for (const row of affected) {
      if (row.state !== '走水中') continue;
      await db.schedules.update(row.id, { state: '待排', volumeM3: newVolumeM3, updatedAt: stamp });
      count += 1;
    }
    // 批次完批状态按新口径回退：累计不足计划量时回到泵送中
    const batch = await db.pumpBatches.get(old.batchId);
    if (batch && batch.state === '已完批') {
      const receipts = await db.pumpReceipts.where('batchId').equals(old.batchId).toArray();
      if (batchPumpedM3(batch.batchNo, receipts) < batch.plannedM3) {
        await db.pumpBatches.update(batch.id, { state: '泵送中', updatedAt: stamp });
      }
    }
    return { receipt, affected: count };
  });
  if (result !== null) await recomputeSlots();
  return result;
}

/* ---------------------------- 整库快照 ---------------------------- */

export interface DatabaseSnapshot {
  name: string;
  schemaVersion: number;
  exportedAt: string;
  ponds: Pond[];
  gates: Gate[];
  observations: Observation[];
  assays: Assay[];
  schedules: Schedule[];
  pumpBatches: PumpBatch[];
  pumpReceipts: PumpReceipt[];
}

export async function exportSnapshot(): Promise<DatabaseSnapshot> {
  const [ponds, gates, observations, assays, schedules, pumpBatches, pumpReceipts] = await Promise.all([
    db.ponds.toArray(),
    db.gates.toArray(),
    db.observations.toArray(),
    db.assays.toArray(),
    db.schedules.toArray(),
    db.pumpBatches.toArray(),
    db.pumpReceipts.toArray(),
  ]);
  return {
    name: DB_NAME,
    schemaVersion: DB_SCHEMA_VERSION,
    exportedAt: nowIso(),
    ponds,
    gates,
    observations,
    assays,
    schedules,
    pumpBatches,
    pumpReceipts,
  };
}

const SNAPSHOT_TABLES = [
  () => db.ponds,
  () => db.gates,
  () => db.observations,
  () => db.assays,
  () => db.schedules,
  () => db.pumpBatches,
  () => db.pumpReceipts,
] as const;

export async function importSnapshot(snapshot: DatabaseSnapshot): Promise<void> {
  await db.transaction(
    'rw',
    [db.ponds, db.gates, db.observations, db.assays, db.schedules, db.pumpBatches, db.pumpReceipts],
    async () => {
      await Promise.all(SNAPSHOT_TABLES.map((table) => table().clear()));
      await db.ponds.bulkPut(snapshot.ponds.map((row) => ({ ...row, revision: ROW_REVISION })));
      await db.gates.bulkPut(snapshot.gates.map((row) => ({ ...row, revision: ROW_REVISION })));
      await db.observations.bulkPut(snapshot.observations.map((row) => ({ ...row, revision: ROW_REVISION })));
      await db.assays.bulkPut(snapshot.assays.map((row) => ({ ...row, revision: ROW_REVISION })));
      await db.schedules.bulkPut(snapshot.schedules.map((row) => ({ ...row, revision: ROW_REVISION })));
      // v2 及更早的存档没有泵站表，按空数组兜底
      await db.pumpBatches.bulkPut((snapshot.pumpBatches ?? []).map((row) => ({ ...row, revision: ROW_REVISION })));
      await db.pumpReceipts.bulkPut((snapshot.pumpReceipts ?? []).map((row) => ({ ...row, revision: ROW_REVISION })));
    },
  );
}

export async function resetDatabase(): Promise<void> {
  await db.transaction(
    'rw',
    [db.ponds, db.gates, db.observations, db.assays, db.schedules, db.pumpBatches, db.pumpReceipts],
    async () => {
      await Promise.all(SNAPSHOT_TABLES.map((table) => table().clear()));
    },
  );
  await seedDatabase();
}

export async function countAll(): Promise<Record<string, number>> {
  const [ponds, gates, observations, assays, schedules, pumpBatches, pumpReceipts] = await Promise.all([
    db.ponds.count(),
    db.gates.count(),
    db.observations.count(),
    db.assays.count(),
    db.schedules.count(),
    db.pumpBatches.count(),
    db.pumpReceipts.count(),
  ]);
  return { ponds, gates, observations, assays, schedules, pumpBatches, pumpReceipts };
}
