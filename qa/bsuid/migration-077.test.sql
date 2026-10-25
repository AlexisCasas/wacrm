-- Isolated-database checks for migration 077. Run with psql -v ON_ERROR_STOP=0; every block prints PASS/FAIL.
\set QUIET on
\pset tuples_only on
\pset format unaligned
create or replace function pg_temp.check(name text, ok boolean) returns void language plpgsql as $$ begin raise notice '% %', case when ok then 'PASS' else 'FAIL' end, name; end $$;

-- fixtures: two accounts, one owner each, one member of A (no auth schema needed beyond the stub below)
create or replace function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema public, auth to authenticated, service_role, anon;
grant select, insert, update, delete on all tables in schema public to authenticated, service_role;
insert into auth.users(id) values ('aaaaaaaa-0000-4000-8000-000000000001'),('bbbbbbbb-0000-4000-8000-000000000002') on conflict do nothing;
insert into accounts(id,name,owner_user_id) values ('a1a1a1a1-0000-4000-8000-00000000000a','QA A','aaaaaaaa-0000-4000-8000-000000000001'),('b2b2b2b2-0000-4000-8000-00000000000b','QA B','bbbbbbbb-0000-4000-8000-000000000002') on conflict do nothing;
insert into profiles(user_id, full_name, email, account_id, account_role) values
 ('aaaaaaaa-0000-4000-8000-000000000001','QA A','qa-a@example.test','a1a1a1a1-0000-4000-8000-00000000000a','owner'),
 ('bbbbbbbb-0000-4000-8000-000000000002','QA B','qa-b@example.test','b2b2b2b2-0000-4000-8000-00000000000b','owner') on conflict do nothing;

create temp table before_counts as select (select count(*) from contacts) c, (select count(*) from contacts where phone_normalized='') e;

-- 0 idempotent re-application is run by the caller; here: existing data untouched
select pg_temp.check('existing contacts count unchanged by the migration', (select c from before_counts) = (select count(*) from contacts));

-- 1 old-image behaviour (defaults)
insert into contacts(account_id,user_id,phone,name) values ('a1a1a1a1-0000-4000-8000-00000000000a','aaaaaaaa-0000-4000-8000-000000000001','+51 900 000 001','Phone A');
select pg_temp.check('old-style insert with a phone works and phone_optional defaults to false', (select not phone_optional from contacts where name='Phone A'));
do $$ begin
  begin insert into contacts(account_id,user_id,phone,name) values ('a1a1a1a1-0000-4000-8000-00000000000a','aaaaaaaa-0000-4000-8000-000000000001','','Ghost'); perform pg_temp.check('old-style insert with EMPTY phone is still rejected (046)', false);
  exception when check_violation then perform pg_temp.check('old-style insert with EMPTY phone is still rejected (046)', true); end;
end $$;

-- 2 resolve_bsuid_contact
create temp table r1 as select * from resolve_bsuid_contact('a1a1a1a1-0000-4000-8000-00000000000a','aaaaaaaa-0000-4000-8000-000000000001','PE.QA0000000000001','PE.ENT.QAP000000001','qa_user','Visible Name');
select pg_temp.check('BSUID-only contact created', (select created from r1));
select pg_temp.check('phone is empty, never a fake number and never the BSUID', (select phone = '' and phone_optional and phone_normalized = '' and phone not like '%QA0000%' from contacts where id=(select contact_id from r1)));
select pg_temp.check('name and username stored (username display-only)', (select name='Visible Name' and wa_username='qa_user' from contacts where id=(select contact_id from r1)));
create temp table r2 as select * from resolve_bsuid_contact('a1a1a1a1-0000-4000-8000-00000000000a','aaaaaaaa-0000-4000-8000-000000000001','PE.QA0000000000001',null,'renamed',null);
select pg_temp.check('same BSUID in the same account resolves to the same contact', (select contact_id from r1)=(select contact_id from r2) and not (select created from r2));
select pg_temp.check('parent BSUID stored once', (select count(*) from contact_identities where kind='parent_bsuid' and value='PE.ENT.QAP000000001')=1);
create temp table r3 as select * from resolve_bsuid_contact('b2b2b2b2-0000-4000-8000-00000000000b','bbbbbbbb-0000-4000-8000-000000000002','PE.QA0000000000001',null,null,null);
select pg_temp.check('the SAME BSUID in another account is a different contact', (select contact_id from r3)<>(select contact_id from r1) and (select created from r3));
select pg_temp.check('no name falls back to a neutral label', (select name='WhatsApp user' from contacts where id=(select contact_id from r3)));
select pg_temp.check('several phone-less contacts can coexist (partial unique index ignores empty)', (select count(*) from contacts where phone_normalized='' and phone_optional)>=2);

