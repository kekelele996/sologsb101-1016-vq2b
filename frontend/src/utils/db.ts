/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据库名：gbbrinepond
 * - v1：建立全部表与 pondId+date 复合索引
 * - v2：新增 evapMm 字段并写入升级迁移逻辑，旧记录自动补齐默认值
 * - v3：新增泵站 / 泵送批次 / 泵站回执三表；走水单补对账字段；
 *       旧走水单没有泵送批次的，按池号补批次，补不出来的单列
 * 纯前端应用：不依赖任何后端服务或外部接口。
 */
import Dexie, { type Table } from 'dexie';
import type { Pond } from '../types/pond';
import type { Gate } from '../types/gate';
import type { Observation } from '../types/observation';
import type { Assay } from '../types/assay';
import type { Schedule, ScheduleState } from '../types/schedule';
import type { PumpStation } from '../types/pumpStation';
import type { PumpBatch } from '../types/pumpBatch';
import type { PumpReceipt, PumpReceiptDraft, PumpReceiptReissueDraft } from '../types/pumpReceipt';
import { CHAIN_POLICY, DEFAULT_DAILY_CAPACITY_M3, STATION_ID } from '../types/pumpStation';
import { estimateEvapMm } from './brine';
import { batchPumpedVolume, checkReconcile, receiptsVoidImpact } from './pumping';
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
  pumpStations!: Table<PumpStation, string>;
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

    // ---------- v3：泵站 / 批次 / 回执三表 + 走水单对账字段 ----------
    this.version(DB_SCHEMA_VERSION)
      .stores({
        ponds: 'id, code, seriesName, stage, status, createdAt, updatedAt',
        gates: 'id, fromPondId, toPondId, state, openingPct',
        observations: 'id, pondId, date, [pondId+date], densityGcm3, evapMm',
        assays: 'id, pondId, date, [pondId+date], verdict, verdictManual',
        schedules: 'id, pondId, planDate, state, orderIndex, batchCode, receiptId',
        pumpStations: 'id, name, updatedAt',
        pumpBatches: 'id, code, startDate, state',
        pumpReceipts: 'id, batchId, pondId, batchCode, state, version, reissuesId, supersededById',
      })
      .upgrade(async (tx) => {
        // 迁移 1：补泵站参数行（容量上限 + 断链口径）
        const stationTable = tx.table('pumpStations');
        const stationCount = await stationTable.count();
        if (stationCount === 0) {
          await stationTable.add({
            id: STATION_ID,
            name: '盐田外输泵站',
            dailyCapacityM3: DEFAULT_DAILY_CAPACITY_M3,
            chainPolicy: CHAIN_POLICY,
            createdAt: nowIso(),
            updatedAt: nowIso(),
            revision: ROW_REVISION,
          });
        }

        // 迁移 2：走水单补对账字段
        await tx.table('schedules').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.batchCode !== 'string') row.batchCode = '';
          if (typeof row.receiptId !== 'string') row.receiptId = '';
          if (typeof row.receiptVersion !== 'number') row.receiptVersion = 0;
          if (typeof row.reconciledAt !== 'string') row.reconciledAt = '';
        });

        // 迁移 3：旧数据没写泵送批次 —— 按池号补；补不出池号（池已删除）的单列
        const ponds = (await tx.table('ponds').toArray()) as Pond[];
        const schedules = (await tx.table('schedules').toArray()) as Schedule[];
        const pondById = new Map(ponds.map((pond) => [pond.id, pond]));
        if (schedules.length > 0) {
          const stamp = nowIso();
          const byPond = new Map<string, Schedule[]>();
          const dangling: Schedule[] = [];
          schedules.forEach((row) => {
            if (pondById.has(row.pondId)) {
              const list = byPond.get(row.pondId) ?? [];
              list.push(row);
              byPond.set(row.pondId, list);
            } else {
              dangling.push(row);
            }
          });

          const batches: PumpBatch[] = [];
          const scheduleUpdates: Array<{ id: string; batchCode: string }> = [];
          byPond.forEach((list, pondId) => {
            const pond = pondById.get(pondId)!;
            const dates = list.map((row) => row.planDate).sort();
            const planned = list.reduce((acc, row) => acc + row.volumeM3, 0);
            const pumped = list
              .filter((row) => row.state === '走水中' || row.state === '已出卤')
              .reduce((acc, row) => acc + row.volumeM3, 0);
            const allDone = list.length > 0 && list.every((row) => row.state === '已出卤');
            batches.push({
              id: `batch-legacy-${pondId}`,
              code: `LEG-${pond.code}`,
              startDate: dates[0] ?? '2026-01-01',
              shift: '早班',
              plannedVolumeM3: Math.round(planned * 10) / 10,
              pumpedVolumeM3: Math.round(pumped * 10) / 10,
              state: allDone ? '已完结' : '在泵',
              note: '升级补录：旧数据未写泵送批次，按池号补建',
              createdAt: stamp,
              updatedAt: stamp,
              revision: ROW_REVISION,
            });
            list.forEach((row) => scheduleUpdates.push({ id: row.id, batchCode: `LEG-${pond.code}` }));
          });

          if (dangling.length > 0) {
            const dates = dangling.map((row) => row.planDate).sort();
            const planned = dangling.reduce((acc, row) => acc + row.volumeM3, 0);
            const pumped = dangling
              .filter((row) => row.state === '走水中' || row.state === '已出卤')
              .reduce((acc, row) => acc + row.volumeM3, 0);
            batches.push({
              id: 'batch-legacy-unmatched',
              code: 'LEG-未匹配池',
              startDate: dates[0] ?? '2026-01-01',
              shift: '早班',
              plannedVolumeM3: Math.round(planned * 10) / 10,
              pumpedVolumeM3: Math.round(pumped * 10) / 10,
              state: '在泵',
              note: '升级补录：池号补不出来的走水单单列于此',
              createdAt: stamp,
              updatedAt: stamp,
              revision: ROW_REVISION,
            });
            dangling.forEach((row) => scheduleUpdates.push({ id: row.id, batchCode: 'LEG-未匹配池' }));
          }

          const pumpBatchTable = tx.table('pumpBatches');
          for (const batch of batches) {
            // 幂等：重复升级不重复补
            const existing = await pumpBatchTable.get(batch.id);
            if (existing === undefined) await pumpBatchTable.add(batch);
          }
          // 统一写回旧走水单的批次号（按池号补的结果）
          for (const update of scheduleUpdates) {
            await tx.table('schedules').update(update.id, { batchCode: update.batchCode });
          }
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
      // 泵站参数行兜底（老库 / 旧存档导入后也保证有一行）
      if ((await db.pumpStations.count()) === 0) {
        await db.pumpStations.add({
          id: STATION_ID,
          name: '盐田外输泵站',
          dailyCapacityM3: DEFAULT_DAILY_CAPACITY_M3,
          chainPolicy: CHAIN_POLICY,
          createdAt: nowIso(),
          updatedAt: nowIso(),
          revision: ROW_REVISION,
        });
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

/** 删除蒸发池，并级联清理相关闸门、观测、化验、走水计划与泵站回执 */
export async function removePond(id: string): Promise<void> {
  await db.transaction(
    'rw',
    [db.ponds, db.gates, db.observations, db.assays, db.schedules, db.pumpReceipts],
    async () => {
      const gates = await db.gates.toArray();
      const related = gates.filter((gate) => gate.fromPondId === id || gate.toPondId === id).map((gate) => gate.id);
      if (related.length > 0) await db.gates.bulkDelete(related);
      await db.observations.where('pondId').equals(id).delete();
      await db.assays.where('pondId').equals(id).delete();
      await db.schedules.where('pondId').equals(id).delete();
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

/**
 * 推进走水状态。
 * 已排 → 走水中 必须先经泵站回执对账（schedule.receiptId 非空），由 reconcileSchedule 写入。
 */
export async function advanceScheduleState(scheduleId: string, next: ScheduleState, actualDensity: number): Promise<void> {
  if (next === '已出卤') {
    await applyDischarge(scheduleId, actualDensity);
    return;
  }
  if (next === '走水中') {
    const current = await db.schedules.get(scheduleId);
    if (current && current.receiptId === '') {
      throw new Error('请先在「泵站外输」按池号 + 批次对账，对账通过后才进入走水中');
    }
  }
  await db.schedules.update(scheduleId, { state: next, updatedAt: nowIso() });
}

/* -------------------------------- 泵站 -------------------------------- */

export async function getStation(): Promise<PumpStation> {
  const existing = await db.pumpStations.get(STATION_ID);
  if (existing !== undefined) return existing;
  const row: PumpStation = {
    id: STATION_ID,
    name: '盐田外输泵站',
    dailyCapacityM3: DEFAULT_DAILY_CAPACITY_M3,
    chainPolicy: CHAIN_POLICY,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    revision: ROW_REVISION,
  };
  await db.pumpStations.put(row);
  return row;
}

export async function updateStation(draft: { name: string; dailyCapacityM3: number }): Promise<PumpStation> {
  const current = await getStation();
  const next: PumpStation = {
    ...current,
    name: draft.name.trim() || current.name,
    dailyCapacityM3: draft.dailyCapacityM3 > 0 ? draft.dailyCapacityM3 : current.dailyCapacityM3,
    // 断链口径固定为「断点续泵」，容量口径跟着它走
    chainPolicy: CHAIN_POLICY,
    updatedAt: nowIso(),
    revision: ROW_REVISION,
  };
  await db.pumpStations.put(next);
  return next;
}

/* ------------------------------- 泵送批次 ------------------------------- */

export async function listBatches(): Promise<PumpBatch[]> {
  const rows = await db.pumpBatches.toArray();
  return rows.sort((a, b) => b.startDate.localeCompare(a.startDate) || a.code.localeCompare(b.code));
}

export async function getBatch(id: string): Promise<PumpBatch | undefined> {
  return db.pumpBatches.get(id);
}

/** 重算批次累计已泵量（生效回执分段累计，断点续泵口径） */
async function refreshBatchVolume(batchId: string): Promise<void> {
  const receipts = await db.pumpReceipts.where('batchId').equals(batchId).toArray();
  const pumped = batchPumpedVolume(batchId, receipts);
  await db.pumpBatches.update(batchId, { pumpedVolumeM3: pumped, updatedAt: nowIso() });
}

export async function putBatch(row: PumpBatch): Promise<void> {
  await db.pumpBatches.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION });
}

/** 删除批次：其下回执一并删除，用过这些回执的走水单退回待排 */
export async function removeBatch(id: string): Promise<void> {
  await db.transaction('rw', db.pumpBatches, db.pumpReceipts, db.schedules, async () => {
    const receipts = await db.pumpReceipts.where('batchId').equals(id).toArray();
    const impacted = receiptsVoidImpact(
      receipts.map((receipt) => receipt.id),
      await db.schedules.toArray(),
    );
    for (const schedule of impacted) {
      await db.schedules.update(schedule.id, {
        state: '待排' as ScheduleState,
        receiptId: '',
        receiptVersion: 0,
        reconciledAt: '',
        updatedAt: nowIso(),
      });
    }
    await db.pumpReceipts.where('batchId').equals(id).delete();
    await db.pumpBatches.delete(id);
  });
}

/* ------------------------------- 泵站回执 ------------------------------- */

export async function listReceipts(): Promise<PumpReceipt[]> {
  const rows = await db.pumpReceipts.toArray();
  return rows.sort((a, b) => b.endTime.localeCompare(a.endTime) || a.code.localeCompare(b.code));
}

/** 班末补录回执（初版，version = 1） */
export async function createReceipt(draft: PumpReceiptDraft): Promise<PumpReceipt> {
  const batch = await db.pumpBatches.get(draft.batchId);
  if (batch === undefined) throw new Error('泵送批次不存在，无法补录回执');
  const stamp = nowIso();
  const receipt: PumpReceipt = {
    id: uuid('receipt'),
    code: draft.code.trim(),
    batchId: draft.batchId,
    pondId: draft.pondId,
    batchCode: batch.code,
    volumeM3: draft.volumeM3,
    startTime: draft.startTime,
    endTime: draft.endTime,
    shift: draft.shift,
    levelAfterCm: draft.levelAfterCm,
    levelConfirmed: draft.levelConfirmed,
    version: 1,
    state: '生效',
    reissuesId: '',
    supersededById: '',
    voidReason: '',
    createdAt: stamp,
    updatedAt: stamp,
    revision: ROW_REVISION,
  };
  await db.transaction('rw', db.pumpReceipts, db.pumpBatches, async () => {
    await db.pumpReceipts.put(receipt);
    await refreshBatchVolume(draft.batchId);
  });
  return receipt;
}

/**
 * 改口径重出回执：
 * 原版置「已作废」并保留（supersededById 指向新版），新版本号 +1；
 * 用过旧版对账的走水单全部退回「待排」解除对账，按新体积重新对账。
 */
export async function reissueReceipt(
  receiptId: string,
  draft: PumpReceiptReissueDraft,
): Promise<{ newReceipt: PumpReceipt; affectedScheduleIds: string[] }> {
  return db.transaction('rw', db.pumpReceipts, db.schedules, db.pumpBatches, async () => {
    const old = await db.pumpReceipts.get(receiptId);
    if (old === undefined) throw new Error('回执不存在');
    if (old.state !== '生效') throw new Error('只有生效中的回执才能改口径重出');

    const stamp = nowIso();
    const nextVersion = old.version + 1;
    const newReceipt: PumpReceipt = {
      ...old,
      id: uuid('receipt'),
      code: `${old.code}-V${nextVersion}`,
      volumeM3: draft.volumeM3,
      startTime: draft.startTime,
      endTime: draft.endTime,
      levelAfterCm: draft.levelAfterCm,
      levelConfirmed: draft.levelConfirmed,
      version: nextVersion,
      state: '生效',
      reissuesId: old.id,
      supersededById: '',
      voidReason: '',
      createdAt: stamp,
      updatedAt: stamp,
      revision: ROW_REVISION,
    };

    // 用过旧版的走水单退回待排、解除对账（批次意向保留，按新体积重新对账）
    const affected = await db.schedules.where('receiptId').equals(old.id).toArray();
    for (const schedule of affected) {
      await db.schedules.update(schedule.id, {
        state: '待排' as ScheduleState,
        receiptId: '',
        receiptVersion: 0,
        reconciledAt: '',
        updatedAt: stamp,
      });
    }

    await db.pumpReceipts.update(old.id, {
      state: '已作废',
      supersededById: newReceipt.id,
      voidReason: draft.voidReason.trim() || '泵站改口径重出',
      updatedAt: stamp,
    });
    await db.pumpReceipts.put(newReceipt);
    await refreshBatchVolume(old.batchId);

    return { newReceipt, affectedScheduleIds: affected.map((row) => row.id) };
  });
}

/**
 * 走水对账：池号 + 批次一致、回执生效、水位落到位 → 走水单进入「走水中」。
 */
export async function reconcileSchedule(scheduleId: string, receiptId: string): Promise<Schedule> {
  return db.transaction('rw', db.schedules, db.pumpReceipts, async () => {
    const schedule = await db.schedules.get(scheduleId);
    if (schedule === undefined) throw new Error('走水单不存在');
    const receipt = await db.pumpReceipts.get(receiptId);
    if (receipt === undefined) throw new Error('回执不存在');
    const check = checkReconcile(schedule, receipt);
    if (!check.ok) throw new Error(check.reason);
    const next: Schedule = {
      ...schedule,
      state: '走水中',
      batchCode: receipt.batchCode,
      receiptId: receipt.id,
      receiptVersion: receipt.version,
      reconciledAt: nowIso(),
      updatedAt: nowIso(),
      revision: ROW_REVISION,
    };
    await db.schedules.put(next);
    return next;
  });
}

/** 解除对账：走水单退回「待排」 */
export async function unlinkScheduleReceipt(scheduleId: string): Promise<void> {
  await db.schedules.update(scheduleId, {
    state: '待排',
    receiptId: '',
    receiptVersion: 0,
    reconciledAt: '',
    updatedAt: nowIso(),
  });
}

/* ---------------------------- 整库快照 ---------------------------- */

export interface DatabaseSnapshot {
  name: string
  schemaVersion: number
  exportedAt: string
  ponds: Pond[]
  gates: Gate[]
  observations: Observation[]
  assays: Assay[]
  schedules: Schedule[]
  pumpStations: PumpStation[]
  pumpBatches: PumpBatch[]
  pumpReceipts: PumpReceipt[]
}

export async function exportSnapshot(): Promise<DatabaseSnapshot> {
  const [ponds, gates, observations, assays, schedules, pumpStations, pumpBatches, pumpReceipts] = await Promise.all([
    db.ponds.toArray(),
    db.gates.toArray(),
    db.observations.toArray(),
    db.assays.toArray(),
    db.schedules.toArray(),
    db.pumpStations.toArray(),
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
    pumpStations,
    pumpBatches,
    pumpReceipts,
  };
}

export async function importSnapshot(snapshot: DatabaseSnapshot): Promise<void> {
  await db.transaction(
    'rw',
    [db.ponds, db.gates, db.observations, db.assays, db.schedules, db.pumpStations, db.pumpBatches, db.pumpReceipts],
    async () => {
      await Promise.all([
        db.ponds.clear(),
        db.gates.clear(),
        db.observations.clear(),
        db.assays.clear(),
        db.schedules.clear(),
        db.pumpStations.clear(),
        db.pumpBatches.clear(),
        db.pumpReceipts.clear(),
      ]);
      await db.ponds.bulkPut(snapshot.ponds.map((row) => ({ ...row, revision: ROW_REVISION })));
      await db.gates.bulkPut(snapshot.gates.map((row) => ({ ...row, revision: ROW_REVISION })));
      await db.observations.bulkPut(snapshot.observations.map((row) => ({ ...row, revision: ROW_REVISION })));
      await db.assays.bulkPut(snapshot.assays.map((row) => ({ ...row, revision: ROW_REVISION })));
      await db.schedules.bulkPut(
        snapshot.schedules.map((row) => ({
          ...row,
          batchCode: typeof row.batchCode === 'string' ? row.batchCode : '',
          receiptId: typeof row.receiptId === 'string' ? row.receiptId : '',
          receiptVersion: typeof row.receiptVersion === 'number' ? row.receiptVersion : 0,
          reconciledAt: typeof row.reconciledAt === 'string' ? row.reconciledAt : '',
          revision: ROW_REVISION,
        })),
      );
      await db.pumpStations.bulkPut(snapshot.pumpStations.map((row) => ({ ...row, revision: ROW_REVISION })));
      await db.pumpBatches.bulkPut(snapshot.pumpBatches.map((row) => ({ ...row, revision: ROW_REVISION })));
      await db.pumpReceipts.bulkPut(snapshot.pumpReceipts.map((row) => ({ ...row, revision: ROW_REVISION })));
    },
  );
  // 导入 v2 旧存档（无泵站表）后兜底参数行
  if ((await db.pumpStations.count()) === 0) {
    await db.pumpStations.add({
      id: STATION_ID,
      name: '盐田外输泵站',
      dailyCapacityM3: DEFAULT_DAILY_CAPACITY_M3,
      chainPolicy: CHAIN_POLICY,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      revision: ROW_REVISION,
    });
  }
}

export async function resetDatabase(): Promise<void> {
  await db.transaction(
    'rw',
    [db.ponds, db.gates, db.observations, db.assays, db.schedules, db.pumpStations, db.pumpBatches, db.pumpReceipts],
    async () => {
      await Promise.all([
        db.ponds.clear(),
        db.gates.clear(),
        db.observations.clear(),
        db.assays.clear(),
        db.schedules.clear(),
        db.pumpStations.clear(),
        db.pumpBatches.clear(),
        db.pumpReceipts.clear(),
      ]);
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
