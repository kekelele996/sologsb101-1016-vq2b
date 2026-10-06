/**
 * 泵站回执（PumpReceipt）
 * 泵站班末把「泵送体积 + 时段」回给调度端；调度端按「池号 + 批次」与走水单对账：
 * 泵站这段收了货（回执生效）、水位也落到位，走水单才进「走水中」。
 *
 * 泵站改口径重出回执时：
 * - 原回执置为「已作废」（记录 supersededBy），永不物理删除；
 * - 新回执 version 递增、reissuesId 指向原版，前后两版都留着可查；
 * - 用过旧版对账的走水单全部退回「待排」，解除对账后按新体积重新对账（见 utils/pumping.ts）。
 */

/** 回执状态：生效（当前可用版本） / 已作废（被新版替换） */
export type ReceiptState = '生效' | '已作废'

export const RECEIPT_STATE_OPTIONS: ReceiptState[] = ['生效', '已作废']

export interface PumpReceipt {
  id: string
  /** 回执单号（班末报量唯一凭证） */
  code: string
  /** 批次号（泵送批次 id） */
  batchId: string
  /** 收货蒸发池（对账键之一：池号） */
  pondId: string
  /** 对应批次号文本冗余（对账键之二：批次，直接取批次 code） */
  batchCode: string
  /** 班末泵送体积（m³） */
  volumeM3: number
  /** 泵运起：ISO 时间 */
  startTime: string
  /** 泵运止：ISO 时间 */
  endTime: string
  /** 班别 */
  shift: string
  /** 调度端确认水位已落到位（cm）；与生效回执同时满足，走水单才进「走水中」 */
  levelAfterCm: number
  /** 水位是否确认落到位 */
  levelConfirmed: boolean
  /** 版本号，初版 = 1，改口径重出逐版 +1 */
  version: number
  /** 生效 / 已作废 */
  state: ReceiptState
  /** 重出时指向被替换的原版 id（初版为空） */
  reissuesId: string
  /** 被作废时指向替换它的新版 id */
  supersededById: string
  /** 作废 / 重出原因 */
  voidReason: string
  createdAt: string
  updatedAt: string
  revision: number
}

/** 班末补录回执的表单草稿（初版） */
export interface PumpReceiptDraft {
  code: string
  batchId: string
  pondId: string
  volumeM3: number
  startTime: string
  endTime: string
  shift: string
  levelAfterCm: number
  levelConfirmed: boolean
}

/** 改口径重出回执的表单草稿（基于已作废原版生成新版） */
export interface PumpReceiptReissueDraft {
  volumeM3: number
  startTime: string
  endTime: string
  levelAfterCm: number
  levelConfirmed: boolean
  voidReason: string
}