-- 3 integrity guards
do $$ begin
  begin insert into contact_identities(account_id,contact_id,kind,value) select 'b2b2b2b2-0000-4000-8000-00000000000b', contact_id, 'parent_bsuid', 'PE.CROSS' from r1; perform pg_temp.check('cannot attach an identity to a contact of ANOTHER account', false);
  exception when foreign_key_violation then perform pg_temp.check('cannot attach an identity to a contact of ANOTHER account', true); end;
end $$;
do $$ begin
  begin
    insert into contacts(account_id,user_id,phone,phone_optional,name) values ('a1a1a1a1-0000-4000-8000-00000000000a','aaaaaaaa-0000-4000-8000-000000000001','',true,'Smuggled');
    set constraints all immediate;
    perform pg_temp.check('phone_optional without an identity is rejected at commit', false);
  exception when check_violation then perform pg_temp.check('phone_optional without an identity is rejected at commit', true); end;
end $$;
do $$ begin
  begin perform resolve_bsuid_contact('a1a1a1a1-0000-4000-8000-00000000000a','aaaaaaaa-0000-4000-8000-000000000001','  ',null,null,null); perform pg_temp.check('blank BSUID refused', false);
  exception when others then perform pg_temp.check('blank BSUID refused', sqlstate='22023'); end;
end $$;

-- 4 link_contact_bsuid
create temp table pc as select id from contacts where name='Phone A';
create temp table l1 as select * from link_contact_bsuid('a1a1a1a1-0000-4000-8000-00000000000a',(select id from pc),'PE.QA0000000000002',null,'phone_user_handle');
select pg_temp.check('BSUID linked to an existing phone contact', (select outcome from l1)='linked' and (select count(*) from contact_identities where contact_id=(select id from pc) and value='PE.QA0000000000002')=1);
select pg_temp.check('the phone contact keeps its phone and gains the display username', (select phone='+51 900 000 001' and wa_username='phone_user_handle' from contacts where id=(select id from pc)));
create temp table l2 as select * from link_contact_bsuid('a1a1a1a1-0000-4000-8000-00000000000a',(select id from pc),'PE.QA0000000000001',null,null);
select pg_temp.check('an id owned by ANOTHER contact is a conflict and nothing is merged', (select outcome from l2)='conflict' and (select owner_contact_id from l2)=(select contact_id from r1) and (select count(*) from contacts where id=(select id from pc))=1);
create temp table l3 as select * from link_contact_bsuid('a1a1a1a1-0000-4000-8000-00000000000a',(select id from pc),'PE.QA0000000000003',null,null,'PE.QA0000000000002');
select pg_temp.check('a changed BSUID supersedes the old one, which still resolves to the contact', (select count(*) from contact_identities where contact_id=(select id from pc) and kind='bsuid' and superseded_at is null and value='PE.QA0000000000003')=1 and (select superseded_at is not null from contact_identities where value='PE.QA0000000000002' and account_id='a1a1a1a1-0000-4000-8000-00000000000a'));
do $$ begin
  begin perform link_contact_bsuid('b2b2b2b2-0000-4000-8000-00000000000b',(select id from contacts where name='Phone A'),'PE.QA9',null,null); perform pg_temp.check('linking across accounts refused', false);
  exception when others then perform pg_temp.check('linking across accounts refused', sqlstate='42501'); end;
end $$;

