"""Idempotente Datenkorrekturen fuer Upgrades des Zugfolge-Add-ons."""


LEGACY_ADMIN_REQUEST_WORLD_BACKFILL_SQL = """
    UPDATE zugfolge_admin_request AS request
       SET world_id = projection.world_id,
           world_name = COALESCE(
               NULLIF(BTRIM(request.world_name), ''),
               projection.world_name
           ),
           world_kind = COALESCE(
               NULLIF(projection.profile_kind, ''),
               NULLIF(request.world_kind, '')
           ),
           ranking_status = CASE
               WHEN projection.profile_kind = 'public' THEN 'ranked'
               WHEN projection.profile_kind IN ('tutorial', 'private', 'test') THEN 'unranked'
               ELSE request.ranking_status
           END,
           schedule_period_weeks = CASE
               WHEN projection.telemetry -> 'world' ->> 'schedulePeriodWeeks' ~ '^[3-8]$'
               THEN (projection.telemetry -> 'world' ->> 'schedulePeriodWeeks')::integer
               ELSE request.schedule_period_weeks
           END,
           world_epoch = CASE
               WHEN projection.simulation_time IS NOT NULL
                AND projection.telemetry -> 'world' ->> 'simulationTimeS' ~ '^[0-9]{1,9}$'
               THEN projection.simulation_time
                    - (projection.telemetry -> 'world' ->> 'simulationTimeS')::integer * INTERVAL '1 second'
               ELSE request.world_epoch
           END
      FROM zugfolge_world_projection AS projection
     WHERE request.world_projection_id = projection.id
       AND request.action_type IS DISTINCT FROM 'world_deploy'
       AND (request.world_id IS NULL OR BTRIM(request.world_id) = '')
       AND projection.world_id IS NOT NULL
       AND BTRIM(projection.world_id) <> ''
"""


def backfill_legacy_admin_request_worlds(cr):
    """Bind legacy requests to their existing projection exactly once.

    ``world_id`` is the legacy marker: it did not exist before 19.0.1.4.0,
    while every old request already had ``world_projection_id``. New
    ``world_deploy`` drafts are explicitly excluded because they intentionally
    have no projection and carry their own signed world definition.
    """
    cr.execute(LEGACY_ADMIN_REQUEST_WORLD_BACKFILL_SQL)
    return cr.rowcount
