/**
 * 泵站泵送批次（PumpBatch）与班末回执（PumpReceipt）
 * 盐田往外输卤必须经过泵站：泵站按批次开机，班末把泵送体积与时段回给调度端；
 * 调度端按「池号 + 批次号」把回执与走水编排单对账。
 *
 * 断链策略：断点续泵 —— 批次号不变，已泵体积留在回执链上，续泵从断点接着泵；
 * 容量口径跟着这个选择：按班末回执的实际泵送体积核销，断链当班只占已泵部分。
 */

/** 泵送批次状态：泵送中 / 断链待续 / 已完批 / 已作废 */
export type PumpBatchState = '泵送中' | '断链待续' | '已完批' | '已作废'

export const PUMP_BATCH_STATE_OPTIONS: PumpBatchState[] = ['泵送中', '断链待续', '已完批', '已作废']

export interface PumpBatch {
  id: string
  /** 泵送批次号（对账键之一），如 PB-20261006-01 */
  batchNo: string
  /** 对应蒸发池 */
  pondId: string
  /** 冗余池号：对账直接按池号匹配，不必每次回查 ponds 表 */
  pondCode: string
  /** 批次计划泵送日期 YYYY-MM-DD */
  planDate: string
  /** 计划泵送量（m³） */
  plannedM3: number
  /** 批次状态 */
  state: PumpBatchState
  /** 断链原因（断链待续时记录） */
  breakNote: string
  createdAt: string
  updatedAt: string
  revision: number
}

/** 回执状态：有效 / 已作废（作废留档，前后两版都可查） */
export type PumpReceiptState = '有效' | '已作废'

export const PUMP_RECEIPT_STATE_OPTIONS: PumpReceiptState[] = ['有效', '已作废']

export interface PumpReceipt {
  id: string
  /** 回执编号：同一回执链重出时编号不变，靠版次区分 */
  receiptNo: string
  /** 关联泵送批次 */
  batchId: string
  /** 冗余：批次号 + 池号，对账直接按这两个字段匹配 */
  batchNo: string
  pondId: string
  pondCode: string
  /** 本版回执确认的泵送体积（m³） */
  volumeM3: number
  /** 泵送时段（HH:MM） */
  periodStart: string
  periodEnd: string
  /** 班末回执所属班次日期 YYYY-MM-DD：容量按它核销 */
  shiftDate: string
  /** 版次：首版 1，改口径重出时 +1 */
  version: number
  /** 回执状态 */
  state: PumpReceiptState
  /** 本版重出时指向被作废的上一版回执 */
  supersedesId: string | null
  /** 作废原因（已作废时填写） */
  voidReason: string
  createdAt: string
  updatedAt: string
  revision: number
}

/** 新建泵送批次的表单草稿 */
export interface PumpBatchDraft {
  pondId: string
  planDate: string
  plannedM3: number
}

/** 班末回执的表单草稿 */
export interface PumpReceiptDraft {
  volumeM3: number
  periodStart: string
  periodEnd: string
  shiftDate: string
}
