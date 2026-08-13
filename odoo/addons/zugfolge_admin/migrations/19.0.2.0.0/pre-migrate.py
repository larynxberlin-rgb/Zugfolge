import logging
import uuid


_logger = logging.getLogger(__name__)


def migrate(cr, _version):
    """Make legacy correlations unique before the ORM installs the constraint."""
    cr.execute(
        """
            SELECT correlation_id
              FROM zugfolge_admin_request
             WHERE correlation_id IS NOT NULL
             GROUP BY correlation_id
            HAVING COUNT(*) > 1
        """
    )
    duplicate_correlations = [row[0] for row in cr.fetchall()]
    for correlation_id in duplicate_correlations:
        cr.execute(
            """
                SELECT id, state, game_audit_event_id, game_result
                  FROM zugfolge_admin_request
                 WHERE correlation_id = %s
                 ORDER BY id
            """,
            [correlation_id],
        )
        rows = cr.fetchall()
        externally_bound = [
            row for row in rows
            if row[1] in ("dispatched", "accepted", "completed", "failed")
            or row[2] is not None
            or row[3] is not None
        ]
        if len(externally_bound) > 1:
            raise RuntimeError(
                "Mehrere bereits an das Game gebundene Administrationsantraege "
                "teilen dieselbe correlation_id; Upgrade zur sicheren manuellen "
                "Reconciliation abgebrochen."
            )
        keep_id = externally_bound[0][0] if externally_bound else rows[0][0]
        rewritten = 0
        for row in rows:
            if row[0] == keep_id:
                continue
            cr.execute(
                "UPDATE zugfolge_admin_request SET correlation_id = %s WHERE id = %s",
                [str(uuid.uuid4()), row[0]],
            )
            rewritten += 1
        _logger.warning(
            "Repaired %s duplicate draft correlation(s) for legacy admin request %s",
            rewritten,
            keep_id,
        )
