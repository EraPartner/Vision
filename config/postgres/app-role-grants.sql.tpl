-- Grant set for the least-privilege application role — single source of truth.
--
-- The native runtime packages this file with the backend. Keep it to simple
-- semicolon-terminated statements because the Node bootstrap splits it on
-- semicolons after substituting the quoted identifier variables below.

GRANT CONNECT ON DATABASE :"db_name" TO :"app_role";

GRANT USAGE, CREATE ON SCHEMA public TO :"app_role";

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO :"app_role";

GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO :"app_role";

ALTER DEFAULT PRIVILEGES FOR ROLE :"owner_role" IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO :"app_role";

ALTER DEFAULT PRIVILEGES FOR ROLE :"owner_role" IN SCHEMA public
  GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO :"app_role";
