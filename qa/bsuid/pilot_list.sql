-- READ-ONLY. Phone-less (BSUID) contacts of one account created in the last :hours hours, with masked data only.
-- Use it to find the practicante's contact from the time of his message, then authorize that exact contact_id.
-- psql -v account=<uuid> -v hours=<n> -f pilot_list.sql
select c.id                                                           as contact_id,
       to_char(c.created_at at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS') as created_utc,
       left(i.value, 2)                                               as id_prefix,
       left(c.name, 1) || '***'                                       as name_masked,
       (c.wa_username is not null)                                    as has_username,
       c.blocked,
       (select count(*) from messages m join conversations v on v.id = m.conversation_id
         where v.contact_id = c.id and v.account_id = c.account_id and m.sender_type = 'customer') as customer_msgs,
       (select to_char(min(m.created_at) at time zone 'utc', 'HH24:MI:SS') from messages m join conversations v on v.id = m.conversation_id
         where v.contact_id = c.id and v.account_id = c.account_id and m.sender_type = 'customer') as first_msg_utc,
       i.send_authorized_remaining                                    as replies_authorized
  from contacts c
  join contact_identities i on i.contact_id = c.id and i.account_id = c.account_id and i.kind = 'bsuid' and i.superseded_at is null
 where c.account_id = :'account'::uuid
   and c.phone_optional
   and c.created_at > now() - make_interval(hours => :hours)
 order by c.created_at desc
 limit 20;
