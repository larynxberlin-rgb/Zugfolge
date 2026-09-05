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
               WHEN projection.profile_kind IN ('private', 'test') THEN 'unranked'
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


LEGACY_DEPLOYMENT_AUDIT_BACKFILL_SQL = """
    INSERT INTO zugfolge_world_deployment_audit (
        world_projection_id,
        world_id,
        deployment_revision,
        previous_deployment_hash,
        deployment_hash,
        previous_blueprint_hash,
        blueprint_hash,
        message_id,
        correlation_id,
        occurred_at,
        payload_hash,
        "authorization"
    )
    SELECT projection.id,
           projection.world_id,
           projection.deployment_revision,
           NULL,
           projection.deployment_hash,
           NULL,
           projection.blueprint_hash,
           'legacy-deployment-baseline:' || projection.id::text,
           'legacy-deployment-baseline:' || projection.world_id,
           COALESCE(projection.observed_at, NOW() AT TIME ZONE 'UTC'),
           projection.payload_hash,
           jsonb_build_object(
               'schemaVersion', 'zugfolge-legacy-deployment-baseline/v1',
               'migration', '19.0.2.0.3'
           )
      FROM zugfolge_world_projection AS projection
     WHERE projection.deployment_hash IS NOT NULL
       AND BTRIM(projection.deployment_hash) <> ''
    ON CONFLICT DO NOTHING
"""


def backfill_legacy_deployment_audit(cr):
    """Promote an existing immutable Odoo mirror to signed generation 1.

    No projection is deleted or rewritten except for the new generation marker;
    the exact legacy deployment and blueprint hashes become the first immutable
    audit row. Re-running the migration is a no-op.
    """
    cr.execute("""
        UPDATE zugfolge_world_projection
           SET deployment_revision = 1
         WHERE deployment_hash IS NOT NULL
           AND BTRIM(deployment_hash) <> ''
           AND COALESCE(deployment_revision, 0) < 1
    """)
    updated = cr.rowcount
    cr.execute(LEGACY_DEPLOYMENT_AUDIT_BACKFILL_SQL)
    return updated + cr.rowcount


def remove_retired_learning_worlds(env):
    """Remove obsolete learning-world mirrors, including their administrative records.

    This runs once during the stopped-stack upgrade. Ordinary worlds, partners,
    invoices and the central server register are retained.
    """
    env.flush_all()
    env.cr.execute("""
        SELECT world_id FROM zugfolge_world_projection WHERE profile_kind = 'tutorial'
        UNION SELECT request.world_id FROM zugfolge_admin_request request
        WHERE request.world_kind = 'tutorial'
          AND NOT EXISTS (
              SELECT 1 FROM zugfolge_world_projection projection
              WHERE projection.world_id = request.world_id
                AND projection.profile_kind IS DISTINCT FROM 'tutorial'
          )
    """)
    world_ids = [row[0] for row in env.cr.fetchall() if row[0]]
    projections = env["zugfolge.world.projection"].sudo().search([("world_id", "in", world_ids)])
    requests = env["zugfolge.admin.request"].sudo().search([
        "|", "|", ("world_id", "in", world_ids),
        ("world_projection_id", "in", projections.ids), ("world_kind", "=", "tutorial"),
    ])
    targets = [
        ("zugfolge.alpha.invitation", ["|", ("world_projection_id", "in", projections.ids), ("revocation_request_id", "in", requests.ids)]),
        ("zugfolge.infra.release.import", ["|", ("world_projection_id", "in", projections.ids), ("adoption_request_id", "in", requests.ids)]),
        ("zugfolge.feedback", [("world_projection_id", "in", projections.ids)]),
        ("zugfolge.world.participation", [("world_id", "in", world_ids)]),
        ("zugfolge.world.offer", [("projection_id", "in", projections.ids)]),
        ("zugfolge.world.deployment.audit", [("world_id", "in", world_ids)]),
        ("zugfolge.projection.receipt", [("world_id", "in", world_ids)]),
        ("zugfolge.admin.capability", [("world_id", "in", world_ids)]),
        ("zugfolge.admin.request", [("id", "in", requests.ids)]),
        ("zugfolge.world.projection", [("id", "in", projections.ids)]),
    ]
    removed = 0
    for model_name, domain in targets:
        records = env[model_name].sudo().search(domain)
        if not records:
            continue
        jobs = env["queue.job"].sudo().search([("model_name", "=", model_name)])
        selected_ids = set(records.ids)
        jobs = jobs.filtered(lambda job: bool(set(job.records.ids) & selected_ids))
        if any(set(job.records.ids) - selected_ids for job in jobs):
            raise ValueError("A queued job combines retired and regular world records.")
        jobs.unlink()
        env["mail.activity"].sudo().search([("res_model", "=", model_name), ("res_id", "in", records.ids)]).unlink()
        env["mail.message"].sudo().search([("model", "=", model_name), ("res_id", "in", records.ids)]).unlink()
        env["mail.followers"].sudo().search([("res_model", "=", model_name), ("res_id", "in", records.ids)]).unlink()
        env["ir.attachment"].sudo().search([("res_model", "=", model_name), ("res_id", "in", records.ids)]).unlink()
        env["ir.model.data"].sudo().search([("model", "=", model_name), ("res_id", "in", records.ids)]).unlink()
        # Only these fixed module tables bypass their ordinary immutable-audit guard.
        # Database foreign keys still protect any unexpected external dependency.
        env.cr.execute('DELETE FROM "' + records._table + '" WHERE id = ANY(%s)', [records.ids])
        removed += env.cr.rowcount
    env.invalidate_all()
    return removed
