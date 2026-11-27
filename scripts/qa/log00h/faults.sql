-- QA database ONLY (installed by seed.mjs, never part of a migration): server-side failures on two sentinel amounts,
-- so that the payment error paths can be exercised without touching application code.
create or replace function public.qa_fail_payment() returns trigger language plpgsql as
$$ begin raise exception 'qa_injected_failure'; end $$;

drop trigger if exists qa_fail_register on public.order_payments;
create trigger qa_fail_register before insert on public.order_payments
  for each row when (new.amount = 11.11) execute function public.qa_fail_payment();

drop trigger if exists qa_fail_confirm on public.order_payments;
create trigger qa_fail_confirm before update on public.order_payments
  for each row when (new.status = 'confirmed' and new.amount = 13.13) execute function public.qa_fail_payment();
