import { BulkVouchers } from '@/components/orders/logistics/bulk-vouchers'

// Bulk vouchers of PR-04. A separate page on purpose: "Pedidos confirmados" keeps its own list untouched. What each user can do is decided by the
// server (flag + operational area): anyone else gets the notice, never the tool.
export default function BulkVouchersPage() {
  return <BulkVouchers />
}
