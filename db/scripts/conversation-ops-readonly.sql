-- Aggregate-only operational inspection. Run with psql -X -v ON_ERROR_STOP=1.
-- No IDs, message text, payloads, credentials, or per-user rows are selected.
BEGIN READ ONLY;

SELECT current_database() AS database_name,
       current_setting('server_version_num') AS pg_version_num,
       current_user AS inspection_role,
       now() AS inspected_at;

SELECT role_name,
       EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) AS exists
FROM (VALUES ('wg_auth'), ('wg_conversation')) AS roles(role_name);

SELECT table_name,
       to_regclass('public.' || table_name) IS NOT NULL AS exists,
       CASE WHEN to_regclass('public.' || table_name) IS NOT NULL
            AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wg_conversation')
            THEN has_table_privilege('wg_conversation', 'public.' || table_name, 'SELECT')
             AND has_table_privilege('wg_conversation', 'public.' || table_name, 'INSERT')
             AND has_table_privilege('wg_conversation', 'public.' || table_name, 'UPDATE')
             AND has_table_privilege('wg_conversation', 'public.' || table_name, 'DELETE')
            ELSE NULL END AS conversation_role_has_crud
FROM (VALUES ('conversation_threads'), ('conversation_turns'),
             ('conversation_messages'), ('conversation_sources'),
             ('conversation_company_events'), ('conversation_summaries'),
             ('conversation_requests')) AS tables(table_name);

SELECT table_name,
       CASE WHEN to_regclass('public.' || table_name) IS NOT NULL
                 AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wg_conversation')
            THEN has_table_privilege('wg_conversation', 'public.' || table_name, 'SELECT')
              OR has_table_privilege('wg_conversation', 'public.' || table_name, 'INSERT')
              OR has_table_privilege('wg_conversation', 'public.' || table_name, 'UPDATE')
              OR has_table_privilege('wg_conversation', 'public.' || table_name, 'DELETE')
            ELSE NULL END AS conversation_role_has_any_access
FROM (VALUES ('users'), ('sessions'), ('posts'), ('worksite_tips')) AS outside_tables(table_name);

SELECT table_name,
       CASE WHEN to_regclass('public.' || table_name) IS NOT NULL
                 AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wg_auth')
            THEN has_table_privilege('wg_auth', 'public.' || table_name, 'SELECT')
             AND has_table_privilege('wg_auth', 'public.' || table_name, 'INSERT')
             AND has_table_privilege('wg_auth', 'public.' || table_name, 'UPDATE')
             AND has_table_privilege('wg_auth', 'public.' || table_name, 'DELETE')
            ELSE NULL END AS auth_role_has_crud
FROM (VALUES ('users'), ('sessions')) AS auth_tables(table_name);

SELECT CASE WHEN to_regclass('public.user_favorite_firms') IS NOT NULL
                 AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wg_auth')
            THEN has_table_privilege('wg_auth', 'public.user_favorite_firms', 'SELECT')
             AND has_table_privilege('wg_auth', 'public.user_favorite_firms', 'INSERT')
             AND has_table_privilege('wg_auth', 'public.user_favorite_firms', 'DELETE')
             AND NOT has_table_privilege('wg_auth', 'public.user_favorite_firms', 'UPDATE')
            ELSE NULL END AS auth_favorites_exact_grant;

SELECT table_name,
       CASE WHEN to_regclass('public.' || table_name) IS NOT NULL
                 AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wg_auth')
            THEN has_table_privilege('wg_auth', 'public.' || table_name, 'SELECT')
              OR has_table_privilege('wg_auth', 'public.' || table_name, 'INSERT')
              OR has_table_privilege('wg_auth', 'public.' || table_name, 'UPDATE')
              OR has_table_privilege('wg_auth', 'public.' || table_name, 'DELETE')
            ELSE NULL END AS auth_role_has_conversation_access
FROM (VALUES ('conversation_threads'), ('conversation_turns'),
             ('conversation_messages'), ('conversation_summaries'),
             ('conversation_requests')) AS conversation_tables(table_name);

SELECT count(*) FILTER (WHERE expires_at <= now()) AS expired_threads,
       count(*) FILTER (WHERE expires_at <= now() - interval '1 hour') AS expired_over_one_hour,
       min(expires_at) FILTER (WHERE expires_at <= now()) AS oldest_expired_at
FROM conversation_threads;

SELECT count(*) FILTER (WHERE pending_through_sequence IS NOT NULL) AS summary_backlog,
       count(*) FILTER (WHERE pending_through_sequence IS NOT NULL
                        AND lease_expires_at < now()) AS expired_summary_leases,
       count(*) FILTER (WHERE pending_through_sequence IS NOT NULL
                        AND updated_at < now() - interval '1 hour') AS summary_backlog_over_one_hour,
       count(*) FILTER (WHERE status = 'failed') AS failed_summaries,
       min(updated_at) FILTER (WHERE pending_through_sequence IS NOT NULL) AS oldest_summary_update
FROM conversation_summaries;

SELECT count(*) FILTER (WHERE status = 'pending') AS pending_requests,
       count(*) FILTER (WHERE status = 'pending' AND lease_expires_at < now()) AS expired_request_leases,
       count(*) FILTER (WHERE status = 'pending'
                        AND created_at < now() - interval '1 hour') AS pending_over_one_hour
FROM conversation_requests;

COMMIT;
