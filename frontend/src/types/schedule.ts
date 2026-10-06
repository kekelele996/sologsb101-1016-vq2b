/**
 * 走水编排（Schedule）
 * 按日期排序的走水与出卤计划，可通过拖拽调整先后顺序。
 * 排一批走水时与泵站按「池号 + 批次」对账：对账到生效回执且水位落到位才进「走水中」。
 */

/** 走水状态：待排 / 已排 / 走水中 / 已出卤 */
export type ScheduleState = '待排' | '已排' | '走水中' | '已出卤'

export const SCHEDULE_STATE_OPTIONS: ScheduleState[] = ['待排', '已排', '走水中', '已出卤']

/** 状态推进顺序 */
export const SCHEDULE_STATE_FLOW: ScheduleState[] = ['待排', '已排', '走水中', '已出卤']

export interface Schedule {
  id: string
  /** 所属蒸发池（对账键之一：池号） */
  pondId: string
  /** 计划走水日期 YYYY-MM-DD（容量档位按此日期排队） */
  planDate: string
  /** 目标密度（g/cm³） */
  targetDensity: number
  /** 计划量（m³） */
  volumeM3: number
  /** 调度员 */
  operator: string
  /** 走水状态 */
  state: ScheduleState
  /** 手工拖拽后的排序序号，越小越先走水 */
  orderIndex: number
  /** 对账批次号文本（对账键之二：批次）；未对账为空串 */
  batchCode: string
  /** 对账使用的泵站回执 id；回执作废后清空并退回「待排」 */
  receiptId: string
  /** 对账锁定的回执版本（重出作废时据此退回） */
  receiptVersion: number
  /** 对账确认时间 ISO */
  reconciledAt: string
  createdAt: string
  updatedAt: string
  revision: number
}

/** 新建 / 编辑走水编排的表单草稿 */
export interface ScheduleDraft {
  pondId: string
  planDate: string
  targetDensity: number
  volumeM3: number
  operator: string
  state: ScheduleState
  orderIndex: number
}

/** 走水单对账入参：池号 + 批次（经回执） */
export interface ReconcilePayload {
  scheduleId: string
  receiptId: string
}
