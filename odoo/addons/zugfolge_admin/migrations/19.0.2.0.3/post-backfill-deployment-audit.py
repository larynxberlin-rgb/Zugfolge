import logging

from odoo.addons.zugfolge_admin.upgrade import backfill_legacy_deployment_audit


_logger = logging.getLogger(__name__)


def migrate(cr, _version):
    changed = backfill_legacy_deployment_audit(cr)
    _logger.info("Zugfolge deployment projection audit backfill changed %s rows", changed)