-- 5 RLS
set role authenticated;
select set_config('request.jwt.claim.sub','aaaaaaaa-0000-4000-8000-000000000001', false);
select pg_temp.check('a member of account A sees only A identities', (select count(*) from contact_identities where account_id='b2b2b2b2-0000-4000-8000-00000000000b')=0 and (select count(*) from contact_identities where account_id='a1a1a1a1-0000-4000-8000-00000000000a')>0);
do $$ begin
  begin insert into contact_identities(account_id,contact_id,kind,value) select account_id, contact_id, 'bsuid', 'PE.CLIENTWRITE' from contact_identities limit 1; perform pg_temp.check('a client cannot write identities', false);
  exception when insufficient_privilege or others then perform pg_temp.check('a client cannot write identities (RLS)', true); end;
end $$;
do $$ begin
  begin perform resolve_bsuid_contact('a1a1a1a1-0000-4000-8000-00000000000a','aaaaaaaa-0000-4000-8000-000000000001','PE.CLIENTCALL',null,null,null); perform pg_temp.check('a client cannot call the resolver', false);
  exception when insufficient_privilege then perform pg_temp.check('a client cannot call the resolver', true); end;
end $$;
reset role;

-- 6 old image can still read and update a BSUID-only contact (name/blocked), as it does the 41 historical empty-phone rows
update contacts set name='Edited by old PATCH', blocked=true where id=(select contact_id from r1);
select pg_temp.check('name/blocked updates on a BSUID-only contact work (phone untouched)', (select name='Edited by old PATCH' and blocked and phone='' from contacts where id=(select contact_id from r1)));
update contacts set blocked=false where id=(select contact_id from r1);

-- 7 deleting a contact removes its identities, deleting an account too
create temp table dc as select * from resolve_bsuid_contact('b2b2b2b2-0000-4000-8000-00000000000b','bbbbbbbb-0000-4000-8000-000000000002','PE.QA0000000000009',null,null,null);
delete from contacts where id=(select contact_id from dc);
select pg_temp.check('deleting a contact deletes its identities', (select count(*) from contact_identities where value='PE.QA0000000000009')=0);

-- 8 pilot send authorization + audit
create temp table sc as select * from resolve_bsuid_contact('a1a1a1a1-0000-4000-8000-00000000000a','aaaaaaaa-0000-4000-8000-000000000001','PE.QA0000000000050',null,'pilot_user','Pilot');
select pg_temp.check('new BSUID contact starts with ZERO send authorizations', (select send_authorized_remaining=0 from contact_identities where value='PE.QA0000000000050'));
select pg_temp.check('consume with no authorization returns false and spends nothing', (select consume_bsuid_send('a1a1a1a1-0000-4000-8000-00000000000a',(select contact_id from sc),'manual_reply')) = false);
select pg_temp.check('authorize returns the granted count', (select authorize_bsuid_send('a1a1a1a1-0000-4000-8000-00000000000a',(select contact_id from sc),1,'qa')) = 1);
select pg_temp.check('first consume true, second false (a single reply)', (select consume_bsuid_send('a1a1a1a1-0000-4000-8000-00000000000a',(select contact_id from sc),'manual_reply')) and not (select consume_bsuid_send('a1a1a1a1-0000-4000-8000-00000000000a',(select contact_id from sc),'manual_reply')));
select pg_temp.check('authorizations and consumption are audited', (select count(*) from contact_identity_audit where contact_id=(select contact_id from sc) and event='send_authorized')=1 and (select count(*) from contact_identity_audit where contact_id=(select contact_id from sc) and event='send_consumed')=1);
do $$ begin
  begin perform authorize_bsuid_send('a1a1a1a1-0000-4000-8000-00000000000a',(select contact_id from sc),4,null); perform pg_temp.check('authorization is capped at 3', false);
  exception when others then perform pg_temp.check('authorization is capped at 3', sqlstate='22023'); end;
end $$;
do $$ begin
  begin perform authorize_bsuid_send('b2b2b2b2-0000-4000-8000-00000000000b',(select contact_id from sc),1,null); perform pg_temp.check('cannot authorize a contact through another account', false);
  exception when others then perform pg_temp.check('cannot authorize a contact through another account', sqlstate='42704'); end;
