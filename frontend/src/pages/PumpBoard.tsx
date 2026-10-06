/**
 * /pumping 泵站外输
 * 泵站参数与日泵送容量档位、泵送批次、班末回执（改口径重出留档）、走水对账。
 * 消费模型：PumpStation、PumpBatch、PumpReceipt、Schedule、Pond；
 * 复用组件：<StationParamsCard>、<CapacityBoard>、<BatchPanel>、<ReceiptPanel>、<ReconcilePanel>
 */
import { Show, onMount } from 'solid-js';
import StationParamsCard from '../components/pumping/StationParamsCard';
import CapacityBoard from '../components/pumping/CapacityBoard';
import BatchPanel from '../components/pumping/BatchPanel';
import ReceiptPanel from '../components/pumping/ReceiptPanel';
import ReconcilePanel from '../components/pumping/ReconcilePanel';
import { usePondStore } from '../stores/pondStore';
import { usePumpStore } from '../stores/pumpStore';

export default function PumpBoard() {
  const pondStore = usePondStore();
  const pumpStore = usePumpStore();

  onMount(() => {
    void pondStore.loadAll();
    void pumpStore.loadAll();
  });

  return (
    <div class="space-y-3.5">
      <Show when={pumpStore.state.error !== ''}>
        <div class="rounded-lg border border-rose-200 bg-rose-50 px-3.5 py-2 text-sm text-rose-700">
          泵站数据错误：{pumpStore.state.error}
        </div>
      </Show>

      <Show when={pumpStore.state.lastMessage !== ''}>
        <div class="rounded-lg border border-brine-200 bg-brine-50 px-3.5 py-2 text-sm text-brine-800">
          {pumpStore.state.lastMessage}
        </div>
      </Show>

      <StationParamsCard />
      <CapacityBoard />
      <ReconcilePanel />
      <BatchPanel />
      <ReceiptPanel />
    </div>
  );
}
