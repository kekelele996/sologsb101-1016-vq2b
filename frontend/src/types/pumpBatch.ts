/**
 * 泵送批次（PumpBatch）
 * 泵站按批次开机：一批水对应一个批次号，班末把泵送体积与时段报给调度端。
 * 断链时按全站口径「断点续泵」——沿用同一批次，已泵量不回滚、容量不重复占。
 */

/** 批次状态：在泵（含断链待续） / 已完结（整批泵完） */
export type PumpBatchState = '在泵' | '已完结'

export const PUMP_BATCH_STATE_OPTIONS: PumpBatchState[] = ['在泵', '已完结']

export interface PumpBatch {
  id: string
  /** 批次号（泵站段唯一，如 PB-20261006-01） */
  code: string
  /** 开机日期 YYYY-MM-DD：容量按这一日档位锁定，断链续泵不换档位 */
  startDate: string
  /** 班次：早班 / 中班 / 晚班 */
  shift: string
  /** 计划泵送量（m³，开机令口径） */
  plannedVolumeM3: number
  /** 累计已泵体积（m³，= 生效回执体积之和，断链续泵分段累加） */
  pumpedVolumeM3: number
  /** 批次状态 */
  state: PumpBatchState
  /** 备注（断链经过等） */
  note: string
  createdAt: string
  updatedAt: string
  revision: number
}

/** 新建 / 编辑泵送批次的表单草稿 */
export interface PumpBatchDraft {
  code: string
  startDate: string
  shift: string
  plannedVolumeM3: number
  state: PumpBatchState
  note: string
}

/** 班次选项 */
export const SHIFT_OPTIONS = ['早班', '中班', '晚班'] as const