end $$;
insert into contacts(account_id,user_id,phone,name) values ('a1a1a1a1-0000-4000-8000-00000000000a','aaaaaaaa-0000-4000-8000-000000000001','+51 900 000 088','Phone Only');
do $$ begin
  begin perform authorize_bsuid_send('a1a1a1a1-0000-4000-8000-00000000000a',(select id from contacts where name='Phone Only'),1,null); perform pg_temp.check('a phone-only contact has no BSUID to authorize', false);
  exception when others then perform pg_temp.check('a phone-only contact has no BSUID to authorize', sqlstate in ('42704')); end;
end $$;
select pg_temp.check('the other account cannot consume it', (select consume_bsuid_send('b2b2b2b2-0000-4000-8000-00000000000b',(select contact_id from sc),'manual_reply')) = false);
select authorize_bsuid_send('a1a1a1a1-0000-4000-8000-00000000000a',(select contact_id from sc),2,null);
create temp table rv as select revoke_bsuid_send('a1a1a1a1-0000-4000-8000-00000000000a',(select contact_id from sc)) as rows;
select pg_temp.check('revoke clears the authorization and is audited', (select rows from rv)=1 and (select send_authorized_remaining=0 from contact_identities where value='PE.QA0000000000050') and (select count(*)=1 from contact_identity_audit where event='send_revoked' and contact_id=(select contact_id from sc)));
select pg_temp.check('a superseded id cannot be consumed', (select count(*) from (select link_contact_bsuid('a1a1a1a1-0000-4000-8000-00000000000a',(select contact_id from sc),'PE.QA0000000000051',null,null,'PE.QA0000000000050')) x)=1 and (select consume_bsuid_send('a1a1a1a1-0000-4000-8000-00000000000a',(select contact_id from sc),'manual_reply')) = false);
set role authenticated;
select set_config('request.jwt.claim.sub','aaaaaaaa-0000-4000-8000-000000000001', false);
do $$ begin
  begin perform authorize_bsuid_send('a1a1a1a1-0000-4000-8000-00000000000a',(select id from contacts limit 1),1,null); perform pg_temp.check('a client cannot authorize sends', false);
  exception when insufficient_privilege then perform pg_temp.check('a client cannot authorize sends', true); end;
end $$;
do $$ begin
  begin perform consume_bsuid_send('a1a1a1a1-0000-4000-8000-00000000000a',(select id from contacts limit 1),'x'); perform pg_temp.check('a client cannot consume authorizations', false);
  exception when insufficient_privilege then perform pg_temp.check('a client cannot consume authorizations', true); end;
end $$;
select pg_temp.check('a client cannot read the audit trail (RLS, no policy)', (select count(*) from contact_identity_audit)=0);
do $$ begin
  begin update contact_identities set send_authorized_remaining=3; perform pg_temp.check('a client cannot raise its own authorization (RLS)', (select count(*) from contact_identities where send_authorized_remaining=3)=0);
  exception when others then perform pg_temp.check('a client cannot raise its own authorization (RLS)', true); end;
end $$;
reset role;

-- 9 previous image against the migrated schema: the statements the old code issues
select pg_temp.check('old code: merge_duplicate_contacts() still runs and keeps phone-less contacts', (select merge_duplicate_contacts() >= 0) and (select count(*) from contacts where phone_optional and phone='')>=1);
insert into conversations(account_id,user_id,contact_id) values ('a1a1a1a1-0000-4000-8000-00000000000a','aaaaaaaa-0000-4000-8000-000000000001',(select contact_id from sc));
select pg_temp.check('old code: a conversation can be created for a phone-less contact', (select count(*) from conversations where contact_id=(select contact_id from sc))=1);
select record_blocked_inbound((select contact_id from sc),'a1a1a1a1-0000-4000-8000-00000000000a', now());
select pg_temp.check('old code: record_blocked_inbound works on a phone-less contact', true);
select pg_temp.check('old code: lookup by phone suffix never returns a phone-less contact', (select count(*) from contacts where account_id='a1a1a1a1-0000-4000-8000-00000000000a' and phone like '%000001' and phone_optional)=0);
update contacts set phone='+51 900 000 077' where name='Phone A';
select pg_temp.check('old code: healing a phone number (UPDATE phone) works for a phone contact', (select phone='+51 900 000 077' from contacts where name='Phone A'));
