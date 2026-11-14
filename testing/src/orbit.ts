// Orbit for chosen handles on a running stack, as the owner inside its own Postgres: no
// migration, so it goes with the container.
import { sql } from './database.ts';
import type { Coordinates } from './stack/stack.ts';

/** The users_handle_format check, so a mistyped handle fails here and not silently later. */
export const HANDLE_FORMAT = /^[A-Za-z0-9][A-Za-z0-9_\-]{2,31}$/v;

/** The handles, lower-cased, as an SQL array, inlined safely as HANDLE_FORMAT allows no quote. */
const sqlArray = (handles: readonly string[]): string =>
  `ARRAY[${handles.map((handle) => `'${handle.toLowerCase()}'`).join(', ')}]::text[]`;

/** The lock makes calls take turns, as two replacing the function at once fail with "tuple
 *  concurrently updated"; the owner's SECURITY DEFINER trigger writes past orbit_grants' RLS. */
const grantSql = (list: string): string =>
  `BEGIN;
SELECT pg_advisory_xact_lock(hashtext('kit grantOrbit'));
CREATE TABLE IF NOT EXISTS preview_orbit_handles (handle text PRIMARY KEY);
CREATE OR REPLACE FUNCTION preview_orbit_on_sign_up() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    IF lower(NEW.handle) IN (SELECT handle FROM preview_orbit_handles) THEN
        INSERT INTO orbit_grants (user_id, reason) VALUES (NEW.id, 'local preview')
            ON CONFLICT (user_id) DO NOTHING;
    END IF;
    RETURN NULL;
END;
$$;
CREATE OR REPLACE TRIGGER preview_orbit_on_sign_up AFTER INSERT OR UPDATE OF handle ON users
    FOR EACH ROW EXECUTE FUNCTION preview_orbit_on_sign_up();
INSERT INTO preview_orbit_handles (handle) SELECT unnest(${list}) ON CONFLICT DO NOTHING;
INSERT INTO orbit_grants (user_id, reason)
    SELECT id, 'local preview' FROM users WHERE lower(handle) = ANY (${list})
    ON CONFLICT (user_id) DO NOTHING;
COMMIT;`;

/** Grants Orbit to the handles' accounts now and on later sign-ups or handle changes, ignoring
 *  case. Each call adds to the handles earlier ones granted, and calls may run at once. */
export const grantOrbit = async (
  coordinates: Coordinates,
  handles: readonly string[],
): Promise<void> => {
  const invalid = handles.filter((handle) => !HANDLE_FORMAT.test(handle));
  if (invalid.length > 0) {
    throw new Error(`not a valid handle: ${invalid.join(', ')}`);
  }
  if (handles.length > 0) {
    await sql(coordinates, grantSql(sqlArray(handles)));
  }
};
