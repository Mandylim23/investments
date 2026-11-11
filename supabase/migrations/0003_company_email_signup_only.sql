create or replace function public.require_company_email_for_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.email is null
     or lower(split_part(new.email, '@', 2)) <> 'selangorproperties.com.my' then
    raise exception using
      errcode = '23514',
      message = 'Only @selangorproperties.com.my email addresses can create an account.';
  end if;

  return new;
end;
$$;

revoke all on function public.require_company_email_for_new_user() from public, anon, authenticated;

drop trigger if exists require_company_email_for_new_user on auth.users;
create trigger require_company_email_for_new_user
  before insert on auth.users
  for each row execute function public.require_company_email_for_new_user();
