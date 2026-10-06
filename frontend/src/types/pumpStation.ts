/**
 * 泵站（PumpStation）
 * 盐田往外输卤的泵站参数：单日泵送容量上限与断链处置口径。
 * 纯前端单机台账，固定只有一行（id = STATION_ID）。
 */

/**
 * 断链处置策略（全站口径）：
 * - 断点续泵：同一批次号延续，班末回执分段累计，容量只在开机日占一次（本系统采用）
 * - 作废重开：原批次与回执作废、另开新批次，容量释放后重新占用（仅作文档对照，不落地）
 */
export type ChainPolicy = '断点续泵' | '作废重开'

/** 全站统一采用的断链口径：断点续泵（容量口径跟着它走，见 utils/pumping.ts） */
export const CHAIN_POLICY: ChainPolicy = '断点续泵'

export const CHAIN_POLICY_OPTIONS: ChainPolicy[] = ['断点续泵', '作废重开']

/** 泵站台账固定主键（全库只有一行参数） */
export const STATION_ID = 'station-main'

/** 出厂默认单日泵送容量上限（m³/日） */
export const DEFAULT_DAILY_CAPACITY_M3 = 3000

export interface PumpStation {
  id: string
  /** 泵站名称 */
  name: string
  /** 单日泵送容量上限（m³/日）：容量满了之后的走水单排队到次日档位 */
  dailyCapacityM3: number
  /** 断链处置口径（本系统固定为「断点续泵」） */
  chainPolicy: ChainPolicy
  createdAt: string
  updatedAt: string
  revision: number
}

/** 编辑泵站参数的表单草稿 */
export interface PumpStationDraft {
  name: string
  dailyCapacityM3: number
}
