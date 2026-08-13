import logging

from odoo.addons.zugfolge_admin.upgrade import backfill_legacy_admin_request_worlds


_logger = logging.getLogger(__name__)


def migrate(cr, version):
    updated = backfill_legacy_admin_request_worlds(cr)
    _logger.info(
        "Backfilled world binding for %s legacy Zugfolge administration requests (source version %s).",
        updated,
        version,
    )
