/**
 * 走水编排（Schedule）
 * 按日期排序的走水与出卤计划，可通过拖拽调整先后顺序。
 */

/** 走水状态：待排 / 已排 / 走水中 / 已出卤 */
export type ScheduleState = '待排' | '已排' | '走水中' | '已出卤'

export const SCHEDULE_STATE_OPTIONS: ScheduleState[] = ['待排', '已排', '走水中', '已出卤']

/** 状态推进顺序 */
export const SCHEDULE_STATE_FLOW: ScheduleState[] = ['待排', '已排', '走水中', '已出卤']

export interface Schedule {
  id: string
  /** 所属蒸发池 */
  pondId: string
  /** 计划走水日期 YYYY-MM-DD */
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
  /** 关联泵送批次号：与泵站按「池号 + 批次号」对账；空串表示尚未开立批次（待排单标记已排时自动开立） */
  pumpBatchNo: string
  /** 泵站档位日期：日泵送容量满时，后续走水单排队到次日档位 */
  slotDate: string
  /** 目标水位（cm）：走水后水位应落到该线以下，是对账「水位落到位」的判定线 */
  targetLevelCm: number
  createdAt: string
  updatedAt: string
  revision: number
}

/** 新建 / 编辑走水编排的表单草稿（批次号与档位由系统维护，不进表单） */
export interface ScheduleDraft {
  pondId: string
  planDate: string
  targetDensity: number
  volumeM3: number
  operator: string
  state: ScheduleState
  orderIndex: number
  targetLevelCm: number
}
