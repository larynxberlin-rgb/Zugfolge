import logging


_logger = logging.getLogger(__name__)


def migrate(cr, _version):
    """Keep unverifiable legacy body-only receipts explicitly replay-ineligible."""
    cr.execute(
        """
            SELECT COUNT(*)
              FROM zugfolge_projection_receipt
             WHERE envelope_hash IS NULL
                OR envelope_hash_schema IS NULL
        """
    )
    legacy_count = cr.fetchone()[0]
    if legacy_count:
        _logger.warning(
            "%s legacy Zugfolge projection receipt(s) have only the historical "
            "body digest and will fail closed with replay_conflict. Upgrade only "
            "after the Game projection outbox has been quiesced and drained.",
            legacy_count,
        )
